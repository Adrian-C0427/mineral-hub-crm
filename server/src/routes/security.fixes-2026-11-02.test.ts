/**
 * Regression tests for the 2026-11-02 audit (Low):
 *  - GET /research/documents|permits?sortBy=abstractId read EVERY matching row
 *    to order them in process; /records/ids caps the same read at
 *    MAX_SELECTABLE_IDS. Now capped too (newest first), with `truncated`.
 *  - A research import (and its /ingest/preview, which writes nothing and so
 *    is free to repeat) loaded the org's entire documents / permits table to
 *    dedupe against. It now reads the file's footprint only — its states and
 *    counties (and, for documents, their recording-date span) — and the three
 *    ingest POSTs carry a per-user replay ceiling like the contacts import.
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

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));

import { researchRouter, MAX_SELECTABLE_IDS } from "./research.js";
import { ingestResearchCsv } from "../domain/researchIngest.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { Permission } from "../domain/permissions.js";

async function withApp<T>(permissions: Permission[], run: (port: number) => Promise<T>): Promise<T> {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "2mb" }));
  app.use((req: AuthedRequest, _res, next) => {
    req.user = {
      id: "u1", role: "ASSOCIATE", name: "T", email: "t@local.test", firstName: null, lastName: null, phone: null,
      organizationId: "org_a", orgRole: "MEMBER", permissions, mustChangePassword: false, isDemo: false, referenceOrgId: null,
    };
    next();
  });
  app.use("/api/research", researchRouter);
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
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json as Record<string, unknown> | null };
}

const arg = (key: string, i = 0) => (db.calls[key]?.[i] ?? {}) as Record<string, unknown>;

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
  db.results["$queryRawUnsafe"] = []; // gis survey lookup: no layer
});

describe("abstract order is a capped read", () => {
  it("documents: at most MAX_SELECTABLE_IDS newest rows, true total, truncated flag", async () => {
    db.results["researchDocument.count"] = 3;
    db.results["researchDocument.findMany"] = [];
    await withApp(["viewResearch"], async (port) => {
      const res = await call(port, "GET", "/api/research/documents?sortBy=abstractId&sortDir=asc");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 3, rows: [], truncated: true });
    });
    expect(arg("researchDocument.findMany")).toMatchObject({ take: MAX_SELECTABLE_IDS, orderBy: [{ recordingDate: "desc" }, { id: "asc" }] });
    expect(db.calls["researchDocument.count"]).toHaveLength(1);
  });

  it("permits: the same cap, and no flag when everything fit", async () => {
    db.results["researchPermit.count"] = 0;
    db.results["researchPermit.findMany"] = [];
    await withApp(["viewResearch"], async (port) => {
      const res = await call(port, "GET", "/api/research/permits?sortBy=abstractId");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 0, rows: [], truncated: false });
    });
    expect(arg("researchPermit.findMany")).toMatchObject({ take: MAX_SELECTABLE_IDS, orderBy: [{ activityDate: "desc" }, { id: "asc" }] });
  });
});

const csv = (header: string, ...rows: string[]) => [header, ...rows].join("\n");
const prisma = db.prisma as unknown as PrismaClient;

describe("an import reads existing records for the file's footprint only", () => {
  it("documents: the file's states + counties and its recording-date span (whole UTC days)", async () => {
    db.results["researchDocument.findMany"] = [];
    const s = await ingestResearchCsv({
      prisma, organizationId: "org_a", createdByUserId: null, category: "deeds", dryRun: true, previewRows: 8,
      mapping: { docType: "Type", recordingDate: "Recorded", grantor: "Grantor", grantee: "Grantee", county: "County", state: "State" },
      csv: csv("Type,Recorded,Grantor,Grantee,County,State",
        "Mineral Deed,03/20/2026,Smith,Blackrock LLC,Leon County,Texas",
        "Mineral Deed,03/12/2026,Jones,Blackrock LLC,leon,TX",
        "Mineral Deed,2026-04-02T15:30:00Z,Brown,Blackrock LLC,Freestone,TX",
        "Mineral Deed,not a date,Green,Blackrock LLC,Harris,TX", // rejected before dedupe: widens nothing
        "Mineral Deed,03/01/2026,White,Blackrock LLC,,"), // no county: rejected too
    });
    expect(s.imported).toBe(3);
    expect(s.rejected).toBe(2);
    expect(db.calls["researchDocument.findMany"]).toHaveLength(1);
    expect(arg("researchDocument.findMany").where).toEqual({
      organizationId: "org_a",
      state: { in: ["TX"], mode: "insensitive" },
      county: { in: ["Leon", "Freestone"], mode: "insensitive" },
      recordingDate: { gte: new Date("2026-03-12T00:00:00Z"), lt: new Date("2026-04-03T00:00:00Z") },
    });
  });

  it("permits: the file's states + counties", async () => {
    db.results["researchPermit.findMany"] = [];
    const s = await ingestResearchCsv({
      prisma, organizationId: "org_a", createdByUserId: null, category: "permits", dryRun: true,
      assignedState: "TX", assignedCounty: "Leon",
      mapping: { operator: "Operator", apiNumber: "API", filedDate: "Filed" },
      csv: csv("Operator,API,Filed", "Acme Energy,42-289-12345,01/05/2026", "Acme Energy,42-289-12346,01/06/2026"),
    });
    expect(s.imported).toBe(2);
    expect(arg("researchPermit.findMany").where).toEqual({
      organizationId: "org_a", state: { in: ["TX"], mode: "insensitive" }, county: { in: ["Leon"], mode: "insensitive" },
    });
  });

  it("a file with nothing to dedupe reads nothing", async () => {
    const s = await ingestResearchCsv({
      prisma, organizationId: "org_a", createdByUserId: null, category: "deeds", dryRun: true,
      mapping: { docType: "Type", recordingDate: "Recorded", grantor: "Grantor", grantee: "Grantee", county: "County" },
      csv: csv("Type,Recorded,Grantor,Grantee,County", "Mineral Deed,03/20/2026,Smith,Blackrock LLC,"),
    });
    expect(s.rejected).toBe(1);
    expect(db.calls["researchDocument.findMany"]).toBeUndefined();
  });
});

describe("ingest replays are capped per user", () => {
  it("/ingest/analyze answers 429 past the ceiling", async () => {
    await withApp(["manageResearchData"], async (port) => {
      const body = { category: "deeds", csv: "Type,Recorded\nMineral Deed,03/20/2026" };
      let status = 0;
      for (let i = 0; i < 61; i++) status = (await call(port, "POST", "/api/research/ingest/analyze", body)).status;
      expect(status).toBe(429);
    });
  });
});
