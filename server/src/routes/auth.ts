import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { verifyPassword, hashPassword } from "../auth/password.js";
import { signSession, setSessionCookie, clearSessionCookie } from "../auth/session.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { LOGIN_RATE_LIMIT, env, isProd, emailConfigured } from "../config.js";
import { createOrganization, resolveJoinToken, consumeInvite } from "../services/org.js";
import { normalizePhone } from "../domain/phone.js";
import { sendEmail } from "../services/email.js";
import {
  generateSecret, verifyTotp, otpauthUri, generateRecoveryCodes, hashRecoveryCode,
} from "../domain/totp.js";
import {
  getProvider, enabledProviders, buildAuthorizeUrl, exchangeCode, fetchProfile,
} from "../services/oauth.js";
import { encryptSecret, decryptSecret } from "../services/secrets.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: LOGIN_RATE_LIMIT.WINDOW_MS,
  max: LOGIN_RATE_LIMIT.MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

/** Issue a session (cookie + bearer token) and the compact user summary. */
function issueSession(res: import("express").Response, user: { id: string; name: string; email: string; role: "OWNER" | "ASSOCIATE"; orgRole: string | null; sessionEpoch: number }) {
  const token = signSession({ userId: user.id, role: user.role, epoch: user.sessionEpoch });
  setSessionCookie(res, token);
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, orgRole: user.orgRole } };
}

// TOTP secrets are encrypted at rest with the integrations key (AES-256-GCM,
// services/secrets). Rows enrolled before this hardening hold base32 plaintext
// (which never contains ":"), so the "v1:" ciphertext prefix disambiguates —
// legacy enrollments keep verifying and are re-encrypted on their next enroll.
const sealTotpSecret = (secret: string): string => encryptSecret(secret);
function revealTotpSecret(stored: string): string {
  if (!stored.startsWith("v1:")) return stored; // legacy plaintext row
  try { return decryptSecret(stored); } catch { return stored; }
}

/** Verify a submitted 2FA value against the user's TOTP secret or recovery codes. */
async function verifySecondFactor(user: { id: string; totpSecret: string | null; totpRecoveryCodes: string[] }, code: string): Promise<boolean> {
  if (user.totpSecret && verifyTotp(revealTotpSecret(user.totpSecret), code)) return true;
  // Recovery code: single-use — consume it on success.
  const hash = hashRecoveryCode(code);
  if (user.totpRecoveryCodes.includes(hash)) {
    await prisma.user.update({
      where: { id: user.id },
      data: { totpRecoveryCodes: user.totpRecoveryCodes.filter((h) => h !== hash) },
    });
    return true;
  }
  return false;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().trim().optional(),
});

authRouter.post(
  "/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, totpCode } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Constant-ish response — don't reveal whether the email exists.
    if (!user || user.status !== "ACTIVE") {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    // Second factor step-up: password is correct, but 2FA is on.
    if (user.totpEnabled) {
      if (!totpCode) {
        res.json({ twoFactorRequired: true });
        return;
      }
      const passed = await verifySecondFactor(user, totpCode);
      if (!passed) {
        res.status(401).json({ error: "Invalid verification code", twoFactorRequired: true });
        return;
      }
    }

    res.json(issueSession(res, user));
  }),
);

// Public self-service registration. All profile fields required; optionally join an
// existing org via a Team ID or invite code, otherwise a personal org is created.
const registerLimiter = rateLimit({
  windowMs: LOGIN_RATE_LIMIT.WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

const registerSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  phone: z.string().trim().min(1, "Phone number is required").transform(normalizePhone),
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  joinToken: z.string().trim().optional(),
});

