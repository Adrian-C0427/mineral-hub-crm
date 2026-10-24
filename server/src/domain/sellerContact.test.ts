import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  contactPatchFromSellerPatch, dealSellerFromInfo, matchSellerContact, opportunitySellerFromInfo, overlayContact,
  resolveSellerContact, sellerInfoSchema, type SellerContactRow,
} from "./sellerContact.js";

/**
 * The seller block → Contact rules: how an existing contact is recognized
 * (email; phone + name; or, with no contact details, the whole name), how a
 * new one is built (entity-only sellers file under the entity name), and how
 * the deal / opportunity rows and the contact mirror each other.
 */

const contact = (over: Partial<SellerContactRow> = {}): SellerContactRow => ({
  id: "c1", firstName: "Mary", lastName: "Hernandez", entityName: null, phone: "9035551234", email: "mary@example.com",
  preferredContact: "CALL", mailingStreet: "1 Main St", mailingCity: "Centerville", mailingState: "TX", mailingZip: "75833", ...over,
});

function fakeTx(rows: SellerContactRow[]) {
  const findFirst = vi.fn(async (args: { where: Record<string, unknown> }) => {
    const w = args.where as { id?: string; email?: { equals: string } };
    if (w.id) return rows.find((r) => r.id === w.id) ?? null;
    if (w.email) return rows.find((r) => (r.email ?? "").toLowerCase() === w.email!.equals.toLowerCase()) ?? null;
    return null;
  });
  const findMany = vi.fn(async (args: { where: { OR: Record<string, { equals: string }>[] } }) =>
    rows.filter((r) => args.where.OR.some((cond) => {
      const f = cond.firstName?.equals, l = cond.lastName?.equals, e = cond.entityName?.equals;
      if (e != null) return (r.entityName ?? "").toLowerCase() === e.toLowerCase();
      return r.firstName.toLowerCase() === (f ?? "").toLowerCase() && r.lastName.toLowerCase() === (l ?? "").toLowerCase();
    })));
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...contact({ id: "new" }), ...(args.data as object) }) as SellerContactRow);
  const update = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({ ...rows.find((r) => r.id === args.where.id)!, ...(args.data as object) }) as SellerContactRow);
  return { tx: { contact: { findFirst, findMany, create, update } } as unknown as Prisma.TransactionClient, findFirst, findMany, create, update };
}

const info = (over: Record<string, unknown>) => sellerInfoSchema.parse(over);
const notFound = (m: string) => new Error(m);

describe("sellerInfoSchema", () => {
  it("needs a name, an entity name or a contact", () => {
    expect(sellerInfoSchema.safeParse({ phone: "903 555 1234" }).success).toBe(false);
    expect(sellerInfoSchema.safeParse({ companyName: "Hernandez Family Trust" }).success).toBe(true);
    expect(sellerInfoSchema.safeParse({ contactId: "c1" }).success).toBe(true);
  });
  it("normalizes the phone to digits and lower-cases the email; blanks become null", () => {
    const s = info({ firstName: " Mary ", lastName: "", phone: "(903) 555-1234", email: "Mary@Example.com", companyName: "  " });
    expect(s).toMatchObject({ firstName: "Mary", lastName: null, companyName: null, phone: "9035551234", email: "mary@example.com" });
  });
  it("rejects a malformed email", () => {
    expect(sellerInfoSchema.safeParse({ firstName: "A", email: "not-an-email" }).success).toBe(false);
  });
});

describe("matchSellerContact", () => {
  it("matches on email regardless of case or name", async () => {
    const { tx } = fakeTx([contact()]);
    expect((await matchSellerContact(tx, "org", info({ firstName: "M", lastName: "H", email: "MARY@example.com" })))?.id).toBe("c1");
  });
  it("matches on phone + the same person name", async () => {
    const { tx } = fakeTx([contact({ email: null })]);
    expect((await matchSellerContact(tx, "org", info({ firstName: "mary", lastName: "HERNANDEZ", phone: "903-555-1234" })))?.id).toBe("c1");
  });
  it("does not merge two different people who share a phone", async () => {
    const { tx } = fakeTx([contact({ email: null })]);
    expect(await matchSellerContact(tx, "org", info({ firstName: "Jose", lastName: "Hernandez", phone: "903-555-1234" }))).toBeNull();
  });
  it("matches on phone + the same entity name", async () => {
    const { tx } = fakeTx([contact({ email: null, entityName: "Hernandez Family Trust" })]);
    expect((await matchSellerContact(tx, "org", info({ companyName: "hernandez family trust", phone: "9035551234" })))?.id).toBe("c1");
  });
  it("with no contact details, needs the whole name (person + entity) to agree", async () => {
    const { tx } = fakeTx([contact({ email: null, phone: null })]);
    expect((await matchSellerContact(tx, "org", info({ firstName: "Mary", lastName: "Hernandez" })))?.id).toBe("c1");
    expect(await matchSellerContact(tx, "org", info({ firstName: "Mary", lastName: "Hernandez", companyName: "MH LLC" }))).toBeNull();
  });
  it("an email nobody has means a new contact, even when the name matches", async () => {
    const { tx } = fakeTx([contact()]);
    expect(await matchSellerContact(tx, "org", info({ firstName: "Mary", lastName: "Hernandez", email: "other@example.com" }))).toBeNull();
  });
});

