/**
 * Regression tests for the 2026-10-12 audit fixes:
 *  - The demo guard matched the raw request target case-sensitively, while
 *    Express routes case-insensitively ("/API/ORG/invites" reached the handler)
 *    and on the parsed pathname (an absolute-form target "http://h/api/…"
 *    matched no policy pattern). Both spellings are now refused, and the
 *    locked routers carry their own URL-independent backstop.
 *  - Demo users no longer see the reference org's DEAL-LINKED map tracts or
 *    its upload filenames.
 *  - Research import history (runs + raw rows) is always the caller's own.
 *
 * Routers run against a fake Prisma client that records what it was asked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import net from "node:net";
import type { Server } from "node:http";

const db = vi.hoisted(() => {
  const calls: Record<string, unknown[]> = {};
  const results: Record<string, unknown> = {};
  const record = (key: string) => async (args: unknown) => {
    (calls[key] ??= []).push(args);
    return results[key];
  };
  // Any model / method resolves to a recorder, so routers can be imported whole.
  const model = (name: string) => new Proxy({}, { get: (_t, m) => record(`${name}.${String(m)}`) });
  const prisma = new Proxy({}, { get: (_t, name) => model(String(name)) });
  return { calls, results, prisma };
});

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));

import { demoBlockReason, demoGuard } from "../middleware/demo.js";
import { authRouter } from "./auth.js";
import { filesRouter } from "./files.js";
import { aiRouter } from "./ai.js";
import { mapRouter } from "./map.js";
import { researchRouter } from "./research.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { PERMISSIONS } from "../domain/permissions.js";

const DEMO_ORG = "org_demo";
const REFERENCE_ORG = "org_ref";

function asUser(demo: boolean) {
  return (req: AuthedRequest, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: "u1", role: "OWNER", name: "Demo", email: "demo@local.test", firstName: null, lastName: null, phone: null,
      organizationId: demo ? DEMO_ORG : REFERENCE_ORG, orgRole: "OWNER", permissions: [...PERMISSIONS], mustChangePassword: false,
      isDemo: demo, referenceOrgId: demo ? REFERENCE_ORG : null,
    };
    next();
  };
}

async function withApp<T>(build: (app: express.Express) => void, run: (port: number) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  build(app);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await run((server.address() as { port: number }).port);
  } finally {
    server.close();
  }
}

async function fetchJson(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Raw HTTP/1.1 with an absolute-form request target (fetch can't send one). */
function rawStatus(port: number, requestLine: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1", () =>
      c.write(`${requestLine}\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`));
    let buf = "";
    c.on("data", (d) => { buf += d; });
    c.on("end", () => resolve(Number(buf.split(" ")[1])));
    c.on("error", reject);
  });
}

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
});

describe("demo guard sees the path Express routes on", () => {
  it("policy ignores path case and repeated slashes", () => {
    for (const p of ["/API/ORG/invites", "/api/Org/Invites/", "/Api/auth/change-password", "/API/AI/deals/x/summary", "/API/FILES", "/api/Deals/bulk-delete", "/API/research/ingest/commit"]) {
      expect(demoBlockReason("POST", p), p).not.toBeNull();
    }
    expect(demoBlockReason("PATCH", "/API/AUTH/me")).not.toBeNull();
    // Allowed mutations stay allowed whatever the case.
    expect(demoBlockReason("POST", "/API/AUTH/logout")).toBeNull();
    expect(demoBlockReason("POST", "/api/Deals")).toBeNull();
  });

  const build = (demo: boolean) => (app: express.Express) => {
    app.use(asUser(demo));
    app.use("/api", demoGuard);
    const r = express.Router();
    r.post("/invites", (_req, res) => { res.json({ reached: true }); });
    app.use("/api/org", r);
  };

  it("refuses a mixed-case spelling of a locked route", async () => {
    await withApp(build(true), async (port) => {
      for (const p of ["/API/ORG/invites", "/api/Org/Invites"]) {
        const res = await fetchJson(port, "POST", p);
        expect(res.status, p).toBe(403);
        expect(res.body.demo).toBe(true);
      }
    });
  });

  it("refuses an absolute-form request target", async () => {
    await withApp(build(true), async (port) => {
      expect(await rawStatus(port, "POST http://evil.example/api/org/invites HTTP/1.1")).toBe(403);
      expect(await rawStatus(port, "POST http://evil.example/API/ORG/INVITES HTTP/1.1")).toBe(403);
    });
  });

  it("never affects a non-demo user", async () => {
    await withApp(build(false), async (port) => {
      expect((await fetchJson(port, "POST", "/API/ORG/invites")).status).toBe(200);
    });
  });
});

