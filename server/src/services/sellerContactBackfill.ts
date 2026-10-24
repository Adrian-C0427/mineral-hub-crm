import { prisma } from "../db.js";
import type { Prisma } from "@prisma/client";
import { normalizePhone } from "../domain/phone.js";
import { splitPersonName } from "../domain/opportunities.js";
import { dealSellerFromInfo, opportunitySellerFromInfo, resolveSellerContact, sellerInfoSchema, type SellerInfo } from "../domain/sellerContact.js";

/**
 * One-time, idempotent: deals and opportunities recorded before sellers
 * became Contacts get their seller Contact, in two passes per organisation.
 *
 *  Pass 1 — LINK. A deal seller row with no contact is linked to the contact
 *  it reliably is: the converted opportunity's contact (primary seller), an
 *  exact email, or an exact phone + exact person / entity name. Never a
 *  similar name.
 *
 *  Pass 2 — CREATE. What is still unlinked but carries seller information
 *  (a name, an entity, an email or a phone) goes through the same resolution
 *  a new deal uses (domain/sellerContact.ts): an existing contact with the
 *  same email, phone + name, or — with no contact details at all — the same
 *  full name is reused, else a contact is created from the stored seller
 *  details (name, entity, phone, email, mailing address). Deals that only
 *  carry legacy seller NAMES (Deal.sellerNames, no seller rows) get a seller
 *  row per name first. Opportunities get Opportunity.contactId the same way;
 *  a converted opportunity takes its deal's primary seller contact.
 *
 *  Ambiguous = more than one contact answers the same reliable key (two
 *  contacts with that email, that phone + name, or — name only — that full
 *  name). Those are never merged: the record is left unlinked and reported.
 *  Records with no seller information at all are reported too.
 *
 * Nothing existing is overwritten: contacts are only created or linked, and
 * a linked contact is only ever FILLED where it was blank. Re-running finds
 * everything already linked (or the contacts the first run created) and
 * changes nothing. The report (ids and reasons, no names) goes to the log.
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

/**
 * Why a seller block must NOT be resolved automatically: more than one
 * contact answers its reliable key. Null when it is safe to resolve.
 */
export function ambiguityOf(s: SellerInfo, contacts: ContactRow[]): string | null {
  if (s.contactId) return null;
  if (s.email) {
    const n = contacts.filter((c) => lower(c.email) === s.email).length;
    return n > 1 ? `${n} contacts share the email` : null;
  }
  const first = lower(s.firstName), last = lower(s.lastName), company = lower(s.companyName);
  const sameName = (c: ContactRow) => (first || last ? lower(c.firstName) === first && lower(c.lastName) === last : true) && lower(c.entityName) === company;
  if (s.phone) {
    const n = contacts.filter((c) => normalizePhone(c.phone) === s.phone && ((first && last && lower(c.firstName) === first && lower(c.lastName) === last) || (company && lower(c.entityName) === company))).length;
    return n > 1 ? `${n} contacts share the phone and name` : null;
  }
  const n = contacts.filter(sameName).length;
  return n > 1 ? `${n} contacts share the name` : null;
}

const LEGAL_FORM = /\b(?:L\.?L\.?C|L\.?P|L\.?L\.?P|LTD|INC|CORP|CO|COMPANY|TRUST|PARTNERSHIP|ESTATE|FOUNDATION|BANK|CHURCH|ASSOCIATION|ASSN|HEIRS|MINERALS|ROYALT(?:Y|IES)|ENERGY|RESOURCES|HOLDINGS|PROPERTIES|INVESTMENTS?)\b/i;

/** A legacy seller NAME (Deal.sellerNames) as a seller block: an entity when it reads like one, else a person. */
export function sellerInfoFromLegacyName(name: string): SellerInfo | null {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) return null;
  const r = LEGAL_FORM.test(n) ? sellerInfoSchema.safeParse({ companyName: n, sellerType: "OTHER" }) : sellerInfoSchema.safeParse({ ...splitPersonName(n), sellerType: "INDIVIDUAL" });
  return r.success ? r.data : null;
}

