import { API_BASE, ApiError, getAuthToken } from "../api/client";
import type { RecordRef } from "./cloud";

/** Outlook mail (server: routes/mail.ts). Bodies arrive already sanitized. */
export interface Address { name: string | null; address: string }
export type WellKnown = "inbox" | "sentitems" | "drafts" | "archive" | "deleteditems" | "junkemail";

export interface MailFolder { id: string; name: string; wellKnown: WellKnown | null; unread: number; total: number; childCount: number }
export interface MailSummary {
  id: string; conversationId: string | null; subject: string | null; from: Address | null; to: Address[]; cc: Address[];
  receivedAt: string | null; sentAt: string | null; isRead: boolean; isDraft: boolean; hasAttachments: boolean; preview: string;
  importance: string | null; flagged: boolean; folderId: string | null; filed?: boolean;
}
export interface MailAttachment { id: string; name: string; contentType: string | null; size: number; isInline: boolean; contentId: string | null; kind: "file" | "item" | "reference" }
export interface EmailLinkView { id: string; record: RecordRef | null; source: "AUTO" | "MANUAL" | "SENT"; name?: string | null }
export interface MailMessage extends MailSummary {
  bcc: Address[]; replyTo: Address[]; internetMessageId: string | null; bodyHtml: string; attachments: MailAttachment[]; webLink: string | null;
  editableHtml: string | null; storedId: string | null; links: EmailLinkView[];
}

export interface Signature {
  id: string; accountId: string; name: string; html: string; defaultNew: boolean; defaultReply: boolean;
  images: { contentId: string; filename: string; mimeType: string; sizeBytes: number }[];
  updatedAt: string;
}

/** An email filed on a record (visible to anyone who can see the record). */
export interface FiledEmail {
  id: string; direction: "in" | "out"; subject: string | null; fromAddress: string | null; fromName: string | null;
  toRecipients: Address[]; ccRecipients: Address[]; bodyPreview: string | null; hasAttachments: boolean;
  sentAt: string | null; receivedAt: string | null; createdAt: string; conversationId: string | null;
  sendStatus: "QUEUED" | "SENDING" | "SENT" | "FAILED" | null; sendError: string | null;
  account: { id: string; email: string | null; userId: string; displayName: string | null };
  mine: boolean; links: EmailLinkView[];
}

export const FOLDER_LABEL: Record<WellKnown, string> = {
  inbox: "Inbox", sentitems: "Sent Items", drafts: "Drafts", archive: "Archive", deleteditems: "Deleted Items", junkemail: "Junk Email",
};

export const fmtAddress = (a: Address | null | undefined) => (a ? (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address) : "");
export const shortAddress = (a: Address | null | undefined) => (a ? a.name || a.address : "");

/** Fetch an authed binary as an object URL (inline images; signature images). */
export async function authedObjectUrl(path: string): Promise<string> {
  const t = getAuthToken();
  const res = await fetch(`${API_BASE}/api${path}`, { headers: t ? { Authorization: `Bearer ${t}` } : {}, credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "Couldn't load an image.");
  return URL.createObjectURL(await res.blob());
}

/** Very small email address check (the server validates for real). */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(s.trim());
}

/** "Riley <riley@x.com>, b@y.com" → addresses (invalid entries returned separately). */
export function parseAddressList(raw: string): { ok: Address[]; bad: string[] } {
  const ok: Address[] = [];
  const bad: string[] = [];
  for (const part of raw.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(.*)<([^<>]+)>$/);
    const address = (m ? m[2] : part).trim().toLowerCase();
    const name = m ? m[1].trim().replace(/^"|"$/g, "") || null : null;
    if (looksLikeEmail(address)) ok.push({ name, address });
    else bad.push(part);
  }
  return { ok, bad };
}
