/**
 * Regression tests for the 2026-10-26 audit (Medium): deal and opportunity
 * seller edits reached the linked Contact with only deal permissions.
 *  - Changing a Contact through a seller needs "Manage contacts". A caller who
 *    can see the contact but not manage it is refused (403) when the edit would
 *    change it; one who can't see it never changes it (the edit stays on the
 *    deal's own seller row, and the reply never hints at what the contact holds).
 *  - A contact's details (phone, email, mailing address) reach a deal seller
 *    row or reply only for a caller with "View contacts" — a typed name that
 *    matches a contact no longer copies that person's phone and email.
 *  - Only fields whose value actually changes count, so a form that resends
 *    unchanged values works for everyone.
 *
 * Routers run against a fake Prisma client that records what it was asked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

const db = vi.hoisted(() => {
  const calls: Record<string, unknown[]> = {};
  const results: Record<string, unknown> = {};
  const record = (key: string) => async (args: unknown) => {
    (calls[key] ??= []).push(args);
    const r = results[key];
    return typeof r === "function" ? (r as (a: unknown) => unknown)(args) : r;
  };
  const model = (name: string) => new Proxy({}, { get: (_t, m) => record(`${name}.${String(m)}`) });
  const prisma: Record<string, unknown> = new Proxy({}, {
    get: (_t, name) => {
      if (name === "$transaction") {
        return async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]));
      }
      return model(String(name));
    },
  });
  return { calls, results, prisma };
});

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));

import { dealsRouter } from "./deals.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { Permission } from "../domain/permissions.js";
import { contactSyncFor, dealSellerFromInfo, overlayContact, sellerInfoSchema, type SellerContactRow } from "../domain/sellerContact.js";
import { convertedSeller } from "../domain/opportunities.js";

const DEALS: Permission[] = ["viewDeals", "editDeals"];
const NO_CONTACTS = DEALS;
const VIEW_ONLY: Permission[] = [...DEALS, "viewContacts"];
const MANAGE: Permission[] = [...DEALS, "viewContacts", "manageContacts"];

const contact = (over: Partial<SellerContactRow> = {}): SellerContactRow => ({
  id: "c1", firstName: "Mary", middleName: null, lastName: "Hernandez", entityName: null, phone: "9035551234", email: "mary@example.com",
  preferredContact: "CALL", mailingStreet: "1 Main St", mailingCity: "Centerville", mailingState: "TX", mailingZip: "75833",
  states: [], counties: [], ...over,
});

/** A DealSeller row as the seller routes read it back (with its contact). */
const sellerRow = (over: Record<string, unknown> = {}) => ({
  id: "s1", dealId: "d1", isPrimary: true, ownershipPercent: null, contactId: "c1",
  firstName: "Mary", middleName: null, lastName: "Hernandez", companyName: null, trustName: null, sellerType: "INDIVIDUAL",
  primaryPhone: "9030000000", secondaryPhone: null, email: "row@example.com", preferredContactMethod: null,
  mailingAddress: null, mailingCity: null, mailingState: null, mailingZip: null,
  physicalAddress: null, physicalCity: null, physicalState: null, physicalZip: null,
  internalNotes: null, preferredCommunicationNotes: null, assignedTeamMemberId: null, assignedTeamMember: null,
  contact: contact(), createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-01T00:00:00Z"),
  ...over,
});

async function call(permissions: Permission[], method: string, path: string, body?: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req: AuthedRequest, _res, next) => {
    req.user = {
      id: "u1", role: "ASSOCIATE", name: "Test", email: "t@local.test", firstName: null, lastName: null, phone: null,
      organizationId: "org_a", orgRole: "MEMBER", permissions, mustChangePassword: false, isDemo: false, referenceOrgId: null,
    };
    next();
  });
  app.use("/api/deals", dealsRouter);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
  Object.assign(db.results, {
    "deal.findFirst": { id: "d1" },
    "dealSeller.findFirst": { id: "s1", dealId: "d1", contactId: "c1" },
    "dealSeller.count": 0,
    "dealSeller.update": (args: { data: Record<string, unknown> }) => sellerRow(args.data),
    "dealSeller.create": (args: { data: Record<string, unknown> }) => sellerRow(args.data),
    "dealSeller.updateMany": { count: 0 },
    "contact.findFirst": contact(),
    "contact.update": (args: { data: Record<string, unknown> }) => ({ ...contact(), ...args.data }),
  });
});