describe("resolveSellerContact", () => {
  it("links the named contact and fills only its blank fields", async () => {
    const { tx, update, create } = fakeTx([contact({ phone: null, mailingZip: null })]);
    const r = await resolveSellerContact(tx, "org", info({ contactId: "c1", phone: "9030000000", email: "new@example.com", mailingZip: "75000" }), { notFound });
    expect(r.created).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toEqual({ phone: "9030000000", mailingZip: "75000" }); // the email it already has is kept
  });
  it("refuses a contact from another org", async () => {
    const { tx } = fakeTx([]);
    await expect(resolveSellerContact(tx, "org", info({ contactId: "nope" }), { notFound })).rejects.toThrow(/not found/i);
  });
  it("creates a person contact typed as a seller, owned by the creator", async () => {
    const { tx, create } = fakeTx([]);
    const r = await resolveSellerContact(tx, "org", info({ firstName: "Ann", lastName: "Lee", phone: "9035550000" }), { ownerId: "u1", type: "SELLER", notFound });
    expect(r.created).toBe(true);
    expect(create.mock.calls[0][0].data).toMatchObject({ organizationId: "org", firstName: "Ann", lastName: "Lee", entityName: null, type: "SELLER", phone: "9035550000", ownerId: "u1" });
  });
  it("files an entity-only seller under its entity name", async () => {
    const { tx, create } = fakeTx([]);
    await resolveSellerContact(tx, "org", info({ companyName: "Hernandez Family Trust", sellerType: "TRUST" }), { type: "PROSPECT", notFound });
    expect(create.mock.calls[0][0].data).toMatchObject({ firstName: "Hernandez Family Trust", lastName: "", entityName: "Hernandez Family Trust", type: "PROSPECT" });
  });
  it("is idempotent: the same block twice reuses the contact it created", async () => {
    const rows: SellerContactRow[] = [];
    const { tx, create } = fakeTx(rows);
    const first = await resolveSellerContact(tx, "org", info({ firstName: "Ann", lastName: "Lee", email: "ann@example.com" }), { notFound });
    rows.push(first.contact);
    const second = await resolveSellerContact(tx, "org", info({ firstName: "Ann", lastName: "Lee", email: "ann@example.com" }), { notFound });
    expect(create).toHaveBeenCalledTimes(1);
    expect(second.created).toBe(false);
    expect(second.contact.id).toBe(first.contact.id);
  });
});

describe("rows built from a resolved contact", () => {
  it("deal seller: the typed values first, the contact's for blanks, the contact's preference as a label", () => {
    const s = dealSellerFromInfo(info({ firstName: "Mary", lastName: "Hernandez", sellerType: "INDIVIDUAL" }), contact());
    expect(s).toMatchObject({
      contactId: "c1", isPrimary: true, sellerType: "INDIVIDUAL", firstName: "Mary", lastName: "Hernandez", companyName: null,
      primaryPhone: "9035551234", email: "mary@example.com", preferredContactMethod: "Phone",
      mailingAddress: "1 Main St", mailingCity: "Centerville", mailingState: "TX", mailingZip: "75833",
    });
  });
  it("deal seller type defaults from what was given: an entity is OTHER, a person INDIVIDUAL", () => {
    expect(dealSellerFromInfo(info({ companyName: "X LLC" }), contact({ entityName: "X LLC" })).sellerType).toBe("OTHER");
    expect(dealSellerFromInfo(info({ firstName: "A" }), contact({ entityName: null })).sellerType).toBe("INDIVIDUAL");
  });
  it("an entity-only contact (filed under its entity name) gives no person name", () => {
    const trust = contact({ firstName: "Lone Star Family Trust", lastName: "", entityName: "Lone Star Family Trust" });
    expect(opportunitySellerFromInfo(info({ contactId: "c1" }), trust)).toMatchObject({ sellerName: null, companyName: "Lone Star Family Trust" });
    expect(dealSellerFromInfo(info({ contactId: "c1" }), trust)).toMatchObject({ firstName: null, lastName: null, companyName: "Lone Star Family Trust" });
    expect(overlayContact({ firstName: "x", lastName: "y", companyName: null, primaryPhone: null, email: null, mailingAddress: null, mailingCity: null, mailingState: null, mailingZip: null }, trust))
      .toMatchObject({ firstName: "x", lastName: "y", companyName: "Lone Star Family Trust" });
  });
  it("opportunity seller columns: the plain name, company, phone and email", () => {
    expect(opportunitySellerFromInfo(info({ contactId: "c1" }), contact({ entityName: "MH LLC" }))).toEqual({
      contactId: "c1", sellerName: "Mary Hernandez", companyName: "MH LLC", phone: "9035551234", email: "mary@example.com",
    });
  });
});

describe("keeping the contact and the seller row consistent", () => {
  it("overlay: the contact's shared fields win over the row's copy; blanks fall back", () => {
    const row = { firstName: "Old", lastName: "Name", companyName: "Old LLC", primaryPhone: "1", email: "old@x.com", mailingAddress: "a", mailingCity: "b", mailingState: "c", mailingZip: "d", trustName: "T" };
    const out = overlayContact(row, contact({ entityName: null, email: null }));
    expect(out).toMatchObject({ firstName: "Mary", lastName: "Hernandez", companyName: "Old LLC", primaryPhone: "9035551234", email: "old@x.com", mailingAddress: "1 Main St", trustName: "T" });
    expect(overlayContact(row, null)).toBe(row);
  });
  it("a seller patch mirrors only the shared fields it names; a cleared name becomes \"\"", () => {
    expect(contactPatchFromSellerPatch({ lastName: null, companyName: "New LLC", primaryPhone: "9", trustName: "ignored" } as never))
      .toEqual({ lastName: "", entityName: "New LLC", phone: "9" });
    expect(contactPatchFromSellerPatch({})).toEqual({});
  });
});
