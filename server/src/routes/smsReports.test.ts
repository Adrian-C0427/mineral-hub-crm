/**
 * Reports → SMS performance routes (routes/smsReports.ts), against a fake
 * Prisma client that records every query: the response shapes for an empty
 * org (N/A, never 0% or NaN), the not-connected status, the contact-access
 * gate on drill-downs, the minerals / all-texting scope, the cost without a
 * price, drill lists built from the same SQL as their tiles, and that every
 * query is scoped to the caller's org.
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
      const tag = /\/\* (sms:[a-z0-9-]+) \*\//.exec(q.sql)?.[1] ?? "?";
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

type Caller = { orgRole: OrgRole; permissions: Permission[]; isDemo?: boolean };
const OWNER: Caller = { orgRole: "OWNER", permissions: [] };
const VIEWER: Caller = { orgRole: "VIEWER", permissions: ["viewReports", "viewContacts"] };
const REPORTS_ONLY: Caller = { orgRole: "MEMBER", permissions: ["viewReports"] };
const NO_REPORTS: Caller = { orgRole: "MEMBER", permissions: ["viewContacts"] };
const DEMO_OWNER: Caller = { orgRole: "OWNER", permissions: [], isDemo: true };

async function call(caller: Caller, path: string) {
  const app = express();
  app.use((req: AuthedRequest, _res, next) => {
    req.user = {
      id: "u_1", role: "ASSOCIATE", name: "Test", email: "t@local.test", firstName: null, lastName: null, phone: null,
      organizationId: "org_a", orgRole: caller.orgRole, permissions: caller.permissions, mustChangePassword: false, isDemo: caller.isDemo ?? false, referenceOrgId: null,
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
      scopeSaved: false, minerals: 0, realEstate: 0, unclassified: 0,
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

  it("is for live workspaces only: the demo workspace gets nothing, and nothing is queried", async () => {
    db.results["integration.findUnique"] = CONNECTED;
    for (const path of ["/status", "/filters", "", "/contacts?set=reached", "/contacts/c1/messages"]) {
      const res = await call(DEMO_OWNER, `/api/reports/sms${path}`);
      expect(res.status, path).toBe(403);
      expect(res.body).toMatchObject({ error: "SMS performance is available in live workspaces only.", demo: true });
    }
    expect(db.raw).toHaveLength(0);
    expect(Object.keys(db.calls)).toHaveLength(0);
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
    expect(b.notes).toMatchObject({ reachedTexts: 0, unconfirmedTexts: 0, inboundFirstContacts: 0, lateReplies: 0, unknownSegments: 0 });
    // The newer sections: N/A wherever there is nothing to divide by.
    expect(b.kpis).toMatchObject({
      wrongNumbers: 0, wrongNumberRate: null, opportunities: 0, interestedRate: null, offers: 0, offerAcceptanceRate: null, closedDeals: 0,
      textingCost: null, costPerReply: null, costPerOpportunity: null, costPerOffer: null, costPerClosedDeal: null,
      medianAnswerSeconds: null, answeredWithinHourRate: null, neverAnsweredRate: null, stillWaiting: 0, avgTextsBeforeReply: null,
    });
    expect(b.funnel.steps.every((s: { fromReached: number | null }) => s.fromReached === null)).toBe(true);
    expect(b.funnel).toMatchObject({ interestedRate: null, contactsPerClosedDeal: null, textsPerClosedDeal: null, historySince: null });
    expect(b.speed).toMatchObject({ responded: 0, never: 0, neverRate: null, within1hRate: null, byMember: [] });
    expect(b.bestTime).toMatchObject({ timezone: "UTC", fallback: true, cells: [], best: [] });
    expect(b.phoneQuality).toEqual({ tags: [], sources: [] });
    expect(b.carrierHealth.days).toHaveLength(30);
    expect(b.carrierHealth.days.every((d: { optOutRate: number | null; small: boolean }) => d.optOutRate === null && d.small)).toBe(true);
    expect(b.carrierHealth.last7).toMatchObject({ sent: 0, optOutRate: null, failureRate: null, warnings: [] });
    expect(b.scopeInfo).toEqual({ saved: false, texted: { minerals: 0, realEstate: 0, unclassified: 0 } });
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

// --- Minerals scope, cost, funnel, the newer drill lists ------------------------

const SCOPED = {
  ...CONNECTED,
  connectedAt: new Date("2026-09-15T15:00:00Z"),
  config: {
    ...CONNECTED.config,
    scope: { mineralTags: ["reeves county"], realEstateTags: ["sub2"], mineralPipelineIds: ["pMin", "pOna"] },
    pricePerSegment: 0.01,
    locationTimezone: "America/Chicago",
    hlPipelines: [{ id: "pMin", name: "Minerals" }, { id: "pOna", name: "Offer Not Accepted" }, { id: "pJv", name: "JV's" }],
  },
};
const MINERALS_ONLY = `c."line" = 'minerals'`;
/** Queries that follow the scope; carrier health, the line split and the tag list never do. */
const SCOPED_TAGS = ["sms:volume", "sms:trend", "sms:cohort", "sms:times", "sms:cohort-x", "sms:funnel", "sms:bd-cohort", "sms:bd-volume",
  "sms:quality", "sms:speed-members", "sms:best-time", "sms:inbound-first"];
