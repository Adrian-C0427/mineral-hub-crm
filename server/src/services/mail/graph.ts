/**
 * Outlook mail through Microsoft Graph v1.0 (Mail.ReadWrite, Mail.Send).
 * Ids are immutable (client.ts sends Prefer: IdType="ImmutableId"), so a
 * message keeps its id when it moves — draft → Sent Items, inbox → archive.
 * Bodies come back as HTML and are sanitized before they leave this module.
 */
import type { ConnectedAccount } from "@prisma/client";
import { providerFetch, providerJson, ProviderError } from "../connected/client.js";
import { sanitizeReceived } from "./html.js";

const G = "https://graph.microsoft.com/v1.0";
const PREFER_HTML = 'IdType="ImmutableId", outlook.body-content-type="html"';
const LIST_SELECT = "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,bodyPreview,importance,flag,parentFolderId";

export const WELL_KNOWN = ["inbox", "sentitems", "drafts", "archive", "deleteditems", "junkemail"] as const;
export type WellKnown = (typeof WELL_KNOWN)[number];

export interface Address { name: string | null; address: string }
export interface MailFolder { id: string; name: string; wellKnown: WellKnown | null; unread: number; total: number; childCount: number }
export interface MailSummary {
  id: string; conversationId: string | null; subject: string | null; from: Address | null;
  to: Address[]; cc: Address[]; receivedAt: string | null; sentAt: string | null;
  isRead: boolean; isDraft: boolean; hasAttachments: boolean; preview: string; importance: string | null;
  flagged: boolean; folderId: string | null;
}
export interface MailAttachment { id: string; name: string; contentType: string | null; size: number; isInline: boolean; contentId: string | null; kind: "file" | "item" | "reference" }
export interface MailMessage extends MailSummary {
  bcc: Address[]; replyTo: Address[]; internetMessageId: string | null; bodyHtml: string; attachments: MailAttachment[]; webLink: string | null;
}

interface GRecip { emailAddress?: { name?: string; address?: string } }
interface GMessage {
  id: string; conversationId?: string; subject?: string; from?: GRecip; toRecipients?: GRecip[]; ccRecipients?: GRecip[]; bccRecipients?: GRecip[]; replyTo?: GRecip[];
  receivedDateTime?: string; sentDateTime?: string; isRead?: boolean; isDraft?: boolean; hasAttachments?: boolean; bodyPreview?: string; importance?: string;
  flag?: { flagStatus?: string }; parentFolderId?: string; internetMessageId?: string; webLink?: string;
  body?: { contentType?: string; content?: string };
  attachments?: { "@odata.type"?: string; id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; contentId?: string }[];
  "@removed"?: unknown;
}

const addr = (r?: GRecip): Address | null => (r?.emailAddress?.address ? { name: r.emailAddress.name ?? null, address: r.emailAddress.address.toLowerCase() } : null);
const addrs = (rs?: GRecip[]): Address[] => (rs ?? []).map(addr).filter((a): a is Address => !!a);
export const toRecipients = (list: readonly Address[]) => list.map((a) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }));

export function summary(m: GMessage): MailSummary {
  return {
    id: m.id, conversationId: m.conversationId ?? null, subject: m.subject ?? null, from: addr(m.from),
    to: addrs(m.toRecipients), cc: addrs(m.ccRecipients), receivedAt: m.receivedDateTime ?? null, sentAt: m.sentDateTime ?? null,
    isRead: m.isRead ?? true, isDraft: m.isDraft ?? false, hasAttachments: m.hasAttachments ?? false, preview: m.bodyPreview ?? "",
    importance: m.importance ?? null, flagged: m.flag?.flagStatus === "flagged", folderId: m.parentFolderId ?? null,
  };
}

