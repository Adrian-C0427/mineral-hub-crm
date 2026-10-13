/**
 * Integrations hub (admin-only). The server owns the catalog
 * (domain/integrationCatalog.ts) and per-org state; the client renders what
 * this router returns and never sees a stored credential — only a masked hint.
 *
 * Security model:
 *  - API keys / webhook URLs are validated against the provider on connect,
 *    then stored AES-256-GCM-encrypted inside the row's config JSON.
 *  - Serialization strips every "_"-prefixed config key.
 *  - Connect, disconnect, config changes, tests, and syncs are audit-logged
 *    to ActivityLog with the acting user.
 *
 * HighLevel (read-only SMS mirror for Reports) connects with a Private
 * Integration key + Location ID and has two extra routes — /highlevel/status
 * and /highlevel/import (services/highlevel/).
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import type { Integration } from "@prisma/client";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { demoReadOnly } from "../middleware/demo.js";
import { INTEGRATION_CATALOG, providerByKey } from "../domain/integrationCatalog.js";
import { validateSecret, validateEnvProvider, envConfigured } from "../services/integrationProviders.js";
import { encryptSecret, secretHint } from "../services/secrets.js";
import { syncIntegration, checkIntegration, configOf } from "../services/integrationSync.js";
import { isInboundEmailProvider } from "../services/emailInboundSync.js";
import { fetchResendDomains, senderDomainWarning } from "../services/resend.js";
import { logActivity } from "../services/activityLog.js";
import { env } from "../config.js";
import {
  isOAuthProvider, oauthConfigured, buildAuthorizeUrl, signState, verifyState,
  exchangeCode, persistBundle,
} from "../services/integrationOAuth.js";
import { RESPONSE_WINDOW_OPTIONS } from "../domain/smsMetrics.js";
import { HIGHLEVEL, highLevelStatus, validateHighLevelConnection, needsReconnect } from "../services/highlevel/sync.js";
import { readSyncState, responseWindowOf, parseLocationId, type HlSyncState } from "../services/highlevel/mapping.js";
import { ensureImportLoop, kickHighLevelRun } from "../services/highlevel/scheduler.js";

export const integrationsRouter = Router();
integrationsRouter.use(requireAuth, requireOrg, requirePermission("manageApiIntegrations"), demoReadOnly());

// connect/test/sync trigger outbound requests to third parties — cap how fast an
// admin (or a stolen admin session) can fire them. Read routes are unaffected.
const actionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many integration actions. Try again in a few minutes." },
});
integrationsRouter.use((req, res, next) => (req.method === "POST" ? actionLimiter(req, res, next) : next()));

// Internal bookkeeping keys that would only bloat the payload (the calendar
// event map can hold hundreds of entries).
// "domains" is the Resend account's domain-verification snapshot (DKIM/SPF/DNS
// selector detail). It's used server-side to derive senderDomainWarning; the
// client only needs that derived warning, never the raw DNS records — so keep
// it out of the serialized config the API returns.
// "hlSync" / "hlUsers" are the HighLevel sync's bookkeeping (checkpoint, run
// stats) and its user directory — the card reads GET /highlevel/status instead.
const INTERNAL_CONFIG_KEYS = new Set(["eventMap", "inboundCursor", "domains", "hlSync", "hlUsers"]);

function publicConfig(row: Integration | null): Record<string, unknown> {
  const cfg = (row?.config ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith("_") && !INTERNAL_CONFIG_KEYS.has(k)));
}

function serialize(def: (typeof INTEGRATION_CATALOG)[number], row: Integration | null) {
  const cfg = row ? configOf(row) : {};
  // `configured` tells the client whether the provider can be connected at all:
  // env providers need their env vars; oauth providers need client credentials;
  // apikey/webhook are always connectable.
  const configured = def.implementation === "env" ? envConfigured(def.key)
    : def.implementation === "oauth" ? oauthConfigured(def.key)
    : true;
  return {
    ...def,
    // Env-configured providers report their real runtime status; stored rows
    // report connection state.
    status: def.implementation === "env"
      ? (envConfigured(def.key) ? "CONNECTED" : "NOT_CONNECTED")
      : (row?.status ?? "NOT_CONNECTED"),
    configured,
    config: publicConfig(row),
    secretMask: cfg._hint ?? null,
    connectedAt: row?.connectedAt ?? null,
    lastSyncAt: row?.lastSyncAt ?? null,
    lastError: row?.lastError ?? null,
  };
}

async function getRow(req: AuthedRequest, provider: string): Promise<Integration | null> {
  return prisma.integration.findUnique({
    where: { organizationId_provider: { organizationId: orgId(req), provider } },
  });
}

function requireDef(provider: string) {
  const def = providerByKey(provider);
  if (!def) throw new HttpError(404, "Unknown integration provider");
  return def;
}

// Full catalog merged with this org's state.
integrationsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.integration.findMany({ where: { organizationId: orgId(req) } });
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    res.json(INTEGRATION_CATALOG.map((def) => serialize(def, byProvider.get(def.key) ?? null)));
  }),
);

const configSchema = z.object({
  schedule: z.enum(["manual", "hourly", "daily"]).optional(),
  notes: z.string().max(2000).optional(),
  // Sender identity — Resend only (ignored by other providers).
  fromEmail: z.string().trim().email().max(320).optional(),
  fromName: z.string().trim().max(120).optional(),
  // HighLevel only: Location ID (connect) and response window (settings).
  locationId: z.string().trim().max(500).optional(),
  responseWindowDays: z.number().int()
    .refine((v) => (RESPONSE_WINDOW_OPTIONS as readonly number[]).includes(v), "Pick a response window of 7, 14, 30, 60 or 90 days.")
    .optional(),
});

/** Keep only the settings that belong to this provider. */
function configFor(provider: string, config: z.infer<typeof configSchema> | undefined): Record<string, unknown> {
  const c: Record<string, unknown> = { ...(config ?? {}) };
  if (provider === HIGHLEVEL) {
    // HighLevel syncs on its own cadence; its location changes only by reconnecting.
    delete c.schedule; delete c.locationId; delete c.fromEmail; delete c.fromName;
  } else {
    delete c.locationId; delete c.responseWindowDays;
  }
  return c;
}