const UNSCOPED_TAGS = ["sms:health-days", "sms:health-7d", "sms:line-split", "sms:tags"];
const sqlOf = (tag: string) => db.raw.filter((q) => q.sql.includes(`/* ${tag} */`));
/** The opportunity lateral of a query, as text. */
const lateral = (q: Prisma.Sql) => q.sql.slice(q.sql.indexOf("LEFT JOIN LATERAL"), q.sql.indexOf("x ON TRUE"));

describe("scope: minerals only (default) vs all texting", () => {
  it("counts only contacts classified as minerals by default — except carrier health and the line split", async () => {
    db.results["integration.findUnique"] = SCOPED;
    const res = await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30");
    expect(res.body.scope).toBe("minerals");
    for (const tag of SCOPED_TAGS) {
      expect(sqlOf(tag).length, tag).toBeGreaterThan(0);
      for (const q of sqlOf(tag)) expect(q.sql, tag).toContain(MINERALS_ONLY);
    }
    for (const tag of UNSCOPED_TAGS) for (const q of sqlOf(tag)) expect(q.sql, tag).not.toContain(MINERALS_ONLY);
    // Volume needs the contact (its line) even without a filter.
    expect(sqlOf("sms:volume")[0].sql).toContain('LEFT JOIN "HighLevelContact" c');
    // The funnel reads the minerals pipelines only.
    expect(sqlOf("sms:funnel")[0].values).toEqual(expect.arrayContaining([["pMin", "pOna"]]));
    expect(res.body.funnel.pipelines).toEqual([{ id: "pMin", name: "Minerals" }, { id: "pOna", name: "Offer Not Accepted" }]);
    expect(res.body.funnel.historySince).toBe("2026-09-15T15:00:00.000Z");
    expectOrgScoped();
  });

  it("counts everything with scope=all, every pipeline in the funnel, and no contact join for plain volume", async () => {
    db.results["integration.findUnique"] = SCOPED;
    const res = await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30&scope=all");
    expect(res.body.scope).toBe("all");
    for (const q of db.raw) expect(q.sql).not.toContain(MINERALS_ONLY);
    expect(sqlOf("sms:volume")[0].sql).not.toContain("JOIN");
    expect(sqlOf("sms:funnel")[0].sql).not.toContain('"pipelineId" = ANY');
    expect(res.body.funnel.pipelines).toBeNull();
    expectOrgScoped();
  });

  it("uses the suggested minerals pipelines until a filter is saved", async () => {
    db.results["integration.findUnique"] = { ...SCOPED, config: { ...SCOPED.config, scope: null } };
    const res = await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30");
    expect(res.body.scopeInfo.saved).toBe(false);
    expect(res.body.funnel.pipelines).toEqual([{ id: "pMin", name: "Minerals" }]);
  });

  it("splits the period's texted people by line and reports the scope state on /status", async () => {
    db.results["integration.findUnique"] = SCOPED;
    db.rawResults["sms:line-split"] = [{ line: "minerals", n: 40 }, { line: "real_estate", n: 12 }, { line: null, n: 5 }, { line: "unclassified", n: 1 }];
    db.rawResults["sms:status-lines"] = [{ line: "minerals", n: 900 }, { line: null, n: 30 }];
    const report = await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30");
    expect(report.body.scopeInfo).toEqual({ saved: true, texted: { minerals: 40, realEstate: 12, unclassified: 6 } });
    const status = await call(VIEWER, "/api/reports/sms/status");
    expect(status.body).toMatchObject({ scopeSaved: true, minerals: 900, realEstate: 0, unclassified: 30 });
    expect(sqlOf("sms:status-lines")[0].sql).toContain('"outboundTotal" > 0');
  });

  it("limits the filter choices to the scope's contacts", async () => {
    await call(OWNER, "/api/reports/sms/filters");
    expect(sqlOf("sms:filter-tags")[0].sql).toContain(MINERALS_ONLY);
    db.raw.length = 0;
    await call(OWNER, "/api/reports/sms/filters?scope=all");
    expect(sqlOf("sms:filter-tags")[0].sql).not.toContain(MINERALS_ONLY);
  });
});

