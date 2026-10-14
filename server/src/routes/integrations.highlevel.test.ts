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
  const prisma = new Proxy({}, { get: (_t, name) => (String(name).startsWith("$") ? record(String(name)) : model(String(name))) });
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

/** Set per test: call as the demo workspace's owner instead of a live one. */
let asDemo = false;

function asOwner(req: AuthedRequest, _res: express.Response, next: express.NextFunction) {
  req.user = {
    id: "u1", role: "OWNER", name: "Owner", email: "owner@local.test", firstName: null, lastName: null, phone: null,
    organizationId: ORG, orgRole: "OWNER", permissions: [...PERMISSIONS], mustChangePassword: false,
    isDemo: asDemo, referenceOrgId: null,
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
  asDemo = false;
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

describe("HighLevel tags written by Mineral Hub", () => {
  const base = (extra: Record<string, unknown> = {}) => row({ locationId: LOC, _secret: "v1:x", responseWindowDays: 30, hlSync: { phase: "live" }, ...extra });
  const configWrites = () => (db.calls["integration.update"] ?? []) as { data: { config: Record<string, unknown> } }[];

  it("switching on saves the setting and marks every texted contact to be checked", async () => {
    db.results["integration.findUnique"] = base();
    const r = await call("PATCH", "/highlevel", { config: { crmTagsEnabled: true } });
    expect(r.status).toBe(200);
    expect(configWrites()[0].data.config.crmTagsEnabled).toBe(true);
    expect(db.calls["highLevelContact.updateMany"]).toContainEqual({
      where: { organizationId: ORG, deletedInHl: false, outboundTotal: { gt: 0 } }, data: { crmTagsPending: true },
    });
    expect(r.body.config.crmTagsEnabled).toBe(true);
  });

  it("switching off stops writing and leaves HighLevel's tags alone", async () => {
    db.results["integration.findUnique"] = base({ crmTagsEnabled: true });
    expect((await call("PATCH", "/highlevel", { config: { crmTagsEnabled: false } })).status).toBe(200);
    expect(db.calls["highLevelContact.updateMany"]).toContainEqual({ where: { organizationId: ORG, crmTagsPending: true }, data: { crmTagsPending: false } });
    expect(db.calls["$executeRaw"]).toBeUndefined();
  });

  it("other providers never take the setting", async () => {
    db.results["integration.findUnique"] = row({ schedule: "manual" });
    await call("PATCH", "/resend", { config: { crmTagsEnabled: true, notes: "x" } });
    expect(configWrites()[0]?.data.config.crmTagsEnabled).toBeUndefined();
  });

  it("Remove CRM tags turns the setting off and marks every contact carrying one; only once the import is done", async () => {
    db.results["$queryRaw"] = [{ n: 0 }]; // the status's "contacts carrying a CRM tag" count
    db.results["integration.findUnique"] = base({ hlSync: { phase: "importing" } });
    expect((await call("POST", "/highlevel/crm-tags/remove", {})).status).toBe(409);
    db.results["integration.findUnique"] = base({ crmTagsEnabled: true });
    const r = await call("POST", "/highlevel/crm-tags/remove", {});
    expect(r.status).toBe(200);
    expect(configWrites()[0].data.config.crmTagsEnabled).toBe(false);
    expect(JSON.stringify(db.calls["$executeRaw"])).toContain("hl:crm-untag");
    const hlSync = configWrites()[configWrites().length - 1].data.config.hlSync as Record<string, unknown>;
    expect(hlSync.crmTags).toMatchObject({ removing: true, backlog: true });
  });
});

describe("POST /highlevel/refresh-tags", () => {
  const updates = () => (db.calls["integration.update"] ?? []) as { data: { config: { hlSync: Record<string, unknown> } } }[];

  it("refuses before and during the import (the import reads current tags itself)", async () => {
    db.results["integration.findUnique"] = row({ locationId: LOC, hlSync: { phase: "preview" } });
    expect((await call("POST", "/highlevel/refresh-tags", {})).status).toBe(409);
    db.results["integration.findUnique"] = row({ locationId: LOC, hlSync: { phase: "importing" } });
    expect((await call("POST", "/highlevel/refresh-tags", {})).status).toBe(409);
    expect(updates()).toHaveLength(0);
  });

  it("starts a re-read of every contact once live, and asks for HighLevel's tag list again", async () => {
    db.results["integration.findUnique"] = row({ locationId: LOC, _secret: "v1:x", hlSync: { phase: "live", metaRefreshAt: "2026-10-13T10:00:00Z" } });
    db.results["highLevelContact.count"] = 12_410;
    const r = await call("POST", "/highlevel/refresh-tags", {});
    expect(r.status).toBe(200);
    const hlSync = updates()[0].data.config.hlSync;
    expect(hlSync.tagRefresh).toMatchObject({ total: 12_410, changed: 0 });
    expect(hlSync.metaRefreshAt).toBeUndefined();
  });

  it("leaves a running re-read alone", async () => {
    const t = { startedAt: "2026-10-13T16:00:00Z", total: 50, changed: 3 };
    db.results["integration.findUnique"] = row({ locationId: LOC, _secret: "v1:x", hlSync: { phase: "live", tagRefresh: t } });
    expect((await call("POST", "/highlevel/refresh-tags", {})).status).toBe(200);
    expect(updates()).toHaveLength(0);
  });
});

describe("Minerals filter and price (PATCH /highlevel)", () => {
  const PIPES = [{ id: "pMin", name: "Minerals", stages: [] }, { id: "pRE", name: "On-Market", stages: [] }];
  const base = (extra: Record<string, unknown> = {}) => row({ locationId: LOC, responseWindowDays: 30, hlPipelines: PIPES, hlTags: ["Leon County", "dispo"], hlSync: { phase: "live" }, ...extra });
  const saved = () => (db.calls["integration.update"][0] as { data: { config: Record<string, unknown> } }).data.config;

  it("saves a cleaned filter, recounts every contact, and keeps the internal lists out of the response", async () => {
    db.results["integration.findUnique"] = base();
    const r = await call("PATCH", "/highlevel", { config: { scope: { mineralTags: [" Leon  County", "leon county"], realEstateTags: ["Dispo"], mineralPipelineIds: ["pMin"] }, pricePerSegment: 0.0091 } });
    expect(r.status).toBe(200);
    expect(saved()).toMatchObject({
      scope: { mineralTags: ["leon county"], realEstateTags: ["dispo"], mineralPipelineIds: ["pMin"] }, pricePerSegment: 0.0091,
      hlPipelines: PIPES, hlTags: ["Leon County", "dispo"], hlSync: { phase: "live" },
    });
    expect(db.calls["highLevelContact.updateMany"]).toEqual([{ where: { organizationId: ORG }, data: { summaryDirty: true } }]);
    expect(r.body.config).toEqual({
      locationId: LOC, responseWindowDays: 30, pricePerSegment: 0.0091,
      scope: { mineralTags: ["leon county"], realEstateTags: ["dispo"], mineralPipelineIds: ["pMin"] },
    });
  });

  it("refuses a tag on both lists, an unknown pipeline, a malformed filter, and a price outside $0–$1", async () => {
    db.results["integration.findUnique"] = base();
    const both = await call("PATCH", "/highlevel", { config: { scope: { mineralTags: ["Tiny"], realEstateTags: ["tiny"], mineralPipelineIds: [] } } });
    expect(both).toMatchObject({ status: 400, body: { error: expect.stringMatching(/can't be both minerals and real estate/) } });
    const gone = await call("PATCH", "/highlevel", { config: { scope: { mineralTags: [], realEstateTags: [], mineralPipelineIds: ["pGone"] } } });
    expect(gone.status).toBe(400);
    expect((await call("PATCH", "/highlevel", { config: { scope: { mineralTags: "leon county" } } })).status).toBe(400);
    expect((await call("PATCH", "/highlevel", { config: { scope: { mineralTags: [], realEstateTags: [], mineralPipelineIds: [], extra: 1 } } })).status).toBe(400);
    const pricey = await call("PATCH", "/highlevel", { config: { pricePerSegment: 9.1 } });
    expect(pricey).toMatchObject({ status: 400, body: { error: expect.stringMatching(/between 0 and 1/) } });
    expect((await call("PATCH", "/highlevel", { config: { pricePerSegment: -0.01 } })).status).toBe(400);
    expect(db.calls["integration.update"]).toBeUndefined();
    expect(db.calls["highLevelContact.updateMany"]).toBeUndefined();
  });

  it("only recounts when the filter actually changes; null goes back to the suggestion; price alone recounts nothing", async () => {
    const scope = { mineralTags: ["leon county"], realEstateTags: [], mineralPipelineIds: ["pMin"] };
    db.results["integration.findUnique"] = base({ scope });
    await call("PATCH", "/highlevel", { config: { scope: { ...scope, mineralTags: ["Leon County"] }, pricePerSegment: 0.01 } });
    expect(db.calls["highLevelContact.updateMany"]).toBeUndefined();
    expect(saved()).toMatchObject({ pricePerSegment: 0.01 });
    await call("PATCH", "/highlevel", { config: { scope: null } });
    expect(db.calls["highLevelContact.updateMany"]).toHaveLength(1);
    expect((db.calls["integration.update"][1] as { data: { config: Record<string, unknown> } }).data.config.scope).toBeNull();
    await call("PATCH", "/highlevel", { config: { pricePerSegment: null } });
    expect(db.calls["highLevelContact.updateMany"]).toHaveLength(1);
  });

  it("a newly used tag no stored contact carries starts a tag re-read (at most once a day); a known tag doesn't", async () => {
    db.results["integration.findUnique"] = base();
    db.results["highLevelContact.count"] = (args: { where: { tags?: unknown } }) => (args.where.tags ? 0 : 400);
    const r = await call("PATCH", "/highlevel", { config: { scope: { mineralTags: ["minerals"], realEstateTags: [], mineralPipelineIds: [] } } });
    expect(r.status).toBe(200);
    expect(r.body.tagRefreshStarted).toBe(true);

    for (const k of Object.keys(db.calls)) delete db.calls[k];
    db.results["highLevelContact.count"] = 7; // every tag already on stored contacts
    const r2 = await call("PATCH", "/highlevel", { config: { scope: { mineralTags: ["leon county"], realEstateTags: [], mineralPipelineIds: [] } } });
    expect(r2.body.tagRefreshStarted).toBeUndefined();

    for (const k of Object.keys(db.calls)) delete db.calls[k];
    db.results["integration.findUnique"] = base({ hlSync: { phase: "live", tagRefresh: { startedAt: new Date().toISOString(), total: 4, changed: 0, finishedAt: new Date().toISOString(), auto: true } } });
    db.results["highLevelContact.count"] = 0;
    const r3 = await call("PATCH", "/highlevel", { config: { scope: { mineralTags: ["brand new tag"], realEstateTags: [], mineralPipelineIds: [] } } });
    expect(r3.body.tagRefreshStarted).toBeUndefined(); // an automatic one ran in the last day
  });

  it("other providers never take the HighLevel-only settings", async () => {
    db.results["integration.findUnique"] = { ...row({ fromEmail: "a@b.test" }), provider: "resend" };
    await call("PATCH", "/resend", { config: { pricePerSegment: 0.5, scope: { mineralTags: [], realEstateTags: [], mineralPipelineIds: [] } } });
    const cfg = saved();
    expect(cfg.pricePerSegment).toBeUndefined();
    expect(cfg.scope).toBeUndefined();
  });
});

describe("Minerals filter options and preview", () => {
  const PIPES = [{ id: "pMin", name: "Minerals", stages: [] }, { id: "pRE", name: "On-Market", stages: [] }];
  beforeEach(() => {
    db.results["integration.findUnique"] = row({ locationId: LOC, hlPipelines: PIPES, hlTags: ["Leon County", "dispo", "western haynesville"], hlSync: { phase: "live" } });
    db.results["highLevelContact.findMany"] = [
      { hlId: "a", tags: ["leon county"] }, { hlId: "b", tags: ["Dispo"] }, { hlId: "c", tags: [] },
      { hlId: "d", tags: ["dispo", "Leon County"] }, { hlId: "e", tags: ["wrong number-1"] },
    ];
    db.results["highLevelOpportunity.findMany"] = [{ hlContactId: "c", pipelineId: "pMin" }, { hlContactId: "e", pipelineId: "pRE" }];
  });

  it("GET /highlevel/scope lists every tag and pipeline with its texted people, the suggestion and its split", async () => {
    const r = await call("GET", "/highlevel/scope");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      saved: false,
      scope: { mineralTags: ["Leon County"], realEstateTags: [], mineralPipelineIds: ["pMin"] },
      suggested: { mineralTags: ["Leon County"], realEstateTags: [], mineralPipelineIds: ["pMin"] },
      tags: [
        { name: "dispo", texted: 2 }, { name: "Leon County", texted: 2 }, { name: "wrong number-1", texted: 1 },
        { name: "western haynesville", texted: 0 },
      ],
      pipelines: [{ id: "pMin", name: "Minerals", texted: 1 }, { id: "pRE", name: "On-Market", texted: 1 }],
      counts: { texted: 5, minerals: 3, realEstate: 0, unclassified: 2 },
      pricePerSegment: null,
      responseWindowDays: 30,
      crmTagsEnabled: false,
      notes: "",
    });
    // Texted people only: the query asks for contacts with at least one text sent, and live opportunities.
    expect(db.calls["highLevelContact.findMany"][0]).toMatchObject({ where: { organizationId: ORG, outboundTotal: { gt: 0 } } });
    expect(db.calls["highLevelOpportunity.findMany"][0]).toMatchObject({ where: { organizationId: ORG, deletedInHl: false } });
  });

  it("GET /highlevel/scope returns the form's other settings as stored now (the page's list may be older)", async () => {
    db.results["integration.findUnique"] = row({
      locationId: LOC, hlPipelines: PIPES, hlTags: [], hlSync: { phase: "live" },
      pricePerSegment: 0.0091, responseWindowDays: 14, crmTagsEnabled: true, notes: "Owner's key",
    });
    const r = await call("GET", "/highlevel/scope");
    expect(r.body).toMatchObject({ pricePerSegment: 0.0091, responseWindowDays: 14, crmTagsEnabled: true, notes: "Owner's key" });
  });

  it("POST /highlevel/scope-preview splits texted people under a draft filter without saving it", async () => {
    const r = await call("POST", "/highlevel/scope-preview", { scope: { mineralTags: ["leon county"], realEstateTags: ["dispo"], mineralPipelineIds: [] } });
    expect(r).toMatchObject({ status: 200, body: { texted: 5, minerals: 2, realEstate: 1, unclassified: 2 } });
    expect(db.calls["integration.update"]).toBeUndefined();
    const bad = await call("POST", "/highlevel/scope-preview", { scope: { mineralTags: ["dispo"], realEstateTags: ["Dispo"], mineralPipelineIds: [] } });
    expect(bad.status).toBe(400);
    expect((await call("POST", "/highlevel/scope-preview", {})).status).toBe(400);
  });

  it("GET / keeps the copied pipelines and tags out of the card", async () => {
    db.results["integration.findMany"] = [row({ locationId: LOC, hlPipelines: PIPES, hlTags: ["x"], locationTimezone: "America/Chicago", hlSync: { phase: "live" } })];
    const card = (await call("GET", "/")).body.find((p: { key: string }) => p.key === "highlevel");
    expect(card.config).toEqual({ locationId: LOC, locationTimezone: "America/Chicago" });
  });
});

describe("HighLevel is for live workspaces only", () => {
  it("the demo workspace doesn't see it in the list and can't reach any of its routes", async () => {
    db.results["integration.findMany"] = [];
    const live = await call("GET", "/");
    expect(live.body.map((p: { key: string }) => p.key)).toContain("highlevel");
    asDemo = true;
    const demo = await call("GET", "/");
    expect(demo.status).toBe(200);
    expect(demo.body.map((p: { key: string }) => p.key)).not.toContain("highlevel");
    expect(demo.body.length).toBe(live.body.length - 1);
    for (const [method, path] of [["GET", "/highlevel/status"], ["GET", "/highlevel/scope"], ["POST", "/highlevel/scope-preview"], ["GET", "/highlevel/oauth/start"]] as const) {
      const res = await call(method, path, method === "POST" ? { scope: { mineralTags: [], realEstateTags: [], mineralPipelineIds: [] } } : undefined);
      expect(res.status, path).toBe(403);
      expect(res.body, path).toMatchObject({ demo: true });
      // Reads get the live-only answer; writes are already refused by the demo's read-only lock.
      if (method === "GET") expect(res.body.error, path).toBe("SMS performance and HighLevel are available in live workspaces only.");
    }
  });

  it("an encoded spelling of /highlevel doesn't get past the demo lock on /:provider routes", async () => {
    asDemo = true;
    for (const path of ["/%68ighlevel/oauth/start", "/%48igh%4cevel/oauth/start"]) {
      const res = await call("GET", path);
      expect(res.status, path).toBe(403);
      expect(res.body, path).toMatchObject({ demo: true, error: "SMS performance and HighLevel are available in live workspaces only." });
    }
    // Other providers' /:provider routes still answer the demo normally (oauth/start has its own lock).
    const other = await call("GET", "/%67oogle/oauth/start");
    expect(other.body.error).not.toBe("SMS performance and HighLevel are available in live workspaces only.");
  });
});
