/**
 * Creating and editing an opportunity (POST / PATCH /opportunities): both run
 * the same field rules — org-scoped owner and contact, blank → null, the same
 * limits — and PATCH changes only the fields it names. Stage and pipeline are
 * not editable through PATCH (Move stage keeps the history).
 *
 * The router runs against a fake Prisma client that records what it was asked.
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
  const model = (name: string, methods: string[]) =>
    Object.fromEntries(methods.map((m) => [m, record(`${name}.${m}`)]));
  const prisma = {
    pipeline: model("pipeline", ["findFirst"]),
    opportunity: model("opportunity", ["findFirst", "create", "update"]),
    opportunityStageHistory: model("opportunityStageHistory", ["create"]),
    user: model("user", ["findMany", "findFirst"]),
    contact: model("contact", ["findFirst", "findMany", "create", "update"]),
    $transaction: async (fn: unknown) => {
      (calls["$transaction"] ??= []).push(fn);
      return typeof fn === "function" ? (fn as (tx: unknown) => unknown)(prisma) : Promise.all(fn as Promise<unknown>[]);
    },
  };
  return { calls, results, prisma };
});

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));
vi.mock("../domain/stages.js", async (orig) => ({
  ...(await orig<typeof import("../domain/stages.js")>()),
  ensureStages: vi.fn(async () => [
    { key: "NEW", isTerminal: false },
    { key: "QUALIFIED", isTerminal: false },
    { key: "LOST", isTerminal: true },
  ]),
}));

import { opportunitiesRouter } from "./opportunities.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { OrgRole, Permission } from "../domain/permissions.js";

type Caller = { id: string; orgRole: OrgRole; permissions: Permission[] };
const EDITOR: Caller = { id: "u_ed", orgRole: "MEMBER", permissions: ["viewDeals", "editDeals"] };
const VIEWER: Caller = { id: "u_v", orgRole: "VIEWER", permissions: ["viewDeals"] };

async function call(caller: Caller, method: string, path: string, body?: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req: AuthedRequest, _res, next) => {
    req.user = {
      id: caller.id, role: "ASSOCIATE", name: "Test", email: "t@local.test", firstName: null, lastName: null, phone: null,
      organizationId: "org_a", orgRole: caller.orgRole, permissions: caller.permissions, mustChangePassword: false, isDemo: false, referenceOrgId: null,
    };
    next();
  });
  app.use("/api/opportunities", opportunitiesRouter);
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

/** A stored opportunity in the shape every read (summary or detail) accepts. */
const row = (over: Record<string, unknown> = {}) => ({
  id: "opp_1", organizationId: "org_a", name: "Smith prospect", pipelineId: "pl_opp", stage: "QUALIFIED",
  currentStageEnteredAt: new Date("2026-10-01T00:00:00Z"), owner: null, contactId: null, sellerName: "Ann Smith", companyName: null,
  phone: null, email: null, state: "TX", county: "Leon", abstract: null, survey: null, estAcres: null, estNma: 40, estNra: null,
  source: null, notes: null, lastActivityAt: null, nextFollowUpDate: null, convertedDealId: null, convertedAt: null, closeReason: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  pipeline: { id: "pl_opp", kind: "OPPORTUNITIES", convertMode: "MANUAL", convertStageKey: null, convertToPipelineId: null },
  contact: null, convertedDeal: null, stageHistory: [], activities: [],
  ...over,
});

const updateData = () => (db.calls["opportunity.update"]![0] as { data: Record<string, unknown> }).data;
const createData = () => (db.calls["opportunity.create"]![0] as { data: Record<string, unknown> }).data;

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
  Object.assign(db.results, {
    "pipeline.findFirst": { id: "pl_opp", kind: "OPPORTUNITIES" },
    "opportunity.findFirst": row(),
    "opportunity.create": { id: "opp_1" },
    "opportunity.update": { id: "opp_1" },
    "opportunityStageHistory.create": {},
    "user.findFirst": { id: "u_owner" },
    "user.findMany": [],
    "contact.findFirst": { id: "c_1" },
    "contact.findMany": [],
    "contact.create": { id: "c_new", firstName: "Mary", lastName: "Hernandez", entityName: null, phone: null, email: null, preferredContact: null, mailingStreet: null, mailingCity: null, mailingState: null, mailingZip: null },
  });
});