authRouter.post(
  "/register",
  registerLimiter,
  asyncHandler(async (req, res) => {
    const data = registerSchema.parse(req.body);
    const email = data.email.toLowerCase();
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) throw new HttpError(409, "An account with that email already exists");

    // Resolve the join token up front so an invalid code fails before we create anything.
    const join = data.joinToken ? await resolveJoinToken(data.joinToken) : null;

    // Invite-only signup (default): without a valid code, brand-new workspaces
    // can't be self-provisioned. Flip ALLOW_PUBLIC_SIGNUP=true to open it up.
    if (!join && !env.ALLOW_PUBLIC_SIGNUP) {
      throw new HttpError(403, "Sign-up requires a Team ID or invite code. Ask your administrator for an invite.");
    }

    const user = await prisma.$transaction(async (tx) => {
      let organizationId: string;
      let orgRole: "OWNER" | "MEMBER";
      if (join) {
        organizationId = join.organizationId;
        orgRole = "MEMBER";
        await consumeInvite(join.inviteCodeId, tx);
      } else {
        const org = await createOrganization(`${data.firstName} ${data.lastName}'s Workspace`, tx);
        organizationId = org.id;
        orgRole = "OWNER";
      }
      return tx.user.create({
        data: {
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          name: `${data.firstName} ${data.lastName}`,
          email,
          passwordHash: await hashPassword(data.password),
          // Legacy account role: OWNER only for workspace creators. Invite-code
          // joiners are ASSOCIATE — authorization runs on orgRole + permissions,
          // and the legacy role must never grant a joiner elevated access.
          role: join ? "ASSOCIATE" : "OWNER",
          organizationId,
          orgRole,
        },
      });
    });

    const token = signSession({ userId: user.id, role: user.role, epoch: user.sessionEpoch });
    setSessionCookie(res, token);
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, orgRole: user.orgRole },
    });
  }),
);

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Valid UI themes. Kept here so the preferences route and any future default
// logic share one source of truth.
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

/**
 * The user's EXPLICITLY chosen theme, or null when unset/unavailable. Null (not
 * a default) is important: the client only adopts a non-null value, so an unset
 * choice — or a DB that predates the column — never overrides the local theme.
 */
async function readTheme(userId: string): Promise<Theme | null> {
  try {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { themePreference: true } });
    return row?.themePreference === "light" || row?.themePreference === "dark" ? row.themePreference : null;
  } catch {
    return null; // column not pushed yet — never break /me
  }
}

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const [org, themePreference] = await Promise.all([
      req.user!.organizationId
        ? prisma.organization.findUnique({
            where: { id: req.user!.organizationId },
            select: { id: true, name: true, teamId: true, fullLogo: true, compactLogo: true },
          })
        : Promise.resolve(null),
      readTheme(req.user!.id),
    ]);
    res.json({ user: { ...req.user, organization: org, themePreference } });
  }),
);

// Lightweight per-user preferences (theme today). No password step-up — this is
// a low-risk personalization, unlike the identity fields in PATCH /me. Best
// effort: if the column hasn't been pushed yet, report persisted:false so the
// client keeps its local copy instead of erroring.
authRouter.patch(
  "/preferences",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { theme } = z.object({ theme: z.enum(THEMES) }).parse(req.body);
    let persisted = true;
    try {
      await prisma.user.update({ where: { id: req.user!.id }, data: { themePreference: theme } });
    } catch {
      persisted = false;
    }
    res.json({ theme, persisted });
  }),
);

// Join an organization from account settings (existing user).
authRouter.post(
  "/join",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.body);
    const join = await resolveJoinToken(token);
    if (join.organizationId === req.user!.organizationId) {
      throw new HttpError(400, "You are already a member of this organization");
    }
    await prisma.$transaction(async (tx) => {
      await consumeInvite(join.inviteCodeId, tx);
      await tx.user.update({
        where: { id: req.user!.id },
        data: { organizationId: join.organizationId, orgRole: "MEMBER" },
      });
    });
    const org = await prisma.organization.findUnique({
      where: { id: join.organizationId },
      select: { id: true, name: true, teamId: true },
    });
    res.json({ organization: org, orgRole: "MEMBER" });
  }),
);

// Self-service account update (Settings page). All fields required.
const accountSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  phone: z.string().trim().min(1, "Phone number is required").transform(normalizePhone),
  email: z.string().email(),
  /** CURRENT password — identity confirmation only. Changing the password goes
   *  exclusively through POST /auth/change-password (verifies old, sets new).
   *  This endpoint must never overwrite the hash: silently re-hashing whatever
   *  was typed here turned typos into surprise password changes. */
  password: z.string().min(1, "Your current password is required to save changes"),
});

authRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = accountSchema.parse(req.body);
    const email = data.email.toLowerCase();

    // Verify identity with the CURRENT password before touching the profile.
    const existing = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!existing) throw new HttpError(404, "Account not found");
    if (!(await verifyPassword(data.password, existing.passwordHash))) {
      throw new HttpError(403, "Your current password is incorrect. (To change your password, use the Change Password section.)");
    }

    const clash = await prisma.user.findFirst({ where: { email, NOT: { id: req.user!.id } } });
    if (clash) throw new HttpError(409, "Another account already uses that email");

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        email,
        name: `${data.firstName} ${data.lastName}`,
        // NOTE: no passwordHash here — profile saves never change the password.
      },
      select: { id: true, name: true, email: true, role: true, firstName: true, lastName: true, phone: true },
    });
    res.json({ user });
  }),
);

// Self-service password change: verify the current password, then set a new one.
// Clears any mustChangePassword flag (used after an owner-issued reset).
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

authRouter.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new HttpError(404, "Account not found");
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new HttpError(400, "Your current password is incorrect");
    }
    // Bumping sessionEpoch strands every token issued before this moment — the
    // whole point of changing a password after a suspected compromise. That
    // includes the caller's own token, so re-issue one for them: they stay
    // signed in on THIS device while every other session is evicted.
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        sessionEpoch: { increment: 1 },
      },
    });
    res.json({ ok: true, ...issueSession(res, updated) });
  }),
);

// ===========================================================================
// Password reset (forgot → emailed link → reset)
// ===========================================================================

const RESET_TTL_MS = env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const forgotLimiter = rateLimit({
  windowMs: LOGIN_RATE_LIMIT.WINDOW_MS,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many reset requests. Try again later." },
});