// --- HighLevel ------------------------------------------------------------------

integrationsRouter.get(
  "/highlevel/status",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await highLevelStatus(orgId(req)));
  }),
);

// Start the first import (the owner has seen the preview count).
integrationsRouter.post(
  "/highlevel/import",
  asyncHandler(async (req: AuthedRequest, res) => {
    const row = await getRow(req, HIGHLEVEL);
    if (!row || row.status === "NOT_CONNECTED") throw new HttpError(400, "Connect HighLevel before importing.");
    if (needsReconnect(row)) throw new HttpError(400, "HighLevel needs a new key before the import can start. Use Replace key.");
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    const state = readSyncState(cfg);
    if (state.phase !== "preview") throw new HttpError(409, "The import has already started.");
    const hlSync: HlSyncState = { ...state, phase: "importing", importStartedAt: new Date().toISOString() };
    await prisma.integration.update({ where: { id: row.id }, data: { config: { ...cfg, hlSync } as never } });
    await logActivity({
      eventType: "integration.import_started",
      summary: `HighLevel import started (about ${(state.preview?.texts ?? 0).toLocaleString("en-US")} texts)`,
      organizationId: orgId(req), actorUserId: req.user?.id ?? null,
    });
    ensureImportLoop(orgId(req));
    res.json(await highLevelStatus(orgId(req)));
  }),
);

/**
 * HighLevel connect: validate the key against the Location (and the scopes
 * the sync needs), then store it with the preview count. Reconnecting to the
 * SAME location keeps the sync state, so nothing is re-imported; a different
 * location is refused while texts from the old one are stored, because the
 * mirror can't tell two accounts' texts apart.
 */