describe("PATCH /opportunities/:id", () => {
  it("writes only the fields it was sent (plus the activity stamp)", async () => {
    const res = await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { name: "  Smith minerals ", estNma: 0 });
    expect(res.status).toBe(200);
    const data = updateData();
    expect(Object.keys(data).sort()).toEqual(["estNma", "lastActivityAt", "name"]);
    expect(data.name).toBe("Smith minerals");
    expect(data.estNma).toBe(0);
    expect(res.body.id).toBe("opp_1");
  });

  it("clears emptied fields to null — an empty owner never reaches the foreign key", async () => {
    const res = await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { sellerName: "", email: "  ", ownerId: "", contactId: "", notes: null });
    expect(res.status).toBe(200);
    expect(updateData()).toMatchObject({ sellerName: null, email: null, ownerId: null, contactId: null, notes: null });
    expect(db.calls["user.findFirst"]).toBeUndefined();
    expect(db.calls["contact.findFirst"]).toBeUndefined();
  });

  it("checks the owner and contact belong to the caller's org", async () => {
    db.results["user.findFirst"] = null;
    let res = await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { ownerId: "u_elsewhere" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner/i);
    expect((db.calls["user.findFirst"]![0] as { where: unknown }).where).toEqual({ id: "u_elsewhere", organizationId: "org_a" });

    db.results["user.findFirst"] = { id: "u_owner" };
    db.results["contact.findFirst"] = null;
    res = await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { contactId: "c_elsewhere" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contact/i);
    expect(db.calls["opportunity.update"]).toBeUndefined();
  });

  it("applies the create rules: a name can't be blanked and estimates can't go negative", async () => {
    expect((await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { name: "   " })).status).toBe(400);
    expect((await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { estNra: -1 })).status).toBe(400);
    expect((await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { notes: "x".repeat(10_001) })).status).toBe(400);
    expect((await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { nextFollowUpDate: "10/12/2026" })).status).toBe(400);
    expect(db.calls["opportunity.update"]).toBeUndefined();
  });

  it("refuses a stage or pipeline change (Move stage owns those) and writes nothing", async () => {
    let res = await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { stage: "LOST", sellerName: "B" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/move stage/i);
    res = await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { pipelineId: "pl_other" });
    expect(res.status).toBe(400);
    expect(db.calls["opportunity.update"]).toBeUndefined();
  });

  it("stores the follow-up as a calendar day and clears it with null", async () => {
    await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { nextFollowUpDate: "2026-11-03" });
    expect((updateData().nextFollowUpDate as Date).toISOString()).toBe("2026-11-03T00:00:00.000Z");
    delete db.calls["opportunity.update"];
    await call(EDITOR, "PATCH", "/api/opportunities/opp_1", { nextFollowUpDate: null });
    expect(updateData().nextFollowUpDate).toBeNull();
  });

  it("is org-scoped and needs editDeals", async () => {
    db.results["opportunity.findFirst"] = null;
    const res = await call(EDITOR, "PATCH", "/api/opportunities/opp_other", { sellerName: "B" });
    expect(res.status).toBe(404);
    expect((db.calls["opportunity.findFirst"]![0] as { where: unknown }).where).toEqual({ id: "opp_other", organizationId: "org_a" });

    db.results["opportunity.findFirst"] = row();
    expect((await call(VIEWER, "PATCH", "/api/opportunities/opp_1", { sellerName: "B" })).status).toBe(403);
    expect(db.calls["opportunity.update"]).toBeUndefined();
  });
});

