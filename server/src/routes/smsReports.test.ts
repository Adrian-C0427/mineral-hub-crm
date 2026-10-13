/**
 * Reports → SMS performance routes (routes/smsReports.ts), against a fake
 * Prisma client that records every query: the response shapes for an empty
 * org (N/A, never 0% or NaN), the not-connected status, the contact-access
 * gate on drill-downs, and that every query is scoped to the caller's org.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { Prisma } from "@prisma/client";

const db = vi.hoisted(() => {
  const calls: Record<string, unknown[]> = {};
  const results: Record<string, unknown> = {};
  const record = (key: string) => async (args: unknown) => {
    (calls[key] ??= []).push(args);
    const r = results[key];
    return typeof r === "function" ? (r as (a: unknown) => unknown)(args) : r;
  };
  const model = (name: string, methods: string[]) =>
    Object.fromEntries(methods.map((m) => [m, record(`${name}.${m}`)]));
  /** Raw queries are answered by their leading tag comment, e.g. sms:volume. */
  const raw: Prisma.Sql[] = [];
  const rawResults: Record<string, unknown[]> = {};
  const prisma = {
    integration: model("integration", ["findUnique"]),
    highLevelMessage: model("highLevelMessage", ["findFirst", "findMany", "aggregate"]),
    highLevelContact: model("highLevelContact", ["findUnique", "count"]),
    $queryRaw: async (q: Prisma.Sql) => {
      raw.push(q);
      const tag = /\/\* (sms:[a-z-]+) \*\//.exec(q.sql)?.[1] ?? "?";
      return rawResults[tag] ?? [];
    },
  };
  return { calls, results, raw, rawResults, prisma };
});

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));

import { smsReportsRouter } from "./smsReports.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { OrgRole, Permission } from "../domain/permissions.js";

type Caller = { orgRole: OrgRole; permissions: Permission[] };
const OWNER: Caller = { orgRole: "OWNER", permissions: [] };
const VIEWER: Caller = { orgRole: "VIEWER", permissions: ["viewReports", "viewContacts"] };
const REPORTS_ONLY: Caller = { orgRole: "MEMBER", permissions: ["viewReports"] };
const NO_REPORTS: Caller = { orgRole: "MEMBER", permissions: ["viewContacts"] };

async function call(caller: Caller, path: string) {
  const app = express();
  app.use((req: AuthedRequest, _res, next) => {
    req.user = {
      id: "u_1", role: "ASSOCIATE", name: "Test", email: "t@local.test", firstName: null, lastName: null, phone: null,
      organizationId: "org_a", orgRole: caller.orgRole, permissions: caller.permissions, mustChangePassword: false, isDemo: false, referenceOrgId: null,
    };
    next();
  });
  app.use("/api/reports/sms", smsReportsRouter);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

const CONNECTED = {
  status: "CONNECTED", lastSyncAt: new Date("2026-10-12T19:00:00Z"), lastError: "HighLevel rejected the key",
  config: {
    locationId: "loc1", locationName: "XLeads – Carsa", responseWindowDays: 14, _secret: "enc",
    hlUsers: [{ id: "hu1", name: "Maria Gonzalez", email: null }],
    hlSync: { phase: "importing", imported: 1200, preview: { texts: 5000, at: "2026-10-01T00:00:00Z" } },
  },
};

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
  for (const k of Object.keys(db.rawResults)) delete db.rawResults[k];
  db.raw.length = 0;
  Object.assign(db.results, {
    "integration.findUnique": null,
    "highLevelMessage.findFirst": null,
    "highLevelMessage.findMany": [],
    "highLevelMessage.aggregate": { _min: { sentAt: null }, _max: { sentAt: null } },
    "highLevelContact.findUnique": null,
    "highLevelContact.count": 0,
  });
});

/** Every recorded query/lookup names org_a and no other org. */
function expectOrgScoped() {
  expect(db.raw.length).toBeGreaterThan(0);
  for (const q of db.raw) {
    expect(q.values, q.sql).toContain("org_a");
    expect(q.sql).toMatch(/"organizationId" = \?/);
  }
  for (const [key, list] of Object.entries(db.calls)) {
    for (const args of list) expect(JSON.stringify(args), key).toContain("org_a");
  }
}

describe("GET /api/reports/sms/status", () => {
  it("is not connected (and has no data) for an org that never connected HighLevel", async () => {
    const res = await call(OWNER, "/api/reports/sms/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connected: false, status: "NOT_CONNECTED", phase: null, locationName: null, lastSyncAt: null,
      imported: 0, previewTexts: null, responseWindowDays: 30, lastError: null, hasData: false,
    });
  });

  it("shows the sync error only to people who manage integrations", async () => {
    db.results["integration.findUnique"] = CONNECTED;
    db.results["highLevelMessage.findFirst"] = { id: "m1" };
    const owner = await call(OWNER, "/api/reports/sms/status");
    expect(owner.body).toMatchObject({
      connected: true, phase: "importing", locationName: "XLeads – Carsa", imported: 1200, previewTexts: 5000,
      responseWindowDays: 14, lastError: "HighLevel rejected the key", hasData: true,
    });
    expect(JSON.stringify(owner.body)).not.toContain("enc"); // never the stored secret
    const viewer = await call(VIEWER, "/api/reports/sms/status");
    expect(viewer.body.lastError).toBeNull();
  });

  it("needs viewReports", async () => {
    expect((await call(NO_REPORTS, "/api/reports/sms/status")).status).toBe(403);
  });
});

