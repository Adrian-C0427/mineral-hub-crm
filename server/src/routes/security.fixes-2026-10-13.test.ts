/**
 * Regression tests for the 2026-10-13 hardening pass:
 *  - Sentry: credentials are scrubbed from STRING request bodies (the SDK's
 *    actual shape), dropped on credential routes, and redacted from queries.
 *  - The demo org's public portal answers only that demo org's sessions.
 *  - SSO never auto-links an identity to an account whose email is unproven;
 *    email changes un-prove the address and burn outstanding reset links.
 *  - Password-reset links and invite codes are claimed atomically.
 *  - Second factor: TOTP codes can't be replayed, recovery codes are spent
 *    atomically, and failures are capped per ACCOUNT (not only per IP).
 *  - In-org permission gates: publishing a document, the buyer-match roster,
 *    research merges, and a linked contact's PII.
 *  - Upload limit errors are 4xx, not 500s.
 *  - Demo map tracts: a reference deal id in ?dealId= can't reopen linked tracts.
 *
 * Routers run against a fake Prisma client that records what it was asked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
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
        return async (arg: unknown) => {
          (calls["$transaction"] ??= []).push(arg);
          return typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]);
        };
      }
      if (typeof name === "string" && name.startsWith("$")) return record(name);
      return model(String(name));
    },
  });
  return { calls, results, prisma };
});

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));
vi.mock("../services/portalRateLimit.js", () => ({ portalRateLimited: vi.fn(async () => false), PORTAL_READ_MAX_PER_WINDOW: 600 }));
vi.mock("../services/oauth.js", async (orig) => ({
  ...(await orig<typeof import("../services/oauth.js")>()),
  getProvider: (key: string) => (key === "google" ? { key: "google", name: "Google" } : null),
  exchangeCode: vi.fn(async () => ({ accessToken: "at", idClaims: {} })),
  fetchProfile: vi.fn(async () => ({ providerAccountId: "g-123", email: "victim@corp.test", emailVerified: true, name: "Victim" })),
}));

import { scrubSentryRequest, REDACTED } from "../sentryScrub.js";
import { portalRouter, portalOpenTo } from "./portal.js";
import { authRouter } from "./auth.js";
import { filesRouter } from "./files.js";
import { dealsRouter } from "./deals.js";
import { researchRouter } from "./research.js";
import { opportunitiesRouter } from "./opportunities.js";
import { mapRouter } from "./map.js";
import { consumeInvite } from "../services/org.js";
import { errorHandler } from "../middleware/errors.js";
import { env } from "../config.js";
import { hashPassword } from "../auth/password.js";
import { generateSecret, totpAt, hashRecoveryCode } from "../domain/totp.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { Permission } from "../domain/permissions.js";

type Caller = { id?: string; org?: string; isDemo?: boolean; orgRole?: "OWNER" | "MEMBER"; permissions?: Permission[] } | null;

async function withApp<T>(caller: Caller, mount: (app: express.Express) => void, run: (port: number) => Promise<T>): Promise<T> {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(cookieParser());
  app.use((req: AuthedRequest, _res, next) => {
    if (caller) {
      req.user = {
        id: caller.id ?? "u1", role: "ASSOCIATE", name: "T", email: "t@local.test", firstName: null, lastName: null, phone: null,
        organizationId: caller.org ?? "org_a", orgRole: caller.orgRole ?? "MEMBER", permissions: caller.permissions ?? [],
        mustChangePassword: false, isDemo: caller.isDemo ?? false, referenceOrgId: caller.isDemo ? "org_ref" : null,
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
    method, redirect: "manual", headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* redirect / html */ }
  return { status: res.status, body: json as Record<string, unknown> | null, location: res.headers.get("location") };
}

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
});

