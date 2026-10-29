/**
 * Regression tests for the 2026-10-29 audit (Low):
 *  - The map's deal, asset, filter and opportunity reads need "View deals" as
 *    well as "View map": /map/deals returned ask prices, profit estimates and
 *    the selected buyer to a caller with the map alone.
 *  - A sealed TOTP secret neither key can open (a rotation finished too early)
 *    fails closed: a code is refused with 401, never a 500, and a recovery code
 *    still signs the user in so they can re-enroll. The ciphertext is never
 *    treated as the secret.
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

import { mapRouter } from "./map.js";
import { authRouter } from "./auth.js";
import { errorHandler } from "../middleware/errors.js";
import { hashPassword } from "../auth/password.js";
import { totpAt, hashRecoveryCode } from "../domain/totp.js";
import { encryptSecret } from "../services/secrets.js";
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
describe("map reads of deals, assets and opportunities need View deals", () => {
  const mount = (app: express.Express) => app.use("/api/map", mapRouter);
  const PATHS = ["/api/map/deals?status=ALL", "/api/map/assets", "/api/map/filters", "/api/map/opportunities"];

  it("refuses a caller with View map alone, without reading the org's deals", async () => {
    await withApp(["viewMap"], mount, async (port) => {
      for (const p of PATHS) expect((await call(port, "GET", p)).status, p).toBe(403);
    });
    expect(db.calls["deal.findMany"]).toBeUndefined();
    expect(db.calls["opportunity.findMany"]).toBeUndefined();
  });

  it("serves them with View map and View deals", async () => {
    Object.assign(db.results, { "deal.findMany": [], "opportunity.findMany": [] });
    await withApp(["viewMap", "viewDeals"], mount, async (port) => {
      for (const p of PATHS) expect((await call(port, "GET", p)).status, p).toBe(200);
    });
  });

  it("still serves the map's own layers (imported tracts) with View map alone", async () => {
    Object.assign(db.results, { "mapTract.findMany": [], "$queryRaw": [], "$queryRawUnsafe": [] });
    await withApp(["viewMap"], mount, async (port) => {
      expect((await call(port, "GET", "/api/map/tracts")).status).not.toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
describe("a stored TOTP secret no configured key can open", () => {
  const mount = (app: express.Express) => app.use("/api/auth", authRouter);
  let n = 0;
  const ip = () => ({ "x-forwarded-for": `10.9.${Math.floor(++n / 250)}.${n % 250}` });
  // Sealed format with a key id this server does not have.
  const unreadable = encryptSecret("JBSWY3DPEHPK3PXP").replace(/^v2:[^:]+:/, "v2:00000000:");
  const userWith = async (id: string, over: Record<string, unknown> = {}) => ({
    id, name: "U", email: `${id}@corp.test`, role: "ASSOCIATE", orgRole: "MEMBER", status: "ACTIVE", sessionEpoch: 0,
    passwordHash: await hashPassword("pw"), totpEnabled: true, totpSecret: unreadable, totpRecoveryCodes: [], ...over,
  });

  it("refuses a code with 401 (not a 500) and never verifies against the ciphertext", async () => {
    db.results["user.findUnique"] = await userWith("u_sealed");
    db.results["user.updateMany"] = { count: 1 };
    const now = Math.floor(Date.now() / 1000);
    // Before the fix the ciphertext reached the TOTP check; a code derived from
    // the original plaintext secret must not pass either.
    const code = totpAt("JBSWY3DPEHPK3PXP", now);
    await withApp(null, mount, async (port) => {
      expect((await call(port, "POST", "/api/auth/login", { email: "u_sealed@corp.test", password: "pw", totpCode: code }, ip())).status).toBe(401);
      expect((await call(port, "POST", "/api/auth/login", { email: "u_sealed@corp.test", password: "pw", totpCode: "123456" }, ip())).status).toBe(401);
    });
    expect(db.calls["user.updateMany"]).toBeUndefined();
  });

  it("lets a recovery code sign the user in so they can re-enroll", async () => {
    const recovery = "WXYZ-2345";
    db.results["user.findUnique"] = await userWith("u_sealed_rec", { totpRecoveryCodes: [hashRecoveryCode(recovery)] });
    db.results["$executeRaw"] = 1;
    await withApp(null, mount, async (port) => {
      expect((await call(port, "POST", "/api/auth/login", { email: "u_sealed_rec@corp.test", password: "pw", totpCode: recovery }, ip())).status).toBe(200);
    });
  });
});