describe("locked routers refuse demo writes on their own (no demoGuard mounted)", () => {
  const build = (app: express.Express) => {
    app.use(asUser(true));
    app.use("/api/auth", authRouter);
    app.use("/api/files", filesRouter);
    app.use("/api/ai", aiRouter);
  };

  it("account security, uploads and AI are 403 before any database work", async () => {
    await withApp(build, async (port) => {
      const cases: [string, string][] = [
        ["PATCH", "/api/auth/me"],
        ["POST", "/api/auth/change-password"],
        ["POST", "/api/auth/join"],
        ["POST", "/api/auth/2fa/setup"],
        ["POST", "/api/auth/2fa/enable"],
        ["POST", "/api/auth/2fa/disable"],
        ["POST", "/api/auth/2fa/recovery-codes"],
        ["POST", "/api/files"],
        ["POST", "/api/files/f1/replace"],
        ["POST", "/api/files/cloud/onedrive/import"],
        ["POST", "/api/ai/deals/d1/summary"],
      ];
      for (const [m, p] of cases) {
        const res = await fetchJson(port, m, p, {});
        expect(res.status, `${m} ${p}`).toBe(403);
        expect(res.body.demo, `${m} ${p}`).toBe(true);
      }
      expect(Object.keys(db.calls).filter((k) => !k.startsWith("user."))).toEqual([]);
    });
  });
});

describe("demo map tracts exclude the reference org's deal-linked tracts", () => {
  const build = (demo: boolean) => (app: express.Express) => {
    app.use(asUser(demo));
    app.use("/api/map", mapRouter);
  };
  const tract = { id: "t1", name: "Tract 1", sourceFile: "Smith LOI tracts.zip", importId: "i1", properties: {}, geometry: null, deal: { id: "d_ref", name: "Smith" } };

  it("demo: unlinked tracts only, no deal and no upload filename", async () => {
    db.results["mapTract.findMany"] = [{ ...tract }];
    await withApp(build(true), async (port) => {
      const res = await fetchJson(port, "GET", "/api/map/tracts");
      expect(res.status).toBe(200);
      expect((db.calls["mapTract.findMany"][0] as { where: unknown }).where).toEqual({ organizationId: REFERENCE_ORG, dealId: null });
      const props = res.body.features[0].properties;
      expect(props.__source).not.toMatch(/Smith/);
      expect(props.__dealId).toBeNull();
      expect(props.__dealName).toBeNull();
    });
  });

  it("demo import list: same scope, filenames hidden", async () => {
    db.results["mapTract.groupBy"] = [{ importId: "i1", sourceFile: "Smith LOI tracts.zip", dealId: null, _count: { _all: 3 }, _min: { createdAt: new Date() } }];
    await withApp(build(true), async (port) => {
      const res = await fetchJson(port, "GET", "/api/map/tracts/imports");
      expect((db.calls["mapTract.groupBy"][0] as { where: unknown }).where).toEqual({ organizationId: REFERENCE_ORG, dealId: null });
      expect(res.body[0].sourceFile).not.toMatch(/Smith/);
    });
  });

  it("demo deal-scoped request still matches only that (demo) deal", async () => {
    db.results["mapTract.findMany"] = [];
    await withApp(build(true), async (port) => {
      await fetchJson(port, "GET", "/api/map/tracts?dealId=d_demo");
      expect((db.calls["mapTract.findMany"][0] as { where: unknown }).where).toEqual({ organizationId: REFERENCE_ORG, dealId: "d_demo" });
    });
  });

  it("non-demo org keeps every tract, deal-linked included, with filenames", async () => {
    db.results["mapTract.findMany"] = [{ ...tract }];
    await withApp(build(false), async (port) => {
      const res = await fetchJson(port, "GET", "/api/map/tracts");
      expect((db.calls["mapTract.findMany"][0] as { where: unknown }).where).toEqual({ organizationId: REFERENCE_ORG });
      expect(res.body.features[0].properties.__source).toBe("Smith LOI tracts.zip");
      expect(res.body.features[0].properties.__dealId).toBe("d_ref");
    });
  });
});

describe("research import history is the caller's own", () => {
  const build = (app: express.Express) => {
    app.use(asUser(true));
    app.use("/api/research", researchRouter);
  };

  it("demo lists its own runs, not the reference org's", async () => {
    db.results["researchIngestRun.findMany"] = [];
    await withApp(build, async (port) => {
      expect((await fetchJson(port, "GET", "/api/research/ingest/runs")).status).toBe(200);
      expect((db.calls["researchIngestRun.findMany"][0] as { where: { organizationId: string } }).where.organizationId).toBe(DEMO_ORG);
    });
  });

  it("a reference-org run's raw rows are not readable from the demo", async () => {
    db.results["researchIngestRun.findFirst"] = null;
    await withApp(build, async (port) => {
      expect((await fetchJson(port, "GET", "/api/research/ingest/runs/run_ref/rows")).status).toBe(404);
      expect((db.calls["researchIngestRun.findFirst"][0] as { where: unknown }).where).toEqual({ id: "run_ref", organizationId: DEMO_ORG });
      expect(db.calls["researchIngestRow.findMany"]).toBeUndefined();
    });
  });
});