// ---------------------------------------------------------------------------
describe("Sentry request scrubbing", () => {
  it("redacts credentials inside a STRING JSON body (the SDK's real shape)", () => {
    const req = scrubSentryRequest({ url: "https://api.test/api/deals/d1", data: JSON.stringify({ name: "Smith", nested: { apiKey: "k", password: "p" } }) });
    const data = JSON.parse(req.data as string);
    expect(data.name).toBe("Smith");
    expect(data.nested.apiKey).toBe(REDACTED);
    expect(data.nested.password).toBe(REDACTED);
  });

  it("drops the body on credential routes entirely", () => {
    for (const url of ["https://api.test/api/integrations/highlevel/connect", "https://api.test/api/auth/login", "https://api.test/API/Users"]) {
      const req = scrubSentryRequest({ url, data: JSON.stringify({ secret: "pit-abc", config: { locationId: "x" } }) });
      expect(req.data, url).toBe(REDACTED);
    }
  });

  it("redacts OAuth code/state in the query string and URL, and auth headers", () => {
    const req = scrubSentryRequest({
      url: "https://api.test/api/integrations/outlook/oauth/callback?code=SECRETCODE&state=S&x=1",
      query_string: "code=SECRETCODE&state=S&x=1",
      headers: { Authorization: "Bearer t", Cookie: "c=1", accept: "json" },
    });
    expect(req.url).not.toContain("SECRETCODE");
    expect(req.query_string).not.toContain("SECRETCODE");
    expect(String(req.query_string)).toContain("x=1");
    expect(req.headers).toEqual({ accept: "json" });
  });

  it("still scrubs an object body", () => {
    const req = scrubSentryRequest({ url: "https://api.test/api/deals", data: { token: "t", ok: 1 } });
    expect(req.data).toEqual({ token: REDACTED, ok: 1 });
  });
});