function full(m: GMessage): MailMessage {
  return {
    ...summary(m),
    bcc: addrs(m.bccRecipients), replyTo: addrs(m.replyTo), internetMessageId: m.internetMessageId ?? null, webLink: m.webLink ?? null,
    bodyHtml: m.body?.contentType === "html" ? sanitizeReceived(m.body.content ?? "") : `<pre style="white-space:pre-wrap;font:inherit">${(m.body?.content ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id, name: a.name ?? "attachment", contentType: a.contentType ?? null, size: a.size ?? 0, isInline: !!a.isInline, contentId: a.contentId ?? null,
      kind: a["@odata.type"]?.endsWith("itemAttachment") ? "item" : a["@odata.type"]?.endsWith("referenceAttachment") ? "reference" : "file",
    })),
  };
}

const enc = (id: string) => {
  if (!/^[A-Za-z0-9_=+/-]{1,400}$/.test(id)) throw new ProviderError("Invalid message id.", "invalid");
  return encodeURIComponent(id);
};

/**
 * A nextLink handed back by the client must be a Graph mail URL for this
 * mailbox. Checked on the PARSED url — what providerFetch will request — not
 * the raw string: `/me/messages/../../me/drive/...` passes a prefix test and
 * is fetched as `/me/drive/...`.
 */
export function ownMailLink(link: string): string {
  let u: URL;
  try { u = new URL(link); } catch { throw new ProviderError("Invalid page cursor.", "invalid"); }
  if (u.origin !== "https://graph.microsoft.com" || !/^\/v1\.0\/me\/(mailFolders|messages)(\/|$)/.test(u.pathname)) throw new ProviderError("Invalid page cursor.", "invalid");
  return u.href;
}
const ownLink = ownMailLink;

/** The mailbox's folders (top level + one level of children), with well-known ones tagged. */
export async function listFolders(a: ConnectedAccount): Promise<MailFolder[]> {
  const [top, ...known] = await Promise.all([
    providerJson<{ value?: { id: string; displayName?: string; unreadItemCount?: number; totalItemCount?: number; childFolderCount?: number }[] }>(
      a, `${G}/me/mailFolders?$top=100&$select=id,displayName,unreadItemCount,totalItemCount,childFolderCount`),
    ...WELL_KNOWN.map((w) => providerJson<{ id: string }>(a, `${G}/me/mailFolders/${w}?$select=id`).catch(() => null)),
  ]);
  const wk = new Map<string, WellKnown>();
  known.forEach((k, i) => { if (k?.id) wk.set(k.id, WELL_KNOWN[i]); });
  const order = (f: MailFolder) => (f.wellKnown ? WELL_KNOWN.indexOf(f.wellKnown) : 99);
  return (top.value ?? [])
    .map((f) => ({ id: f.id, name: f.displayName ?? "Folder", wellKnown: wk.get(f.id) ?? null, unread: f.unreadItemCount ?? 0, total: f.totalItemCount ?? 0, childCount: f.childFolderCount ?? 0 }))
    .sort((x, y) => order(x) - order(y) || x.name.localeCompare(y.name));
}

export async function folderIdOf(a: ConnectedAccount, w: WellKnown): Promise<string> {
  return (await providerJson<{ id: string }>(a, `${G}/me/mailFolders/${w}?$select=id`)).id;
}

/** A page of a folder (newest first), or search results across the mailbox. */
export async function listMessages(a: ConnectedAccount, p: { folder: string; q?: string; unread?: boolean; cursor?: string | null }): Promise<{ items: MailSummary[]; cursor: string | null }> {
  let url: string;
  if (p.cursor) url = ownLink(p.cursor);
  else if (p.q) {
    // $search runs across the mailbox and can't be ordered; quotes are its delimiters.
    url = `${G}/me/messages?$search=${encodeURIComponent(`"${p.q.replace(/"/g, "")}"`)}&$top=25&$select=${LIST_SELECT}`;
  } else {
    const folder = (WELL_KNOWN as readonly string[]).includes(p.folder) ? p.folder : enc(p.folder);
    url = `${G}/me/mailFolders/${folder}/messages?$top=25&$select=${LIST_SELECT}&$orderby=receivedDateTime desc${p.unread ? "&$filter=isRead eq false" : ""}`;
  }
  const j = await providerJson<{ value?: GMessage[]; "@odata.nextLink"?: string }>(a, url);
  return { items: (j.value ?? []).map(summary), cursor: j["@odata.nextLink"] ?? null };
}

export async function getMessage(a: ConnectedAccount, id: string): Promise<MailMessage> {
  const m = await providerJson<GMessage>(a, `${G}/me/messages/${enc(id)}?$select=${LIST_SELECT},bccRecipients,replyTo,internetMessageId,webLink,body&$expand=attachments($select=id,name,contentType,size,isInline)`, {
    headers: { Prefer: PREFER_HTML },
  });
  // contentId isn't selectable through $expand on every tenant; fetch it for inline parts.
  if (m.attachments?.some((x) => x.isInline)) {
    const atts = await providerJson<{ value?: GMessage["attachments"] }>(a, `${G}/me/messages/${enc(id)}/attachments?$select=id,name,contentType,size,isInline,contentId`).catch(() => null);
    if (atts?.value) m.attachments = atts.value;
  }
  return full(m);
}

/** Every message in a conversation, oldest first. */
export async function getConversation(a: ConnectedAccount, conversationId: string): Promise<MailSummary[]> {
  const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`);
  const j = await providerJson<{ value?: GMessage[] }>(a, `${G}/me/messages?$filter=${filter}&$top=50&$select=${LIST_SELECT}`);
  return (j.value ?? []).map(summary).sort((x, y) => (x.receivedAt ?? x.sentAt ?? "").localeCompare(y.receivedAt ?? y.sentAt ?? ""));
}

