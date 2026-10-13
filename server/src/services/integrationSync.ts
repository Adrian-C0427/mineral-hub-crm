/**
 * Integration synchronization — shared by the manual "Sync now" route and the
 * in-process scheduler. A sync re-validates the connection with the provider
 * (the meaningful health check for credential-based integrations today) and
 * stamps lastSyncAt / lastError, flipping status CONNECTED ⇄ ERROR so the UI
 * and audit trail reflect reality. Provider-specific data pulls can layer on
 * top of this hook without changing the framework.
 *
 * Scheduler: a lightweight setInterval loop (Railway runs one long-lived
 * container, so in-process scheduling needs no extra infrastructure). Every
 * tick finds CONNECTED integrations whose config.schedule ("hourly"/"daily")
 * is due by lastSyncAt and syncs them. Failures never throw out of the tick.
 *
 * HighLevel has its own cadence (services/highlevel/scheduler.ts) but rides
 * THIS tick for its 15-minute live sync, reusing the rows the tick already
 * loaded: production's database (Neon free plan) suspends after 5 idle
 * minutes and caps compute hours, so a separate, shorter HighLevel interval
 * would keep it awake around the clock.
 */
import type { Integration } from "@prisma/client";
import { prisma } from "../db.js";
import { logActivity } from "./activityLog.js";
import { providerByKey } from "../domain/integrationCatalog.js";
import { decryptSecret } from "./secrets.js";
import { validateSecret, validateEnvProvider, type ValidationResult } from "./integrationProviders.js";
import { isOAuthProvider, getFreshAccessToken } from "./integrationOAuth.js";
import { isInboundEmailProvider, syncInboundEmail } from "./emailInboundSync.js";
import { refreshResendDomains } from "./resend.js";
import { syncOutlookCalendar } from "./outlookCalendarSync.js";
import { checkHighLevel, runHighLevelSync, HIGHLEVEL } from "./highlevel/sync.js";
import { highLevelTick, ensureImportLoop, MANUAL_BUDGET_MS } from "./highlevel/scheduler.js";
import { env } from "../config.js";

export interface IntegrationConfig {
  schedule?: "manual" | "hourly" | "daily";
  notes?: string;
  /** Encrypted credential (AES-256-GCM) — never serialized to clients. */
  _secret?: string;
  /** Masked display hint ("…1234"). */
  _hint?: string;
}

export const configOf = (row: Integration): IntegrationConfig =>
  ((row.config ?? {}) as IntegrationConfig);

/** Validate the integration's credentials/config against the provider. */
export async function checkIntegration(row: Integration): Promise<ValidationResult> {
  const def = providerByKey(row.provider);
  if (!def) return { ok: false, message: "Unknown provider." };
  if (def.implementation === "env") return validateEnvProvider(row.provider);
  if (row.provider === HIGHLEVEL) return checkHighLevel(row);
  // OAuth: "valid" = we can obtain a fresh access token (refreshing if needed).
  if (isOAuthProvider(row.provider)) {
    try {
      await getFreshAccessToken(row);
      return { ok: true, message: `${def.name} authorization is valid.` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "OAuth token check failed." };
    }
  }
  const cfg = configOf(row);
  if (!cfg._secret) return { ok: false, message: "No credential stored. Reconnect this integration." };
  let secret: string;
  try {
    secret = decryptSecret(cfg._secret);
  } catch {
    return { ok: false, message: "Stored credential could not be decrypted (encryption key changed?). Reconnect this integration." };
  }
  return validateSecret(row.provider, secret);
}

