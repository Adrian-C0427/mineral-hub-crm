/**
 * Emails on CRM records: which records an email involves, the links, and the
 * activity history entries — each written exactly once per email (unique
 * keys on EmailLink and on the timeline rows' emailMessageId), so re-syncing,
 * retrying a send, or a webhook arriving twice never duplicates anything.
 *
 * A "reliable match" (automatic linking) is an exact address match: a
 * contact's or buyer's email among the message's From / To / Cc — never the
 * mailbox owner's own address or another team member's (internal mail). A
 * later message in a conversation that is already on a record joins it too.
 *
 * Timeline entries:
 *   contact  → a ContactActivity EMAIL (shows in the contact's activity)
 *   buyer    → for a reply FROM the buyer: a DealBuyerMessage EMAIL_IN on
 *              their most recently active deal, responseReceived set, and a
 *              notification — the same behavior the inbox sync always had
 */
import type { ConnectedAccount, EmailMessage, Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { recordKey, type RecordRef } from "../connected/records.js";
import { htmlToText } from "./html.js";
import { pushTeams } from "../notifyPush.js";

export interface MatchedRecords { refs: RecordRef[]; buyerByEmail: Map<string, string> }

/** Records whose email is among `addresses` (org-scoped, exact, case-insensitive). */
export async function matchAddresses(orgId: string, addresses: readonly string[], exclude: readonly string[] = []): Promise<MatchedRecords> {
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => a && !skip.has(a)))];
  if (!wanted.length) return { refs: [], buyerByEmail: new Map() };
  const insensitive = wanted.map((e) => ({ email: { equals: e, mode: "insensitive" as const } }));
  const [contacts, buyers] = await Promise.all([
    prisma.contact.findMany({ where: { organizationId: orgId, OR: insensitive }, select: { id: true }, take: 20 }),
    prisma.buyer.findMany({ where: { organizationId: orgId, OR: insensitive }, select: { id: true, email: true }, take: 20 }),
  ]);
  return {
    refs: [...contacts.map((c) => ({ type: "contact" as const, id: c.id })), ...buyers.map((b) => ({ type: "buyer" as const, id: b.id }))],
    buyerByEmail: new Map(buyers.map((b) => [b.email!.toLowerCase(), b.id])),
  };
}

/** Addresses of everyone in the organization (their mail to each other isn't "about" a record). */
export async function teamAddresses(orgId: string): Promise<string[]> {
  const [users, accounts] = await Promise.all([
    prisma.user.findMany({ where: { organizationId: orgId }, select: { email: true } }),
    prisma.connectedAccount.findMany({ where: { organizationId: orgId, provider: "outlook" }, select: { email: true } }),
  ]);
  return [...users.map((u) => u.email), ...accounts.map((a) => a.email)].filter((e): e is string => !!e).map((e) => e.toLowerCase());
}

/** Records already holding another message of this conversation. */
export async function conversationRecords(orgId: string, accountId: string, conversationId: string | null): Promise<RecordRef[]> {
  if (!conversationId) return [];
  const links = await prisma.emailLink.findMany({
    where: { organizationId: orgId, message: { accountId, conversationId } },
    select: { contactId: true, dealId: true, opportunityId: true, buyerId: true }, take: 50,
  });
  const seen = new Map<string, RecordRef>();
  for (const l of links) {
    const ref: RecordRef | null = l.contactId ? { type: "contact", id: l.contactId } : l.dealId ? { type: "deal", id: l.dealId }
      : l.opportunityId ? { type: "opportunity", id: l.opportunityId } : l.buyerId ? { type: "buyer", id: l.buyerId } : null;
    if (ref) seen.set(recordKey(ref), ref);
  }
  return [...seen.values()];
}

/** Link an email to records (idempotent). */
export async function linkEmail(msg: Pick<EmailMessage, "id" | "organizationId">, refs: readonly RecordRef[], source: "AUTO" | "MANUAL" | "SENT", userId: string | null): Promise<void> {
  for (const ref of refs) {
    const key = recordKey(ref);
    await prisma.emailLink.upsert({
      where: { messageId_recordKey: { messageId: msg.id, recordKey: key } },
      create: { organizationId: msg.organizationId, messageId: msg.id, recordKey: key, [`${ref.type}Id`]: ref.id, source, createdByUserId: userId } as Prisma.EmailLinkUncheckedCreateInput,
      update: {},
    });
  }
}

/**
 * Activity history for a linked email: a contact EMAIL entry per linked
 * contact (one per email — the unique emailMessageId means the first linked
 * contact holds it), and the deal-buyer reply bookkeeping for buyers.
 */
