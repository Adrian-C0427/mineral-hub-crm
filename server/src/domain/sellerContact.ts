import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { normalizePhone } from "./phone.js";

/**
 * Seller information ↔ Contact.
 *
 * Creating a deal or an opportunity captures the seller through one shared
 * block (`sellerInfoSchema`, the client's SellerInformation component). The
 * seller IS a Contact: the block either names an existing Contact
 * (`contactId`) or describes one, in which case an existing Contact with the
 * same email, the same phone + name, or (with no contact details) the same
 * name is reused and only otherwise created — so retries and the same seller
 * on a second deal never produce duplicate contacts. The link lives on
 * DealSeller.contactId / Opportunity.contactId; the Contact stays the source
 * of truth for the shared identity and contact details (name, company, phone,
 * email, mailing address) while deal-specific details (trust name, physical
 * address, internal notes…) stay on the deal's seller row.
 *
 * Everything here takes the caller's transaction client so the contact and
 * the record that links it are created together or not at all.
 */

export const SELLER_TYPES = ["INDIVIDUAL", "TRUST", "LLC", "CORPORATION", "ESTATE", "PARTNERSHIP", "OTHER"] as const;
export type SellerType = (typeof SELLER_TYPES)[number];

const text = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const sellerInfoSchema = z
  .object({
    /** An existing Contact to link (must be in the caller's org). */
    contactId: z.string().max(200).nullish().transform((v) => (v ? v : null)),
    sellerType: z.enum(SELLER_TYPES).optional(),
    firstName: text(120),
    lastName: text(120),
    /** Company / entity name (trust, LLC, estate…). */
    companyName: text(200),
    phone: text(40).transform((v) => (v ? normalizePhone(v) || null : null)),
    email: text(200).transform((v) => (v ? v.toLowerCase() : null)),
    mailingAddress: text(300),
    mailingCity: text(120),
    mailingState: text(40),
    mailingZip: text(20),
  })
  .superRefine((s, ctx) => {
    if (!s.contactId && !s.firstName && !s.lastName && !s.companyName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Seller information needs a name or an entity name" });
    }
    if (s.email && !EMAIL_RE.test(s.email)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "Seller email is not a valid address" });
  });
export type SellerInfo = z.infer<typeof sellerInfoSchema>;

/** The Contact columns the seller link shares. */
export interface SellerContactRow {
  id: string;
  firstName: string;
  lastName: string;
  entityName: string | null;
  phone: string | null;
  email: string | null;
  preferredContact: string | null;
  mailingStreet: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  /** Geography of interest (filled from the first deal when the contact has none). */
  states?: string[];
  counties?: string[];
}
export const sellerContactSelect = {
  id: true, firstName: true, lastName: true, entityName: true, phone: true, email: true, preferredContact: true,
  mailingStreet: true, mailingCity: true, mailingState: true, mailingZip: true, states: true, counties: true,
} as const;

/**
 * A contact with no geography of interest yet takes the deal's (states and
 * counties) when it becomes that deal's seller — the contact's own entries
 * are never overwritten.
 */
export async function fillContactGeography(tx: Tx, contact: SellerContactRow, geo: { states?: string[] | null; counties?: string[] | null }): Promise<void> {
  const data: { states?: string[]; counties?: string[] } = {};
  if (!(contact.states ?? []).length && geo.states?.length) data.states = geo.states;
  if (!(contact.counties ?? []).length && geo.counties?.length) data.counties = geo.counties;
  if (Object.keys(data).length) await tx.contact.update({ where: { id: contact.id }, data });
}

type Tx = Prisma.TransactionClient;

const lower = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
const same = (a: string | null | undefined, b: string | null | undefined) => lower(a) === lower(b);

/** An entity-only contact is filed under its entity name (firstName = entity,
 *  no last name): its person-name fields read as blank. */
export function contactPersonName(c: Pick<SellerContactRow, "firstName" | "lastName" | "entityName">): { firstName: string | null; lastName: string | null } {
  const entityOnly = !!c.entityName && !c.lastName && c.firstName === c.entityName;
  return entityOnly ? { firstName: null, lastName: null } : { firstName: c.firstName || null, lastName: c.lastName || null };
}

/** "Mary Hernandez" — the person's name, else the entity, else "". */
export function sellerInfoName(s: Pick<SellerInfo, "firstName" | "lastName" | "companyName">): string {
  return [s.firstName, s.lastName].filter(Boolean).join(" ") || s.companyName || "";
}

