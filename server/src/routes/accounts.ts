/**
 * Personal connected accounts — Outlook mail, OneDrive, Google Drive
 * (services/connected/). Every route acts on the CALLER's own accounts only:
 * an id that isn't theirs is a 404, and connecting/using a provider requires
 * the CRM permission its features need (Outlook → sendEmail, drives →
 * manageDocuments), checked here on every request — not just in the UI.
 *
 * Admins (manageApiIntegrations) additionally get GET /team (who has
 * connected what — never mailbox or drive contents) and can disconnect a
 * member's account (offboarding, a lost device).
 *
 * The provider redirects back to the shared public callback
 * (routes/integrations.ts → integrationsOAuthCallbackRouter), which forwards
 * code + state to the SPA in the URL fragment; the SPA then finishes through
 * POST /:provider/oauth/complete here, as the same signed-in member.
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { hasPermission, orgId, requireAuth, requireOrg, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { demoReadOnly, forbidDemo } from "../middleware/demo.js";
import { ACCOUNT_PROVIDER_DEFS, ACCOUNT_PROVIDERS, accountProviderConfigured, isAccountProvider, type AccountProvider } from "../services/connected/providers.js";
import { buildAccountAuthorizeUrl, verifyAccountState, TokenError } from "../services/connected/oauth.js";
import { connectAccount, disconnectAccount, loadOwnAccount, serializeAccount } from "../services/connected/accounts.js";
import { syncAccount } from "../services/connected/sync.js";
import { ProviderError } from "../services/connected/client.js";

export const accountsRouter = Router();
accountsRouter.use(requireAuth, requireOrg, demoReadOnly());

// Connecting, syncing and disconnecting call out to Microsoft/Google — keyed on
// the member, so one session can't hammer the providers (or the token endpoint).
const actionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user?.id ?? req.ip ?? "unknown",
  message: { error: "Too many account actions. Try again in a few minutes." },
});
accountsRouter.use((req, res, next) => (req.method === "GET" ? next() : actionLimiter(req, res, next)));

function requireProvider(key: string): AccountProvider {
  if (!isAccountProvider(key)) throw new HttpError(404, "Unknown provider.");
  return key;
}

function assertMayUse(req: AuthedRequest, provider: AccountProvider): void {
  const def = ACCOUNT_PROVIDER_DEFS[provider];
  if (!hasPermission(req, def.permission)) {
    throw new HttpError(403, `Your role doesn't include ${def.permission === "sendEmail" ? "sending email" : "managing documents"}, which ${def.name} needs.`);
  }
}

/** The caller's providers (configured / allowed) and their own accounts. */
accountsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.connectedAccount.findMany({
      where: { organizationId: orgId(req), userId: req.user!.id },
      orderBy: [{ provider: "asc" }, { connectedAt: "asc" }],
    });
    // The pre-2026-11 company-wide connections (one per org) — still doing
    // their old job until members connect their own (shown as "reconnect").
    const legacy = await prisma.integration.findMany({
      where: { organizationId: orgId(req), provider: { in: [...ACCOUNT_PROVIDERS] }, status: "CONNECTED" },
      select: { provider: true, connectedAt: true },
    });
    res.json({
      providers: ACCOUNT_PROVIDERS.map((key) => ({
        key,
        name: ACCOUNT_PROVIDER_DEFS[key].name,
        configured: accountProviderConfigured(key),
        allowed: hasPermission(req, ACCOUNT_PROVIDER_DEFS[key].permission),
        legacyConnectedAt: legacy.find((l) => l.provider === key)?.connectedAt ?? null,
      })),
      // Disconnected accounts are history, not connections — listed only so a
      // member can see what they had (and reconnect it in place).
      accounts: rows.map(serializeAccount),
    });
  }),
);

/** Admin view: which members have connected which accounts. No contents. */
accountsRouter.get(
  "/team",
  requirePermission("manageApiIntegrations"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.connectedAccount.findMany({
      where: { organizationId: orgId(req), status: { not: "DISCONNECTED" } },
      include: { user: { select: { id: true, name: true, avatarColor: true } } },
      orderBy: [{ provider: "asc" }, { connectedAt: "asc" }],
    });
    res.json(rows.map((a) => ({ ...serializeAccount(a), owner: a.user })));
  }),
);

