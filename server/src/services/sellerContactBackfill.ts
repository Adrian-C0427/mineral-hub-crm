import { prisma } from "../db.js";
import { normalizePhone } from "../domain/phone.js";

/**
 * One-time, idempotent: deal sellers recorded before sellers became Contacts
 * (DealSeller.contactId null) are linked to the Contact they reliably are —
 * never by a similar name:
 *  1. the deal was converted from an opportunity that had a linked contact →
 *     the deal's primary seller is that contact;
 *  2. the seller's email equals a contact's email in the org (case-insensitive);
 *  3. the seller's phone equals a contact's phone AND the person name (or the
 *     company ↔ entity name) is the same, exactly.
 * Nothing else is touched: no contact is created, no field rewritten. Rows
 * that match nothing stay unlinked (the deal page's seller editor can link
 * them by hand). Logs counts only.
 */

interface SellerRow {
  id: string; dealId: string; isPrimary: boolean; contactId: string | null;
  firstName: string | null; lastName: string | null; companyName: string | null; email: string | null; primaryPhone: string | null;
}
interface ContactRow { id: string; firstName: string; lastName: string; entityName: string | null; email: string | null; phone: string | null }

const lower = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** The contact a seller row reliably is, from the org's contacts (pure). */
export function matchSellerToContact(s: SellerRow, contacts: ContactRow[], convertedContactId: string | null): string | null {
  if (convertedContactId && s.isPrimary) return convertedContactId;
  const email = lower(s.email);
  if (email) {
    const c = contacts.find((x) => lower(x.email) === email);
    if (c) return c.id;
  }
  const phone = normalizePhone(s.primaryPhone);
  if (phone) {
    const first = lower(s.firstName), last = lower(s.lastName), company = lower(s.companyName);
    const c = contacts.find((x) => normalizePhone(x.phone) === phone && (
      (first && last && lower(x.firstName) === first && lower(x.lastName) === last)
      || (company && lower(x.entityName) === company)));
    if (c) return c.id;
  }
  return null;
}

const BATCH = 500;

export async function backfillSellerContacts(): Promise<number> {
  let linked = 0;
  const orgs = await prisma.dealSeller.findMany({ where: { contactId: null }, select: { deal: { select: { organizationId: true } } }, distinct: ["dealId"] });
  const orgIds = [...new Set(orgs.map((r) => r.deal.organizationId).filter((v): v is string => !!v))];
  for (const organizationId of orgIds) {
    const contacts = await prisma.contact.findMany({ where: { organizationId }, select: { id: true, firstName: true, lastName: true, entityName: true, email: true, phone: true } });
    if (contacts.length === 0) continue;
    // Deals converted from an opportunity that carried a contact.
    const converted = await prisma.opportunity.findMany({ where: { organizationId, convertedDealId: { not: null }, contactId: { not: null } }, select: { convertedDealId: true, contactId: true } });
    const convertedContact = new Map(converted.map((o) => [o.convertedDealId!, o.contactId!]));
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.dealSeller.findMany({
        where: { contactId: null, deal: { organizationId }, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, dealId: true, isPrimary: true, contactId: true, firstName: true, lastName: true, companyName: true, email: true, primaryPhone: true },
        orderBy: { id: "asc" }, take: BATCH,
      });
      if (rows.length === 0) break;
      for (const s of rows) {
        const contactId = matchSellerToContact(s, contacts, convertedContact.get(s.dealId) ?? null);
        if (contactId) { await prisma.dealSeller.update({ where: { id: s.id }, data: { contactId } }); linked++; }
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < BATCH) break;
    }
  }
  if (linked) console.log(`Seller contacts backfill: linked ${linked} deal seller${linked === 1 ? "" : "s"} to their contact.`);
  return linked;
}
