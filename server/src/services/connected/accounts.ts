/**
 * Connected accounts — connect, reconnect, disconnect and describe a team
 * member's own Outlook / OneDrive / Google Drive connection.
 *
 * Rules:
 *  - One row per provider account per organization: reconnecting the same
 *    account updates it in place (its linked emails and files stay attached),
 *    and an account another member has connected can't be connected again.
 *  - "Connected" means usable: the provider granted every feature permission.
 *    A partial grant is stored as NEEDS_RECONNECT with no tokens kept.
 *  - Disconnecting wipes the tokens (and revokes the Google grant, deletes
 *    Graph subscriptions, fails anything still queued to send) but keeps the
 *    row and everything linked to records through it.
 *  - Removing a member from the organization disconnects their accounts.
 */
import { Prisma, type ConnectedAccount } from "@prisma/client";
import { prisma } from "../../db.js";
import { HttpError } from "../../middleware/errors.js";
import { logActivity } from "../activityLog.js";
import {
  ACCOUNT_PROVIDER_DEFS, accountProviderConfigured, grantedScopes, isAccountProvider, missingScopes, normScope, scopeLabels,
  type AccountProvider,
} from "./providers.js";
import { exchangeAccountCode, fetchIdentity, openTokens, revokeGoogleToken, sealTokens, type TokenBundle } from "./oauth.js";
import { providerFetch } from "./client.js";

export interface AccountView {
  id: string;
  provider: AccountProvider;
  providerName: string;
  email: string | null;
  displayName: string | null;
  status: "CONNECTED" | "NEEDS_RECONNECT" | "DISCONNECTED";
  syncStatus: "IDLE" | "SYNCING" | "ERROR";
  lastSyncAt: Date | null;
  lastSyncAttemptAt: Date | null;
  lastError: string | null;
  permissions: string[];
  missingPermissions: string[];
  connectedAt: Date;
  disconnectedAt: Date | null;
  autoLinkEmail: boolean;
}

/** What the client may see of an account: never tokens or sync cursors. */
export function serializeAccount(a: ConnectedAccount): AccountView {
  const provider = a.provider as AccountProvider;
  const def = ACCOUNT_PROVIDER_DEFS[provider];
  const missing = a.status === "DISCONNECTED" ? [] : missingScopes(def, a.scopes);
  return {
    id: a.id,
    provider,
    providerName: def.name,
    email: a.email,
    displayName: a.displayName,
    status: a.status as AccountView["status"],
    syncStatus: a.syncStatus as AccountView["syncStatus"],
    lastSyncAt: a.lastSyncAt,
    lastSyncAttemptAt: a.lastSyncAttemptAt,
    lastError: a.lastError,
    permissions: a.status === "DISCONNECTED" ? [] : scopeLabels(def, a.scopes),
    missingPermissions: missing.map((s) => def.scopeLabels[s] ?? s),
    connectedAt: a.connectedAt,
    disconnectedAt: a.disconnectedAt,
    autoLinkEmail: a.autoLinkEmail,
  };
}

/** The member's own account (404 for anyone else's — no existence leak). */
export async function loadOwnAccount(orgId: string, userId: string, id: string): Promise<ConnectedAccount> {
  const a = await prisma.connectedAccount.findFirst({ where: { id, organizationId: orgId, userId } });
  if (!a || !isAccountProvider(a.provider)) throw new HttpError(404, "Connected account not found.");
  return a;
}

/** The member's own account, which must be connected and usable. */
export async function loadUsableAccount(orgId: string, userId: string, id: string, provider?: AccountProvider): Promise<ConnectedAccount> {
  const a = await loadOwnAccount(orgId, userId, id);
  if (provider && a.provider !== provider) throw new HttpError(404, "Connected account not found.");
  if (a.status !== "CONNECTED" || !a.tokens) {
    throw new HttpError(409, `${ACCOUNT_PROVIDER_DEFS[a.provider as AccountProvider].name} (${a.email ?? "account"}) needs to be reconnected in Settings → Integrations.`);
  }
  return a;
}

export interface ConnectResult { account: ConnectedAccount; reconnected: boolean; missing: string[] }

/**
 * Finish a member's authorization: redeem the code (with the PKCE verifier),
 * identify the account, check the grant, and create or update its row.
 */