describe("PATCH /deals/:id/sellers/:sellerId — changing the linked Contact", () => {
  it("refuses a caller who can see contacts but not manage them, and writes nothing", async () => {
    const res = await call(VIEW_ONLY, "PATCH", "/api/deals/d1/sellers/s1", { email: "new@example.com" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage contacts/i);
    expect(db.calls["contact.update"]).toBeUndefined();
    expect(db.calls["dealSeller.update"]).toBeUndefined();
  });

  it("lets the same caller resend the contact's unchanged values (a form save)", async () => {
    const res = await call(VIEW_ONLY, "PATCH", "/api/deals/d1/sellers/s1", {
      firstName: "Mary", lastName: "Hernandez", primaryPhone: "(903) 555-1234", email: "MARY@example.com", internalNotes: "call after 5",
    });
    expect(res.status).toBe(200);
    expect(db.calls["contact.update"]).toBeUndefined();
    expect((db.calls["dealSeller.update"]![0] as { data: Record<string, unknown> }).data.internalNotes).toBe("call after 5");
  });

  it("never touches the contact for a caller who can't see contacts; the edit stays on the deal's row", async () => {
    const res = await call(NO_CONTACTS, "PATCH", "/api/deals/d1/sellers/s1", { primaryPhone: "9037770000" });
    expect(res.status).toBe(200);
    expect(db.calls["contact.update"]).toBeUndefined();
    expect((db.calls["dealSeller.update"]![0] as { data: Record<string, unknown> }).data.primaryPhone).toBe("9037770000");
    // The reply shows the row's own details, not the contact's.
    expect(res.body.primaryPhone).toBe("9037770000");
    expect(res.body.email).toBe("row@example.com");
  });

  it("with Manage contacts, mirrors only the fields that change", async () => {
    const res = await call(MANAGE, "PATCH", "/api/deals/d1/sellers/s1", { firstName: "Mary", email: "new@example.com" });
    expect(res.status).toBe(200);
    expect(db.calls["contact.update"]).toHaveLength(1);
    expect((db.calls["contact.update"]![0] as { data: Record<string, unknown> }).data).toEqual({ email: "new@example.com" });
  });

  it("refuses linking a contact from another organization", async () => {
    db.results["contact.findFirst"] = null;
    const res = await call(MANAGE, "PATCH", "/api/deals/d1/sellers/s1", { contactId: "c_other" });
    expect(res.status).toBe(400);
    expect(db.calls["dealSeller.update"]).toBeUndefined();
  });
});

describe("POST /deals/:id/sellers — contact details only with View contacts", () => {
  it("a typed name linked to an existing contact does not copy its phone, email or address for a caller who can't see contacts", async () => {
    const res = await call(NO_CONTACTS, "POST", "/api/deals/d1/sellers", { contactId: "c1", sellerType: "INDIVIDUAL" });
    expect(res.status).toBe(201);
    const data = (db.calls["dealSeller.create"]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ contactId: "c1", firstName: "Mary", lastName: "Hernandez", primaryPhone: null, email: null, mailingAddress: null, preferredContactMethod: null });
    expect(res.body.primaryPhone).toBeNull();
    expect(res.body.email).toBeNull();
    expect(res.body.firstName).toBe("Mary");
    // Nothing is written to the existing contact either.
    expect(db.calls["contact.update"]).toBeUndefined();
  });

  it("with View contacts the linked contact's details fill the row, as before", async () => {
    const res = await call(VIEW_ONLY, "POST", "/api/deals/d1/sellers", { contactId: "c1", sellerType: "INDIVIDUAL" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ primaryPhone: "9035551234", email: "mary@example.com", mailingAddress: "1 Main St" });
  });

  it("does not fill an existing contact's blank details without Manage contacts", async () => {
    db.results["contact.findFirst"] = contact({ email: null });
    const res = await call(VIEW_ONLY, "POST", "/api/deals/d1/sellers", { contactId: "c1", sellerType: "INDIVIDUAL", email: "typed@example.com" });
    expect(res.status).toBe(201);
    expect(db.calls["contact.update"]).toBeUndefined();
  });
});

describe("contactSyncFor", () => {
  const patch = { email: "new@example.com" };
  it("applies changes with Manage contacts", () => {
    expect(contactSyncFor({ view: true, manage: true }, patch, contact())).toEqual(patch);
  });
  it("refuses a change for a caller who can view but not manage", () => {
    expect(contactSyncFor({ view: true, manage: false }, patch, contact())).toBeNull();
  });
  it("is a silent no-op for a caller who can't view (no oracle on the contact's values)", () => {
    expect(contactSyncFor({ view: false, manage: false }, patch, contact())).toEqual({});
    expect(contactSyncFor({ view: false, manage: false }, { email: "mary@example.com" }, contact())).toEqual({});
  });
  it("compares phones as digits, emails without case, and blank as null", () => {
    const same = { phone: "(903) 555-1234", email: " MARY@example.com ", entityName: "", firstName: "Mary", lastName: "Hernandez" };
    expect(contactSyncFor({ view: true, manage: false }, same, contact())).toEqual({});
  });
  it("an entity-only contact's blank person name is unchanged, so it is not overwritten", () => {
    const entity = contact({ firstName: "Acme Minerals LLC", lastName: "", entityName: "Acme Minerals LLC" });
    expect(contactSyncFor({ view: true, manage: true }, { firstName: "", lastName: "" }, entity)).toEqual({});
  });
});

describe("contact details on deal seller rows", () => {
  const info = sellerInfoSchema.parse({ contactId: "c1" });
  it("dealSellerFromInfo keeps only the names without View contacts", () => {
    expect(dealSellerFromInfo(info, contact(), false)).toMatchObject({
      firstName: "Mary", lastName: "Hernandez", primaryPhone: null, email: null, preferredContactMethod: null,
      mailingAddress: null, mailingCity: null, mailingState: null, mailingZip: null,
    });
  });
  it("overlayContact overlays only the names without View contacts", () => {
    const row = sellerRow({ firstName: null, lastName: null });
    const out = overlayContact(row, contact(), false);
    expect(out).toMatchObject({ firstName: "Mary", lastName: "Hernandez", primaryPhone: "9030000000", email: "row@example.com", mailingAddress: null });
  });
  it("converting an opportunity without View contacts takes the contact's names and the opportunity's own phone/email", () => {
    const opp = { phone: "903-111-2222", email: "opp@example.com", sellerName: "Mary Hernandez", companyName: null } as Parameters<typeof convertedSeller>[0];
    expect(convertedSeller(opp, contact(), false)).toMatchObject({
      firstName: "Mary", lastName: "Hernandez", primaryPhone: "9031112222", email: "opp@example.com", mailingAddress: null, preferredContactMethod: null,
    });
    expect(convertedSeller(opp, contact())).toMatchObject({ primaryPhone: "9035551234", email: "mary@example.com", mailingAddress: "1 Main St" });
  });
});
