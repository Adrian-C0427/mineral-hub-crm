/**
 * Outlook mailbox sync (background, server-side; services/connected/sync.ts
 * runs it every 5 minutes and a Graph change notification can nudge it).
 *
 *  - Incremental: each folder's Graph delta feed (Inbox and Sent Items),
 *    started 14 days back so a large mailbox isn't enumerated; the delta
 *    link is stored and resumed. An expired link restarts the window.
 *  - Only mail that involves a CRM record is stored: an exact address match
 *    with a contact or buyer (never internal mail between team members), or
 *    a message in a conversation already filed on a record. Everything else
 *    is skipped — the mailbox stays the owner's.
 *  - Idempotent: a message is stored once per mailbox (unique provider id);
 *    CRM-sent mail is already stored and only gains its conversation id.
 *  - Never destructive: messages deleted in Outlook stay on the records they
 *    were filed on.
 *  - Turn off "Auto-file email" on the account and it files nothing.
 */
import type { ConnectedAccount } from "@prisma/client";
import { prisma } from "../../db.js";
import { ProviderError } from "../connected/client.js";
import { registerAccountSyncer } from "../connected/sync.js";
import { deltaPage, getMessage, type MailSummary, type WellKnown } from "./graph.js";
import { conversationRecords, linkEmail, matchAddresses, recordTimeline, teamAddresses } from "./links.js";
import { ensureSubscription } from "./subscriptions.js";
import type { RecordRef } from "../connected/records.js";
import type { Prisma } from "@prisma/client";

const LOOKBACK_MS = 14 * 24 * 60 * 60_000;
const MAX_PAGES = 20;
const FOLDERS: WellKnown[] = ["inbox", "sentitems"];

type MailState = Partial<Record<WellKnown, string>>;

async function ingest(a: ConnectedAccount, m: MailSummary, folder: WellKnown, team: string[]): Promise<boolean> {
  if (m.isDraft) return false;
  const existing = await prisma.emailMessage.findUnique({ where: { accountId_providerMessageId: { accountId: a.id, providerMessageId: m.id } } });
  if (existing) {
    if (!existing.conversationId && m.conversationId) await prisma.emailMessage.update({ where: { id: existing.id }, data: { conversationId: m.conversationId } });
    return false;
  }
  const inbound = folder === "inbox";
  const involved = [...(inbound && m.from ? [m.from.address] : []), ...m.to.map((x) => x.address), ...m.cc.map((x) => x.address)];
  const self = a.email ? [a.email] : [];
  const matched = await matchAddresses(a.organizationId, involved, [...team, ...self]);
  const inConversation = await conversationRecords(a.organizationId, a.id, m.conversationId);
  if (!matched.refs.length && !inConversation.length) return false;

  const full = await getMessage(a, m.id);
  let msg;
  try {
    msg = await prisma.emailMessage.create({
      data: {
        organizationId: a.organizationId, accountId: a.id, providerMessageId: m.id, internetMessageId: full.internetMessageId, conversationId: m.conversationId,
        direction: inbound ? "in" : "out", folder, subject: full.subject, fromAddress: full.from?.address ?? null, fromName: full.from?.name ?? null,
        toRecipients: full.to as unknown as Prisma.InputJsonValue, ccRecipients: full.cc as unknown as Prisma.InputJsonValue,
        bodyPreview: full.preview.slice(0, 500), bodyHtml: full.bodyHtml, hasAttachments: full.hasAttachments,
        sentAt: full.sentAt ? new Date(full.sentAt) : null, receivedAt: full.receivedAt ? new Date(full.receivedAt) : null,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return false; // stored meanwhile (webhook + schedule)
    throw e;
  }
  const refs: RecordRef[] = [...matched.refs, ...inConversation];
  await linkEmail(msg, refs, "AUTO", null);
  // A buyer "replied" only when the buyer is the sender — not when copied.
  const sender = full.from?.address ?? "";
  const timelineRefs = refs.filter((r) => r.type !== "buyer" || (inbound && matched.buyerByEmail.get(sender) === r.id));
  await recordTimeline(msg, a, timelineRefs);
  return true;
}

async function syncFolder(a: ConnectedAccount, folder: WellKnown, state: MailState, team: string[]): Promise<number> {
  let link = state[folder] ?? null;
  const since = new Date(Date.now() - LOOKBACK_MS);
  let filed = 0;
  let restarted = false;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    let page;
    try {
      page = await deltaPage(a, folder, link, since);
    } catch (e) {
      // Expired/invalid delta token: start the window over (idempotent ingest).
      if (!restarted && e instanceof ProviderError && (e.kind === "notfound" || e.kind === "invalid")) { link = null; restarted = true; continue; }
      throw e;
    }
    for (const m of page.messages) if (!m.removed && (await ingest(a, m, folder, team))) filed++;
    link = page.next ?? page.delta ?? link;
    state[folder] = link ?? undefined;
    if (!page.next) break;
  }
  return filed;
}

async function syncMail(a: ConnectedAccount): Promise<string> {
  await ensureSubscription(a).catch((e) => console.warn(`[mail] subscription upkeep for ${a.id}: ${e instanceof Error ? e.message : e}`));
  if (!a.autoLinkEmail) return "Up to date (auto-filing is off for this mailbox).";
  const syncState = (a.syncState ?? {}) as { mail?: MailState };
  const state: MailState = { ...(syncState.mail ?? {}) };
  const team = await teamAddresses(a.organizationId);
  let filed = 0;
  for (const folder of FOLDERS) {
    filed += await syncFolder(a, folder, state, team);
    await prisma.connectedAccount.update({ where: { id: a.id }, data: { syncState: { ...syncState, mail: state } as Prisma.InputJsonValue } });
  }
  return filed ? `Up to date — ${filed} new email${filed === 1 ? "" : "s"} filed on records.` : "Up to date.";
}

registerAccountSyncer("outlook", (a) => syncMail(a));