async function connectHighLevel(req: AuthedRequest, secret: string, config: Record<string, unknown>, locationInput: string | undefined) {
  const def = requireDef(HIGHLEVEL);
  const locationId = parseLocationId(locationInput);
  if (!locationId) {
    throw new HttpError(400, "Enter your HighLevel Location ID — letters and numbers, found in HighLevel under Settings → Business Profile, or in the address bar after /location/.");
  }
  const existing = await getRow(req, HIGHLEVEL);
  const prev = (existing?.config ?? {}) as Record<string, unknown>;
  const prevLocation = typeof prev.locationId === "string" ? prev.locationId : null;
  if (prevLocation && prevLocation !== locationId) {
    const held = await prisma.highLevelMessage.findFirst({ where: { organizationId: orgId(req) }, select: { id: true } });
    if (held) {
      const name = typeof prev.locationName === "string" ? `“${prev.locationName}”` : prevLocation;
      throw new HttpError(409, `This workspace already holds texts imported from HighLevel location ${name}. Connecting a different location would mix two accounts in Reports. Reconnect with a key for ${name}, or ask Mineral Hub support to clear the imported texts first.`);
    }
  }

  const check = await validateHighLevelConnection(secret, locationId);
  if (!check.ok) throw new HttpError(400, check.message);

  const now = new Date().toISOString();
  const prevSync = prevLocation === locationId && prev.hlSync ? readSyncState(prev) : null;
  // Same location, import already started: keep the checkpoint and carry on.
  const resumed = !!prevSync && prevSync.phase !== "preview";
  const hlSync: HlSyncState = resumed
    ? { ...prevSync!, consecutiveFailures: 0, pausedUntil: undefined, usersRefreshAt: now }
    : { phase: "preview", preview: { texts: check.texts, at: now }, usersRefreshAt: now, ...(prevSync?.dateParam ? { dateParam: prevSync.dateParam } : {}) };
  delete hlSync.pausedUntil;
  const keep = Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith("_") && k !== "schedule"));
  const cfg = {
    ...keep, ...config,
    locationId, locationName: check.location.name,
    responseWindowDays: responseWindowOf(prev),
    hlUsers: check.users, hlSync,
    _secret: encryptSecret(secret), _hint: secretHint(secret),
  };
  const row = await prisma.integration.upsert({
    where: { organizationId_provider: { organizationId: orgId(req), provider: HIGHLEVEL } },
    create: { organizationId: orgId(req), provider: HIGHLEVEL, status: "CONNECTED", connectedAt: new Date(), lastError: null, config: cfg as never },
    update: { status: "CONNECTED", connectedAt: new Date(), lastError: null, config: cfg as never },
  });
  await logActivity({
    eventType: "integration.connected",
    summary: `Integration ${def.name} connected (${check.location.name})`,
    organizationId: orgId(req), actorUserId: req.user?.id ?? null,
  });
  if (hlSync.phase === "importing") ensureImportLoop(orgId(req));
  const message = resumed
    ? `Reconnected to ${check.location.name}. Syncing picks up where it left off.`
    : `Connected to ${check.location.name}. Found ${check.texts.toLocaleString("en-US")} texts in HighLevel — nothing has been imported yet.`;
  return { ...serialize(def, row), message };
}

const connectSchema = z.object({
  secret: z.string().min(1).max(4096).optional(),
  config: configSchema.optional(),
});

integrationsRouter.post(
  "/:provider/connect",
  asyncHandler(async (req: AuthedRequest, res) => {
    const def = requireDef(req.params.provider);
    const { secret, config } = connectSchema.parse(req.body);

    if (def.implementation === "env") {
      throw new HttpError(400, `${def.name} is configured with environment variables on the API service, not from this page.`);
    }
    if (def.implementation === "oauth") {
      throw new HttpError(400, `${def.name} connects via OAuth. Start the authorization at GET /api/integrations/${def.key}/oauth/start.`);
    }
    if (!secret) throw new HttpError(400, `${def.secretLabel ?? "A credential"} is required to connect ${def.name}.`);
    if (def.key === HIGHLEVEL) return res.json(await connectHighLevel(req, secret.trim(), configFor(def.key, config), config?.locationId));
    if (def.key === "resend" && !config?.fromEmail) {
      throw new HttpError(400, "A sender email address is required to connect Resend — it becomes the From address on every email the app sends.");
    }

    // Validate against the provider BEFORE storing anything.
    const result = await validateSecret(def.key, secret);
    if (!result.ok) throw new HttpError(400, result.message);

    // Resend: snapshot the account's domain verification statuses and check
    // the chosen sender against them, so the card can show exactly why a send
    // would fail before anyone tries one.
    let extra: Record<string, unknown> = {};
    let warning: string | null = null;
    if (def.key === "resend") {
      const domains = await fetchResendDomains(secret).catch(() => []);
      extra = { domains };
      warning = senderDomainWarning(config!.fromEmail!, domains);
    }

    const cfg = { ...configFor(def.key, config), ...extra, _secret: encryptSecret(secret), _hint: secretHint(secret) };
    const row = await prisma.integration.upsert({
      where: { organizationId_provider: { organizationId: orgId(req), provider: def.key } },
      create: {
        organizationId: orgId(req), provider: def.key, status: "CONNECTED", connectedAt: new Date(),
        lastSyncAt: new Date(), lastError: warning, config: cfg,
      },
      update: {
        status: "CONNECTED", connectedAt: new Date(), lastSyncAt: new Date(), lastError: warning, config: cfg,
      },
    });
    await logActivity({
      eventType: "integration.connected",
      summary: `Integration ${def.name} connected`,
      organizationId: orgId(req), actorUserId: req.user?.id ?? null,
    });
    res.json({ ...serialize(def, row), message: warning ? `${result.message} ${warning}` : result.message });
  }),
);