/**
 * The Contact an existing contact-less seller block matches, if any:
 *   1. the same email (case-insensitive);
 *   2. the same phone number AND the same person or entity name;
 *   3. with neither an email nor a phone given: the same person name AND the
 *      same entity name (none on both sides counts as the same).
 * A match on name alone with contact details present is NOT taken — two
 * different John Smiths must not be merged because one has a phone.
 */
export async function matchSellerContact(tx: Tx, organizationId: string, s: SellerInfo): Promise<SellerContactRow | null> {
  if (s.email) {
    const byEmail = await tx.contact.findFirst({
      where: { organizationId, email: { equals: s.email, mode: "insensitive" } },
      select: sellerContactSelect, orderBy: { updatedAt: "desc" },
    });
    if (byEmail) return byEmail;
  }
  const hasName = !!(s.firstName || s.lastName);
  const nameWhere: Prisma.ContactWhereInput[] = [];
  if (hasName) nameWhere.push({ firstName: { equals: s.firstName ?? "", mode: "insensitive" }, lastName: { equals: s.lastName ?? "", mode: "insensitive" } });
  if (s.companyName) nameWhere.push({ entityName: { equals: s.companyName, mode: "insensitive" } });
  if (nameWhere.length === 0) return null;
  const candidates = await tx.contact.findMany({
    where: { organizationId, OR: nameWhere },
    select: sellerContactSelect, orderBy: { updatedAt: "desc" }, take: 50,
  });
  if (s.phone) return candidates.find((c) => normalizePhone(c.phone) === s.phone) ?? null;
  if (s.email) return null; // an email was given and nobody has it: a new contact
  // No contact details at all: the whole name must agree.
  return candidates.find((c) =>
    same(c.firstName, s.firstName) && same(c.lastName, s.lastName) && same(c.entityName, s.companyName)) ?? null;
}

/**
 * Resolve the seller block to a Contact in the caller's org: the named one
 * (400 when it isn't the caller's), else a match (see matchSellerContact),
 * else a new Contact built from the block. A linked or matched contact only
 * gains details it was missing — nothing it already holds is overwritten.
 */
export async function resolveSellerContact(
  tx: Tx,
  organizationId: string,
  s: SellerInfo,
  opts: { ownerId?: string | null; type?: "SELLER" | "PROSPECT"; notFound: (msg: string) => Error },
): Promise<{ contact: SellerContactRow; created: boolean }> {
  let existing: SellerContactRow | null = null;
  if (s.contactId) {
    existing = await tx.contact.findFirst({ where: { id: s.contactId, organizationId }, select: sellerContactSelect });
    if (!existing) throw opts.notFound("Contact not found in your organization");
  } else {
    existing = await matchSellerContact(tx, organizationId, s);
  }
  if (existing) {
    const fill: Prisma.ContactUpdateInput = {};
    if (!existing.entityName && s.companyName) fill.entityName = s.companyName;
    if (!existing.phone && s.phone) fill.phone = s.phone;
    if (!existing.email && s.email) fill.email = s.email;
    if (!existing.mailingStreet && s.mailingAddress) fill.mailingStreet = s.mailingAddress;
    if (!existing.mailingCity && s.mailingCity) fill.mailingCity = s.mailingCity;
    if (!existing.mailingState && s.mailingState) fill.mailingState = s.mailingState;
    if (!existing.mailingZip && s.mailingZip) fill.mailingZip = s.mailingZip;
    if (Object.keys(fill).length) {
      existing = await tx.contact.update({ where: { id: existing.id }, data: fill, select: sellerContactSelect });
    }
    return { contact: existing, created: false };
  }
  // Contact needs a first name: an entity-only seller is filed under its
  // entity name (the Contacts page shows `firstName lastName`).
  const created = await tx.contact.create({
    data: {
      organizationId,
      firstName: s.firstName ?? (s.lastName ? "" : s.companyName ?? ""),
      lastName: s.lastName ?? "",
      entityName: s.companyName ?? null,
      type: opts.type ?? "SELLER",
      status: "NEW",
      email: s.email ?? null,
      phone: s.phone ?? null,
      mailingStreet: s.mailingAddress ?? null,
      mailingCity: s.mailingCity ?? null,
      mailingState: s.mailingState ?? null,
      mailingZip: s.mailingZip ?? null,
      ownerId: opts.ownerId ?? null,
    },
    select: sellerContactSelect,
  });
  return { contact: created, created: true };
}

/** Contact.preferredContact codes → DealSeller.preferredContactMethod labels. */
const PREFERRED_METHOD: Record<string, string> = { CALL: "Phone", PHONE: "Phone", TEXT: "Text", EMAIL: "Email", MAIL: "Mail" };
export function preferredMethodLabel(code: string | null | undefined): string | null {
  const c = (code ?? "").trim();
  return c ? PREFERRED_METHOD[c.toUpperCase()] ?? c : null;
}

