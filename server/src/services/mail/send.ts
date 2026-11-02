/**
 * Sending email through a member's own Outlook mailbox (Microsoft Graph).
 *
 * Every send is draft → attachments → send, from the authenticated mailbox:
 *  - the sender is the member (their name and address, their reply-to) and
 *    the message lands in their Sent Items like any Outlook message;
 *  - replies / reply-all / forwards are created by Microsoft from the
 *    original (createReply…), so threading headers and the quoted history
 *    are Outlook's own; our text and signature go above the quote;
 *  - the signature is the mailbox's imported Outlook signature, inline
 *    images embedded as cid: attachments — nothing CRM-branded is added.
 *
 * Reliability:
 *  - Idempotent: each request carries a clientRequestId (unique per mailbox);
 *    a retried request returns the first result instead of sending again.
 *  - Accurate status: a message is SENT only after Graph accepts /send
 *    (202). If the /send call's outcome is unknown (timeout), the draft is
 *    checked: no longer a draft → sent; still a draft → failed (and removed).
 *    A failure before /send deletes the draft, so nothing half-built lingers.
 *  - Bulk sends (deal → selected buyers) are queued and drained by a worker
 *    that keeps each mailbox under Exchange Online's 30 messages/minute and
 *    backs off on throttling.
 */
import { Prisma, type ConnectedAccount, type EmailMessage } from "@prisma/client";
import { prisma } from "../../db.js";
import { HttpError } from "../../middleware/errors.js";
import { providerFetch, providerJson, ProviderError, backoffMs, sleep } from "../connected/client.js";
import type { RecordRef } from "../connected/records.js";
import { htmlToText, newMessageBody, replyBody, sanitizeComposed, sanitizeReceived } from "./html.js";
import { toRecipients, type Address } from "./graph.js";
import { pickSignature, type SignatureWithAssets } from "./signatures.js";
import { dealOutreach, linkEmail, matchAddresses, recordTimeline, teamAddresses } from "./links.js";

const G = "https://graph.microsoft.com/v1.0";
const PREFER_HTML = 'IdType="ImmutableId", outlook.body-content-type="html"';
const INLINE_MAX = 3 * 1024 * 1024;
const UPLOAD_CHUNK = 4 * 1024 * 1024 - (4 * 1024 * 1024) % (320 * 1024);
export const MAX_ATTACHMENTS_BYTES = 35 * 1024 * 1024;

export type SendMode = "new" | "reply" | "replyAll" | "forward" | "draft";

export interface OutAttachment {
  name: string;
  contentType: string;
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
  isInline?: boolean;
  contentId?: string;
}

export interface SendInput {
  account: ConnectedAccount;
  userId: string;
  mode: SendMode;
  /** reply / forward: the message replied to; draft: the draft being sent. */
  sourceMessageId?: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** What the member wrote (HTML from the composer). */
  html: string;
  /** undefined = the mailbox default for the kind of message; null = no signature. */
  signatureId?: string | null;
  attachments: OutAttachment[];
  /** Records the member chose to file the email on. */
  links: RecordRef[];
  clientRequestId: string;
  /** Bulk send from a deal to one buyer. */
  dealBuyer?: { dealId: string; buyerId: string; threadId: string | null };
}

const json = (v: unknown) => JSON.stringify(v);