integrationsRouter.post(
  "/:provider/disconnect",
  asyncHandler(async (req: AuthedRequest, res) => {
    const def = requireDef(req.params.provider);
    if (def.implementation === "env") {
      throw new HttpError(400, `${def.name} is controlled by environment variables — remove them from the API service to disable it.`);
    }
    const existing = await getRow(req, def.key);
    // Purge the credential, keep non-secret config for an easy reconnect.
    // HighLevel also keeps its sync state (checkpoint, user names): the synced
    // texts stay for Reports, and reconnecting the same location resumes
    // instead of re-importing. NOT_CONNECTED stops its syncing.
    const kept = def.key === HIGHLEVEL
      ? Object.fromEntries(Object.entries((existing?.config ?? {}) as Record<string, unknown>).filter(([k]) => !k.startsWith("_")))
      : publicConfig(existing);
    const row = await prisma.integration.upsert({
      where: { organizationId_provider: { organizationId: orgId(req), provider: def.key } },
      create: { organizationId: orgId(req), provider: def.key, status: "NOT_CONNECTED" },
      update: { status: "NOT_CONNECTED", connectedAt: null, lastError: null, config: kept as never },
    });
    await logActivity({
      eventType: "integration.disconnected",
      summary: `Integration ${def.name} disconnected`,
      organizationId: orgId(req), actorUserId: req.user?.id ?? null,
    });
    res.json(serialize(def, row));
  }),
);

// Non-secret settings (sync schedule, notes, sender identity). Secrets only
// change via connect.
integrationsRouter.patch(
  "/:provider",
  asyncHandler(async (req: AuthedRequest, res) => {
    const def = requireDef(req.params.provider);
    const { config: parsed } = z.object({ config: configSchema }).parse(req.body);
    const config = configFor(def.key, parsed);
    const existing = await getRow(req, def.key);
    if (!existing) throw new HttpError(404, "Integration not configured");
    const prevCfg = (existing.config ?? {}) as Record<string, unknown>;
    const secretPart = Object.fromEntries(Object.entries(prevCfg).filter(([k]) => k.startsWith("_")));
    if (def.key === "resend" && !config.fromEmail && !prevCfg.fromEmail) {
      throw new HttpError(400, "Resend needs a sender email address.");
    }
    // Preserve non-secret keys the form doesn't send (domain snapshot, cursors).
    const preserved = Object.fromEntries(
      Object.entries(prevCfg).filter(([k]) => !k.startsWith("_") && !(k in config)),
    );
    const nextCfg: Record<string, unknown> = { ...preserved, ...config };
    // A changed Resend sender is re-checked against the stored domain snapshot.
    const warning = def.key === "resend" && typeof nextCfg.fromEmail === "string"
      ? senderDomainWarning(nextCfg.fromEmail, Array.isArray(nextCfg.domains) ? (nextCfg.domains as never) : [])
      : undefined;
    // HighLevel: a new response window changes who counts as "responded" —
    // every stored summary is recomputed by the sync.
    const windowChanged = def.key === HIGHLEVEL && typeof config.responseWindowDays === "number"
      && config.responseWindowDays !== responseWindowOf(prevCfg);
    const row = await prisma.integration.update({
      where: { id: existing.id },
      data: {
        config: { ...nextCfg, ...secretPart } as never,
        ...(warning !== undefined ? { lastError: warning } : {}),
      },
    });
    if (windowChanged) {
      await prisma.highLevelContact.updateMany({ where: { organizationId: orgId(req) }, data: { summaryDirty: true } });
      if (row.status !== "NOT_CONNECTED") kickHighLevelRun(row, "window");
    }
    await logActivity({
      eventType: "integration.config_updated",
      summary: windowChanged
        ? `Integration ${def.name} response window set to ${config.responseWindowDays} days`
        : `Integration ${def.name} settings updated`,
      organizationId: orgId(req), actorUserId: req.user?.id ?? null,
    });
    res.json(serialize(def, row));
  }),
);