/**
 * The deal's seller row for a resolved contact: the block's values first (what
 * the user just typed), the contact's for anything left blank.
 */
export function dealSellerFromInfo(s: SellerInfo, c: SellerContactRow) {
  const phone = s.phone ?? (c.phone ? normalizePhone(c.phone) || null : null);
  const person = contactPersonName(c);
  return {
    contactId: c.id,
    isPrimary: true,
    sellerType: s.sellerType ?? (s.companyName || c.entityName ? ("OTHER" as SellerType) : ("INDIVIDUAL" as SellerType)),
    firstName: s.firstName ?? person.firstName,
    lastName: s.lastName ?? person.lastName,
    companyName: s.companyName ?? c.entityName,
    primaryPhone: phone,
    email: s.email ?? c.email,
    preferredContactMethod: preferredMethodLabel(c.preferredContact),
    mailingAddress: s.mailingAddress ?? c.mailingStreet,
    mailingCity: s.mailingCity ?? c.mailingCity,
    mailingState: s.mailingState ?? c.mailingState,
    mailingZip: s.mailingZip ?? c.mailingZip,
  };
}

/** The opportunity's plain seller columns for a resolved contact. */
export function opportunitySellerFromInfo(s: SellerInfo, c: SellerContactRow) {
  const person = contactPersonName(c);
  const name = [s.firstName ?? person.firstName, s.lastName ?? person.lastName].filter(Boolean).join(" ").trim();
  return {
    contactId: c.id,
    sellerName: name || null,
    companyName: s.companyName ?? c.entityName,
    phone: s.phone ?? (c.phone ? normalizePhone(c.phone) || null : null),
    email: s.email ?? c.email,
  };
}

/**
 * Mirror a seller edit onto its linked Contact — only the shared fields the
 * patch names (DealSeller column names in, Contact columns out). Clearing a
 * field clears it on the contact too; a name can't be null on a Contact, so
 * it becomes "".
 */
export function contactPatchFromSellerPatch(p: {
  firstName?: string | null; lastName?: string | null; companyName?: string | null;
  primaryPhone?: string | null; email?: string | null;
  mailingAddress?: string | null; mailingCity?: string | null; mailingState?: string | null; mailingZip?: string | null;
}): Prisma.ContactUpdateInput {
  const out: Prisma.ContactUpdateInput = {};
  if (p.firstName !== undefined) out.firstName = p.firstName ?? "";
  if (p.lastName !== undefined) out.lastName = p.lastName ?? "";
  if (p.companyName !== undefined) out.entityName = p.companyName;
  if (p.primaryPhone !== undefined) out.phone = p.primaryPhone;
  if (p.email !== undefined) out.email = p.email;
  if (p.mailingAddress !== undefined) out.mailingStreet = p.mailingAddress;
  if (p.mailingCity !== undefined) out.mailingCity = p.mailingCity;
  if (p.mailingState !== undefined) out.mailingState = p.mailingState;
  if (p.mailingZip !== undefined) out.mailingZip = p.mailingZip;
  return out;
}

/** Non-empty contact value, else the seller row's own copy. */
const pick = <T extends string | null>(c: T | undefined, s: T): T => (c != null && c !== "" ? c : s);

/**
 * A DealSeller row as the API shows it: the linked Contact's shared fields
 * overlay the row's copy (the Contact is the source of truth), everything
 * deal-specific comes from the row.
 */
export function overlayContact<S extends {
  firstName: string | null; lastName: string | null; companyName: string | null;
  primaryPhone: string | null; email: string | null;
  mailingAddress: string | null; mailingCity: string | null; mailingState: string | null; mailingZip: string | null;
}>(s: S, c: SellerContactRow | null | undefined): S {
  if (!c) return s;
  const person = contactPersonName(c);
  return {
    ...s,
    firstName: pick(person.firstName, s.firstName),
    lastName: pick(person.lastName, s.lastName),
    companyName: pick(c.entityName, s.companyName),
    primaryPhone: pick(c.phone ? normalizePhone(c.phone) || null : null, s.primaryPhone),
    email: pick(c.email, s.email),
    mailingAddress: pick(c.mailingStreet, s.mailingAddress),
    mailingCity: pick(c.mailingCity, s.mailingCity),
    mailingState: pick(c.mailingState, s.mailingState),
    mailingZip: pick(c.mailingZip, s.mailingZip),
  };
}