export async function recordTimeline(msg: EmailMessage, account: Pick<ConnectedAccount, "userId">, refs: readonly RecordRef[]): Promise<void> {
  const subject = msg.subject?.trim() || "(no subject)";
  const text = msg.bodyPreview || (msg.bodyHtml ? htmlToText(msg.bodyHtml, 500) : "");
  const when = msg.direction === "in" ? msg.receivedAt ?? msg.createdAt : msg.sentAt ?? msg.createdAt;

  const contact = refs.find((r) => r.type === "contact");
  if (contact) {
    const exists = await prisma.contactActivity.findUnique({ where: { emailMessageId: msg.id }, select: { id: true } });
    if (!exists) {
      await prisma.contactActivity.create({
        data: {
          organizationId: msg.organizationId, contactId: contact.id, kind: "EMAIL", emailMessageId: msg.id,
          title: `${msg.direction === "in" ? "Email from" : "Email to"} ${msg.direction === "in" ? msg.fromName ?? msg.fromAddress ?? "contact" : recipientsText(msg)} — ${subject}`.slice(0, 200),
          body: text || subject, createdById: account.userId, createdAt: when,
        },
      }).catch((e: unknown) => { if (!isUniqueViolation(e)) throw e; });
      if (msg.direction === "out" || msg.direction === "in") {
        await prisma.contact.updateMany({ where: { id: contact.id, OR: [{ lastContactedAt: null }, { lastContactedAt: { lt: when } }] }, data: { lastContactedAt: when } });
      }
    }
  }

  const buyer = refs.find((r) => r.type === "buyer");
  if (buyer && msg.direction === "in") await buyerReply(msg, buyer.id, subject, text, when);
}

function recipientsText(msg: EmailMessage): string {
  const to = (msg.toRecipients as { name?: string | null; address: string }[] | null) ?? [];
  const first = to[0];
  return first ? `${first.name ?? first.address}${to.length > 1 ? ` +${to.length - 1}` : ""}` : "recipient";
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** A buyer replied: their most recent deal outreach gets the reply, marked answered, with a notification. */
async function buyerReply(msg: EmailMessage, buyerId: string, subject: string, text: string, when: Date): Promise<void> {
  const exists = await prisma.dealBuyerMessage.findUnique({ where: { emailMessageId: msg.id }, select: { id: true } });
  if (exists) return;
  const activity = await prisma.dealBuyerActivity.findFirst({
    where: { buyerId, deal: { organizationId: msg.organizationId } },
    orderBy: { lastActivityDate: "desc" },
    select: { id: true, dealId: true, assignedTeamMemberId: true, sentByUserId: true, lastActivityDate: true, buyer: { select: { name: true } } },
  });
  if (!activity) return; // no outreach on record to thread the reply onto
  try {
    await prisma.$transaction([
      prisma.dealBuyerMessage.create({
        data: { organizationId: msg.organizationId, dealId: activity.dealId, buyerId, activityId: activity.id, kind: "EMAIL_IN", subject, body: text, occurredAt: when, emailMessageId: msg.id },
      }),
      prisma.dealBuyerActivity.update({
        where: { id: activity.id },
        data: { responseReceived: true, ...(activity.lastActivityDate == null || when > activity.lastActivityDate ? { lastActivityDate: when } : {}) },
      }),
      prisma.notification.create({
        data: {
          organizationId: msg.organizationId, userId: activity.assignedTeamMemberId ?? activity.sentByUserId ?? null,
          type: "email_reply", title: `Email reply from ${activity.buyer.name}`, body: subject, link: `/deals/${activity.dealId}`,
        },
      }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) return;
    throw e;
  }
  // Await so a test (or a caller) sees it; pushTeams never throws.
  await pushTeams(msg.organizationId, { title: `Email reply from ${activity.buyer.name}`, body: subject, link: `/deals/${activity.dealId}` });
  await prisma.emailLink.upsert({
    where: { messageId_recordKey: { messageId: msg.id, recordKey: `deal:${activity.dealId}` } },
    create: { organizationId: msg.organizationId, messageId: msg.id, recordKey: `deal:${activity.dealId}`, dealId: activity.dealId, source: "AUTO" },
    update: {},
  });
}

/** Sent from a deal to a buyer (bulk or individual): the outreach bookkeeping, once. */
export async function dealOutreach(msg: EmailMessage, dealId: string, buyerId: string, userId: string, threadId: string | null): Promise<void> {
  const exists = await prisma.dealBuyerMessage.findUnique({ where: { emailMessageId: msg.id }, select: { id: true } });
  if (exists) return;
  const now = msg.sentAt ?? new Date();
  await prisma.$transaction(async (tx) => {
    const activity = await tx.dealBuyerActivity.upsert({
      where: { dealId_buyerId: { dealId, buyerId } },
      create: { dealId, buyerId, status: "CONTACTED", dateSent: now, lastActivityDate: now, sentByUserId: userId },
      update: { lastActivityDate: now },
    });
    await tx.dealBuyerMessage.create({
      data: {
        organizationId: msg.organizationId, dealId, buyerId, activityId: activity.id, kind: "EMAIL_OUT",
        subject: msg.subject, body: msg.bodyHtml, occurredAt: now, createdByUserId: userId, threadId, emailMessageId: msg.id,
      },
    });
  });
}
