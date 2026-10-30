/**
 * Regression tests for the 2026-10-30 audit (Low): the rest of the map's
 * deal data needs "View deals" as well as "View map" (the 2026-10-29 fix
 * covered /map/deals, /map/assets, /map/filters and /map/opportunities).
 *  - GET /gis/suggest returned the org's deals and mineral assets (name,
 *    stage, counties, abstract ids) to a caller with the map alone.
 *  - GET /map/tracts and /map/tracts/imports returned the linked deal's id
 *    and name, and accepted ?dealId= to list one deal's tracts.
 *
 * Routers run against a fake Prisma client that records what it was asked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";

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

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));

vi.mock("../services/sonrisWells.js", () => ({ sonrisWellsAvailable: () => false }));

import { mapRouter } from "./map.js";
import { gisRouter } from "./gis.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { Permission } from "../domain/permissions.js";

async function withApp<T>(permissions: Permission[] | null, mount: (app: express.Express) => void, run: (port: number) => Promise<T>): Promise<T> {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(cookieParser());
  app.use((req: AuthedRequest, _res, next) => {
    if (permissions) {
      req.user = {
        id: "u1", role: "ASSOCIATE", name: "T", email: "t@local.test", firstName: null, lastName: null, phone: null,
        organizationId: "org_a", orgRole: "MEMBER", permissions, mustChangePassword: false, isDemo: false, referenceOrgId: null,
      };
    }
    next();
  });
  mount(app);
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

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
});

// ---------------------------------------------------------------------------
describe("map search lists deals and assets only with View deals", () => {
  const mount = (app: express.Express) => app.use("/api/gis", gisRouter);
  const DEALS = [
    { id: "d1", name: "Smith Ranch", recordType: "DEAL", stage: "NEGOTIATING", counties: ["Leon"], abstractIds: ["abs1"] },
    { id: "a1", name: "Smith Minerals", recordType: "OWNED_ASSET", stage: "HOLD", counties: ["Leon"], abstractIds: [] },
  ];

  it("omits them, without reading the org's deals, for View map alone", async () => {
    Object.assign(db.results, { "$queryRawUnsafe": [], "deal.findMany": DEALS });
    await withApp(["viewMap"], mount, async (port) => {
      const r = await call(port, "GET", "/api/gis/suggest?q=smith");
      expect(r.status).toBe(200);
      expect(r.body?.deals).toEqual([]);
      expect(r.body?.assets).toEqual([]);
    });
    expect(db.calls["deal.findMany"]).toBeUndefined();
  });

  it("lists them with View map and View deals", async () => {
    Object.assign(db.results, { "$queryRawUnsafe": [], "deal.findMany": DEALS });
    await withApp(["viewMap", "viewDeals"], mount, async (port) => {
      const r = await call(port, "GET", "/api/gis/suggest?q=smith");
      expect(r.status).toBe(200);
      expect((r.body?.deals as { id: string }[]).map((d) => d.id)).toEqual(["d1"]);
      expect((r.body?.assets as { id: string }[]).map((d) => d.id)).toEqual(["a1"]);
    });
  });
});

// ---------------------------------------------------------------------------
describe("imported tracts name their deal only with View deals", () => {
  const mount = (app: express.Express) => app.use("/api/map", mapRouter);
  // A fresh copy per query: the route blanks fields on the rows it reads.
  const TRACTS = () => [{
    id: "t1", name: "Tract 1", sourceFile: "smith-ranch.shp", importId: "imp1", properties: {}, geometry: null,
    deal: { id: "d1", name: "Smith Ranch" },
  }];
  const GROUPS = [{ importId: "imp1", sourceFile: "smith-ranch.shp", dealId: "d1", _count: { _all: 1 }, _min: { createdAt: new Date(0) } }];

  it("strips the deal id and name for View map alone", async () => {
    Object.assign(db.results, { "mapTract.findMany": TRACTS, "mapTract.groupBy": GROUPS, "deal.findMany": [{ id: "d1", name: "Smith Ranch" }] });
    await withApp(["viewMap"], mount, async (port) => {
      const fc = await call(port, "GET", "/api/map/tracts");
      expect(fc.status).toBe(200);
      const props = (fc.body?.features as { properties: Record<string, unknown> }[])[0].properties;
      expect(props.__dealId).toBeNull();
      expect(props.__dealName).toBeNull();
      const list = await call(port, "GET", "/api/map/tracts/imports");
      expect(list.status).toBe(200);
      expect(list.body).toEqual([expect.objectContaining({ importId: "imp1", dealId: null, dealName: null })]);
    });
    expect(db.calls["deal.findMany"]).toBeUndefined();
  });

  it("refuses ?dealId= scoping for View map alone", async () => {
    Object.assign(db.results, { "mapTract.findMany": TRACTS, "mapTract.groupBy": GROUPS });
    await withApp(["viewMap"], mount, async (port) => {
      expect((await call(port, "GET", "/api/map/tracts?dealId=d1")).status).toBe(403);
      expect((await call(port, "GET", "/api/map/tracts/imports?dealId=d1")).status).toBe(403);
    });
    expect(db.calls["mapTract.findMany"]).toBeUndefined();
    expect(db.calls["mapTract.groupBy"]).toBeUndefined();
  });

  it("keeps the deal id and name with View deals", async () => {
    Object.assign(db.results, { "mapTract.findMany": TRACTS, "mapTract.groupBy": GROUPS, "deal.findMany": [{ id: "d1", name: "Smith Ranch" }] });
    await withApp(["viewMap", "viewDeals"], mount, async (port) => {
      const fc = await call(port, "GET", "/api/map/tracts?dealId=d1");
      const props = (fc.body?.features as { properties: Record<string, unknown> }[])[0].properties;
      expect(props.__dealId).toBe("d1");
      expect(props.__dealName).toBe("Smith Ranch");
      const list = await call(port, "GET", "/api/map/tracts/imports");
      expect(list.body).toEqual([expect.objectContaining({ dealId: "d1", dealName: "Smith Ranch" })]);
    });
  });
});