authRouter.post(
  "/password/forgot",
  forgotLimiter,
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Always respond 200 with the same shape — never reveal whether the email exists.
    const response: { ok: true; devResetUrl?: string } = { ok: true };

    if (user && user.status === "ACTIVE") {
      const rawToken = crypto.randomBytes(32).toString("base64url");
      await prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: sha256(rawToken), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
      });
      const resetUrl = `${env.APP_URL}/reset-password?token=${rawToken}`;

      // An org-connected Resend integration can deliver even when no
      // instance-wide transport (Resend env / SMTP) is configured.
      if (emailConfigured() || user.organizationId) {
        await sendEmail({
          organizationId: user.organizationId ?? undefined,
          to: user.email,
          subject: "Reset your Mineral Hub password",
          html: `<p>Hi ${escapeHtml(user.firstName ?? user.name)},</p>
<p>We received a request to reset your Mineral Hub password. This link expires in ${env.PASSWORD_RESET_TTL_MINUTES} minutes:</p>
<p><a href="${resetUrl}">Reset your password</a></p>
<p>If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
        }).catch((e) => { console.error("Password reset email failed:", e instanceof Error ? e.message : e); });
      } else if (!isProd) {
        // Dev convenience: no SMTP configured, so hand the link back directly.
        response.devResetUrl = resetUrl;
        console.log(`[password reset] ${user.email} → ${resetUrl}`);
      }
    }

    res.json(response);
  }),
);

authRouter.post(
  "/password/reset",
  asyncHandler(async (req, res) => {
    const { token, password } = z
      .object({ token: z.string().min(1), password: z.string().min(8, "Password must be at least 8 characters") })
      .parse(req.body);

    const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new HttpError(400, "This reset link is invalid or has expired. Request a new one.");
    }
    await prisma.$transaction([
      // sessionEpoch bump evicts every existing session: someone resetting a
      // forgotten password is exactly the case where an attacker may be holding
      // a live token. No re-issue here — the user signs in fresh afterwards.
      prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash: await hashPassword(password), sessionEpoch: { increment: 1 } },
      }),
      prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      // Invalidate any other outstanding tokens for this user.
      prisma.passwordResetToken.updateMany({
        where: { userId: row.userId, usedAt: null, id: { not: row.id } },
        data: { usedAt: new Date() },
      }),
    ]);
    res.json({ ok: true });
  }),
);

// ===========================================================================
// Two-factor authentication (TOTP)
// ===========================================================================

authRouter.get(
  "/2fa/status",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { totpEnabled: true, totpRecoveryCodes: true } });
    res.json({ enabled: user?.totpEnabled ?? false, recoveryCodesRemaining: user?.totpRecoveryCodes.length ?? 0 });
  }),
);

// Begin enrollment: generate a secret and return the provisioning URI. Not yet
// active — the user must confirm a code via /2fa/enable.
authRouter.post(
  "/2fa/setup",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { email: true, totpEnabled: true } });
    if (user?.totpEnabled) throw new HttpError(400, "Two-factor authentication is already enabled. Disable it first to re-enroll.");
    const secret = generateSecret();
    await prisma.user.update({ where: { id: req.user!.id }, data: { totpSecret: sealTotpSecret(secret) } });
    res.json({ secret, otpauthUri: otpauthUri(secret, user!.email, "Mineral Hub") });
  }),
);

// Confirm the first code and turn 2FA on; returns one-time recovery codes.
authRouter.post(
  "/2fa/enable",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { code } = z.object({ code: z.string().trim().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { totpSecret: true, totpEnabled: true } });
    if (user?.totpEnabled) throw new HttpError(400, "Two-factor authentication is already enabled.");
    if (!user?.totpSecret) throw new HttpError(400, "Start setup first (no pending secret).");
    if (!verifyTotp(revealTotpSecret(user.totpSecret), code)) throw new HttpError(400, "That code is incorrect or expired. Try the current code from your authenticator app.");

    const { codes, hashes } = generateRecoveryCodes();
    await prisma.user.update({ where: { id: req.user!.id }, data: { totpEnabled: true, totpRecoveryCodes: hashes } });
    res.json({ enabled: true, recoveryCodes: codes });
  }),
);

// Turn 2FA off (requires a current code or a recovery code to prove possession).
authRouter.post(
  "/2fa/disable",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { code } = z.object({ code: z.string().trim().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, totpSecret: true, totpEnabled: true, totpRecoveryCodes: true } });
    if (!user?.totpEnabled) throw new HttpError(400, "Two-factor authentication is not enabled.");
    const ok = await verifySecondFactor(user, code);
    if (!ok) throw new HttpError(400, "Verification failed. Enter a current code or a recovery code.");
    await prisma.user.update({ where: { id: req.user!.id }, data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: [] } });
    res.json({ enabled: false });
  }),
);

// Regenerate recovery codes (invalidates the old set).
authRouter.post(
  "/2fa/recovery-codes",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { code } = z.object({ code: z.string().trim().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, totpSecret: true, totpEnabled: true, totpRecoveryCodes: true } });
    if (!user?.totpEnabled) throw new HttpError(400, "Two-factor authentication is not enabled.");
    if (!user.totpSecret || !verifyTotp(revealTotpSecret(user.totpSecret), code)) throw new HttpError(400, "Enter a current code from your authenticator app.");
    const { codes, hashes } = generateRecoveryCodes();
    await prisma.user.update({ where: { id: req.user!.id }, data: { totpRecoveryCodes: hashes } });
    res.json({ recoveryCodes: codes });
  }),
);

// ===========================================================================
// OAuth / SSO (Google, Microsoft)
// ===========================================================================

/** Providers with credentials configured — the client renders a button per entry.
 *  Also carries the signup policy so the login page can require an invite code. */
authRouter.get("/oauth/providers", (_req, res) => {
  res.json({ providers: enabledProviders(), publicSignup: env.ALLOW_PUBLIC_SIGNUP });
});

// Step 1: redirect the browser to the provider's consent screen. A signed,
// short-lived state token guards against CSRF and pins the join token (if any).
authRouter.get(
  "/oauth/:provider/start",
  asyncHandler(async (req, res) => {
    const provider = getProvider(req.params.provider);
    if (!provider) throw new HttpError(404, "That sign-in provider isn't configured.");
    const joinToken = typeof req.query.joinToken === "string" ? req.query.joinToken : undefined;
    const state = jwt.sign({ p: provider.key, joinToken }, env.JWT_SECRET, { expiresIn: "10m" });
    res.redirect(buildAuthorizeUrl(provider, state));
  }),
);

// Step 2: provider redirects back here with a code. Exchange it, resolve/create
// the user, then bounce to the SPA with a session token in the URL fragment.
authRouter.get(
  "/oauth/:provider/callback",
  asyncHandler(async (req, res) => {
    const fail = (msg: string) => res.redirect(`${env.APP_URL}/login?oauthError=${encodeURIComponent(msg)}`);
    const provider = getProvider(req.params.provider);
    if (!provider) return fail("Sign-in provider not configured");
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (req.query.error) return fail(String(req.query.error));
    if (!code || !state) return fail("Missing authorization code");

    let joinToken: string | undefined;
    try {
      const decoded = jwt.verify(state, env.JWT_SECRET) as { p: string; joinToken?: string };
      if (decoded.p !== provider.key) return fail("Invalid sign-in state");
      joinToken = decoded.joinToken;
    } catch {
      return fail("Sign-in session expired, please try again");
    }

    let profile;
    try {
      const accessToken = await exchangeCode(provider, code);
      profile = await fetchProfile(provider, accessToken);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "Sign-in failed");
    }
    if (!profile.email || !profile.emailVerified) return fail("Your provider account has no verified email");

    // Resolve the user: existing OAuth link → existing email → brand-new account.
    const linked = await prisma.oAuthAccount.findUnique({
      where: { provider_providerAccountId: { provider: provider.key, providerAccountId: profile.providerAccountId } },
      include: { user: true },
    });
    let user = linked?.user ?? null;

    if (!user) {
      const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
      if (byEmail) {
        user = byEmail;
        await prisma.oAuthAccount.create({ data: { userId: byEmail.id, provider: provider.key, providerAccountId: profile.providerAccountId, email: profile.email } });
      } else {
        const join = joinToken ? await resolveJoinToken(joinToken).catch(() => null) : null;
        // Same invite-only policy as /register: SSO must not be a side door for
        // self-provisioning a brand-new workspace.
        if (!join && !env.ALLOW_PUBLIC_SIGNUP) {
          return fail("Sign-up requires a Team ID or invite code. Enter your code under Create an account, or ask your administrator for an invite.");
        }
        user = await prisma.$transaction(async (tx) => {
          let organizationId: string;
          let orgRole: "OWNER" | "MEMBER";
          if (join) {
            organizationId = join.organizationId;
            orgRole = "MEMBER";
            await consumeInvite(join.inviteCodeId, tx);
          } else {
            const org = await createOrganization(`${profile.name ?? profile.email}'s Workspace`, tx);
            organizationId = org.id;
            orgRole = "OWNER";
          }
          const created = await tx.user.create({
            data: {
              name: profile.name ?? profile.email!,
              email: profile.email!,
              // No password login for SSO-provisioned accounts until they set one via reset.
              passwordHash: await hashPassword(crypto.randomBytes(32).toString("hex")),
              // Same rule as /register: the legacy account role is OWNER only
              // for workspace creators. SSO must not be a side door that hands
              // an invite-code joiner the elevated legacy role.
              role: join ? "ASSOCIATE" : "OWNER",
              organizationId,
              orgRole,
            },
          });
          await tx.oAuthAccount.create({ data: { userId: created.id, provider: provider.key, providerAccountId: profile.providerAccountId, email: profile.email } });
          return created;
        });
      }
    }

    if (user.status !== "ACTIVE") return fail("This account is not active");

    // SSO satisfies primary auth; if the user also has TOTP on, they still
    // complete it — issue a short-lived pre-auth token the SPA exchanges.
    if (user.totpEnabled) {
      const pre = jwt.sign({ uid: user.id, twofa: true }, env.JWT_SECRET, { expiresIn: "5m" });
      return res.redirect(`${env.APP_URL}/auth/callback#twofa=${pre}`);
    }
    const { token } = issueSession(res, user);
    res.redirect(`${env.APP_URL}/auth/callback#token=${token}`);
  }),
);

// Complete an OAuth login that required a second factor.
authRouter.post(
  "/oauth/2fa",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { preAuthToken, totpCode } = z.object({ preAuthToken: z.string().min(1), totpCode: z.string().trim().min(1) }).parse(req.body);
    let uid: string;
    try {
      const decoded = jwt.verify(preAuthToken, env.JWT_SECRET) as { uid: string; twofa?: boolean };
      if (!decoded.twofa || !decoded.uid) throw new Error("bad token");
      uid = decoded.uid;
    } catch {
      throw new HttpError(401, "Your sign-in session expired. Please sign in again.");
    }
    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user || user.status !== "ACTIVE" || !user.totpEnabled) throw new HttpError(401, "Sign-in failed.");
    const ok = await verifySecondFactor(user, totpCode);
    if (!ok) throw new HttpError(401, "Invalid verification code");
    res.json(issueSession(res, user));
  }),
);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