/** Admin: disconnect a member's account (e.g. offboarding). */
accountsRouter.post(
  "/team/:id/disconnect",
  requirePermission("manageApiIntegrations"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await prisma.connectedAccount.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!a) throw new HttpError(404, "Connected account not found.");
    const row = await disconnectAccount(a, req.user!.id, `disconnected by ${req.user!.name}`);
    res.json(serializeAccount(row));
  }),
);

/** Begin connecting: the provider sign-in URL the browser navigates to. */
accountsRouter.get(
  "/:provider/oauth/start",
  // A GET (so demoReadOnly lets it through), but it begins a connection.
  forbidDemo(),
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = requireProvider(req.params.provider);
    assertMayUse(req, provider);
    if (!accountProviderConfigured(provider)) {
      throw new HttpError(400, `${ACCOUNT_PROVIDER_DEFS[provider].name} isn't set up on the server yet (its app registration keys are missing).`);
    }
    res.json({ url: buildAccountAuthorizeUrl(provider, orgId(req), req.user!.id) });
  }),
);

/** Finish connecting — only as the same signed-in member who started it. */
accountsRouter.post(
  "/:provider/oauth/complete",
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = requireProvider(req.params.provider);
    const { code, state: token } = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(4096) }).parse(req.body);
    let state: ReturnType<typeof verifyAccountState>;
    try {
      state = verifyAccountState(token);
    } catch {
      throw new HttpError(400, "That sign-in link expired or was altered. Start the connection again.");
    }
    if (state.provider !== provider) throw new HttpError(400, "Provider mismatch in the sign-in response.");
    if (state.userId !== req.user!.id || state.orgId !== req.user!.organizationId) {
      throw new HttpError(403, "This sign-in was started by a different user. Start the connection again from your own account.");
    }
    assertMayUse(req, provider);
    try {
      const { account, reconnected, missing } = await connectAccount({ orgId: state.orgId, userId: state.userId, provider, code, verifier: state.verifier });
      // First sync in the background so the card fills in without waiting.
      if (account.status === "CONNECTED") void syncAccount(account, { manual: true }).catch(() => {});
      res.json({
        account: serializeAccount(account),
        message: missing.length
          ? `${ACCOUNT_PROVIDER_DEFS[provider].name} connected without every permission it needs. Reconnect and accept all of them.`
          : `${ACCOUNT_PROVIDER_DEFS[provider].name} ${reconnected ? "reconnected" : "connected"} (${account.email ?? "account"}).`,
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      console.warn(`[accounts] ${provider} connect failed: ${e instanceof TokenError ? e.message : e instanceof Error ? e.message : e}`);
      throw new HttpError(502, `Couldn't finish connecting ${ACCOUNT_PROVIDER_DEFS[provider].name}. Try again.`);
    }
  }),
);

accountsRouter.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await loadOwnAccount(orgId(req), req.user!.id, req.params.id);
    const { autoLinkEmail } = z.object({ autoLinkEmail: z.boolean() }).parse(req.body);
    const row = await prisma.connectedAccount.update({ where: { id: a.id }, data: { autoLinkEmail } });
    res.json(serializeAccount(row));
  }),
);

/** Sync now. */
accountsRouter.post(
  "/:id/sync",
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await loadOwnAccount(orgId(req), req.user!.id, req.params.id);
    assertMayUse(req, a.provider as AccountProvider);
    const result = await syncAccount(a, { manual: true });
    const row = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: a.id } });
    res.json({ ...result, account: serializeAccount(row) });
  }),
);

accountsRouter.post(
  "/:id/disconnect",
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await loadOwnAccount(orgId(req), req.user!.id, req.params.id);
    if (a.status === "DISCONNECTED") return res.json(serializeAccount(a));
    try {
      const row = await disconnectAccount(a, req.user!.id);
      res.json(serializeAccount(row));
    } catch (e) {
      if (e instanceof ProviderError) throw new HttpError(e.httpStatus, e.message);
      throw e;
    }
  }),
);