export async function connectAccount(p: { orgId: string; userId: string; provider: AccountProvider; code: string; verifier: string }): Promise<ConnectResult> {
  const def = ACCOUNT_PROVIDER_DEFS[p.provider];
  if (!accountProviderConfigured(p.provider)) throw new HttpError(400, `${def.name} isn't configured on this server yet.`);
  const bundle = await exchangeAccountCode(p.provider, p.code, p.verifier);
  const identity = await fetchIdentity(p.provider, bundle.access_token);
  // Microsoft and Google both return the granted scopes; if one ever didn't,
  // assume the requested set — the first API call would then catch a gap.
  const scopes = bundle.scope ? grantedScopes(bundle.scope) : def.scopes.map(normScope);
  const missing = missingScopes(def, scopes);

  const existing = await prisma.connectedAccount.findUnique({
    where: { organizationId_provider_providerAccountId: { organizationId: p.orgId, provider: p.provider, providerAccountId: identity.providerAccountId } },
    include: { user: { select: { name: true } } },
  });
  if (existing && existing.userId !== p.userId && existing.status !== "DISCONNECTED") {
    if (def.family === "google") await revokeGoogleToken(bundle.refresh_token ?? bundle.access_token);
    throw new HttpError(409, `${identity.email ?? "This account"} is already connected by ${existing.user.name}. They need to disconnect it first.`);
  }

  if (missing.length && def.family === "google") await revokeGoogleToken(bundle.refresh_token ?? bundle.access_token);
  const usable = missing.length === 0;
  const data = {
    userId: p.userId,
    email: identity.email,
    displayName: identity.displayName,
    scopes,
    status: usable ? "CONNECTED" : "NEEDS_RECONNECT",
    // A partial grant isn't kept: no feature could use it.
    tokens: usable ? sealTokens(bundle) : null,
    syncStatus: usable ? "IDLE" : "ERROR",
    lastError: usable
      ? (bundle.refresh_token ? null : `${def.name} didn't grant offline access, so this connection will stop working within the hour. Reconnect and accept every permission.`)
      : `Not every permission was granted (missing: ${missing.map((s) => def.scopeLabels[s] ?? s).join(", ")}). Reconnect and accept all of them.`,
    connectedAt: new Date(),
    disconnectedAt: null,
  };
  const account = existing
    ? await prisma.connectedAccount.update({ where: { id: existing.id }, data })
    : await prisma.connectedAccount.create({ data: { ...data, organizationId: p.orgId, provider: p.provider, providerAccountId: identity.providerAccountId } });

  await logActivity({
    eventType: existing ? "account.reconnected" : "account.connected",
    summary: `${def.name} ${existing ? "reconnected" : "connected"} (${identity.email ?? "account"})${usable ? "" : " — permissions incomplete"}`,
    organizationId: p.orgId, actorUserId: p.userId,
    metadata: { accountId: account.id, provider: p.provider },
  });
  return { account, reconnected: !!existing, missing };
}

async function deleteGraphSubscriptions(account: ConnectedAccount): Promise<void> {
  const subs = await prisma.providerSubscription.findMany({ where: { accountId: account.id }, select: { subscriptionId: true } });
  for (const s of subs) {
    await providerFetch(account, `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(s.subscriptionId)}`, { method: "DELETE" })
      .catch(() => {}); // it expires on its own within days if this fails
  }
  await prisma.providerSubscription.deleteMany({ where: { accountId: account.id } });
}

/**
 * Disconnect: stop all access through the account and forget its tokens.
 * Emails, signatures and file links it created stay on their records.
 */
export async function disconnectAccount(account: ConnectedAccount, actorUserId: string | null, reason = "disconnected"): Promise<ConnectedAccount> {
  const provider = account.provider as AccountProvider;
  const def = ACCOUNT_PROVIDER_DEFS[provider];
  let bundle: TokenBundle | null = null;
  try { bundle = account.tokens ? openTokens(account.tokens) : null; } catch { bundle = null; }

  if (account.tokens && account.status === "CONNECTED") await deleteGraphSubscriptions(account).catch(() => {});
  else await prisma.providerSubscription.deleteMany({ where: { accountId: account.id } });
  if (bundle && def.family === "google") await revokeGoogleToken(bundle.refresh_token ?? bundle.access_token);

  await prisma.emailMessage.updateMany({
    where: { accountId: account.id, sendStatus: "QUEUED" },
    data: { sendStatus: "FAILED", sendError: `Not sent: the Outlook account was ${reason} first.`, outbox: Prisma.DbNull },
  });
  const row = await prisma.connectedAccount.update({
    where: { id: account.id },
    data: { tokens: null, status: "DISCONNECTED", syncStatus: "IDLE", lastError: null, disconnectedAt: new Date() },
  });
  await logActivity({
    eventType: "account.disconnected",
    summary: `${def.name} ${reason} (${account.email ?? "account"})`,
    organizationId: account.organizationId, actorUserId,
    metadata: { accountId: account.id, provider },
  });
  return row;
}

/** A member is leaving the organization: disconnect every account they connected in it. */
export async function disconnectMemberAccounts(orgId: string, userId: string, actorUserId: string | null): Promise<number> {
  const rows = await prisma.connectedAccount.findMany({ where: { organizationId: orgId, userId, status: { not: "DISCONNECTED" } } });
  for (const a of rows) {
    await disconnectAccount(a, actorUserId, "disconnected because its owner left the organization").catch(async (e) => {
      // Whatever failed (a provider call), the tokens must not outlive the membership.
      console.warn(`[connected] disconnect on member removal failed for ${a.id}: ${e instanceof Error ? e.message : e}`);
      await prisma.connectedAccount.update({ where: { id: a.id }, data: { tokens: null, status: "DISCONNECTED", syncStatus: "IDLE", disconnectedAt: new Date() } });
    });
  }
  return rows.length;
}
