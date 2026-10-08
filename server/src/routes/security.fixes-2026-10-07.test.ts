/**
 * Regression tests for the 2026-10-07 audit fixes:
 *  - Converting an opportunity creates a Deal, so it needs createDeals (the
 *    same gate as POST /deals) — both the explicit convert endpoint and a
 *    stage move onto the pipeline's AUTO-convert stage.
 *  - GET /opportunities requires a pipelineId (no org-wide dump of the
 *    prospect list) and is capped.
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
    opportunity: model("opportunity", ["findMany", "findFirst", "update"]),
    opportunityStageHistory: model("opportunityStageHistory", ["create"]),
    user: model("user", ["findMany", "findFirst"]),
    // The stage move's row lock (lockStageRow).
    $queryRaw: record("$queryRaw"),
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

import { opportunitiesRouter, OPPORTUNITY_LIST_MAX } from "./opportunities.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { OrgRole, Permission } from "../domain/permissions.js";

type Caller = { id: string; orgRole: OrgRole; permissions: Permission[] };
const EDITOR_NO_CREATE: Caller = { id: "u_ed", orgRole: "MEMBER", permissions: ["viewDeals", "editDeals"] };
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
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

const opp = (over: Record<string, unknown> = {}) => ({
  id: "opp_1", organizationId: "org_a", name: "Smith prospect", stage: "NEW", pipelineId: "pl_opp", convertedDealId: null,
  pipeline: { id: "pl_opp", kind: "OPPORTUNITIES", convertMode: "AUTO", convertStageKey: "QUALIFIED", convertToPipelineId: null },
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
  Object.assign(db.results, {
    "pipeline.findFirst": { id: "pl_opp" },
    "opportunity.findMany": [],
    "opportunity.findFirst": opp(),
    "user.findMany": [],
  });
});

describe("opportunity conversion needs createDeals", () => {
  it("rejects the explicit convert without createDeals, before touching the database", async () => {
    const res = await call(EDITOR_NO_CREATE, "POST", "/api/opportunities/opp_1/convert", {});
    expect(res.status).toBe(403);
    expect(db.calls["opportunity.findFirst"]).toBeUndefined();
    expect(db.calls["$transaction"]).toBeUndefined();
  });

  it("rejects a stage move onto the AUTO-convert stage without createDeals and moves nothing", async () => {
    const res = await call(EDITOR_NO_CREATE, "POST", "/api/opportunities/opp_1/stage", { toStage: "QUALIFIED" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/create deals/i);
    expect(db.calls["opportunity.update"]).toBeUndefined();
    expect(db.calls["$transaction"]).toBeUndefined();
  });

  it("still lets the editor move to a stage that does not convert", async () => {
    // The response reload reads the full record; any shape the serializer accepts will do.
    // (The in-transaction re-read after the row lock selects stage fields only.)
    db.results["opportunity.findFirst"] = (args: { include?: { pipeline?: boolean }; select?: unknown }) =>
      args.include?.pipeline || args.select ? opp() : { ...opp({ stage: "LOST" }), owner: null, contact: null, convertedDeal: null, stageHistory: [], activities: [] };
    const res = await call(EDITOR_NO_CREATE, "POST", "/api/opportunities/opp_1/stage", { toStage: "LOST", reason: "No interest" });
    expect(res.status).toBe(200);
    expect(db.calls["$queryRaw"]).toHaveLength(1);
    expect(db.calls["opportunity.update"]).toHaveLength(1);
  });
});

describe("opportunity list", () => {
  it("requires a pipelineId", async () => {
    const res = await call(VIEWER, "GET", "/api/opportunities");
    expect(res.status).toBe(400);
    expect(db.calls["opportunity.findMany"]).toBeUndefined();
  });

  it("scopes to the caller's org and pipeline and caps the query", async () => {
    const res = await call(VIEWER, "GET", "/api/opportunities?pipelineId=pl_opp");
    expect(res.status).toBe(200);
    const args = db.calls["opportunity.findMany"]![0] as { where: unknown; take: number };
    expect(args.where).toEqual({ organizationId: "org_a", pipelineId: "pl_opp" });
    expect(args.take).toBe(OPPORTUNITY_LIST_MAX + 1);
    expect(res.headers.get("x-result-truncated")).toBeNull();
  });

  it("404s a pipeline from another org", async () => {
    db.results["pipeline.findFirst"] = null;
    const res = await call(VIEWER, "GET", "/api/opportunities?pipelineId=pl_other");
    expect(res.status).toBe(404);
    expect(db.calls["opportunity.findMany"]).toBeUndefined();
  });
});