export async function setRead(a: ConnectedAccount, id: string, isRead: boolean): Promise<void> {
  await providerFetch(a, `${G}/me/messages/${enc(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isRead }) });
}

export async function moveMessage(a: ConnectedAccount, id: string, destination: string): Promise<MailSummary> {
  const dest = (WELL_KNOWN as readonly string[]).includes(destination) ? destination : enc(destination);
  const m = await providerJson<GMessage>(a, `${G}/me/messages/${enc(id)}/move`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationId: dest }), retry: true,
  });
  return summary(m);
}

/** A file attachment's bytes (streamed). */
export async function attachmentStream(a: ConnectedAccount, messageId: string, attachmentId: string): Promise<{ body: ReadableStream<Uint8Array>; name: string; contentType: string; size: number }> {
  const meta = await providerJson<{ "@odata.type"?: string; name?: string; contentType?: string; size?: number }>(a, `${G}/me/messages/${enc(messageId)}/attachments/${enc(attachmentId)}?$select=name,contentType,size`);
  if (meta["@odata.type"] && !meta["@odata.type"].endsWith("fileAttachment")) throw new ProviderError("This attachment is an Outlook item, not a file — open it in Outlook.", "invalid");
  const res = await providerFetch(a, `${G}/me/messages/${enc(messageId)}/attachments/${enc(attachmentId)}/$value`, { timeoutMs: 120_000 });
  if (!res.body) throw new ProviderError("Outlook returned an empty attachment.", "unavailable");
  return { body: res.body, name: meta.name ?? "attachment", contentType: meta.contentType ?? "application/octet-stream", size: meta.size ?? 0 };
}

export interface DeltaPage { messages: (MailSummary & { removed: boolean })[]; next: string | null; delta: string | null }

/**
 * One page of a folder's change feed. First call: messages received since
 * `since` (so a big mailbox isn't enumerated); later calls: the stored
 * next/delta link. A 410 (expired token) surfaces as ProviderError notfound.
 */
export async function deltaPage(a: ConnectedAccount, folder: WellKnown, link: string | null, since: Date): Promise<DeltaPage> {
  const url = link
    ? (link.startsWith(`${G}/me/mailFolders`) ? link : (() => { throw new ProviderError("Invalid delta link.", "invalid"); })())
    : `${G}/me/mailFolders/${folder}/messages/delta?$select=${LIST_SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}`;
  const j = await providerJson<{ value?: GMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(a, url, {
    headers: { Prefer: 'IdType="ImmutableId", odata.maxpagesize=50' },
  });
  return {
    messages: (j.value ?? []).map((m) => ({ ...summary(m), removed: !!m["@removed"] })),
    next: j["@odata.nextLink"] ?? null,
    delta: j["@odata.deltaLink"] ?? null,
  };
}