// Live connection test — validates against the provider and records the outcome.
integrationsRouter.post(
  "/:provider/test",
  asyncHandler(async (req: AuthedRequest, res) => {
    const def = requireDef(req.params.provider);
    if (def.implementation === "env") {
      const result = await validateEnvProvider(def.key);
      await logActivity({
        eventType: result.ok ? "integration.test_passed" : "integration.test_failed",
        summary: `Integration ${def.name} test ${result.ok ? "passed" : `failed: ${result.message}`}`,
        organizationId: orgId(req), actorUserId: req.user?.id ?? null,
      });
      return res.json(result);
    }
    const row = await getRow(req, def.key);
    if (!row || row.status === "NOT_CONNECTED") {
      return res.json({ ok: false, message: "Connect this integration before testing." });
    }
    const result = await checkIntegration(row);
    await prisma.integration.update({
      where: { id: row.id },
      data: result.ok ? { lastError: null, status: "CONNECTED" } : { lastError: result.message, status: "ERROR" },
    });
    // A passing test clears a HighLevel key error; an interrupted import resumes.
    if (result.ok && def.key === HIGHLEVEL && readSyncState(row.config).phase === "importing") ensureImportLoop(orgId(req));
    await logActivity({
      eventType: result.ok ? "integration.test_passed" : "integration.test_failed",
      summary: `Integration ${def.name} test ${result.ok ? "passed" : `failed: ${result.message}`}`,
      organizationId: orgId(req), actorUserId: req.user?.id ?? null,
    });
    res.json(result);
  }),
);

// Manual synchronization ("Sync now").
integrationsRouter.post(
  "/:provider/sync",
  asyncHandler(async (req: AuthedRequest, res) => {
    const def = requireDef(req.params.provider);
    if (def.implementation === "env") {
      const result = await validateEnvProvider(def.key);
      return res.json(result);
    }
    const row = await getRow(req, def.key);
    if (!row || row.status === "NOT_CONNECTED") {
      return res.json({ ok: false, message: "Connect this integration before syncing." });
    }
    const result = await syncIntegration(row, req.user?.id ?? null);
    res.json(result);
  }),
);

// --- OAuth authorization flow -------------------------------------------------

// Begin authorization: returns the provider URL the browser should navigate to.
// Org/user context rides in a signed, short-lived state token. The provider
// sends the browser back to the public callback below, which hands the code to
// the SPA; the SPA then finishes via the AUTHED /oauth/complete route.
integrationsRouter.get(
  "/:provider/oauth/start",
  asyncHandler(async (req: AuthedRequest, res) => {
    const def = requireDef(req.params.provider);
    if (def.implementation !== "oauth") throw new HttpError(400, `${def.name} does not use OAuth.`);
    if (!oauthConfigured(def.key)) {
      throw new HttpError(400, `${def.name} isn't configured on the server yet (its OAuth client id/secret are unset).`);
    }
    const state = signState({ orgId: orgId(req), userId: req.user!.id, provider: def.key });
    res.json({ url: buildAuthorizeUrl(def.key, state) });
  }),
);

/**
 * Finish an authorization: exchange the code and store the tokens.
 *
 * This used to happen inside the PUBLIC callback, trusting the signed state
 * alone. Nothing tied that state to the person who started the flow, so an
 * admin could send their own authorize link to someone else — anyone who had
 * already consented to the app bounced straight through, and THEIR mailbox or
 * calendar tokens landed on the admin's org row, where the hourly sync reads
 * them. Completing here instead requires a live session that is the SAME user
 * (and org) the state was minted for, still holding manageApiIntegrations
 * (enforced router-wide). A victim who follows a planted link either has no
 * Mineral Hub session or is a different user, and the code is never redeemed.
 */
integrationsRouter.post(
  "/:provider/oauth/complete",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { code, state: stateToken } = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(4096) }).parse(req.body);
    const provider = req.params.provider;
    let state: { orgId: string; userId: string; provider: string };
    try {
      state = verifyState(stateToken);
    } catch {
      throw new HttpError(400, "Authorization link expired or was tampered with. Try connecting again.");
    }
    if (state.provider !== provider || !isOAuthProvider(provider)) {
      throw new HttpError(400, "Provider mismatch in authorization callback.");
    }
    if (!stateMatchesCaller(state, req)) {
      throw new HttpError(403, "This authorization was started by a different user. Start the connection again from your own account.");
    }
    try {
      await completeOAuthConnection(provider, code, state.orgId, state.userId);
    } catch (e) {
      console.warn(`[oauth-complete] ${provider} token exchange failed: ${e instanceof Error ? e.message : e}`);
      throw new HttpError(502, "Could not complete the connection. Please try again.");
    }
    res.json({ connected: provider });
  }),
);