/** A stored seller row / opportunity as a seller block (an unusable email is dropped rather than blocking the row). */
export function sellerInfoFromStored(s: {
  firstName?: string | null; lastName?: string | null; companyName?: string | null; trustName?: string | null; sellerName?: string | null;
  email?: string | null; phone?: string | null; mailingAddress?: string | null; mailingCity?: string | null; mailingState?: string | null; mailingZip?: string | null;
}): SellerInfo | null {
  const person = s.sellerName && !s.firstName && !s.lastName ? splitPersonName(s.sellerName) : { firstName: s.firstName ?? null, lastName: s.lastName ?? null };
  const base = {
    firstName: person.firstName, lastName: person.lastName, companyName: s.companyName ?? s.trustName ?? null,
    phone: s.phone ?? null, mailingAddress: s.mailingAddress ?? null, mailingCity: s.mailingCity ?? null, mailingState: s.mailingState ?? null, mailingZip: s.mailingZip ?? null,
  };
  const withEmail = sellerInfoSchema.safeParse({ ...base, email: s.email ?? null });
  if (withEmail.success) return withEmail.data;
  const noEmail = sellerInfoSchema.safeParse(base);
  return noEmail.success ? noEmail.data : null;
}

const BATCH = 500;
type Tx = Prisma.TransactionClient;
const asTx = (c: typeof prisma): Tx => c as unknown as Tx;

interface Report { linked: number; created: number; reused: number; sellerRowsAdded: number; skipped: { kind: "deal" | "opportunity"; id: string; reason: string }[] }

export async function backfillSellerContacts(): Promise<Report> {
  const report: Report = { linked: 0, created: 0, reused: 0, sellerRowsAdded: 0, skipped: [] };
  const orgRows = await prisma.organization.findMany({ select: { id: true } });
  for (const { id: organizationId } of orgRows) {
    await linkPass(organizationId, report);
    await createPass(organizationId, report);
  }
  const { linked, created, reused, sellerRowsAdded, skipped } = report;
  if (linked || created || reused || sellerRowsAdded || skipped.length) {
    console.log(`Seller contacts backfill: ${linked} linked, ${reused} matched to existing contacts, ${created} contacts created, ${sellerRowsAdded} seller rows added from legacy names, ${skipped.length} left for review.`);
    for (const s of skipped) console.log(`  review ${s.kind} ${s.id}: ${s.reason}`);
  }
  return report;
}

/** Pass 1 — link by reliable identifiers only. */
async function linkPass(organizationId: string, report: Report): Promise<void> {
  const contacts = await prisma.contact.findMany({ where: { organizationId }, select: { id: true, firstName: true, lastName: true, entityName: true, email: true, phone: true } });
  const converted = await prisma.opportunity.findMany({ where: { organizationId, convertedDealId: { not: null }, contactId: { not: null } }, select: { convertedDealId: true, contactId: true } });
  const convertedContact = new Map(converted.map((o) => [o.convertedDealId!, o.contactId!]));
  if (contacts.length === 0) return;
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
      if (contactId) { await prisma.dealSeller.update({ where: { id: s.id }, data: { contactId } }); report.linked++; }
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH) break;
  }
}