describe("GET /api/reports/sms", () => {
  it("answers an empty org with zeros and N/A — never 0% or NaN", async () => {
    const res = await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30&compareFrom=2026-08-01&compareTo=2026-08-31");
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.range).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(b.compare).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(b.windowDays).toBe(30);
    expect(b.kpis).toMatchObject({
      textsSent: 0, contactsTexted: 0, contactsReached: 0, contactsResponded: 0,
      responseRate: null, optOutRate: null, avgTextsPerContact: null, avgResponseSeconds: null, medianResponseSeconds: null,
    });
    expect(Object.values(b.deltas).every((v) => v === null)).toBe(true);
    expect(b.deltaKind.responseRate).toBe("points");
    expect(b.byTouch).toHaveLength(6);
    expect(b.byTouch.every((t: { rate: number | null }) => t.rate === null)).toBe(true);
    expect(b.trend.bucket).toBe("day");
    expect(b.trend.points).toHaveLength(30);
    expect(b.breakdowns).toEqual({ senders: [], tags: [], sources: [] });
    expect(b.notes).toMatchObject({ reachedTexts: 0, unconfirmedTexts: 0, inboundFirstContacts: 0, lateReplies: 0 });
    expectOrgScoped();
  });

  it("shapes cohort rows, breakdowns and names from the stored HighLevel users", async () => {
    db.results["integration.findUnique"] = CONNECTED;
    Object.assign(db.rawResults, {
      "sms:volume": [{ sent: 40, delivered: 35, failed: 2, inbound: 9, contactsTexted: 16 }],
      "sms:cohort": [
        { touches: 1, outcome: "RESPONDED", count: 3, unconfirmed: 1, texts: 3 },
        { touches: 2, outcome: "NO_REPLY", count: 6, unconfirmed: 2, texts: 12 },
        { touches: 1, outcome: "OPTED_OUT", count: 1, unconfirmed: 0, texts: 1 },
      ],
      "sms:times": [{ avg: 3600.4, median: 1800.6 }],
      "sms:bd-cohort": [
        { dim: "sender", key: "hu1", reached: 6, responded: 2, optedOut: 1, median: 1000 },
        { dim: "sender", key: "none", reached: 4, responded: 1, optedOut: 0, median: 3000 },
        { dim: "tag", key: "(no tag)", reached: 10, responded: 3, optedOut: 1, median: 1800 },
      ],
      "sms:bd-volume": [{ dim: "sender", key: "hu1", textsSent: 30 }, { dim: "sender", key: "none", textsSent: 10 }],
    });
    const res = await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30");
    expect(res.body.kpis).toMatchObject({
      textsSent: 40, contactsReached: 10, contactsResponded: 3, responseRate: 0.3, optedOut: 1, optOutRate: 0.1,
      avgTextsPerContact: 2.5, avgResponseSeconds: 3600, medianResponseSeconds: 1801,
    });
    expect(res.body.previous).toBeNull();
    expect(res.body.deltas).toBeNull();
    expect(res.body.windowDays).toBe(14);
    expect(res.body.byTouch[0]).toMatchObject({ touch: 1, received: 10, responded: 3, rate: 0.3 });
    expect(res.body.breakdowns.senders.map((r: { name: string; textsSent: number }) => [r.name, r.textsSent]))
      .toEqual([["Maria Gonzalez", 30], ["Automated / unassigned", 10]]);
    expect(res.body.breakdowns.tags[0]).toMatchObject({ key: "(no tag)", name: "(no tag)", contactsReached: 10 });
    expect(res.body.notes).toMatchObject({ reachedTexts: 16, unconfirmedTexts: 3, lateReplies: 0 });
  });

  it("never compares for All, and resolves it to the first..last text", async () => {
    db.results["highLevelMessage.aggregate"] = { _min: { sentAt: new Date("2025-08-20T15:00:00Z") }, _max: { sentAt: new Date("2026-10-11T09:00:00Z") } };
    const res = await call(OWNER, "/api/reports/sms?period=ALL&compareFrom=2025-01-01&compareTo=2025-12-31");
    expect(res.body.range).toEqual({ from: "2025-08-20", to: "2026-10-11" });
    expect(res.body.compare).toBeNull();
    expect(res.body.previous).toBeNull();
    expect(res.body.trend.bucket).toBe("month");
    expectOrgScoped();
  });

  it("binds every filter value as a parameter (Automated / unassigned = no team member)", async () => {
    await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30&senders=hu1&senders=none&tags=Reeves%2C%20Oct&tags=(no%20tag)&sources=XLeads");
    const cohort = db.raw.find((q) => q.sql.includes("sms:cohort"))!;
    expect(cohort.sql).toMatch(/IS NULL/);
    expect(cohort.values).toEqual(expect.arrayContaining([["hu1"], ["Reeves, Oct"], ["XLeads"]]));
    expect(cohort.sql).not.toContain("Reeves");
    expectOrgScoped();
  });
});

