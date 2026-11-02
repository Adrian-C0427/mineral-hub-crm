/**
 * Background synchronization for connected accounts (server-side, never the
 * browser). One in-process loop (Railway runs a single long-lived API
 * instance) picks accounts that are due and syncs them one at a time:
 *
 *   outlook      every 5 min (Graph change notifications nudge it sooner) —
 *                services/mail/mailSync.ts
 *   onedrive /   every 30 min — refresh linked files' metadata from the
 *   googledrive  provider's change feed (services/cloud/cloudSync.ts)
 *
 * A sync never deletes CRM data: provider-side deletions mark a linked file
 * MISSING; mail sync only adds. Each run first checks the account still
 * belongs to a member of its organization (else it is disconnected), then
 * records the outcome on the row: lastSyncAt (last SUCCESS), syncStatus,
 * lastError.
 */
import type { ConnectedAccount } from "@prisma/client";
import { prisma } from "../../db.js";
import { ProviderError, providerJson } from "./client.js";
import { disconnectMemberAccounts } from "./accounts.js";
import { ACCOUNT_PROVIDER_DEFS, isAccountProvider, type AccountProvider } from "./providers.js";

export type AccountSyncer = (account: ConnectedAccount, opts: { manual: boolean }) => Promise<string | void>;

const syncers: Partial<Record<AccountProvider, AccountSyncer>> = {};

/** Provider modules register the work a sync does (mail, file metadata). */
export function registerAccountSyncer(provider: AccountProvider, fn: AccountSyncer): void {
  syncers[provider] = fn;
}

export const SYNC_INTERVAL_MS: Record<AccountProvider, number> = {
  outlook: 5 * 60_000,
  onedrive: 30 * 60_000,
  googledrive: 30 * 60_000,
};

const running = new Set<string>();

export interface SyncOutcome { ok: boolean; message: string }

/** Confirms the grant still works and refreshes the account's name/address. */
async function checkIdentity(account: ConnectedAccount): Promise<void> {
  const family = ACCOUNT_PROVIDER_DEFS[account.provider as AccountProvider].family;
  const me = family === "google"
    ? await providerJson<{ email?: string; name?: string }>(account, "https://openidconnect.googleapis.com/v1/userinfo")
    : await providerJson<{ mail?: string; userPrincipalName?: string; displayName?: string }>(account, "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName");
  const email = ("email" in me ? me.email : (me as { mail?: string }).mail ?? (me as { userPrincipalName?: string }).userPrincipalName)?.toLowerCase() ?? null;
  const displayName = ("name" in me ? me.name : (me as { displayName?: string }).displayName) ?? null;
  if ((email && email !== account.email) || (displayName && displayName !== account.displayName)) {
    await prisma.connectedAccount.update({ where: { id: account.id }, data: { email: email ?? account.email, displayName: displayName ?? account.displayName } });
  }
}

/** Run one account's sync now. Concurrent calls for the same account share nothing — the second is refused. */
export async function syncAccount(account: ConnectedAccount, opts: { manual: boolean } = { manual: false }): Promise<SyncOutcome> {
  if (!isAccountProvider(account.provider)) return { ok: false, message: "Unknown provider." };
  const name = ACCOUNT_PROVIDER_DEFS[account.provider].name;
  if (account.status !== "CONNECTED" || !account.tokens) return { ok: false, message: `${name} needs to be reconnected.` };
  if (running.has(account.id)) return { ok: false, message: `${name} is already syncing.` };

  // The owner must still be a member of the organization the account is in.
  const owner = await prisma.user.findUnique({ where: { id: account.userId }, select: { organizationId: true } });
  if (owner?.organizationId !== account.organizationId) {
    await disconnectMemberAccounts(account.organizationId, account.userId, null);
    return { ok: false, message: `${name} was disconnected: its owner is no longer in this organization.` };
  }

  running.add(account.id);
  const startedAt = new Date();
  await prisma.connectedAccount.update({ where: { id: account.id }, data: { syncStatus: "SYNCING", lastSyncAttemptAt: startedAt } });
  try {
    await checkIdentity(account);
    const summary = await syncers[account.provider]?.(account, opts);
    await prisma.connectedAccount.update({
      where: { id: account.id },
      data: { syncStatus: "IDLE", lastSyncAt: new Date(), lastError: null },
    });
    return { ok: true, message: summary || `${name} is up to date.` };
  } catch (e) {
    const message = e instanceof ProviderError ? e.message : `${name} sync failed. It will be retried automatically.`;
    if (!(e instanceof ProviderError)) console.warn(`[connected] ${account.provider} sync ${account.id} failed: ${e instanceof Error ? e.message : e}`);
    // markReconnect (inside the client) already set status for a dead grant.
    await prisma.connectedAccount.update({ where: { id: account.id }, data: { syncStatus: "ERROR", lastError: message } }).catch(() => {});
    return { ok: false, message };
  } finally {
    running.delete(account.id);
  }
}

const TICK_MS = 60_000;
const PER_TICK = 10;

async function tick(): Promise<void> {
  const now = Date.now();
  const rows = await prisma.connectedAccount.findMany({
    where: { status: "CONNECTED", tokens: { not: null } },
    orderBy: { lastSyncAttemptAt: { sort: "asc", nulls: "first" } },
    take: 200,
  });
  let ran = 0;
  for (const a of rows) {
    if (ran >= PER_TICK) break;
    if (!isAccountProvider(a.provider) || running.has(a.id)) continue;
    const due = !a.lastSyncAttemptAt || now - a.lastSyncAttemptAt.getTime() >= SYNC_INTERVAL_MS[a.provider];
    if (!due) continue;
    ran++;
    await syncAccount(a);
  }
}

/** A nudge (e.g. a Graph change notification): sync this account soon, at most once a minute. */
export function requestAccountSync(accountId: string): void {
  void (async () => {
    const a = await prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!a || a.status !== "CONNECTED" || running.has(a.id)) return;
    if (a.lastSyncAttemptAt && Date.now() - a.lastSyncAttemptAt.getTime() < 60_000) return;
    await syncAccount(a);
  })().catch(() => {});
}

let started = false;

/** Start the scheduler once at boot (no-op in tests). */
export function startAccountSyncScheduler(): void {
  if (started || process.env.VITEST) return;
  started = true;
  // A crash mid-sync leaves SYNCING behind; nothing is running at boot.
  void prisma.connectedAccount.updateMany({ where: { syncStatus: "SYNCING" }, data: { syncStatus: "IDLE" } }).catch(() => {});
  setInterval(() => void tick().catch((e) => console.warn(`[connected] sync tick failed: ${e instanceof Error ? e.message : e}`)), TICK_MS).unref();
}