/** Run a sync: validate, stamp lastSyncAt/lastError/status, audit-log the outcome. */
export async function syncIntegration(row: Integration, actorUserId?: string | null): Promise<ValidationResult> {
  // HighLevel: "Sync now" is one bounded sync run, which does its own
  // status / lastSyncAt / lastError bookkeeping.
  if (row.provider === HIGHLEVEL) {
    const r = await runHighLevelSync(row, { budgetMs: MANUAL_BUDGET_MS, reason: "manual" });
    if (r.ok && r.phase === "importing") ensureImportLoop(row.organizationId);
    if (!r.skipped) {
      await logActivity({
        eventType: r.ok ? "integration.synced" : "integration.sync_failed",
        summary: r.ok ? "Integration highlevel synchronized" : `Integration highlevel sync failed: ${r.message}`,
        organizationId: row.organizationId,
        actorUserId: actorUserId ?? null,
      });
    }
    return { ok: r.ok, message: r.message };
  }
  let result = await checkIntegration(row);
  // Data pulls layered on the health check — each provider's real work:
  if (result.ok && isInboundEmailProvider(row.provider)) {
    // Connected mailboxes import inbound buyer replies (EMAIL_IN + notification).
    try {
      const r = await syncInboundEmail(row);
      result = { ok: true, message: `${result.message} Scanned ${r.fetched} new message(s); logged ${r.matched} buyer repl${r.matched === 1 ? "y" : "ies"}.` };
    } catch (e) {
      // Token is valid but the mailbox pull failed (commonly: connected before
      // the read scope existed). Surface it as an error so the UI says why.
      result = { ok: false, message: `Mailbox sync failed: ${e instanceof Error ? e.message : "unknown error"}. If this account was connected before inbound sync existed, disconnect and reconnect to grant read access.` };
    }
  }
  if (result.ok && row.provider === "outlookcalendar") {
    // Mirror deal deadlines onto the connected calendar.
    try {
      const r = await syncOutlookCalendar(row, env.APP_URL);
      result = { ok: true, message: `${result.message} Calendar events: ${r.created} created, ${r.updated} updated, ${r.removed} removed.` };
    } catch (e) {
      result = { ok: false, message: `Calendar sync failed: ${e instanceof Error ? e.message : "unknown error"}` };
    }
  }
  let keepWarning: string | null = null;
  if (result.ok && row.provider === "resend") {
    // Refresh the domain-verification snapshot shown on the card.
    try {
      const r = await refreshResendDomains(row);
      keepWarning = r.warning; // survives the success stamp below
      result = { ok: true, message: `${result.message} ${r.summary}${r.warning ? ` Warning: ${r.warning}` : ""}` };
    } catch (e) {
      result = { ok: false, message: `Domain status refresh failed: ${e instanceof Error ? e.message : "unknown error"}` };
    }
  }
  await prisma.integration.update({
    where: { id: row.id },
    data: result.ok
      ? { lastSyncAt: new Date(), lastError: keepWarning, status: "CONNECTED" }
      : { lastError: result.message, status: "ERROR" },
  });
  await logActivity({
    eventType: result.ok ? "integration.synced" : "integration.sync_failed",
    summary: result.ok
      ? `Integration ${row.provider} synchronized`
      : `Integration ${row.provider} sync failed: ${result.message}`,
    organizationId: row.organizationId,
    actorUserId: actorUserId ?? null,
  });
  return result;
}

const TICK_MS = 15 * 60 * 1000;
const DUE_MS: Record<string, number> = { hourly: 60 * 60 * 1000, daily: 24 * 60 * 60 * 1000 };

async function tick(): Promise<void> {
  // HighLevel rows in ERROR are included so a transient outage recovers by itself.
  const rows = await prisma.integration.findMany({
    where: { OR: [{ status: "CONNECTED" }, { provider: HIGHLEVEL, status: "ERROR" }] },
  });
  const now = Date.now();
  for (const row of rows) {
    // HighLevel never uses config.schedule — it is synced below, from this same tick.
    if (row.provider === HIGHLEVEL || row.status !== "CONNECTED") continue;
    const schedule = configOf(row).schedule;
    const interval = schedule ? DUE_MS[schedule] : undefined;
    if (!interval) continue; // manual (or unset) — only synced on demand
    const last = row.lastSyncAt?.getTime() ?? 0;
    if (now - last < interval) continue;
    try {
      await syncIntegration(row);
    } catch (e) {
      console.error(`Integration sync tick failed for ${row.provider}:`, e instanceof Error ? e.message : e);
    }
  }
  await highLevelTick(rows.filter((r) => r.provider === HIGHLEVEL));
}

/** Start the background scheduler (call once at boot; no-op in tests). */
export function startIntegrationScheduler(): void {
  if (process.env.NODE_ENV === "test") return;
  setInterval(() => void tick().catch(() => {}), TICK_MS).unref();
}