describe("GET /api/reports/sms/filters", () => {
  it("lists HighLevel users plus Automated / unassigned, and the blank tag/source buckets when they exist", async () => {
    db.results["integration.findUnique"] = CONNECTED;
    Object.assign(db.rawResults, {
      "sms:filter-tags": [{ v: "Reeves Oct 2026" }, { v: "heirs list" }],
      "sms:filter-sources": [{ v: "XLeads Reeves" }],
      "sms:filter-senders": [{ v: "hu1" }, { v: "hu_gone" }],
      "sms:filter-blanks": [{ noTag: true, noSource: false }],
    });
    const res = await call(OWNER, "/api/reports/sms/filters");
    expect(res.body).toEqual({
      senders: [{ id: "hu_gone", name: "HighLevel user" }, { id: "hu1", name: "Maria Gonzalez" }, { id: "none", name: "Automated / unassigned" }],
      tags: ["heirs list", "Reeves Oct 2026", "(no tag)"],
      sources: ["XLeads Reeves"],
    });
    expectOrgScoped();
  });
});

describe("drill-downs", () => {
  it("need contact access, with a message that says so", async () => {
    for (const path of ["/api/reports/sms/contacts?set=reached", "/api/reports/sms/contacts/c1/messages"]) {
      const res = await call(REPORTS_ONLY, path);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/View contacts permission/);
    }
    expect(db.raw).toHaveLength(0);
  });

  it("rejects an unknown set", async () => {
    expect((await call(VIEWER, "/api/reports/sms/contacts?set=everyone")).status).toBe(400);
  });

  it("pages a cohort set, scoped to the org", async () => {
    Object.assign(db.rawResults, {
      "sms:drill-count": [{ n: 1 }],
      "sms:drill": [{
        hlId: "c1", name: "Ann Smith", phone: "+14325550101", tags: ["Reeves Oct 2026"], source: "XLeads", senderId: "hu9",
        firstOutboundAt: new Date("2026-09-03T15:00:00Z"), touches: 2, outcome: "RESPONDED", outcomeAt: new Date("2026-09-08T15:00:00Z"),
        responseSeconds: 432000, smsOptedOut: false, deletedInHl: false,
      }],
    });
    const res = await call(VIEWER, "/api/reports/sms/contacts?from=2026-09-01&to=2026-09-30&set=responded&touch=2&limit=500&offset=-4");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 200, offset: 0 });
    expect(res.body.rows[0]).toMatchObject({ hlId: "c1", teamMember: "HighLevel user", textsBeforeReply: 2, outcome: "RESPONDED" });
    const page = db.raw.find((q) => q.sql.includes("sms:drill */"))!;
    expect(page.values).toEqual(expect.arrayContaining(["RESPONDED", 2, 200, 0]));
    expectOrgScoped();
  });

  it("starts the texted list from the messages", async () => {
    await call(VIEWER, "/api/reports/sms/contacts?from=2026-09-01&to=2026-09-30&set=texted");
    const page = db.raw.find((q) => q.sql.includes("sms:drill */"))!;
    expect(page.sql).toContain('FROM "HighLevelMessage" m');
    expectOrgScoped();
  });

  it("returns a contact's timeline without message wording, oldest first", async () => {
    db.results["highLevelContact.findUnique"] = { hlId: "c1", name: "Ann", tags: [], creditedHlUserId: null, assignedToHlUserId: "hu1", touches: 1 };
    db.results["integration.findUnique"] = CONNECTED;
    db.results["highLevelMessage.findMany"] = [
      { sentAt: new Date("2026-09-04T10:00:00Z"), direction: "inbound", status: "delivered", source: null, hlUserId: null, messageType: "TYPE_SMS" },
      { sentAt: new Date("2026-09-03T10:00:00Z"), direction: "outbound", status: "sent", source: "workflow", hlUserId: null, messageType: "TYPE_SMS" },
    ];
    const res = await call(VIEWER, "/api/reports/sms/contacts/c1/messages");
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ hlId: "c1", teamMember: "Maria Gonzalez" });
    expect(res.body.messages.map((m: { statusKind: string }) => m.statusKind)).toEqual(["unconfirmed", "received"]);
    expect(res.body.messages[0]).not.toHaveProperty("body");
    const where = (db.calls["highLevelMessage.findMany"]![0] as { where: unknown }).where;
    expect(where).toEqual({ organizationId: "org_a", hlContactId: "c1" });
  });

  it("is a 404 for a contact the org doesn't have", async () => {
    expect((await call(VIEWER, "/api/reports/sms/contacts/other-org-contact/messages")).status).toBe(404);
  });
});
