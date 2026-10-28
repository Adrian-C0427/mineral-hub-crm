/**
 * Hide / Unhide deals (Deals list visibility):
 *  - GET /deals filters hidden deals IN THE QUERY (?visibility=active|hidden),
 *    and leaves them in when the parameter is omitted, so the Pipeline, Reports
 *    and Mineral Assets keep counting them.
 *  - Hiding only stamps hiddenAt (and logs it); nothing else on the deal changes,
 *    and re-hiding an already hidden deal is a no-op.
 *  - The user's view choice persists through PATCH /auth/preferences.
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
        // Interactive form runs the callback against the same fake; array form resolves each op.
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
import { authRouter } from "./auth.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { PERMISSIONS } from "../domain/permissions.js";

const ORG = "org_main";

function asUser() {
  return (req: AuthedRequest, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: "u1", role: "OWNER", name: "Owner", email: "owner@local.test", firstName: null, lastName: null, phone: null,
      organizationId: ORG, orgRole: "OWNER", permissions: [...PERMISSIONS], mustChangePassword: false,
      isDemo: false, referenceOrgId: null,
    };
    next();
  };
}

async function withApp<T>(run: (port: number) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(asUser());
  app.use("/api/deals", dealsRouter);
  app.use("/api/auth", authRouter);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await run((server.address() as { port: number }).port);
  } finally {
    server.close();
  }
}

async function call(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const listWhere = () => (db.calls["deal.findMany"] as { where: Record<string, unknown> }[])[0]!.where;

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
  db.results["deal.findMany"] = [];
});

describe("GET /deals — visibility is applied in the query", () => {
  it("?visibility=active leaves hidden deals out", async () => {
    await withApp(async (port) => { expect((await call(port, "GET", "/api/deals?visibility=active")).status).toBe(200); });
    expect(listWhere()).toMatchObject({ organizationId: ORG, hiddenAt: null });
    // Every deal is listed on its own — no parent/child filter.
    expect(listWhere()).not.toHaveProperty("parentDealId");
  });

  it("?visibility=hidden returns only hidden deals", async () => {
    await withApp(async (port) => { await call(port, "GET", "/api/deals?visibility=hidden"); });
    expect(listWhere()).toMatchObject({ hiddenAt: { not: null } });
  });

  it("?visibility=all, or no parameter (Pipeline, Reports, Mineral Assets), includes hidden deals", async () => {
    await withApp(async (port) => {
      await call(port, "GET", "/api/deals?visibility=all");
      await call(port, "GET", "/api/deals?recordType=OPPORTUNITY");
    });
    const wheres = (db.calls["deal.findMany"] as { where: Record<string, unknown> }[]).map((c) => c.where);
    expect(wheres).toHaveLength(2);
    for (const w of wheres) expect(w).not.toHaveProperty("hiddenAt");
  });
});

describe("POST /deals/bulk-hidden and /deals/:id/hidden", () => {
  it("stamps hiddenAt on the org's not-yet-hidden deals only, logs each, and changes nothing else", async () => {
    db.results["deal.findMany"] = [{ id: "d1", name: "Smith 40ac" }, { id: "d2", name: "Jones tract" }];
    db.results["deal.updateMany"] = { count: 2 };
    await withApp(async (port) => {
      const res = await call(port, "POST", "/api/deals/bulk-hidden", { ids: ["d1", "d2", "d_other_org"], hidden: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 2, hidden: true });
    });
    // Candidates: this org's rows among the ids that are currently visible.
    expect(db.calls["deal.findMany"]).toEqual([expect.objectContaining({ where: { id: { in: ["d1", "d2", "d_other_org"] }, organizationId: ORG, hiddenAt: null } })]);
    const [upd] = db.calls["deal.updateMany"] as { where: unknown; data: Record<string, unknown> }[];
    expect(upd.where).toEqual({ id: { in: ["d1", "d2"] } });
    expect(Object.keys(upd.data)).toEqual(["hiddenAt"]); // no stage, price or date is touched
    expect(upd.data.hiddenAt).toBeInstanceOf(Date);
    const logs = db.calls["activityLog.create"] as { data: { eventType: string; dealId: string } }[];
    expect(logs.map((l) => [l.data.eventType, l.data.dealId])).toEqual([["DEAL_HIDDEN", "d1"], ["DEAL_HIDDEN", "d2"]]);
  });

  it("unhide clears hiddenAt for hidden deals and is a no-op for visible ones", async () => {
    db.results["deal.findMany"] = [];
    await withApp(async (port) => {
      const res = await call(port, "POST", "/api/deals/bulk-hidden", { ids: ["d1"], hidden: false });
      expect(res.body).toEqual({ updated: 0, hidden: false });
    });
    expect(db.calls["deal.findMany"]).toEqual([expect.objectContaining({ where: expect.objectContaining({ hiddenAt: { not: null } }) })]);
    expect(db.calls["deal.updateMany"]).toBeUndefined();
    expect(db.calls["activityLog.create"]).toBeUndefined();
  });

  it("single-deal endpoint 404s outside the org and otherwise returns the updated deal", async () => {
    db.results["deal.findFirst"] = null;
    await withApp(async (port) => {
      expect((await call(port, "POST", "/api/deals/d9/hidden", { hidden: true })).status).toBe(404);
    });
    const hiddenAt = new Date("2026-10-21T00:00:00Z");
    db.results["deal.findFirst"] = { id: "d1" };
    db.results["deal.findMany"] = [{ id: "d1", name: "Smith 40ac" }];
    db.results["deal.updateMany"] = { count: 1 };
    db.results["deal.findUniqueOrThrow"] = {
      id: "d1", name: "Smith 40ac", organizationId: ORG, stage: "UNDER_CONTRACT", currentStageEnteredAt: hiddenAt, hiddenAt,
      counties: [], states: [], sellerNames: [], abstractIds: [], assetTypes: [], surveys: [], wells: [], leaseStatuses: [], docFolders: [],
      selectedBuyer: null, relationshipOwner: null, assignees: [], recordType: "OPPORTUNITY", createdAt: hiddenAt, updatedAt: hiddenAt,
    };
    await withApp(async (port) => {
      const res = await call(port, "POST", "/api/deals/d1/hidden", { hidden: true });
      expect(res.status).toBe(200);
      expect(res.body.hiddenAt).toBe(hiddenAt.toISOString());
      expect(res.body.stage).toBe("UNDER_CONTRACT");
    });
  });

  it("rejects a malformed body", async () => {
    await withApp(async (port) => {
      expect((await call(port, "POST", "/api/deals/bulk-hidden", { ids: [], hidden: true })).status).toBe(400);
      expect((await call(port, "POST", "/api/deals/bulk-hidden", { ids: ["d1"], hidden: "yes" })).status).toBe(400);
    });
    expect(db.calls["deal.updateMany"]).toBeUndefined();
  });
});

describe("PATCH /auth/preferences — saved Deals visibility", () => {
  it("persists ACTIVE / HIDDEN / ALL and nothing else", async () => {
    await withApp(async (port) => {
      expect((await call(port, "PATCH", "/api/auth/preferences", { dealsVisibility: "HIDDEN" })).body).toMatchObject({ dealsVisibility: "HIDDEN", persisted: true });
      expect((await call(port, "PATCH", "/api/auth/preferences", { dealsVisibility: "everything" })).status).toBe(400);
    });
    expect(db.calls["user.update"]).toEqual([expect.objectContaining({ where: { id: "u1" }, data: { dealsVisibility: "HIDDEN" } })]);
  });

  it("GET /auth/me carries the saved choice back (and null when unset)", async () => {
    db.results["user.findUnique"] = { themePreference: null, accentColor: null, accentColor2: null, avatarColor: null, dealsVisibility: "ALL" };
    await withApp(async (port) => {
      const res = await call(port, "GET", "/api/auth/me");
      expect(res.body.user.dealsVisibility).toBe("ALL");
    });
    db.results["user.findUnique"] = { themePreference: null, accentColor: null, accentColor2: null, avatarColor: null, dealsVisibility: "bogus" };
    await withApp(async (port) => {
      expect((await call(port, "GET", "/api/auth/me")).body.user.dealsVisibility).toBeNull();
    });
  });
});