/** Pass 2 — reuse or create contacts from the stored seller details. */
async function createPass(organizationId: string, report: Report): Promise<void> {
  const notFound = (m: string) => new Error(m);
  const contactsNow = () => prisma.contact.findMany({ where: { organizationId }, select: { id: true, firstName: true, lastName: true, entityName: true, email: true, phone: true } });

  // 2a. Deals with no seller rows at all but legacy seller names → one seller row per name.
  const nameOnly = await prisma.deal.findMany({
    where: { organizationId, sellers: { none: {} }, NOT: { sellerNames: { isEmpty: true } } },
    select: { id: true, sellerNames: true },
  });
  for (const d of nameOnly) {
    let first = true;
    for (const raw of d.sellerNames) {
      const info = sellerInfoFromLegacyName(raw);
      if (!info) continue;
      await prisma.dealSeller.create({
        data: { dealId: d.id, isPrimary: first, sellerType: info.sellerType ?? "INDIVIDUAL", firstName: info.firstName, lastName: info.lastName, companyName: info.companyName },
      });
      report.sellerRowsAdded++;
      first = false;
    }
  }

  // 2b. Seller rows still without a contact.
  const sellers = await prisma.dealSeller.findMany({
    where: { contactId: null, deal: { organizationId } },
    select: {
      id: true, dealId: true, firstName: true, lastName: true, companyName: true, trustName: true, email: true, primaryPhone: true,
      mailingAddress: true, mailingCity: true, mailingState: true, mailingZip: true, deal: { select: { relationshipOwnerId: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const noInfoDeals = new Set<string>();
  for (const s of sellers) {
    const info = sellerInfoFromStored({ ...s, phone: s.primaryPhone });
    if (!info) { noInfoDeals.add(s.dealId); continue; }
    const contacts = await contactsNow();
    const why = ambiguityOf(info, contacts);
    if (why) { report.skipped.push({ kind: "deal", id: s.dealId, reason: why }); continue; }
    const { contact, created } = await prisma.$transaction(async (tx) => {
      const r = await resolveSellerContact(tx, organizationId, info, { ownerId: s.deal.relationshipOwnerId, type: "SELLER", notFound });
      const fill = dealSellerFromInfo(info, r.contact);
      await tx.dealSeller.update({
        where: { id: s.id },
        data: {
          contactId: r.contact.id,
          // Only blanks are filled from the contact; the row's own values stay.
          firstName: s.firstName ?? fill.firstName, lastName: s.lastName ?? fill.lastName, companyName: s.companyName ?? fill.companyName,
          primaryPhone: s.primaryPhone ?? fill.primaryPhone, email: s.email ?? fill.email,
          mailingAddress: s.mailingAddress ?? fill.mailingAddress, mailingCity: s.mailingCity ?? fill.mailingCity, mailingState: s.mailingState ?? fill.mailingState, mailingZip: s.mailingZip ?? fill.mailingZip,
        },
      });
      return r;
    });
    if (created) report.created++; else report.reused++;
    void contact;
  }
  // A deal with seller rows that carry no information at all, and no linked seller either.
  for (const dealId of noInfoDeals) {
    const linked = await prisma.dealSeller.count({ where: { dealId, contactId: { not: null } } });
    if (!linked) report.skipped.push({ kind: "deal", id: dealId, reason: "seller recorded without a name, entity, email or phone" });
  }
  const noSeller = await prisma.deal.findMany({ where: { organizationId, sellers: { none: {} } }, select: { id: true } });
  for (const d of noSeller) report.skipped.push({ kind: "deal", id: d.id, reason: "no seller information on the deal" });

  // 2c. Opportunities without a contact.
  const opps = await prisma.opportunity.findMany({
    where: { organizationId, contactId: null },
    select: { id: true, sellerName: true, companyName: true, phone: true, email: true, ownerId: true, convertedDealId: true },
    orderBy: { createdAt: "asc" },
  });
  for (const o of opps) {
    // A converted opportunity's seller is its deal's primary seller.
    if (o.convertedDealId) {
      const primary = await prisma.dealSeller.findFirst({ where: { dealId: o.convertedDealId, contactId: { not: null } }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], select: { contactId: true } });
      if (primary?.contactId) { await prisma.opportunity.update({ where: { id: o.id }, data: { contactId: primary.contactId } }); report.linked++; continue; }
    }
    const info = sellerInfoFromStored(o);
    if (!info) { report.skipped.push({ kind: "opportunity", id: o.id, reason: "no seller information on the opportunity" }); continue; }
    const why = ambiguityOf(info, await contactsNow());
    if (why) { report.skipped.push({ kind: "opportunity", id: o.id, reason: why }); continue; }
    const { created } = await prisma.$transaction(async (tx) => {
      const r = await resolveSellerContact(tx, organizationId, info, { ownerId: o.ownerId, type: "PROSPECT", notFound });
      const cols = opportunitySellerFromInfo(info, r.contact);
      await tx.opportunity.update({
        where: { id: o.id },
        data: { contactId: r.contact.id, sellerName: o.sellerName ?? cols.sellerName, companyName: o.companyName ?? cols.companyName, phone: o.phone ?? cols.phone, email: o.email ?? cols.email },
      });
      return r;
    });
    if (created) report.created++; else report.reused++;
  }
  void asTx;
}