/** Only the user (and org) the state was minted for may redeem it. */
export function stateMatchesCaller(state: { orgId: string; userId: string }, req: AuthedRequest): boolean {
  return !!req.user && state.userId === req.user.id && state.orgId === req.user.organizationId;
}

async function completeOAuthConnection(provider: string, code: string, orgIdForRow: string, userId: string): Promise<void> {
  const bundle = await exchangeCode(provider, code);
  const existing = await prisma.integration.findUnique({
    where: { organizationId_provider: { organizationId: orgIdForRow, provider } },
  });
  const row = existing ?? await prisma.integration.create({
    data: { organizationId: orgIdForRow, provider, status: "NOT_CONNECTED" },
  });
  await persistBundle(row, bundle);
  // Sync-driven integrations get a sensible default schedule so they work
  // without the user knowing to pick one (still changeable): mailboxes
  // hourly (replies should surface fast), calendar daily (deadlines move
  // slowly).
  const defaultSchedule = isInboundEmailProvider(provider) ? "hourly"
    : provider === "outlookcalendar" ? "daily"
    : null;
  if (defaultSchedule) {
    const fresh = await prisma.integration.findUnique({ where: { id: row.id }, select: { config: true } });
    const cfg = (fresh?.config ?? {}) as Record<string, unknown>;
    if (!cfg.schedule) {
      await prisma.integration.update({ where: { id: row.id }, data: { config: { ...cfg, schedule: defaultSchedule } as never } });
    }
  }
  await prisma.integration.update({
    where: { id: row.id },
    data: { status: "CONNECTED", connectedAt: new Date(), lastSyncAt: new Date(), lastError: null },
  });
  const def = providerByKey(provider);
  await logActivity({
    eventType: "integration.connected",
    summary: `Integration ${def?.name ?? provider} connected (OAuth)`,
    organizationId: orgIdForRow, actorUserId: userId,
  });
}

/**
 * Public OAuth callback router — NO session auth (the provider redirects the
 * browser here without our cookie). It does NOT redeem the code: it only
 * sanity-checks the state and forwards code + state to the SPA in the URL
 * FRAGMENT (never sent to servers or leaked via Referer), where the signed-in
 * user finishes through POST /:provider/oauth/complete.
 * Mounted before the authed router so it handles only this exact path.
 */
export const integrationsOAuthCallbackRouter = Router();

// `actionLimiter` above is attached to the AUTHED router and only for POST, so
// this public GET had no throttle at all — the one unauthenticated entry point
// into the integrations surface.
const callbackLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many callback attempts. Try connecting again in a few minutes." },
});

integrationsOAuthCallbackRouter.get(
  "/:provider/oauth/callback",
  callbackLimiter,
  asyncHandler(async (req, res) => {
    const provider = req.params.provider;
    const back = (params: Record<string, string>) =>
      res.redirect(`${env.APP_URL}/settings/integrations?${new URLSearchParams(params).toString()}`);

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const stateToken = typeof req.query.state === "string" ? req.query.state : "";
    // Do NOT reflect the provider's raw `error` into the redirect: it is an
    // attacker- or third-party-controlled string that ends up rendered by the
    // SPA. Log the detail server-side and hand the client a fixed message.
    if (req.query.error) {
      console.warn(`[oauth-callback] ${provider} returned error: ${String(req.query.error).slice(0, 200)}`);
      return back({ error: "The provider declined the connection.", provider });
    }
    if (!code || !stateToken) return back({ error: "Missing authorization code or state.", provider });

    let state: { provider: string };
    try {
      state = verifyState(stateToken);
    } catch {
      return back({ error: "Authorization link expired or was tampered with. Try again.", provider });
    }
    if (state.provider !== provider || !isOAuthProvider(provider)) {
      return back({ error: "Provider mismatch in authorization callback.", provider });
    }
    const frag = new URLSearchParams({ oauth: provider, code, state: stateToken }).toString();
    return res.redirect(`${env.APP_URL}/settings/integrations#${frag}`);
  }),
);
