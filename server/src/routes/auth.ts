import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPassword, hashPassword } from "../auth/password.js";
import { signSession, setSessionCookie, clearSessionCookie } from "../auth/session.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { LOGIN_RATE_LIMIT } from "../config.js";
import { createOrganization, resolveJoinToken, consumeInvite } from "../services/org.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: LOGIN_RATE_LIMIT.WINDOW_MS,
  max: LOGIN_RATE_LIMIT.MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
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

    const token = signSession({ userId: user.id, role: user.role });
    setSessionCookie(res, token);
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
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
  phone: z.string().trim().min(1, "Phone number is required"),
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
          role: "OWNER",
          organizationId,
          orgRole,
        },
      });
    });

    const token = signSession({ userId: user.id, role: user.role });
    setSessionCookie(res, token);
    res.status(201).json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, orgRole: user.orgRole },
    });
  }),
);

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = req.user!.organizationId
      ? await prisma.organization.findUnique({
          where: { id: req.user!.organizationId },
          select: { id: true, name: true, teamId: true },
        })
      : null;
    res.json({ user: { ...req.user, organization: org } });
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
  phone: z.string().trim().min(1, "Phone number is required"),
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

authRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = accountSchema.parse(req.body);
    const email = data.email.toLowerCase();
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
        passwordHash: await hashPassword(data.password),
      },
      select: { id: true, name: true, email: true, role: true, firstName: true, lastName: true, phone: true },
    });
    res.json({ user });
  }),
);
