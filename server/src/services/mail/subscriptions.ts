/**
 * Microsoft Graph change notifications for connected Outlook mailboxes —
 * new Inbox mail nudges that mailbox's sync right away instead of waiting
 * for the 5-minute schedule.
 *
 *  - Only where the API is publicly reachable over HTTPS (production); local
 *    development relies on the schedule.
 *  - Each subscription has a random clientState secret; only its SHA-256 is
 *    stored, and every notification is checked against it (timing-safe)
 *    before anything happens. A notification never carries mail content
 *    here and is never trusted as data — it only triggers a normal sync.
 *  - Subscriptions last 3 days and are renewed when under a day remains
 *    (each sync checks); a lost one is recreated. Lifecycle events
 *    (reauthorizationRequired, subscriptionRemoved, missed) trigger a sync,
 *    which renews/recreates.
 */
import crypto from "node:crypto";
import type { ConnectedAccount } from "@prisma/client";
import { prisma } from "../../db.js";
import { env } from "../../config.js";
import { providerFetch, providerJson, ProviderError } from "../connected/client.js";
import { requestAccountSync } from "../connected/sync.js";

const G = "https://graph.microsoft.com/v1.0";
const LIFETIME_MS = 3 * 24 * 60 * 60_000;
const RENEW_WITHIN_MS = 24 * 60 * 60_000;
export const INBOX_RESOURCE = "me/mailFolders('Inbox')/messages";

export const webhookUrl = () => `${env.API_URL}/api/webhooks/graph`;
export const webhooksEnabled = () => /^https:\/\//.test(env.API_URL) && !/localhost|127\.0\.0\.1/.test(env.API_URL);

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Keep one live Inbox subscription for the mailbox (create / renew). */
export async function ensureSubscription(a: ConnectedAccount): Promise<void> {
  if (!webhooksEnabled() || a.provider !== "outlook" || a.status !== "CONNECTED") return;
  const subs = await prisma.providerSubscription.findMany({ where: { accountId: a.id } });
  let live = false;
  for (const s of subs) {
    if (s.expiresAt.getTime() - Date.now() > RENEW_WITHIN_MS) { live = true; continue; }
    const expiresAt = new Date(Date.now() + LIFETIME_MS);
    try {
      await providerFetch(a, `${G}/subscriptions/${encodeURIComponent(s.subscriptionId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expirationDateTime: expiresAt.toISOString() }),
      });
      await prisma.providerSubscription.update({ where: { id: s.id }, data: { expiresAt } });
      live = true;
    } catch (e) {
      if (!(e instanceof ProviderError) || e.kind !== "notfound") throw e;
      await prisma.providerSubscription.delete({ where: { id: s.id } });
    }
  }
  if (live) return;
  const secret = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + LIFETIME_MS);
  const created = await providerJson<{ id: string; expirationDateTime?: string }>(a, `${G}/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      changeType: "created", resource: INBOX_RESOURCE, notificationUrl: webhookUrl(), lifecycleNotificationUrl: webhookUrl(),
      expirationDateTime: expiresAt.toISOString(), clientState: secret,
    }),
  });
  await prisma.providerSubscription.create({
    data: { accountId: a.id, subscriptionId: created.id, resource: INBOX_RESOURCE, clientStateHash: sha(secret), expiresAt: created.expirationDateTime ? new Date(created.expirationDateTime) : expiresAt },
  });
}

export interface GraphNotification { subscriptionId?: string; clientState?: string; lifecycleEvent?: string; changeType?: string }

/**
 * Verify and act on a notification batch. Returns how many were accepted.
 * Unknown subscriptions and wrong secrets are ignored (and never reveal which).
 */
export async function handleNotifications(items: readonly GraphNotification[]): Promise<number> {
  let accepted = 0;
  for (const n of items.slice(0, 100)) {
    if (!n.subscriptionId || !n.clientState) continue;
    const sub = await prisma.providerSubscription.findUnique({ where: { subscriptionId: n.subscriptionId } });
    if (!sub) continue;
    const a = Buffer.from(sha(n.clientState), "hex");
    const b = Buffer.from(sub.clientStateHash, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) continue;
    if (n.lifecycleEvent === "subscriptionRemoved") await prisma.providerSubscription.delete({ where: { id: sub.id } }).catch(() => {});
    if (n.lifecycleEvent === "reauthorizationRequired") {
      // Force a renewal on the next sync.
      await prisma.providerSubscription.update({ where: { id: sub.id }, data: { expiresAt: new Date() } }).catch(() => {});
    }
    requestAccountSync(sub.accountId);
    accepted++;
  }
  return accepted;
}
