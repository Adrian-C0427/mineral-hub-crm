/**
 * The CRM records emails and cloud files can be linked to — deals (which
 * include mineral assets), opportunities, contacts and buyers — and the access
 * check every link operation runs server-side: the record must be in the
 * caller's organization and their role must be allowed to see it (deals and
 * opportunities → viewDeals, contacts → viewContacts, buyers → viewBuyers).
 * A record the caller can't see answers 404, not 403.
 */
import { z } from "zod";
import { prisma } from "../../db.js";
import { HttpError } from "../../middleware/errors.js";
import { hasPermission, orgId, type AuthedRequest } from "../../middleware/auth.js";
import type { Permission } from "../../domain/permissions.js";
import { contactName } from "../../domain/contactName.js";

export const RECORD_TYPES = ["deal", "opportunity", "contact", "buyer"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export interface RecordRef { type: RecordType; id: string }

export const recordRefSchema = z.object({ type: z.enum(RECORD_TYPES), id: z.string().min(1).max(200) });

export const RECORD_VIEW_PERMISSION: Record<RecordType, Permission> = {
  deal: "viewDeals", opportunity: "viewDeals", contact: "viewContacts", buyer: "viewBuyers",
};

/** "deal:<id>" — one link row per item per record. */
export const recordKey = (r: RecordRef) => `${r.type}:${r.id}`;

/** The link row's foreign-key column for the record. */
export function recordColumns(r: RecordRef): { dealId?: string; opportunityId?: string; contactId?: string; buyerId?: string } {
  return { [`${r.type}Id`]: r.id } as never;
}

export interface LoadedRecord { ref: RecordRef; name: string; emails: string[] }

/** The record if it's in the caller's org and their role can see it; otherwise 404. */
export async function loadRecord(req: AuthedRequest, ref: RecordRef): Promise<LoadedRecord> {
  const org = orgId(req);
  const notFound = () => new HttpError(404, "Record not found.");
  if (!hasPermission(req, RECORD_VIEW_PERMISSION[ref.type])) throw notFound();
  const lower = (e: string | null | undefined) => (e ? [e.trim().toLowerCase()] : []);
  switch (ref.type) {
    case "deal": {
      const d = await prisma.deal.findFirst({ where: { id: ref.id, organizationId: org }, select: { name: true } });
      if (!d) throw notFound();
      return { ref, name: d.name, emails: [] };
    }
    case "opportunity": {
      const o = await prisma.opportunity.findFirst({ where: { id: ref.id, organizationId: org }, select: { name: true, email: true, contact: { select: { email: true } } } });
      if (!o) throw notFound();
      return { ref, name: o.name, emails: [...new Set([...lower(o.email), ...lower(o.contact?.email)])] };
    }
    case "contact": {
      const c = await prisma.contact.findFirst({ where: { id: ref.id, organizationId: org }, select: { firstName: true, middleName: true, lastName: true, entityName: true, email: true } });
      if (!c) throw notFound();
      return { ref, name: contactName(c) || "Contact", emails: lower(c.email) };
    }
    case "buyer": {
      const b = await prisma.buyer.findFirst({ where: { id: ref.id, organizationId: org }, select: { name: true, email: true } });
      if (!b) throw notFound();
      return { ref, name: b.name, emails: lower(b.email) };
    }
  }
}

/** The record a link row points at (whichever FK is set). */
export function refOf(row: { dealId: string | null; opportunityId: string | null; contactId: string | null; buyerId: string | null }): RecordRef | null {
  if (row.dealId) return { type: "deal", id: row.dealId };
  if (row.opportunityId) return { type: "opportunity", id: row.opportunityId };
  if (row.contactId) return { type: "contact", id: row.contactId };
  if (row.buyerId) return { type: "buyer", id: row.buyerId };
  return null;
}

/** Display names for linked records (org-scoped; records the caller can't see are left unnamed). */
export async function recordNames(req: AuthedRequest, refs: readonly (RecordRef | null)[]): Promise<Map<string, string>> {
  const org = orgId(req);
  const ids = (t: RecordType) => [...new Set(refs.filter((r): r is RecordRef => !!r && r.type === t).map((r) => r.id))];
  const out = new Map<string, string>();
  const can = (t: RecordType) => hasPermission(req, RECORD_VIEW_PERMISSION[t]);
  if (can("deal") && ids("deal").length) for (const d of await prisma.deal.findMany({ where: { id: { in: ids("deal") }, organizationId: org }, select: { id: true, name: true } })) out.set(`deal:${d.id}`, d.name);
  if (can("opportunity") && ids("opportunity").length) for (const o of await prisma.opportunity.findMany({ where: { id: { in: ids("opportunity") }, organizationId: org }, select: { id: true, name: true } })) out.set(`opportunity:${o.id}`, o.name);
  if (can("contact") && ids("contact").length) for (const c of await prisma.contact.findMany({ where: { id: { in: ids("contact") }, organizationId: org }, select: { id: true, firstName: true, middleName: true, lastName: true, entityName: true } })) out.set(`contact:${c.id}`, contactName(c) || "Contact");
  if (can("buyer") && ids("buyer").length) for (const b of await prisma.buyer.findMany({ where: { id: { in: ids("buyer") }, organizationId: org }, select: { id: true, name: true } })) out.set(`buyer:${b.id}`, b.name);
  return out;
}
