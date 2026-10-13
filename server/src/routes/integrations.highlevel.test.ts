/**
 * HighLevel routes on the integrations router: connect (Location ID format,
 * location switching, resuming), import start, response-window change,
 * disconnect keeping history, and the internal config never reaching the
 * browser. Runs against a fake Prisma client that records what it was asked;
 * the HighLevel network check is stubbed.
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
  const prisma = new Proxy({}, { get: (_t, name) => model(String(name)) });
  return { calls, results, prisma };
});
const hl = vi.hoisted(() => ({ check: vi.fn() }));

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));
vi.mock("../services/highlevel/sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/highlevel/sync.js")>()),
  validateHighLevelConnection: hl.check,
}));

import { integrationsRouter } from "./integrations.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { PERMISSIONS } from "../domain/permissions.js";

const ORG = "org_main";
const LOC = "locMock000000000001";

function asOwner(req: AuthedRequest, _res: express.Response, next: express.NextFunction) {
  req.user = {
    id: "u1", role: "OWNER", name: "Owner", email: "owner@local.test", firstName: null, lastName: null, phone: null,
    organizationId: ORG, orgRole: "OWNER", permissions: [...PERMISSIONS], mustChangePassword: false,
    isDemo: false, referenceOrgId: null,
  };
  next();
}

async function call(method: string, path: string, body?: unknown) {
  const app = express();
  app.use(express.json());
  app.use(asOwner);
  app.use("/api/integrations", integrationsRouter);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/integrations${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

const row = (config: Record<string, unknown>, status = "CONNECTED") => ({
  id: "int1", organizationId: ORG, provider: "highlevel", status, config,
  connectedAt: new Date(), lastSyncAt: null, lastError: null, createdAt: new Date(), updatedAt: new Date(),
});

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
  hl.check.mockReset();
  db.results["integration.upsert"] = (args: { create: { config: unknown } ; update: { config: unknown } }) => row(args.update.config as Record<string, unknown>);
  db.results["integration.update"] = (args: { data: { config?: unknown } }) => row((args.data.config ?? {}) as Record<string, unknown>);
  db.results["highLevelMessage.count"] = 0;
  db.results["highLevelContact.count"] = 0;
});

describe("POST /highlevel/connect", () => {
  it("refuses a malformed Location ID before calling HighLevel", async () => {
    const r = await call("POST", "/highlevel/connect", { secret: "pit-x", config: { locationId: "abc" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Location ID/);
    expect(hl.check).not.toHaveBeenCalled();
  });

  it("passes HighLevel's refusal through as a 400", async () => {
    hl.check.mockResolvedValue({ ok: false, message: "HighLevel rejected this key." });
    const r = await call("POST", "/highlevel/connect", { secret: "pit-x", config: { locationId: LOC } });
    expect(r).toMatchObject({ status: 400, body: { error: "HighLevel rejected this key." } });
    expect(db.calls["integration.upsert"]).toBeUndefined();
  });

  it("stores the encrypted key with the preview, and never returns the sync internals", async () => {
    hl.check.mockResolvedValue({ ok: true, location: { id: LOC, name: "XLeads – Carsa Minerals" }, users: [{ id: "u1", name: "Dana", email: null }], texts: 5957 });
    const r = await call("POST", "/highlevel/connect", { secret: "pit-mock-token", config: { locationId: `https://app.xleads.com/v2/location/${LOC}/dashboard` } });
    expect(r.status).toBe(200);
    expect(hl.check).toHaveBeenCalledWith("pit-mock-token", LOC);
    const saved = (db.calls["integration.upsert"][0] as { update: { config: Record<string, unknown> } }).update.config;
    expect(saved).toMatchObject({
      locationId: LOC, locationName: "XLeads – Carsa Minerals", responseWindowDays: 30,
      hlUsers: [{ id: "u1", name: "Dana", email: null }], hlSync: { phase: "preview", preview: { texts: 5957 } },
    });
    expect(String(saved._secret)).toMatch(/^v1:/);
    expect(JSON.stringify(saved)).not.toContain("pit-mock-token");
    expect(r.body.config).toEqual({ locationId: LOC, locationName: "XLeads – Carsa Minerals", responseWindowDays: 30 });
    expect(r.body.message).toMatch(/Found 5,957 texts/);
  });

  it("reconnecting the same location keeps the checkpoint (no re-import)", async () => {
    db.results["integration.findUnique"] = row({ locationId: LOC, responseWindowDays: 60, hlSync: { phase: "live", checkpoint: "2026-10-01T00:00:00.000Z", consecutiveFailures: 2 } }, "ERROR");
    hl.check.mockResolvedValue({ ok: true, location: { id: LOC, name: "Loc" }, users: [], texts: 10 });
    const r = await call("POST", "/highlevel/connect", { secret: "pit-new", config: { locationId: LOC } });
    expect(r.status).toBe(200);
    const saved = (db.calls["integration.upsert"][0] as { update: { config: Record<string, unknown>; status: string } }).update;
    expect(saved.status).toBe("CONNECTED");
    expect(saved.config).toMatchObject({ responseWindowDays: 60, hlSync: { phase: "live", checkpoint: "2026-10-01T00:00:00.000Z", consecutiveFailures: 0 } });
    expect(r.body.message).toMatch(/picks up where it left off/);
  });

  it("refuses a different location while texts from the old one are stored", async () => {
    db.results["integration.findUnique"] = row({ locationId: "locOther00000000001", locationName: "Old account", hlSync: { phase: "live" } });
    db.results["highLevelMessage.findFirst"] = { id: "m1" };
    const r = await call("POST", "/highlevel/connect", { secret: "pit-x", config: { locationId: LOC } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Old account/);
    expect(hl.check).not.toHaveBeenCalled();
  });

  it("allows a different location when nothing was imported yet", async () => {
    db.results["integration.findUnique"] = row({ locationId: "locOther00000000001", hlSync: { phase: "preview", preview: { texts: 3, at: "x" } } });
    db.results["highLevelMessage.findFirst"] = null;
    hl.check.mockResolvedValue({ ok: true, location: { id: LOC, name: "Loc" }, users: [], texts: 42 });
    const r = await call("POST", "/highlevel/connect", { secret: "pit-x", config: { locationId: LOC } });
    expect(r.status).toBe(200);
    const saved = (db.calls["integration.upsert"][0] as { update: { config: Record<string, unknown> } }).update.config;
    expect(saved).toMatchObject({ locationId: LOC, hlSync: { phase: "preview", preview: { texts: 42 } } });
  });
});

describe("POST /highlevel/import", () => {
  it("moves preview → importing", async () => {
    db.results["integration.findUnique"] = row({ locationId: LOC, hlSync: { phase: "preview", preview: { texts: 5957, at: "x" } } });
    const r = await call("POST", "/highlevel/import", {});
    expect(r.status).toBe(200);
    const data = (db.calls["integration.update"][0] as { data: { config: { hlSync: Record<string, unknown> } } }).data;
    expect(data.config.hlSync).toMatchObject({ phase: "importing", preview: { texts: 5957 } });
    expect(typeof data.config.hlSync.importStartedAt).toBe("string");
  });

  it("only starts once", async () => {
    db.results["integration.findUnique"] = row({ locationId: LOC, hlSync: { phase: "importing" } });
    expect((await call("POST", "/highlevel/import", {})).status).toBe(409);
  });
});

describe("PATCH /highlevel", () => {
  it("a new response window marks every contact for a summary recompute", async () => {
    db.results["integration.findUnique"] = row({ locationId: LOC, responseWindowDays: 30, hlSync: { phase: "live" } });
    const r = await call("PATCH", "/highlevel", { config: { responseWindowDays: 60, schedule: "hourly" } });
    expect(r.status).toBe(200);
    expect(db.calls["highLevelContact.updateMany"]).toEqual([{ where: { organizationId: ORG }, data: { summaryDirty: true } }]);
    const cfg = (db.calls["integration.update"][0] as { data: { config: Record<string, unknown> } }).data.config;
    expect(cfg).toMatchObject({ responseWindowDays: 60, hlSync: { phase: "live" } });
    expect(cfg.schedule).toBeUndefined(); // HighLevel never takes the generic schedule
  });

  it("leaves summaries alone when the window is unchanged, and rejects windows that aren't offered", async () => {
    db.results["integration.findUnique"] = row({ locationId: LOC, responseWindowDays: 30 });
    await call("PATCH", "/highlevel", { config: { responseWindowDays: 30, notes: "x" } });
    expect(db.calls["highLevelContact.updateMany"]).toBeUndefined();
    expect((await call("PATCH", "/highlevel", { config: { responseWindowDays: 45 } })).status).toBe(400);
  });
});

describe("disconnect and listing", () => {
  it("disconnect drops the key but keeps the sync state, so history stays and a reconnect resumes", async () => {
    db.results["integration.findUnique"] = row({ locationId: LOC, hlSync: { phase: "live", checkpoint: "c" }, hlUsers: [], _secret: "v1:x", _hint: "…oken" });
    const r = await call("POST", "/highlevel/disconnect", {});
    expect(r.status).toBe(200);
    const update = (db.calls["integration.upsert"][0] as { update: { status: string; config: Record<string, unknown> } }).update;
    expect(update.status).toBe("NOT_CONNECTED");
    expect(update.config).toEqual({ locationId: LOC, hlSync: { phase: "live", checkpoint: "c" }, hlUsers: [] });
    expect(db.calls["highLevelMessage.deleteMany"]).toBeUndefined();
  });

  it("GET / never serializes hlSync / hlUsers", async () => {
    db.results["integration.findMany"] = [row({ locationId: LOC, locationName: "Loc", responseWindowDays: 30, hlSync: { phase: "live" }, hlUsers: [{ id: "u" }], _secret: "v1:x" })];
    const r = await call("GET", "/");
    const card = r.body.find((p: { key: string }) => p.key === "highlevel");
    expect(card).toMatchObject({ name: "HighLevel (LeadConnector)", auth: "apikey", syncable: true, status: "CONNECTED" });
    expect(card.config).toEqual({ locationId: LOC, locationName: "Loc", responseWindowDays: 30 });
  });

  it("GET /highlevel/status reports phase, counts and the window", async () => {
    db.results["integration.findUnique"] = row({ locationId: LOC, locationName: "Loc", responseWindowDays: 14, hlSync: { phase: "importing", preview: { texts: 6000, at: "x" } } });
    db.results["highLevelMessage.count"] = 1234;
    db.results["highLevelContact.count"] = 300;
    const r = await call("GET", "/highlevel/status");
    expect(r.body).toMatchObject({
      connected: true, status: "CONNECTED", locationId: LOC, locationName: "Loc", phase: "importing",
      imported: 1234, contacts: 300, responseWindowDays: 14, storageEstimateMb: 3.9, preview: { texts: 6000 },
    });
  });
});
