/**
 * Regression tests for the 2026-11-04 audit.
 *
 *  High   Research ingest: the geography parser ran quadratic regexes over
 *         uncapped cells and the file-level assignedState/assignedCounty — a
 *         1 MB run of commas pinned the event loop for an hour. Parser is
 *         linear now, the fields are capped, oversized cells reject the row.
 *  Medium 2FA enrolment needed only a session (a borrowed token could lock
 *         the owner out for good); it needs the current password, and the
 *         owner's password reset clears the second factor.
 *  Medium Buyer-portal offers became ACTIVE at once and drove every derived
 *         figure; they start PENDING_REVIEW and count nowhere until confirmed.
 *  Low    Per-account login lockout; Graph page cursors validated on the parsed
 *         URL; seller matching no longer reverse-looks-up a phone/email for
 *         callers without viewContacts; contacts PATCH no longer clears dates
 *         it did not mention (zod runs transforms for missing keys).
 *
 * Routers run against a fake Prisma client that records what it was asked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";

const db = vi.hoisted(() => {
  const calls: Record<string, unknown[]> = {};
  const results: Record<string, unknown> = {};
  const record = (key: string) => async (...args: unknown[]) => {
    (calls[key] ??= []).push(args.length === 1 ? args[0] : args);
    const r = results[key];
    return typeof r === "function" ? (r as (...a: unknown[]) => unknown)(...args) : r;
  };
  const model = (name: string) => new Proxy({}, { get: (_t, m) => (m === "fields" ? {} : record(`${name}.${String(m)}`)) });
  const prisma: Record<string | symbol, unknown> = new Proxy({}, {
    get: (_t, name) => {
      if (name === "$transaction") {
        return async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]));
      }
      if (typeof name === "string" && name.startsWith("$")) return record(name);
      return model(String(name));
    },
  });
  return { calls, results, prisma };
});

const pw = vi.hoisted(() => ({ verify: 0 }));

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));
vi.mock("../auth/password.js", () => ({
  verifyPassword: async (p: string) => { pw.verify++; return p === "correct"; },
  hashPassword: async (p: string) => `hashed:${p}`,
  dummyVerifyPassword: async () => {},
}));
vi.mock("../services/notifyPush.js", () => ({ pushTeams: vi.fn(async () => {}) }));

import { authRouter } from "./auth.js";
import { usersRouter } from "./users.js";
import { researchRouter } from "./research.js";
import { contactsRouter } from "./contacts.js";
import { portalRouter } from "./portal.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { Permission } from "../domain/permissions.js";
import { titleCounty, normState, abstractNumbers, surveyName, countyCell } from "../domain/researchGeo.js";
import { ingestResearchCsv, MAX_LOCATION_CELL_CHARS, MAX_CELL_CHARS } from "../domain/researchIngest.js";
import { matchSellerContact, type SellerInfo } from "../domain/sellerContact.js";
import { ownMailLink } from "../services/mail/graph.js";
import { ownDriveLink } from "../services/cloud/onedrive.js";
import { countedOffers, dealSalePrice, acceptedOffer } from "../domain/metrics.js";

type User = NonNullable<AuthedRequest["user"]>;
const baseUser: User = {
  id: "u1", role: "OWNER", name: "T", email: "t@local.test", firstName: null, lastName: null, phone: null,
  organizationId: "org_a", orgRole: "MEMBER", permissions: [], mustChangePassword: false, isDemo: false, referenceOrgId: null,
};

async function withApp<T>(opts: { permissions?: Permission[]; user?: Partial<User> | null; mount: (app: express.Express) => void }, run: (port: number) => Promise<T>): Promise<T> {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "2mb" }));
  app.use((req: AuthedRequest, _res, next) => {
    if (opts.user !== null) req.user = { ...baseUser, permissions: opts.permissions ?? [], ...(opts.user ?? {}) };
    next();
  });
  opts.mount(app);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await run((server.address() as { port: number }).port);
  } finally {
    server.close();
  }
}

async function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json as Record<string, unknown> | null };
}

const arg = (key: string, i = 0) => (db.calls[key]?.[i] ?? {}) as Record<string, unknown>;
const prisma = db.prisma as unknown as PrismaClient;

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
  pw.verify = 0;
  db.results["$queryRawUnsafe"] = [];
});

// ---------------------------------------------------------------------------
// High — research geography parser and ingest caps
// ---------------------------------------------------------------------------

describe("research geography parser is linear", () => {
  it("1 MB separator runs parse in milliseconds, and real cells read as before", () => {
    const commas = ",".repeat(1_000_000) + "x";
    const spaces = " ".repeat(1_000_000) + "x";
    const t0 = performance.now();
    titleCounty(commas); normState(commas); countyCell(commas); abstractNumbers(spaces); surveyName("a" + spaces); surveyName(commas);
    expect(performance.now() - t0).toBeLessThan(500);

    expect(titleCounty("LEON COUNTY, TX")).toBe("Leon");
    expect(countyCell("Leon, Texas")).toEqual({ county: "Leon", state: "TX" });
    expect(countyCell("LEON COUNTY STATE OF TEXAS")).toEqual({ county: "Leon", state: "TX" });
    expect(countyCell("McMullen Co.")).toEqual({ county: "McMullen", state: null });
    expect(countyCell("Denver, CO")).toEqual({ county: "Denver", state: "CO" });
    expect(countyCell("Leon County, New Mexico")).toEqual({ county: "Leon", state: "NM" });
    expect(titleCounty("ST. LANDRY PARISH")).toBe("St. Landry");
    expect(titleCounty("DEWITT")).toBe("DeWitt");
    expect(normState("Tex.")).toBe("TX");
    expect(abstractNumbers("A-58, 61 / 102 and 7")).toEqual(["58", "61", "102", "7"]);
    expect(abstractNumbers("ABST 0923")).toEqual(["923"]);
    expect(surveyName("A-923 J WARNICK SURVEY")).toBe("J. Warnick Survey");
    expect(surveyName("WARNICK, J")).toBe("J. Warnick Survey");
  });
});

const csv = (header: string, ...rows: string[]) => [header, ...rows].join("\n");

describe("research ingest rejects oversized cells before parsing them", () => {
  it("a location cell over the cap, and any mapped cell over the general cap", async () => {
    db.results["researchDocument.findMany"] = [];
    const t0 = performance.now();
    const s = await ingestResearchCsv({
      prisma, organizationId: "org_a", createdByUserId: null, category: "deeds", dryRun: true, previewRows: 8,
      mapping: { docType: "Type", recordingDate: "Recorded", grantor: "Grantor", grantee: "Grantee", county: "County", state: "State" },
      csv: csv("Type,Recorded,Grantor,Grantee,County,State",
        "Mineral Deed,03/20/2026,Smith,Blackrock LLC,Leon County,Texas",
        `Mineral Deed,03/20/2026,Smith,Blackrock LLC,${"x".repeat(MAX_LOCATION_CELL_CHARS + 100)},Texas`,
        `${"x".repeat(MAX_CELL_CHARS + 1)},03/20/2026,Smith,Blackrock LLC,Leon,TX`),
    });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(s.imported).toBe(1);
    expect(s.rejected).toBe(2);
    const reasons = JSON.stringify(s.skippedReasons);
    expect(reasons).toContain(`Location cell longer than ${MAX_LOCATION_CELL_CHARS.toLocaleString()} characters`);
    expect(reasons).toContain(`Cell longer than ${MAX_CELL_CHARS.toLocaleString()} characters`);
  });

  it("the file-level assigned county is capped at the schema, so a 1 MB one never reaches the parser", async () => {
    const mount = (app: express.Express) => app.use("/api/research", researchRouter);
    await withApp({ permissions: ["manageResearchData"], mount }, async (port) => {
      const t0 = performance.now();
      const res = await call(port, "POST", "/api/research/ingest/preview", {
        category: "deeds", csv: "a", mapping: {}, assignedCounty: ",".repeat(1_000_000) + "x",
      });
      expect(res.status).toBe(400);
      expect(performance.now() - t0).toBeLessThan(1500);
    });
    expect(db.calls["researchDocument.findMany"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Medium — 2FA enrolment and the owner's reset
// ---------------------------------------------------------------------------

describe("2FA enrolment needs the current password", () => {
  const mount = (app: express.Express) => app.use("/api/auth", authRouter);

  it("no password: 400, nothing written", async () => {
    await withApp({ mount }, async (port) => {
      expect((await call(port, "POST", "/api/auth/2fa/setup", {})).status).toBe(400);
    });
    expect(db.calls["user.update"]).toBeUndefined();
  });

  it("wrong password: 403, nothing written", async () => {
    db.results["user.findUnique"] = { email: "t@local.test", totpEnabled: false, passwordHash: "h" };
    await withApp({ mount }, async (port) => {
      expect((await call(port, "POST", "/api/auth/2fa/setup", { password: "wrong" })).status).toBe(403);
    });
    expect(pw.verify).toBe(1);
    expect(db.calls["user.update"]).toBeUndefined();
  });
});

describe("the owner's password reset clears the second factor", () => {
  it("totp fields are reset with the password", async () => {
    db.results["user.findFirst"] = { id: "u2", organizationId: "org_a" };
    db.results["user.update"] = {};
    await withApp({ user: { orgRole: "OWNER" }, mount: (app) => app.use("/api/users", usersRouter) }, async (port) => {
      const res = await call(port, "POST", "/api/users/u2/reset-password", { mode: "temp" });
      expect(res.status).toBe(200);
    });
    expect(arg("user.update")).toMatchObject({
      where: { id: "u2" },
      data: { mustChangePassword: true, sessionEpoch: { increment: 1 }, totpEnabled: false, totpSecret: null, totpRecoveryCodes: [], totpLastUsedStep: null },
    });
  });
});

// ---------------------------------------------------------------------------
// Low — per-account login lockout
// ---------------------------------------------------------------------------

describe("login locks the ACCOUNT after repeated wrong passwords, whatever the address", () => {
  it("the sixth attempt is refused without checking the password, even when it is right", async () => {
    db.results["user.findUnique"] = { id: "lock_me", status: "ACTIVE", passwordHash: "h", totpEnabled: false, sessionEpoch: 0, role: "OWNER", orgRole: "OWNER", name: "T", email: "lock@local.test" };
    await withApp({ user: null, mount: (app) => app.use("/api/auth", authRouter) }, async (port) => {
      for (let i = 0; i < 5; i++) {
        const res = await call(port, "POST", "/api/auth/login", { email: "lock@local.test", password: "wrong" }, { "x-forwarded-for": `10.0.0.${i + 1}` });
        expect(res.status).toBe(401);
      }
      expect(pw.verify).toBe(5);
      const res = await call(port, "POST", "/api/auth/login", { email: "lock@local.test", password: "correct" }, { "x-forwarded-for": "10.0.0.99" });
      expect(res.status).toBe(401);
      expect(res.body?.error).toBe("Invalid email or password");
      expect(pw.verify).toBe(5); // locked: the real check never ran
    });
  });
});

// ---------------------------------------------------------------------------
// Medium — portal offers start PENDING_REVIEW and count nowhere
// ---------------------------------------------------------------------------

describe("buyer-portal offers are pending until confirmed", () => {
  it("a public submission is stored PENDING_REVIEW, never ACTIVE", async () => {
    db.results["portalRateHit.upsert"] = { count: 1 };
    db.results["deal.findUnique"] = { id: "d1", name: "Smith", organizationId: "org_a", publishedToPortal: true, relationshipOwnerId: null, organization: { id: "org_a", portalEnabled: true, isDemo: false } };
    db.results["buyer.findFirst"] = null;
    db.results["buyer.create"] = { id: "b_new" };
    db.results["offer.create"] = {};
    db.results["notification.create"] = {};
    await withApp({ user: null, mount: (app) => app.use("/api/portal", portalRouter) }, async (port) => {
      const res = await call(port, "POST", "/api/portal/offering/smith-slug/offers", {
        companyName: "Acme", contactName: "Pat Lee", email: "pat@acme.test", amount: 999_999_999_999,
      });
      expect(res.status).toBe(201);
    });
    expect(arg("offer.create")).toMatchObject({ data: { dealId: "d1", buyerId: "b_new", status: "PENDING_REVIEW" } });
  });

  it("derived figures ignore pending offers", () => {
    const offers = [
      { id: "o1", amount: 1_000_000_000_000, status: "PENDING_REVIEW" },
      { id: "o2", amount: 250_000, status: "ACTIVE" },
    ];
    expect(countedOffers(offers).map((o) => o.id)).toEqual(["o2"]);
    expect(dealSalePrice(offers, null)).toBe(250_000);
    expect(dealSalePrice([offers[0]], null)).toBeNull();
    expect(acceptedOffer(offers, "o1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Low — seller matching, Graph cursors, contacts PATCH
// ---------------------------------------------------------------------------

describe("seller matching without viewContacts needs the name to agree", () => {
  const jane = { id: "c9", firstName: "Jane", middleName: null, lastName: "Doe", entityName: null, phone: "2145550123", email: null };
  const info = (first: string, last: string): SellerInfo =>
    ({ contactId: null, sellerType: null, firstName: first, middleName: null, lastName: last, companyName: null, phone: "2145550123", email: null, mailingAddress: null, mailingCity: null, mailingState: null, mailingZip: null } as unknown as SellerInfo);
  const tx = db.prisma as unknown as Parameters<typeof matchSellerContact>[0];

  it("a phone match under another name is not linked (no reverse lookup)", async () => {
    db.results["contact.findMany"] = [jane];
    expect(await matchSellerContact(tx, "org_a", info("Probe", "X"), { nameMustAgree: true })).toBeNull();
  });
  it("the same phone with the right name still links, as does any match for a viewContacts caller", async () => {
    db.results["contact.findMany"] = [jane];
    expect((await matchSellerContact(tx, "org_a", info("Jane", "Doe"), { nameMustAgree: true }))?.id).toBe("c9");
    expect((await matchSellerContact(tx, "org_a", info("Probe", "X")))?.id).toBe("c9");
  });
});

describe("Graph page cursors are checked on the parsed URL", () => {
  it("dot-segments cannot step out of the allowed path", () => {
    expect(() => ownMailLink("https://graph.microsoft.com/v1.0/me/messages/../../me/drive/root/children")).toThrow();
    expect(() => ownMailLink("https://graph.microsoft.com/v1.0/me/messagesX")).toThrow();
    expect(ownMailLink("https://graph.microsoft.com/v1.0/me/messages?$skip=50")).toBe("https://graph.microsoft.com/v1.0/me/messages?$skip=50");
    expect(() => ownDriveLink("https://graph.microsoft.com/v1.0/me/drive/%2e%2e/%2e%2e/me/contacts", "page")).toThrow();
    expect(ownDriveLink("https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc", "page")).toContain("/me/drive/root/children");
    expect(() => ownDriveLink("https://graph.microsoft.com/v1.0/me/drive/root/children", "delta")).toThrow();
  });
});

describe("PATCH /contacts/:id leaves dates it does not mention alone", () => {
  it("a name-only patch writes no lastContactedAt / nextFollowUpDate", async () => {
    db.results["contact.findFirst"] = { id: "c1", organizationId: "org_a", firstName: "A", lastName: "B", entityName: null };
    db.results["contact.update"] = { id: "c1", firstName: "A2", lastName: "B", lists: [] };
    await withApp({ permissions: ["manageContacts"], mount: (app) => app.use("/api/contacts", contactsRouter) }, async (port) => {
      expect((await call(port, "PATCH", "/api/contacts/c1", { firstName: "A2" })).status).toBe(200);
    });
    const data = arg("contact.update").data as Record<string, unknown>;
    expect(data).toMatchObject({ firstName: "A2" });
    expect("lastContactedAt" in data).toBe(false);
    expect("nextFollowUpDate" in data).toBe(false);
  });
});