// ---------------------------------------------------------------------------
describe("demo portal answers only its own demo sessions", () => {
  const demoOrg = { id: "org_demo", portalEnabled: true, isDemo: true };
  const mount = (app: express.Express) => app.use("/api/portal", portalRouter);

  it("portalOpenTo: demo org closed to the public and to other orgs, open to its own demo session", () => {
    const req = (user: unknown) => ({ user }) as unknown as express.Request;
    expect(portalOpenTo(demoOrg, req(undefined))).toBe(false);
    expect(portalOpenTo(demoOrg, req({ isDemo: false, organizationId: "org_demo" }))).toBe(false);
    expect(portalOpenTo(demoOrg, req({ isDemo: true, organizationId: "org_other_demo" }))).toBe(false);
    expect(portalOpenTo(demoOrg, req({ isDemo: true, organizationId: "org_demo" }))).toBe(true);
    expect(portalOpenTo({ id: "org_a", portalEnabled: true, isDemo: false }, req(undefined))).toBe(true);
    expect(portalOpenTo({ id: "org_a", portalEnabled: false, isDemo: false }, req(undefined))).toBe(false);
  });

  it("an anonymous visitor gets 404 for a demo offering", async () => {
    db.results["deal.findUnique"] = { publishedToPortal: true, abstractIds: [], organization: demoOrg };
    await withApp(null, mount, async (port) => {
      expect((await call(port, "GET", "/api/portal/offering/s1/features")).status).toBe(404);
    });
  });

  it("a real org's signed-in user gets 404 too", async () => {
    db.results["deal.findUnique"] = { publishedToPortal: true, abstractIds: [], organization: demoOrg };
    await withApp({ org: "org_a" }, mount, async (port) => {
      expect((await call(port, "GET", "/api/portal/offering/s1/features")).status).toBe(404);
    });
  });

  it("the demo org's own session sees it", async () => {
    db.results["deal.findUnique"] = { publishedToPortal: true, abstractIds: [], organization: demoOrg };
    await withApp({ org: "org_demo", isDemo: true }, mount, async (port) => {
      expect((await call(port, "GET", "/api/portal/offering/s1/features")).status).toBe(200);
    });
  });

  it("the org portal page and lead form are gated the same way", async () => {
    db.results["organization.findUnique"] = { ...demoOrg, portalSlug: "brazos" };
    await withApp(null, mount, async (port) => {
      expect((await call(port, "GET", "/api/portal/brazos")).status).toBe(404);
      expect((await call(port, "POST", "/api/portal/brazos/leads", { name: "x" })).status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
describe("SSO auto-link requires a proven email", () => {
  const mount = (app: express.Express) => app.use("/api/auth", authRouter);
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  const nonce = "nonce-123";
  const state = () => jwt.sign({ p: "google", n: sha(nonce) }, env.JWT_SECRET, { expiresIn: "5m", audience: "sso-state" });
  const callback = (port: number) => call(port, "GET", `/api/auth/oauth/google/callback?code=c&state=${state()}`, undefined, { cookie: `mh_oauth_nonce=${nonce}` });
  const existing = (over: Record<string, unknown>) => ({
    id: "u_attacker", name: "A", email: "victim@corp.test", role: "ASSOCIATE", orgRole: "OWNER", status: "ACTIVE",
    totpEnabled: false, sessionEpoch: 0, ...over,
  });

  it("refuses to link into an account whose address was never proven", async () => {
    db.results["oAuthAccount.findUnique"] = null;
    db.results["user.findUnique"] = existing({ emailVerifiedAt: null });
    await withApp(null, mount, async (port) => {
      const res = await callback(port);
      expect(res.status).toBe(302);
      expect(res.location).toMatch(/\/login\?oauthError=/);
      expect(db.calls["oAuthAccount.create"]).toBeUndefined();
    });
  });

  it("links a verified account as before", async () => {
    db.results["oAuthAccount.findUnique"] = null;
    db.results["user.findUnique"] = existing({ id: "u_real", emailVerifiedAt: new Date() });
    await withApp(null, mount, async (port) => {
      const res = await callback(port);
      expect(res.location).toMatch(/\/auth\/callback#token=/);
      expect(db.calls["oAuthAccount.create"]).toHaveLength(1);
    });
  });

  it("never reflects the provider's raw error text onto the login page", async () => {
    await withApp(null, mount, async (port) => {
      const res = await call(port, "GET", "/api/auth/oauth/google/callback?error=Call%20555-0100%20to%20verify");
      expect(decodeURIComponent(res.location ?? "")).not.toContain("555-0100");
    });
  });
});

describe("email changes un-prove the address", () => {
  const mount = (app: express.Express) => app.use("/api/auth", authRouter);
  const body = (email: string) => ({ firstName: "A", lastName: "B", phone: "5125550100", email, password: "pw-current" });

  it("a new address clears emailVerifiedAt and burns outstanding reset links", async () => {
    db.results["user.findUnique"] = { id: "u1", email: "old@corp.test", passwordHash: await hashPassword("pw-current") };
    db.results["user.findFirst"] = null;
    db.results["user.update"] = { id: "u1" };
    db.results["passwordResetToken.updateMany"] = { count: 1 };
    await withApp({ id: "u1" }, mount, async (port) => {
      const res = await call(port, "PATCH", "/api/auth/me", body("new@corp.test"));
      expect(res.status).toBe(200);
      expect((db.calls["user.update"][0] as { data: Record<string, unknown> }).data.emailVerifiedAt).toBeNull();
      expect((db.calls["passwordResetToken.updateMany"][0] as { where: unknown }).where).toEqual({ userId: "u1", usedAt: null });
    });
  });

  it("an unchanged address keeps its verification", async () => {
    db.results["user.findUnique"] = { id: "u1", email: "same@corp.test", passwordHash: await hashPassword("pw-current") };
    db.results["user.findFirst"] = null;
    db.results["user.update"] = { id: "u1" };
    await withApp({ id: "u1" }, mount, async (port) => {
      await call(port, "PATCH", "/api/auth/me", body("SAME@corp.test"));
      expect("emailVerifiedAt" in (db.calls["user.update"][0] as { data: Record<string, unknown> }).data).toBe(false);
      expect(db.calls["passwordResetToken.updateMany"]).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
describe("single-use tokens are claimed atomically", () => {
  it("a password-reset link redeemed twice in parallel: the loser changes nothing", async () => {
    db.results["passwordResetToken.findUnique"] = { id: "t1", userId: "u1", usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    db.results["passwordResetToken.updateMany"] = { count: 0 }; // the other request already claimed it
    await withApp(null, (app) => app.use("/api/auth", authRouter), async (port) => {
      const res = await call(port, "POST", "/api/auth/password/reset", { token: "raw", password: "a-new-password" });
      expect(res.status).toBe(400);
      expect(db.calls["user.update"]).toBeUndefined();
    });
  });

  it("a successful reset proves the address", async () => {
    db.results["passwordResetToken.findUnique"] = { id: "t1", userId: "u1", usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    db.results["passwordResetToken.updateMany"] = { count: 1 };
    db.results["user.update"] = { id: "u1" };
    await withApp(null, (app) => app.use("/api/auth", authRouter), async (port) => {
      expect((await call(port, "POST", "/api/auth/password/reset", { token: "raw", password: "a-new-password" })).status).toBe(200);
      expect((db.calls["user.update"][0] as { data: { emailVerifiedAt: unknown } }).data.emailVerifiedAt).toBeInstanceOf(Date);
    });
  });

  it("an invite whose last use was just taken refuses (and so rolls back) the join", async () => {
    db.results["inviteCode.updateMany"] = { count: 0 };
    await expect(consumeInvite("inv1", db.prisma as never)).rejects.toThrow(/already been used/);
    db.results["inviteCode.updateMany"] = { count: 1 };
    await expect(consumeInvite("inv1", db.prisma as never)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("second factor at sign-in", () => {
  const secret = generateSecret();
  const mount = (app: express.Express) => app.use("/api/auth", authRouter);
  let n = 0;
  const ip = () => ({ "x-forwarded-for": `10.0.${Math.floor(++n / 250)}.${n % 250}` }); // fresh IP per request
  const userWith = async (id: string, over: Record<string, unknown> = {}) => ({
    id, name: "U", email: `${id}@corp.test`, role: "ASSOCIATE", orgRole: "MEMBER", status: "ACTIVE", sessionEpoch: 0,
    passwordHash: await hashPassword("pw"), totpEnabled: true, totpSecret: secret, totpRecoveryCodes: [], ...over,
  });

  it("a TOTP code can't be replayed: the second use finds its step already claimed", async () => {
    db.results["user.findUnique"] = await userWith("u_replay");
    const code = totpAt(secret, Math.floor(Date.now() / 1000));
    await withApp(null, mount, async (port) => {
      db.results["user.updateMany"] = { count: 1 };
      expect((await call(port, "POST", "/api/auth/login", { email: "u_replay@corp.test", password: "pw", totpCode: code }, ip())).status).toBe(200);
      db.results["user.updateMany"] = { count: 0 };
      expect((await call(port, "POST", "/api/auth/login", { email: "u_replay@corp.test", password: "pw", totpCode: code }, ip())).status).toBe(401);
    });
    const where = (db.calls["user.updateMany"][0] as { where: { OR: unknown[] } }).where;
    expect(where.OR).toHaveLength(2); // null, or strictly before this step
  });

  it("a recovery code is spent with a guarded array_remove; a lost race fails", async () => {
    const recovery = "ABCD-EFGH";
    db.results["user.findUnique"] = await userWith("u_rec", { totpRecoveryCodes: [hashRecoveryCode(recovery)] });
    db.results["$executeRaw"] = 0; // a parallel request removed it first
    await withApp(null, mount, async (port) => {
      expect((await call(port, "POST", "/api/auth/login", { email: "u_rec@corp.test", password: "pw", totpCode: recovery }, ip())).status).toBe(401);
    });
    const sql = (db.calls["$executeRaw"][0] as unknown[])[0] as string[];
    expect(sql.join("?")).toMatch(/array_remove\("totpRecoveryCodes"[\s\S]*= ANY\("totpRecoveryCodes"\)/);
  });

  it("caps failures per ACCOUNT, even when every guess comes from a new address", async () => {
    db.results["user.findUnique"] = await userWith("u_grind");
    await withApp(null, mount, async (port) => {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        statuses.push((await call(port, "POST", "/api/auth/login", { email: "u_grind@corp.test", password: "pw", totpCode: "000000" }, ip())).status);
      }
      expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(5)).toEqual([429, 429]);
    });
  });
});

// ---------------------------------------------------------------------------
describe("in-org permission gates", () => {
  it("approving a document for buyers takes publishOfferings, not just manageDocuments", async () => {
    db.results["fileAttachment.findFirst"] = { id: "f1" };
    await withApp({ permissions: ["manageDocuments"] }, (app) => app.use("/api/files", filesRouter), async (port) => {
      expect((await call(port, "PATCH", "/api/files/f1", { visibleToBuyers: true })).status).toBe(403);
      expect(db.calls["fileAttachment.update"]).toBeUndefined();
    });
    db.results["fileAttachment.update"] = { id: "f1", filename: "a.pdf", folder: "Other", visibleToBuyers: false };
    await withApp({ permissions: ["manageDocuments"] }, (app) => app.use("/api/files", filesRouter), async (port) => {
      expect((await call(port, "PATCH", "/api/files/f1", { filename: "renamed.pdf" })).status).toBe(200);
    });
  });

  it("the buyer-match roster takes viewBuyers", async () => {
    await withApp({ permissions: ["viewDeals"] }, (app) => app.use("/api/deals", dealsRouter), async (port) => {
      expect((await call(port, "GET", "/api/deals/d1/matches")).status).toBe(403);
    });
  });

  it("a research merge (edits an existing buyer) takes editBuyers", async () => {
    await withApp({ permissions: ["createBuyers", "viewResearch"] }, (app) => app.use("/api/research", researchRouter), async (port) => {
      const res = await call(port, "POST", "/api/research/buyers/commit", { decisions: [{ key: "k", action: "merge", mergeIntoBuyerId: "b1" }] });
      expect(res.status).toBe(403);
      expect(db.calls["buyer.update"]).toBeUndefined();
    });
  });

  it("an opportunity's linked contact shows phone/email only with viewContacts", async () => {
    const opp = {
      id: "o1", name: "Prospect", pipelineId: "p1", stage: "NEW", owner: null, contactId: "c1", phone: "own", email: "own@x",
      contact: { id: "c1", firstName: "Jo", lastName: "Doe", entityName: null, phone: "5125550100", email: "jo@x.test" },
      convertedDeal: null, stageHistory: [], activities: [],
    };
    db.results["opportunity.findFirst"] = opp;
    db.results["user.findMany"] = [];
    await withApp({ permissions: ["viewDeals"] }, (app) => app.use("/api/opportunities", opportunitiesRouter), async (port) => {
      const res = await call(port, "GET", "/api/opportunities/o1");
      expect(res.status).toBe(200);
      expect(res.body!.contact).toMatchObject({ id: "c1", phone: null, email: null });
      expect(res.body!.phone).toBe("own"); // the opportunity's own fields are its own
    });
    await withApp({ permissions: ["viewDeals", "viewContacts"] }, (app) => app.use("/api/opportunities", opportunitiesRouter), async (port) => {
      expect((await call(port, "GET", "/api/opportunities/o1")).body!.contact).toMatchObject({ phone: "5125550100", email: "jo@x.test" });
    });
  });
});

// ---------------------------------------------------------------------------
describe("upload limit errors are client errors", () => {
  const send = (code: string) => withApp(null, (app) => {
    app.get("/x", () => { throw Object.assign(new Error("limit"), { name: "MulterError", code }); });
  }, (port) => call(port, "GET", "/x"));

  it("maps MulterError to 413 / 400 instead of 500", async () => {
    expect((await send("LIMIT_FILE_SIZE")).status).toBe(413);
    expect((await send("LIMIT_FIELD_COUNT")).status).toBe(400);
  });
});

describe("demo map tracts with a reference deal id", () => {
  it("?dealId= can't reopen the reference org's deal-linked tracts", async () => {
    db.results["mapTract.findMany"] = [];
    await withApp({ org: "org_demo", isDemo: true, permissions: ["viewMap", "viewDeals"] }, (app) => app.use("/api/map", mapRouter), async (port) => {
      await call(port, "GET", "/api/map/tracts?dealId=ref_deal_cuid");
      const where = (db.calls["mapTract.findMany"][0] as { where: Record<string, unknown> }).where;
      expect(where).toEqual({ organizationId: "org_ref", dealId: null, id: { in: [] } });
    });
  });
});
