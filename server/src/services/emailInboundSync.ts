/**
 * Inbound email sync — Gmail / Outlook (Microsoft Graph).
 *
 * When an org's "gmail" or "outlook" integration is CONNECTED, each sync pulls
 * recent inbox messages and matches senders against buyer emails. A message
 * from a known buyer becomes an EMAIL_IN entry on that buyer's most recently
 * active deal timeline, flips responseReceived, refreshes lastActivityDate,
 * and raises a notification (targeted at the assigned team member when there
 * is one, else org-wide) so replies surface in the bell immediately.
 *
 * Incremental: a per-integration cursor (config.inboundCursor, ISO timestamp)
 * advances to the newest message seen, so each message is processed once. The
 * first sync looks back 7 days. Only sender/subject/snippet are stored — never
 * full bodies or attachments.
 */
import type { Integration, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { getFreshAccessToken } from "./integrationOAuth.js";

const FIRST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES_PER_SYNC = 25;
const SNIPPET_MAX = 500;

export interface InboundMessage {
  fromEmail: string;
  subject: string | null;
  snippet: string | null;
  receivedAt: Date;
}

export interface InboundSyncResult {
  fetched: number;
  matched: number;
}

export function isInboundEmailProvider(key: string): boolean {
  return key === "gmail" || key === "outlook";
}

/** "Riley Cole <riley@basinpeak.com>" → "riley@basinpeak.com" (lowercased). */
export function parseFromAddress(raw: string): string | null {
  const angle = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angle?.[1] ?? raw.match(/([^\s<>,;"']+@[^\s<>,;"']+)/)?.[1];
  return bare ? bare.trim().toLowerCase() : null;
}

// --- Provider fetchers -------------------------------------------------------

async function providerJson(url: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as { message?: string };
    throw new Error(`Mail API returned ${res.status}${err.message ? `: ${err.message}` : ""}`);
  }
  return json;
}

async function fetchGmail(token: string, since: Date): Promise<InboundMessage[]> {
  // Gmail's `after:` filter has second granularity; the cursor comparison below
  // handles the overlap. Requires the gmail.readonly scope.
  const q = encodeURIComponent(`in:inbox after:${Math.floor(since.getTime() / 1000)}`);
  const list = await providerJson(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${MAX_MESSAGES_PER_SYNC}`,
    token,
  );
  const ids = ((list.messages ?? []) as { id: string }[]).map((m) => m.id);
  const out: InboundMessage[] = [];
  for (const id of ids) {
    const msg = await providerJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      token,
    );
    const headers = (((msg.payload ?? {}) as { headers?: { name: string; value: string }[] }).headers ?? []);
    const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
    const from = header("From");
    const fromEmail = from ? parseFromAddress(from) : null;
    if (!fromEmail) continue;
    out.push({
      fromEmail,
      subject: header("Subject"),
      snippet: typeof msg.snippet === "string" ? msg.snippet.slice(0, SNIPPET_MAX) : null,
      receivedAt: new Date(Number(msg.internalDate ?? Date.now())),
    });
  }
  return out;
}

async function fetchOutlook(token: string, since: Date): Promise<InboundMessage[]> {
  const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`);
  const select = "subject,from,receivedDateTime,bodyPreview";
  const json = await providerJson(
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=${filter}&$orderby=receivedDateTime asc&$top=${MAX_MESSAGES_PER_SYNC}&$select=${select}`,
    token,
  );
  const rows = (json.value ?? []) as {
    subject?: string; bodyPreview?: string; receivedDateTime?: string;
    from?: { emailAddress?: { address?: string } };
  }[];
  const out: InboundMessage[] = [];
  for (const r of rows) {
    const addr = r.from?.emailAddress?.address?.toLowerCase();
    if (!addr) continue;
    out.push({
      fromEmail: addr,
      subject: r.subject ?? null,
      snippet: r.bodyPreview ? r.bodyPreview.slice(0, SNIPPET_MAX) : null,
      receivedAt: r.receivedDateTime ? new Date(r.receivedDateTime) : new Date(),
    });
  }
  return out;
}

// --- Matching + persistence ---------------------------------------------------

/** Log one matched inbound message; returns false when the sender is unknown. */
async function recordMessage(organizationId: string, m: InboundMessage, buyerByEmail: Map<string, { id: string; name: string }>): Promise<boolean> {
  const buyer = buyerByEmail.get(m.fromEmail);
  if (!buyer) return false;

  // Attach to this buyer's most recently active deal relationship.
  const activity = await prisma.dealBuyerActivity.findFirst({
    where: { buyerId: buyer.id, deal: { organizationId } },
    orderBy: { lastActivityDate: "desc" },
    select: { id: true, dealId: true, assignedTeamMemberId: true, sentByUserId: true, lastActivityDate: true, deal: { select: { name: true } } },
  });
  if (!activity) return false; // no outreach on record — nothing to thread onto

  await prisma.$transaction([
    prisma.dealBuyerMessage.create({
      data: {
        organizationId,
        dealId: activity.dealId,
        buyerId: buyer.id,
        activityId: activity.id,
        kind: "EMAIL_IN",
        subject: m.subject,
        body: m.snippet,
        occurredAt: m.receivedAt,
      },
    }),
    prisma.dealBuyerActivity.update({
      where: { id: activity.id },
      data: {
        responseReceived: true,
        ...(activity.lastActivityDate == null || m.receivedAt > activity.lastActivityDate
          ? { lastActivityDate: m.receivedAt }
          : {}),
      },
    }),
    prisma.notification.create({
      data: {
        organizationId,
        userId: activity.assignedTeamMemberId ?? activity.sentByUserId ?? null,
        type: "email_reply",
        title: `Email reply from ${buyer.name}`,
        body: m.subject ?? m.snippet ?? null,
        link: `/deals/${activity.dealId}`,
      },
    }),
  ]);
  return true;
}

/**
 * Pull new inbox mail for a connected gmail/outlook integration and log
 * matched buyer replies. Advances the incremental cursor on success.
 */
export async function syncInboundEmail(row: Integration): Promise<InboundSyncResult> {
  const token = await getFreshAccessToken(row);
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const cursor = typeof cfg.inboundCursor === "string" ? new Date(cfg.inboundCursor) : null;
  const since = cursor && !Number.isNaN(cursor.getTime()) ? cursor : new Date(Date.now() - FIRST_LOOKBACK_MS);

  const fetched = row.provider === "gmail" ? await fetchGmail(token, since) : await fetchOutlook(token, since);
  // Providers filter at coarse granularity; the cursor is exact.
  const fresh = fetched.filter((m) => m.receivedAt > since).sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());

  const buyers = await prisma.buyer.findMany({
    where: { organizationId: row.organizationId, email: { not: null } },
    select: { id: true, name: true, email: true },
  });
  const buyerByEmail = new Map(buyers.map((b) => [b.email!.toLowerCase(), { id: b.id, name: b.name }]));

  let matched = 0;
  let newest = since;
  for (const m of fresh) {
    if (await recordMessage(row.organizationId, m, buyerByEmail)) matched++;
    if (m.receivedAt > newest) newest = m.receivedAt;
  }

  if (newest > since) {
    // Merge-preserve config — it also carries the encrypted token bundle.
    const latest = await prisma.integration.findUnique({ where: { id: row.id }, select: { config: true } });
    const merged = { ...((latest?.config ?? {}) as Record<string, unknown>), inboundCursor: newest.toISOString() };
    await prisma.integration.update({ where: { id: row.id }, data: { config: merged as Prisma.InputJsonValue } });
  }

  return { fetched: fresh.length, matched };
}
