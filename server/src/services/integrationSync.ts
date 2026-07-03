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
 */
import type { Integration } from "@prisma/client";
import { prisma } from "../db.js";
import { logActivity } from "./activityLog.js";
import { providerByKey } from "../domain/integrationCatalog.js";
import { decryptSecret } from "./secrets.js";
import { validateSecret, validateEnvProvider, type ValidationResult } from "./integrationProviders.js";
import { isOAuthProvider, getFreshAccessToken } from "./integrationOAuth.js";

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
  const result = await checkIntegration(row);
  await prisma.integration.update({
    where: { id: row.id },
    data: result.ok
      ? { lastSyncAt: new Date(), lastError: null, status: "CONNECTED" }
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
  const rows = await prisma.integration.findMany({ where: { status: "CONNECTED" } });
  const now = Date.now();
  for (const row of rows) {
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
}

/** Start the background scheduler (call once at boot; no-op in tests). */
export function startIntegrationScheduler(): void {
  if (process.env.NODE_ENV === "test") return;
  setInterval(() => void tick().catch(() => {}), TICK_MS).unref();
}
