/**
 * The demo write policy against the REAL route table.
 *
 * demoGuard is deny-by-default (middleware/demo.ts): a demo user's write is
 * refused unless it matches DEMO_WRITE_ALLOWLIST. These tests build the actual
 * app, walk every route it registers, and pin three things:
 *   1. The allowlist and the routes it lets through correspond one to one — no
 *      stale entry, and no route allowed by accident because its path happens
 *      to fit another entry's :param shape. Adding a write route that a
 *      pattern already matches fails here until someone decides about it.
 *   2. Locked areas (settings, team, integrations, AI, uploads/imports,
 *      reference data, deletes) can never be put on the allowlist.
 *   3. Every write that is NOT allowed really is refused when sent through the
 *      whole app as a demo user — so a router mounted ahead of demoGuard, or
 *      outside /api, fails here too.
 */
import { describe, it, expect, vi } from "vitest";
import type { Server } from "node:http";

vi.mock("../db.js", () => {
  const rec = () => async () => null;
  const model = new Proxy({}, { get: () => rec() });
  return { prisma: new Proxy({}, { get: () => model }), withDbRetry: <T>(f: () => T) => f() };
});
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));
// Every request is a demo OWNER (the shared demo login's role).
vi.mock("./auth.js", async (orig) => {
  const real = await orig<typeof import("./auth.js")>();
  const { PERMISSIONS } = await import("../domain/permissions.js");
  return {
    ...real,
    attachUser: async (req: import("./auth.js").AuthedRequest, _res: unknown, next: () => void) => {
      req.user = {
        id: "u_demo", role: "OWNER", name: "Demo", email: "demo@local.test", firstName: null, lastName: null, phone: null,
        organizationId: "org_demo", orgRole: "OWNER", permissions: [...PERMISSIONS], mustChangePassword: false,
        isDemo: true, referenceOrgId: "org_ref",
      };
      next();
    },
  };
});

import { createApp } from "../app.js";
import { DEMO_WRITE_ALLOWLIST, demoBlockReason } from "./demo.js";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle?: { stack?: Layer[] }; regexp: RegExp & { fast_slash?: boolean } };

/** The literal prefix a Router was mounted at (all mounts in app.ts are plain strings). */
function mountPath(re: Layer["regexp"]): string {
  if (re.fast_slash) return "";
  return re.source.replace(/^\^/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/, "").replace(/\\\//g, "/");
}

function routes(stack: Layer[], prefix = "", out: { method: string; path: string }[] = []) {
  for (const l of stack) {
    if (l.route) {
      for (const m of Object.keys(l.route.methods)) {
        if (m === "_all") continue;
        out.push({ method: m.toUpperCase(), path: (prefix + l.route.path).replace(/(.)\/$/, "$1") });
      }
    } else if (l.name === "router" && l.handle?.stack) {
      routes(l.handle.stack, prefix + mountPath(l.regexp), out);
    }
  }
  return out;
}

const app = createApp();
const ALL = routes((app as unknown as { _router: { stack: Layer[] } })._router.stack);
const WRITES = ALL.filter((r) => !READS.has(r.method));
/** A concrete request path for a route pattern (each :param → one segment). */
const concrete = (path: string) => path.replace(/:[A-Za-z0-9_]+/g, "x1");
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("demo write policy vs the route table", () => {
  it("finds the app's routes (sanity: the walker sees every router)", () => {
    expect(ALL.length).toBeGreaterThan(200);
    for (const prefix of ["/api/auth", "/api/org", "/api/deals", "/api/integrations", "/api/portal", "/api/research"]) {
      expect(WRITES.some((r) => r.path.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it("allowlist ⇔ allowed routes, one to one", () => {
    const allowed = WRITES.filter((r) => demoBlockReason(r.method, concrete(r.path), {}) === null).map(key).sort();
    expect(allowed).toEqual([...DEMO_WRITE_ALLOWLIST].sort());
  });

  it("locked areas never appear on the allowlist", () => {
    const LOCKED: RegExp[] = [
      /^DELETE (?!\/api\/notifications(\/|$))/, // every delete but the visitor's own notifications
      /\/(bulk-)?delete(\/|$)/,
      /\/import(\/|$)/,
      /^\w+ \/api\/(org|users|integrations|ai|map)(\/|$)/,
      /^\w+ \/api\/auth\/(?!(logout|preferences|table-prefs\/:tableId)$)/,
      /^\w+ \/api\/files(?!\/:id$)/,
      /^POST \/api\/files\/:id$/,
      /^\w+ \/api\/research\/(?!(relationships\/transactions|buyers\/preview|buyers\/commit)$)/,
      /\/replace$|\/cloud\//,
    ];
    for (const entry of DEMO_WRITE_ALLOWLIST) {
      for (const re of LOCKED) expect(re.test(entry), `${entry} matches locked ${re}`).toBe(false);
    }
  });

  it("refuses every non-allowed write through the whole app, whatever the spelling", async () => {
    const blocked = WRITES.filter((r) => demoBlockReason(r.method, concrete(r.path), {}) !== null);
    expect(blocked.length).toBeGreaterThan(80);
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
      const { port } = server.address() as { port: number };
      const failures: string[] = [];
      for (const r of blocked) {
        const p = concrete(r.path);
        for (const variant of [p, p.toUpperCase(), `${p}/`]) {
          const res = await fetch(`http://127.0.0.1:${port}${variant}`, {
            method: r.method, headers: { "content-type": "application/json" }, body: "{}",
          });
          const body = await res.json().catch(() => null) as { demo?: boolean } | null;
          if (res.status !== 403 || body?.demo !== true) failures.push(`${r.method} ${variant} → ${res.status}`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("refuses a bulk delete smuggled through an allowed bulk route", () => {
    expect(demoBlockReason("POST", "/api/expenses/bulk", { action: "delete" })).not.toBeNull();
    expect(demoBlockReason("POST", "/api/expenses/bulk", { action: "DELETE" })).not.toBeNull();
    expect(demoBlockReason("POST", "/api/expenses/bulk", { action: "reimburse" })).toBeNull();
  });
});