describe("cost, speed, best time, phone lists, carrier health", () => {
  const rows = () => Object.assign(db.rawResults, {
    "sms:volume": [{ sent: 1000, delivered: 900, failed: 40, inbound: 120, contactsTexted: 400, segments: 1500, unknownSegments: 25 }],
    "sms:cohort": [{ touches: 1, outcome: "RESPONDED", count: 50, unconfirmed: 0, texts: 50 }, { touches: 2, outcome: "NO_REPLY", count: 250, unconfirmed: 0, texts: 500 }],
    "sms:cohort-x": [{ wrongNumbers: 30, responded: 50, answered: 40, within5m: 10, within1h: 25, within24h: 38, avg: 7200, median: 1800 }],
    "sms:funnel": [{ opportunity: 20, offer: 10, accepted: 4, contract: 3, closed: 2, dead: 5, preExisting: 3, cohortTexts: 900,
      oppAvg: 86400, oppMedian: 43200, closeAvg: 2e6, closeMedian: 1.5e6, closeKnown: 1 }],
    "sms:speed-members": [{ key: "hu1", answered: 30, median: 1500, within1h: 20 }, { key: null, answered: 10, median: 4000, within1h: 5 }],
    "sms:best-time": [{ dow: 2, hour: 10, reached: 60, responded: 12 }, { dow: 3, hour: 9, reached: 5, responded: 3 }],
    "sms:tags": [{ v: "wrong number-1" }, { v: "landline" }, { v: "sms incapable" }, { v: "reeves county" }],
    "sms:quality": [{ dim: "listTag", key: "reeves county", reached: 300, responded: 50, wrongNumber: 30, disconnected: 6, landline: 9, rotated: 60, exhausted: 3 }],
    "sms:bd-volume": [{ dim: "listTag", key: "reeves county", textsSent: 1000, delivered: 900 }],
    "sms:health-days": [{ day: "2026-09-10", sent: 500, failed: 100, reached: 380, optOuts: 4 }],
    "sms:health-7d": [{ sent: 300, failed: 9, reached: 250, optOuts: 15 }],
  });

  it("prices the segments sent and divides by the cohort's results", async () => {
    db.results["integration.findUnique"] = SCOPED;
    rows();
    const b = (await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30")).body;
    expect(b.cost).toMatchObject({ pricePerSegment: 0.01, segments: 1500, unknownSegments: 25, total: 15, perReply: 0.3, perOpportunity: 0.75, perOffer: 1.5, perClosedDeal: 7.5 });
    expect(b.kpis).toMatchObject({ textingCost: 15, costPerClosedDeal: 7.5, wrongNumbers: 30, wrongNumberRate: 0.1, opportunities: 20, interestedRate: 20 / 300 });
    expect(b.notes.unknownSegments).toBe(25);
    expect(b.funnel).toMatchObject({ dead: 5, preExisting: 3, textsPerClosedDeal: 450, toClose: { known: 1, unknown: 1 } });
    expect(b.speed).toMatchObject({ responded: 50, answered: 40, never: 10, neverRate: 0.2, within1hRate: 0.5, medianSeconds: 1800 });
    expect(b.speed.byMember).toEqual([
      { key: "hu1", name: "Maria Gonzalez", answered: 30, medianSeconds: 1500, within1hRate: 20 / 30 },
      { key: "none", name: "Team member not recorded", answered: 10, medianSeconds: 4000, within1hRate: 0.5 },
    ]);
    // Best time in the location's zone, bound as a parameter.
    expect(b.bestTime).toMatchObject({ timezone: "America/Chicago", fallback: false });
    expect(sqlOf("sms:best-time")[0].values).toContain("America/Chicago");
    expect(b.bestTime.best.map((c: { dow: number; hour: number }) => [c.dow, c.hour])).toEqual([[2, 10]]);
    expect(b.bestTime.cells.find((c: { dow: number }) => c.dow === 3).small).toBe(true);
    // Phone lists: the org's tags classified once, matched exactly.
    expect(sqlOf("sms:quality")[0].values).toEqual(expect.arrayContaining([["wrong number-1"], ["landline", "sms incapable"]]));
    expect(b.phoneQuality.tags[0]).toMatchObject({ key: "reeves county", deliveryRate: 0.9, wrongNumberRate: 0.1, landlineRate: 0.03 });
    // Carrier health: the breach day and the rolling 7 days.
    expect(b.carrierHealth.breachDays).toEqual(["2026-09-10"]);
    expect(b.carrierHealth.last7).toMatchObject({ optOutRate: 0.06, warnings: ["optOut"] });
    expect(b.carrierHealth.thresholds).toEqual({ optOutRate: 0.05, failureRate: 0.15, minTexts: 100 });
  });

  it("shows cost as N/A without a price, however many segments went out", async () => {
    db.results["integration.findUnique"] = { ...SCOPED, config: { ...SCOPED.config, pricePerSegment: null } };
    rows();
    const b = (await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30")).body;
    expect(b.cost).toMatchObject({ pricePerSegment: null, segments: 1500, total: null, perReply: null, perOpportunity: null, perOffer: null, perClosedDeal: null });
    expect(b.kpis.textingCost).toBeNull();
  });

  it("compares the newer KPIs too (rates in points)", async () => {
    db.results["integration.findUnique"] = SCOPED;
    rows();
    const b = (await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30&compareFrom=2026-08-01&compareTo=2026-08-31")).body;
    expect(b.previous.textingCost).toBe(15);
    expect(b.deltas.textingCost).toBe(0);
    expect(b.deltaKind.wrongNumberRate).toBe("points");
    expect(sqlOf("sms:funnel")).toHaveLength(2);
  });
});

describe("still waiting and texts before a reply", () => {
  const DAY = 86_400_000;
  /** The instant a query bound for "texted at or after" (bound right after the NO_REPLY outcome, and again for the reached text). */
  const sinceOf = (q: Prisma.Sql) => {
    expect(q.values.filter((v) => v === "NO_REPLY")).toHaveLength(1);
    const i = q.values.indexOf("NO_REPLY");
    const [since, org, again] = q.values.slice(i + 1, i + 4);
    expect(typeof since).toBe("string");
    expect([org, again]).toEqual(["org_a", since]);
    return new Date(since as string).getTime();
  };
  /** The tile's still-waiting condition, as SQL text. */
  const condOf = (q: Prisma.Sql) => /AS "wrongNumbers",\s*count\(\*\) FILTER \(WHERE (.*?)\)::int AS "stillWaiting"/s.exec(q.sql)![1];

  it("counts no-reply people last texted within the response window of now, and averages texts before a reply", async () => {
    db.results["integration.findUnique"] = CONNECTED; // 14-day window
    Object.assign(db.rawResults, {
      "sms:cohort": [
        { touches: 1, outcome: "RESPONDED", count: 6, unconfirmed: 0, texts: 6 },
        { touches: 4, outcome: "RESPONDED", count: 2, unconfirmed: 0, texts: 8 },
        { touches: 3, outcome: "NO_REPLY", count: 30, unconfirmed: 0, texts: 90 },
      ],
      "sms:cohort-x": [{ wrongNumbers: 0, stillWaiting: 12, responded: 8, answered: 0, within5m: 0, within1h: 0, within24h: 0, avg: null, median: null }],
    });
    const before = Date.now();
    const b = (await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30")).body;
    expect(b.kpis).toMatchObject({ stillWaiting: 12, avgTextsBeforeReply: 14 / 8, contactsReached: 38, contactsResponded: 8 });
    // Waiting people stay in "reached": the response rate is unchanged.
    expect(b.kpis.responseRate).toBe(8 / 38);
    const tile = sqlOf("sms:cohort-x")[0];
    // No reply yet, and a text that REACHED them (not a failed one) inside the window.
    const cond = condOf(tile);
    expect(cond).toContain(`c."outcome" = ? AND c."lastMessageAt" >= ?::timestamp`);
    expect(cond).toMatch(/EXISTS \(SELECT 1 FROM "HighLevelMessage" m WHERE m\."organizationId" = \? AND m\."hlContactId" = c\."hlId"\s+AND m\."sentAt" >= \?::timestamp AND m\."direction" = 'outbound' AND NOT \(.*\) AND NOT \(.*\)\)/s);
    expect(tile.values).toEqual(expect.arrayContaining([["pending", "scheduled", "queued"], ["failed", "undelivered", "opt_out"]]));
    const since = sinceOf(tile);
    expect(since).toBeGreaterThanOrEqual(before - 14 * DAY - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() - 14 * DAY);
  });

  it("compares both, judging still waiting against now for the comparison window too", async () => {
    db.results["integration.findUnique"] = SCOPED;
    db.rawResults["sms:cohort"] = [{ touches: 2, outcome: "RESPONDED", count: 5, unconfirmed: 0, texts: 10 }];
    db.rawResults["sms:cohort-x"] = [{ wrongNumbers: 0, stillWaiting: 4, responded: 5, answered: 0, within5m: 0, within1h: 0, within24h: 0, avg: null, median: null }];
    const b = (await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30&compareFrom=2026-08-01&compareTo=2026-08-31")).body;
    expect(b.previous).toMatchObject({ stillWaiting: 4, avgTextsBeforeReply: 2 });
    expect(b.deltas).toMatchObject({ stillWaiting: 0, avgTextsBeforeReply: 0 });
    expect(b.deltaKind).toMatchObject({ stillWaiting: "relative", avgTextsBeforeReply: "relative" });
    const [cur, prev] = sqlOf("sms:cohort-x");
    expect(prev.values).toEqual(expect.arrayContaining([new Date("2026-08-01T00:00:00Z").toISOString()]));
    expect(sinceOf(cur)).toBe(sinceOf(prev));
  });

  it("lists the still-waiting people with the same condition and window as the tile", async () => {
    db.results["integration.findUnique"] = SCOPED;
    await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30&tags=reeves%20county");
    const tile = sqlOf("sms:cohort-x")[0];
    const cond = condOf(tile);
    db.raw.length = 0;
    db.rawResults["sms:drill-count"] = [{ n: 1 }];
    db.rawResults["sms:drill"] = [{
      hlId: "c7", name: "Bo Reyes", tags: ["reeves county"], firstOutboundAt: new Date("2026-09-20T15:00:00Z"), touches: 3, outcome: "NO_REPLY",
      lastMessageAt: new Date("2026-10-08T15:00:00Z"),
    }];
    const res = await call(VIEWER, "/api/reports/sms/contacts?from=2026-09-01&to=2026-09-30&tags=reeves%20county&set=stillWaiting");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.rows[0]).toMatchObject({ hlId: "c7", outcome: "NO_REPLY", lastTextedAt: "2026-10-08T15:00:00.000Z" });
    const drill = sqlOf("sms:drill-count")[0];
    expect(drill.sql).toContain(`AND ${cond}`);
    expect(drill.sql).toContain(MINERALS_ONLY);
    expect(drill.values).toEqual(expect.arrayContaining(["NO_REPLY", ["reeves county"]]));
    // Same 14-day window as the tile, a moment later.
    expect(Math.abs(sinceOf(drill) - sinceOf(tile))).toBeLessThan(5000);
    expectOrgScoped();
    expect((await call(REPORTS_ONLY, "/api/reports/sms/contacts?set=stillWaiting")).status).toBe(403);
  });
});

describe("the newer drill lists", () => {
  const NEW_SETS = ["wrongNumber", "unclassified", "realEstate", "opportunity", "offer", "accepted", "contract", "closed", "dead", "unanswered",
    "disconnected", "landline", "rotated", "exhausted"];

  it("need contact access", async () => {
    for (const set of NEW_SETS) {
      const res = await call(REPORTS_ONLY, `/api/reports/sms/contacts?set=${set}`);
      expect(res.status, set).toBe(403);
    }
    expect(db.raw).toHaveLength(0);
  });

  it("are each scoped to the org", async () => {
    db.results["integration.findUnique"] = SCOPED;
    for (const set of NEW_SETS) {
      db.raw.length = 0;
      const res = await call(VIEWER, `/api/reports/sms/contacts?from=2026-09-01&to=2026-09-30&set=${set}`);
      expect(res.status, set).toBe(200);
      expectOrgScoped();
    }
  });

  it("count a funnel step with the same opportunity rules as its tile", async () => {
    db.results["integration.findUnique"] = SCOPED;
    await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30");
    const tile = sqlOf("sms:funnel")[0];
    db.raw.length = 0;
    db.rawResults["sms:drill"] = [{ hlId: "c1", name: "Ann", tags: [], oppN: 1, oppOffer: true, oppAccepted: true, oppContract: true, oppClosed: true, oppAlive: 1 }];
    const res = await call(VIEWER, "/api/reports/sms/contacts?from=2026-09-01&to=2026-09-30&set=closed");
    const drill = sqlOf("sms:drill-count")[0];
    expect(lateral(drill)).toBe(lateral(tile));
    expect(drill.values).toEqual(expect.arrayContaining([["pMin", "pOna"]]));
    expect(tile.sql).toContain("count(*) FILTER (WHERE x.closed)");
    expect(drill.sql).toContain("AND x.closed");
    expect(drill.sql).toContain(MINERALS_ONLY);
    expect(res.body.rows[0]).toMatchObject({ furthestStep: "closed", oppDead: false });
  });

  it("count wrong numbers and unanswered replies with the same conditions as their tiles", async () => {
    db.results["integration.findUnique"] = SCOPED;
    db.rawResults["sms:tags"] = [{ v: "wrong number-2" }];
    await call(OWNER, "/api/reports/sms?from=2026-09-01&to=2026-09-30");
    const tile = sqlOf("sms:cohort-x")[0];
    const wrongCond = /count\(\*\) FILTER \(WHERE (.*?)\)::int AS "wrongNumbers"/s.exec(tile.sql)![1];
    db.raw.length = 0;
    await call(VIEWER, "/api/reports/sms/contacts?from=2026-09-01&to=2026-09-30&set=wrongNumber");
    expect(sqlOf("sms:drill-count")[0].sql).toContain(`AND ${wrongCond}`);
    expect(sqlOf("sms:drill-count")[0].values).toEqual(expect.arrayContaining([["wrong number-2"]]));
    db.raw.length = 0;
    await call(VIEWER, "/api/reports/sms/contacts?from=2026-09-01&to=2026-09-30&set=unanswered");
    expect(sqlOf("sms:drill-count")[0].sql).toContain(`c."replyAnsweredSeconds" IS NULL`);
  });

  it("list the people outside minerals whatever the scope", async () => {
    for (const [set, cond] of [["unclassified", `coalesce(c."line", 'unclassified') NOT IN ('minerals', 'real_estate')`], ["realEstate", `c."line" = 'real_estate'`]]) {
      db.raw.length = 0;
      await call(VIEWER, `/api/reports/sms/contacts?from=2026-09-01&to=2026-09-30&set=${set}`);
      const q = sqlOf("sms:drill-count")[0];
      expect(q.sql).toContain(cond);
      expect(q.sql).not.toContain(MINERALS_ONLY);
      expect(q.sql).toContain('FROM "HighLevelMessage" m');
    }
  });

  it("narrow to a table row on top of the filters", async () => {
    await call(VIEWER, "/api/reports/sms/contacts?from=2026-09-01&to=2026-09-30&set=reached&tags=a&tags=b&rowDim=tag&rowKey=Reeves%2C%20Oct");
    const q = sqlOf("sms:drill-count")[0];
    expect(q.values).toEqual(expect.arrayContaining([["a", "b"], ["Reeves, Oct"]]));
    db.raw.length = 0;
    db.rawResults["sms:tags"] = [{ v: "landline" }];
    await call(VIEWER, "/api/reports/sms/contacts?from=2026-09-01&to=2026-09-30&set=landline&rowDim=listTag&rowKey=(no%20tag)");
    const nt = sqlOf("sms:drill-count")[0];
    expect(nt.sql).toContain("cardinality(ARRAY(SELECT lt.v");
    expect(nt.values).toEqual(expect.arrayContaining([["landline"]]));
    expectOrgScoped();
  });
});