async function graphPost<T>(a: ConnectedAccount, path: string, body: unknown, prefer = false): Promise<T> {
  return providerJson<T>(a, `${G}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(prefer ? { Prefer: PREFER_HTML } : {}) },
    body: json(body ?? {}),
  });
}

async function addAttachment(a: ConnectedAccount, draftId: string, att: OutAttachment): Promise<void> {
  const enc = encodeURIComponent(draftId);
  if (att.size < INLINE_MAX) {
    const bytes = await att.read(0, att.size);
    await graphPost(a, `/me/messages/${enc}/attachments`, {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: att.name, contentType: att.contentType, contentBytes: bytes.toString("base64"),
      isInline: !!att.isInline, ...(att.contentId ? { contentId: att.contentId } : {}),
    });
    return;
  }
  // 3 MB+ goes through an upload session (pre-authenticated URL — no token sent).
  const session = await graphPost<{ uploadUrl?: string }>(a, `/me/messages/${enc}/attachments/createUploadSession`, {
    AttachmentItem: { attachmentType: "file", name: att.name, size: att.size, contentType: att.contentType },
  });
  if (!session.uploadUrl || !/^https:\/\//.test(session.uploadUrl)) throw new ProviderError("Outlook didn't start the attachment upload.", "unavailable");
  for (let off = 0; off < att.size;) {
    const len = Math.min(UPLOAD_CHUNK, att.size - off);
    const bytes = await att.read(off, len);
    let res: Response | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        res = await fetch(session.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream", "Content-Length": String(len), "Content-Range": `bytes ${off}-${off + len - 1}/${att.size}` },
          body: new Uint8Array(bytes), signal: AbortSignal.timeout(120_000),
        });
      } catch { res = null; }
      if (res && (res.ok || res.status === 202)) break;
      if (res && res.status < 500 && res.status !== 429) break;
      await sleep(backoffMs(attempt));
    }
    if (!res || !(res.ok || res.status === 202)) throw new ProviderError(`Uploading “${att.name}” to Outlook failed.`, "unavailable", res?.status ?? 0);
    off += len;
  }
}

function signatureParts(sig: SignatureWithAssets | null): { html: string | null; inline: OutAttachment[] } {
  if (!sig) return { html: null, inline: [] };
  const inline = sig.assets
    .filter((x) => sig.html.includes(`cid:${x.contentId}`))
    .map((x) => ({ name: x.filename, contentType: x.mimeType, size: x.data.length, read: async (o: number, l: number) => Buffer.from(x.data).subarray(o, o + l), isInline: true, contentId: x.contentId }));
  return { html: sig.html, inline };
}

/** Is the message still a draft? (Used when a /send outcome is unknown.) */
async function stillDraft(a: ConnectedAccount, id: string): Promise<boolean | null> {
  try {
    const m = await providerJson<{ isDraft?: boolean }>(a, `${G}/me/messages/${encodeURIComponent(id)}?$select=isDraft`);
    return m.isDraft !== false;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "notfound") return null;
    throw e;
  }
}

async function deleteDraft(a: ConnectedAccount, id: string): Promise<void> {
  await providerFetch(a, `${G}/me/messages/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

/** Build the draft (new / reply / forward / existing), return its id and final HTML. */
async function buildDraft(a: ConnectedAccount, input: SendInput, sigHtml: string | null): Promise<{ id: string; html: string }> {
  const recipients = { toRecipients: toRecipients(input.to), ccRecipients: toRecipients(input.cc), bccRecipients: toRecipients(input.bcc) };
  if (input.mode === "new") {
    const html = newMessageBody(input.html, sigHtml);
    const d = await graphPost<{ id: string }>(a, "/me/messages", { subject: input.subject, body: { contentType: "HTML", content: html }, ...recipients });
    return { id: d.id, html };
  }
  if (!input.sourceMessageId) throw new HttpError(400, "Which message is this a reply to?");
  const src = encodeURIComponent(input.sourceMessageId);
  let draft: { id: string; body?: { content?: string } };
  if (input.mode === "draft") {
    draft = { id: input.sourceMessageId };
    const html = newMessageBody(input.html, sigHtml);
    await providerFetch(a, `${G}/me/messages/${src}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: json({ subject: input.subject, body: { contentType: "HTML", content: html }, ...recipients }),
    });
    return { id: draft.id, html };
  }
  const action = input.mode === "reply" ? "createReply" : input.mode === "replyAll" ? "createReplyAll" : "createForward";
  draft = await graphPost<{ id: string; body?: { content?: string } }>(a, `/me/messages/${src}/${action}`, {}, true);
  if (!draft.body?.content) {
    draft = await providerJson(a, `${G}/me/messages/${encodeURIComponent(draft.id)}?$select=id,body`, { headers: { Prefer: PREFER_HTML } });
  }
  const html = replyBody(input.html, sigHtml, draft.body?.content ?? "");
  await providerFetch(a, `${G}/me/messages/${encodeURIComponent(draft.id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: json({ subject: input.subject, body: { contentType: "HTML", content: html }, ...recipients }),
  });
  return { id: draft.id, html };
}

/**
 * Send one email now. Returns the stored EmailMessage (SENT), or throws —
 * having recorded the failure — when Microsoft didn't accept it.
 */
export async function sendEmailNow(input: SendInput, existing?: EmailMessage | null): Promise<EmailMessage> {
  const a = input.account;
  if (a.provider !== "outlook" || a.status !== "CONNECTED") throw new HttpError(409, "Reconnect Outlook in Settings → Integrations to send.");
  if (!input.to.length && input.mode !== "forward") throw new HttpError(400, "Add at least one recipient.");
  if (input.mode === "forward" && !input.to.length) throw new HttpError(400, "Who should this be forwarded to?");
  const total = input.attachments.reduce((n, x) => n + x.size, 0);
  if (total > MAX_ATTACHMENTS_BYTES) throw new HttpError(413, `Attachments are limited to ${MAX_ATTACHMENTS_BYTES / 1024 / 1024} MB per email.`);

  // Idempotency: one row per (mailbox, clientRequestId).
  let row = existing ?? await prisma.emailMessage.findUnique({ where: { accountId_clientRequestId: { accountId: a.id, clientRequestId: input.clientRequestId } } });
  if (row && !existing) {
    if (row.sendStatus === "SENT") return row;
    if (row.sendStatus === "SENDING" || row.sendStatus === "QUEUED") throw new HttpError(409, "This email is already being sent.");
  }
  const base = {
    subject: input.subject, toRecipients: input.to as unknown as Prisma.InputJsonValue, ccRecipients: input.cc as unknown as Prisma.InputJsonValue,
    fromAddress: a.email, fromName: a.displayName, direction: "out", sendStatus: "SENDING", sendError: null,
  };
  row = row
    ? await prisma.emailMessage.update({ where: { id: row.id }, data: { ...base, attempts: { increment: 1 } } })
    : await prisma.emailMessage.create({ data: { ...base, organizationId: a.organizationId, accountId: a.id, clientRequestId: input.clientRequestId, createdByUserId: input.userId, attempts: 1 } });

  const kind = input.mode === "new" || input.mode === "draft" ? "new" : "reply";
  const sig = signatureParts(await pickSignature(a.id, input.signatureId, kind));
  let draftId: string | null = input.mode === "draft" ? input.sourceMessageId ?? null : null;
  let finalHtml = "";
  try {
    const d = await buildDraft(a, input, sig.html);
    draftId = d.id;
    finalHtml = d.html;
    // Persist the draft id first: a crash after this point can be reconciled.
    await prisma.emailMessage.update({ where: { id: row.id }, data: { providerMessageId: draftId } });
    for (const att of [...sig.inline, ...input.attachments]) await addAttachment(a, draftId, att);
  } catch (e) {
    if (draftId && input.mode !== "draft") await deleteDraft(a, draftId);
    await fail(row.id, e, draftId && input.mode === "draft" ? draftId : null);
    throw toHttp(e);
  }

  try {
    await providerFetch(a, `${G}/me/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" });
  } catch (e) {
    // Unknown outcome (timeout / no response): ask Outlook whether it went.
    const ambiguous = e instanceof ProviderError && e.kind === "unavailable" && e.status === 0;
    const draft = ambiguous ? await stillDraft(a, draftId).catch(() => true) : true;
    if (draft !== false) {
      if (input.mode !== "draft") await deleteDraft(a, draftId);
      await fail(row.id, e, input.mode === "draft" ? draftId : null);
      throw toHttp(e);
    }
  }

  const stored = sanitizeReceived(finalHtml);
  const sent = await prisma.emailMessage.update({
    where: { id: row.id },
    data: {
      sendStatus: "SENT", sentAt: new Date(), folder: "sentitems", bodyHtml: stored, bodyPreview: htmlToText(stored, 255),
      hasAttachments: input.attachments.length > 0, outbox: Prisma.DbNull, sendError: null,
    },
  });
  // Conversation / internet ids arrive once the message is in Sent Items.
  void providerJson<{ conversationId?: string; internetMessageId?: string }>(a, `${G}/me/messages/${encodeURIComponent(draftId)}?$select=conversationId,internetMessageId`)
    .then((m) => prisma.emailMessage.update({ where: { id: sent.id }, data: { conversationId: m.conversationId ?? null, internetMessageId: m.internetMessageId ?? null } }))
    .catch(() => {});

  await fileSentEmail(sent, a, input);
  return sent;
}

/** Links + activity history for a sent email: chosen records, the replied-to conversation's records, plus recipients who are contacts/buyers. */
async function fileSentEmail(msg: EmailMessage, a: ConnectedAccount, input: SendInput): Promise<void> {
  await linkEmail(msg, input.links, "SENT", input.userId);
  let refs = [...input.links];
  // A reply / forward joins the records its conversation is already filed on.
  if (input.sourceMessageId && input.mode !== "new") {
    const source = await prisma.emailMessage.findUnique({
      where: { accountId_providerMessageId: { accountId: a.id, providerMessageId: input.sourceMessageId } },
      select: { conversationId: true, links: { select: { contactId: true, dealId: true, opportunityId: true, buyerId: true } } },
    });
    if (source) {
      if (source.conversationId && !msg.conversationId) await prisma.emailMessage.update({ where: { id: msg.id }, data: { conversationId: source.conversationId } });
      const carried = source.links.map((l): RecordRef | null => (l.contactId ? { type: "contact", id: l.contactId } : l.dealId ? { type: "deal", id: l.dealId }
        : l.opportunityId ? { type: "opportunity", id: l.opportunityId } : l.buyerId ? { type: "buyer", id: l.buyerId } : null)).filter((r): r is RecordRef => !!r);
      await linkEmail(msg, carried, "AUTO", input.userId);
      refs = [...refs, ...carried];
    }
  }
  if (a.autoLinkEmail) {
    const team = await teamAddresses(a.organizationId);
    const matched = await matchAddresses(a.organizationId, [...input.to, ...input.cc, ...input.bcc].map((x) => x.address), team);
    await linkEmail(msg, matched.refs, "AUTO", input.userId);
    refs = [...refs, ...matched.refs];
  }
  await recordTimeline(msg, a, refs);
  if (input.dealBuyer) {
    await linkEmail(msg, [{ type: "deal", id: input.dealBuyer.dealId }, { type: "buyer", id: input.dealBuyer.buyerId }], "SENT", input.userId);
    await dealOutreach(msg, input.dealBuyer.dealId, input.dealBuyer.buyerId, input.userId, input.dealBuyer.threadId);
  }
}

async function fail(id: string, e: unknown, keepDraftId: string | null): Promise<void> {
  const message = e instanceof ProviderError || e instanceof HttpError ? e.message : "Sending failed.";
  await prisma.emailMessage.update({
    where: { id },
    data: { sendStatus: "FAILED", sendError: message.slice(0, 500), providerMessageId: keepDraftId },
  }).catch(() => {});
}

function toHttp(e: unknown): Error {
  if (e instanceof ProviderError) return new HttpError(e.httpStatus, e.message);
  return e instanceof Error ? e : new Error("Sending failed.");
}

// ---------------------------------------------------------------------------
// Bulk: queue + worker
// ---------------------------------------------------------------------------

export interface QueuedItem { buyerId: string; to: Address; subject: string; html: string }

/** What a queued row carries until it's sent. */
interface Outbox { to: Address[]; subject: string; html: string; signatureId?: string | null; dealId: string; buyerId: string; threadId: string | null; userId: string }

/** Queue one personalized email per buyer, paced to the mailbox's sending limit. */
export async function queueBulk(p: { account: ConnectedAccount; userId: string; dealId: string; threadId: string; signatureId?: string | null; items: QueuedItem[] }): Promise<number> {
  const start = Date.now();
  await prisma.emailMessage.createMany({
    data: p.items.map((it, i) => ({
      organizationId: p.account.organizationId, accountId: p.account.id, direction: "out", sendStatus: "QUEUED",
      subject: it.subject, toRecipients: [it.to] as unknown as Prisma.InputJsonValue, fromAddress: p.account.email, fromName: p.account.displayName,
      clientRequestId: `${p.threadId}:${it.buyerId}`, createdByUserId: p.userId,
      notBefore: new Date(start + i * PACE_MS),
      outbox: { to: [it.to], subject: it.subject, html: sanitizeComposed(it.html), signatureId: p.signatureId, dealId: p.dealId, buyerId: it.buyerId, threadId: p.threadId, userId: p.userId } satisfies Outbox as unknown as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });
  kickOutbox();
  return p.items.length;
}

/** Exchange Online accepts 30 messages a minute per mailbox; stay under it. */
const PACE_MS = 2_100;
const PER_MINUTE = 28;
const recentSends = new Map<string, number[]>();
let draining = false;

function underLimit(accountId: string): boolean {
  const now = Date.now();
  const list = (recentSends.get(accountId) ?? []).filter((t) => now - t < 60_000);
  recentSends.set(accountId, list);
  return list.length < PER_MINUTE;
}

async function drainOnce(): Promise<number> {
  const due = await prisma.emailMessage.findMany({
    where: { sendStatus: "QUEUED", notBefore: { lte: new Date() } },
    orderBy: { notBefore: "asc" }, take: 20,
    include: { account: true },
  });
  let sent = 0;
  for (const row of due) {
    if (!underLimit(row.accountId)) continue;
    // Claim it (another tick can't take the same row).
    const claimed = await prisma.emailMessage.updateMany({ where: { id: row.id, sendStatus: "QUEUED" }, data: { sendStatus: "SENDING" } });
    if (!claimed.count) continue;
    const ob = row.outbox as unknown as Outbox | null;
    if (!ob || row.account.status !== "CONNECTED") {
      await prisma.emailMessage.update({ where: { id: row.id }, data: { sendStatus: "FAILED", sendError: "The Outlook account isn't connected.", outbox: Prisma.DbNull } });
      continue;
    }
    recentSends.get(row.accountId)!.push(Date.now());
    try {
      await sendEmailNow({
        account: row.account, userId: ob.userId, mode: "new", to: ob.to, cc: [], bcc: [], subject: ob.subject, html: ob.html,
        signatureId: ob.signatureId, attachments: [], links: [], clientRequestId: row.clientRequestId!,
        dealBuyer: { dealId: ob.dealId, buyerId: ob.buyerId, threadId: ob.threadId },
      }, { ...row, sendStatus: "SENDING" });
      sent++;
    } catch (e) {
      const throttled = e instanceof HttpError && e.status === 429;
      const reconnect = row.account.status !== "CONNECTED";
      const attempts = row.attempts + 1;
      if (!reconnect && (throttled || attempts < 3)) {
        await prisma.emailMessage.update({ where: { id: row.id }, data: { sendStatus: "QUEUED", notBefore: new Date(Date.now() + (throttled ? 60_000 : 120_000)), attempts } });
      }
      // Otherwise sendEmailNow already recorded FAILED with the reason.
    }
  }
  return sent;
}

/** Wake the worker now (a new batch was queued). */
export function kickOutbox(): void {
  if (draining || process.env.VITEST) return;
  draining = true;
  void drainOnce().catch((e) => console.warn(`[mail] outbox drain failed: ${e instanceof Error ? e.message : e}`)).finally(() => { draining = false; });
}

/**
 * A crash mid-send leaves SENDING rows: if their draft already went out,
 * they're SENT; otherwise they go back to the queue (bulk) or fail
 * (interactive — the member saw the error and can retry).
 */
async function reconcile(): Promise<void> {
  const stale = await prisma.emailMessage.findMany({
    where: { sendStatus: "SENDING", updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    include: { account: true }, take: 50,
  });
  for (const r of stale) {
    let draft: boolean | null = true;
    if (r.providerMessageId && r.account.status === "CONNECTED") draft = await stillDraft(r.account, r.providerMessageId).catch(() => true);
    if (draft === false) {
      await prisma.emailMessage.update({ where: { id: r.id }, data: { sendStatus: "SENT", sentAt: r.sentAt ?? r.updatedAt, outbox: Prisma.DbNull } });
    } else if (r.outbox) {
      if (r.providerMessageId && r.account.status === "CONNECTED") await deleteDraft(r.account, r.providerMessageId);
      await prisma.emailMessage.update({ where: { id: r.id }, data: { sendStatus: "QUEUED", providerMessageId: null, notBefore: new Date() } });
    } else {
      await prisma.emailMessage.update({ where: { id: r.id }, data: { sendStatus: "FAILED", sendError: "Interrupted before Outlook confirmed it — check Sent Items before trying again." } });
    }
  }
}

let started = false;
export function startOutboxWorker(): void {
  if (started || process.env.VITEST) return;
  started = true;
  setInterval(() => kickOutbox(), 5_000).unref();
  setInterval(() => void reconcile().catch(() => {}), 5 * 60_000).unref();
  void reconcile().catch(() => {});
}