describe("POST /opportunities", () => {
  it("creates in the chosen pipeline's first active stage with a history row; blanks stored as null", async () => {
    const res = await call(EDITOR, "POST", "/api/opportunities", { name: "Hernandez", pipelineId: "pl_opp", sellerName: "Ann Smith", ownerId: "", county: "Leon", source: " " });
    expect(res.status).toBe(201);
    const data = createData();
    expect(data).toMatchObject({ organizationId: "org_a", name: "Hernandez", pipelineId: "pl_opp", stage: "NEW", sellerName: "Ann Smith", ownerId: null, county: "Leon", source: null });
    expect(db.calls["opportunityStageHistory.create"]).toHaveLength(1);
    expect((db.calls["pipeline.findFirst"]![0] as { where: unknown }).where).toEqual({ id: "pl_opp", organizationId: "org_a" });
  });

  it("keeps an explicitly chosen stage", async () => {
    await call(EDITOR, "POST", "/api/opportunities", { name: "Hernandez", pipelineId: "pl_opp", stage: "QUALIFIED", companyName: "Hernandez Trust" });
    expect(createData().stage).toBe("QUALIFIED");
  });

  it("needs the seller: refuses a body with no seller block, seller name, entity or contact", async () => {
    const res = await call(EDITOR, "POST", "/api/opportunities", { name: "Hernandez", pipelineId: "pl_opp" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/seller/i);
    expect(db.calls["opportunity.create"]).toBeUndefined();
  });

  it("a seller block creates the Contact in the same transaction and links it", async () => {
    db.results["contact.findFirst"] = null; // nobody has this email yet
    const res = await call(EDITOR, "POST", "/api/opportunities", {
      name: "Hernandez", pipelineId: "pl_opp",
      seller: { firstName: "Mary", lastName: "Hernandez", phone: "(903) 555-1234", email: "Mary@Example.com", sellerType: "INDIVIDUAL" },
    });
    expect(res.status).toBe(201);
    const c = (db.calls["contact.create"]![0] as { data: Record<string, unknown> }).data;
    expect(c).toMatchObject({ organizationId: "org_a", firstName: "Mary", lastName: "Hernandez", type: "PROSPECT", phone: "9035551234", email: "mary@example.com", ownerId: "u_ed" });
    expect(createData()).toMatchObject({ contactId: "c_new", sellerName: "Mary Hernandez", phone: "9035551234", email: "mary@example.com" });
    expect(db.calls["$transaction"]).toHaveLength(1);
  });

  it("a seller block naming an existing contact links it instead of creating one", async () => {
    db.results["contact.findFirst"] = { id: "c_1", firstName: "Ann", lastName: "Lee", entityName: "Lee Minerals LLC", phone: "9030000000", email: "ann@x.com", preferredContact: null, mailingStreet: null, mailingCity: null, mailingState: null, mailingZip: null };
    const res = await call(EDITOR, "POST", "/api/opportunities", { name: "Lee", pipelineId: "pl_opp", seller: { contactId: "c_1" } });
    expect(res.status).toBe(201);
    expect(db.calls["contact.create"]).toBeUndefined();
    expect(createData()).toMatchObject({ contactId: "c_1", sellerName: "Ann Lee", companyName: "Lee Minerals LLC", phone: "9030000000", email: "ann@x.com" });
  });

  it("rejects a pipeline that is gone, holds deals, or a stage it doesn't have — never creating anything", async () => {
    db.results["pipeline.findFirst"] = null;
    let res = await call(EDITOR, "POST", "/api/opportunities", { name: "X", pipelineId: "pl_gone" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown pipeline/i);

    db.results["pipeline.findFirst"] = { id: "pl_deals", kind: "DEALS" };
    res = await call(EDITOR, "POST", "/api/opportunities", { name: "X", pipelineId: "pl_deals" });
    expect(res.status).toBe(400);

    db.results["pipeline.findFirst"] = { id: "pl_opp", kind: "OPPORTUNITIES" };
    res = await call(EDITOR, "POST", "/api/opportunities", { name: "X", pipelineId: "pl_opp", stage: "CLOSING" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown pipeline stage/i);
    expect(db.calls["opportunity.create"]).toBeUndefined();
  });

  it("validates the owner against the caller's org, like PATCH", async () => {
    db.results["user.findFirst"] = null;
    const res = await call(EDITOR, "POST", "/api/opportunities", { name: "X", pipelineId: "pl_opp", ownerId: "u_elsewhere" });
    expect(res.status).toBe(400);
    expect(db.calls["opportunity.create"]).toBeUndefined();
  });
});
