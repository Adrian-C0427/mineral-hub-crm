/**
 * Org branding contract the client's logo rendering relies on
 * (client/src/lib/branding.ts):
 *  - GET /auth/me carries the CALLER's org logos inline, so the sidebar can
 *    never show another org's mark after an account switch.
 *  - PATCH /org/branding writes only the field it was given: replacing or
 *    removing one logo must never blank the other.
 *  - Raster only (the client's picker matches), and the demo workspace can't
 *    write it.
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
    return results[key];
  };
  const model = (name: string) => new Proxy({}, { get: (_t, m) => record(`${name}.${String(m)}`) });
  const prisma = new Proxy({}, { get: (_t, name) => model(String(name)) });
  return { calls, results, prisma };
});

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));

import { authRouter } from "./auth.js";
import { orgRouter } from "./org.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { PERMISSIONS } from "../domain/permissions.js";

const ORG = "org_main";
const PNG = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64")}`;
const JPG = `data:image/jpeg;base64,${Buffer.from("ffd8ffe000104a464946", "hex").toString("base64")}`;
const SVG = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")}`;

function asUser(opts: { demo?: boolean; org?: string } = {}) {
  return (req: AuthedRequest, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: "u1", role: "OWNER", name: "Owner", email: "owner@local.test", firstName: null, lastName: null, phone: null,
      organizationId: opts.org ?? ORG, orgRole: "OWNER", permissions: [...PERMISSIONS], mustChangePassword: false,
      isDemo: !!opts.demo, referenceOrgId: null,
    };
    next();
  };
}

async function withApp<T>(user: ReturnType<typeof asUser>, run: (port: number) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(user);
  app.use("/api/auth", authRouter);
  app.use("/api/org", orgRouter);
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

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
});

describe("GET /auth/me — branding payload", () => {
  it("returns the caller's own org logos inline", async () => {
    db.results["organization.findUnique"] = { id: "org_other", name: "Other Minerals", teamId: "T", fullLogo: PNG, compactLogo: JPG, isDemo: false };
    await withApp(asUser({ org: "org_other" }), async (port) => {
      const res = await call(port, "GET", "/api/auth/me");
      expect(res.status).toBe(200);
      expect(res.body.user.organization).toMatchObject({ id: "org_other", fullLogo: PNG, compactLogo: JPG });
    });
    // Looked up by the AUTHENTICATED user's org — nothing client-supplied.
    expect(db.calls["organization.findUnique"]).toEqual([expect.objectContaining({ where: { id: "org_other" } })]);
  });

  it("returns null logos (→ default branding) when none are uploaded", async () => {
    db.results["organization.findUnique"] = { id: ORG, name: "Main", teamId: "T", fullLogo: null, compactLogo: null, isDemo: false };
    await withApp(asUser(), async (port) => {
      const res = await call(port, "GET", "/api/auth/me");
      expect(res.body.user.organization).toMatchObject({ fullLogo: null, compactLogo: null });
    });
  });
});

describe("PATCH /org/branding", () => {
  it("sets only the provided logo — the other is left untouched", async () => {
    db.results["organization.update"] = { id: ORG, name: "Main", fullLogo: PNG, compactLogo: JPG };
    await withApp(asUser(), async (port) => {
      const res = await call(port, "PATCH", "/api/org/branding", { fullLogo: PNG });
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("teamId");
    });
    const [args] = db.calls["organization.update"] as { where: unknown; data: Record<string, unknown> }[];
    expect(args.where).toEqual({ id: ORG });
    expect(args.data).toEqual({ fullLogo: PNG });
  });

  it("null removes one logo without clearing the other", async () => {
    db.results["organization.update"] = { id: ORG, name: "Main", fullLogo: PNG, compactLogo: null };
    await withApp(asUser(), async (port) => {
      expect((await call(port, "PATCH", "/api/org/branding", { compactLogo: null })).status).toBe(200);
    });
    const [args] = db.calls["organization.update"] as { data: Record<string, unknown> }[];
    expect(args.data).toEqual({ compactLogo: null });
  });

  it("refuses SVG (the client picker no longer offers it) and writes nothing", async () => {
    await withApp(asUser(), async (port) => {
      expect((await call(port, "PATCH", "/api/org/branding", { fullLogo: SVG })).status).toBe(400);
    });
    expect(db.calls["organization.update"]).toBeUndefined();
  });

  it("is read-only in the demo workspace", async () => {
    await withApp(asUser({ demo: true }), async (port) => {
      const res = await call(port, "PATCH", "/api/org/branding", { fullLogo: PNG });
      expect(res.status).toBe(403);
      expect(res.body.demo).toBe(true);
    });
    expect(db.calls["organization.update"]).toBeUndefined();
  });
});
