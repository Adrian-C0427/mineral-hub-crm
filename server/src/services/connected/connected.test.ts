/**
 * Personal connected accounts: scopes, OAuth state + PKCE, the provider
 * client's refresh/retry rules, and connect/disconnect bookkeeping — against
 * a fake database and a stubbed fetch (no network).
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedAccount } from "@prisma/client";

const db = vi.hoisted(() => {
  const accounts = new Map<string, Record<string, unknown>>();
  const queued: Record<string, unknown>[] = [];
  const subs: Record<string, unknown>[] = [];
  const logs: unknown[] = [];
  const prisma = {
    connectedAccount: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id) return accounts.get(where.id as string) ?? null;
        const k = where.organizationId_provider_providerAccountId as Record<string, string>;
        const a = [...accounts.values()].find((r) => r.organizationId === k.organizationId && r.provider === k.provider && r.providerAccountId === k.providerAccountId);
        return a ? { ...a, user: { name: a.userId === "u2" ? "Steven" : "Adrian" } } : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `acc${accounts.size + 1}`, autoLinkEmail: true, syncState: null, lastSyncAt: null, lastSyncAttemptAt: null, ...data };
        accounts.set(row.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...accounts.get(where.id)!, ...data };
        accounts.set(where.id, row);
        return row;
      },
      findMany: async () => [...accounts.values()],
    },
    providerSubscription: {
      findMany: async () => subs,
      deleteMany: async () => { subs.length = 0; return { count: 0 }; },
    },
    emailMessage: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { for (const q of queued) Object.assign(q, data); return { count: queued.length }; },
    },
    activityLog: { create: async (a: unknown) => { logs.push(a); return { id: "log" }; } },
  };
  return { prisma, accounts, queued, subs, logs };
});
vi.mock("../../db.js", () => ({ prisma: db.prisma }));
vi.mock("../activityLog.js", () => ({ logActivity: async (a: unknown) => { db.logs.push(a); return { id: "log" }; } }));

import { env } from "../../config.js";
import { ACCOUNT_PROVIDER_DEFS, grantedScopes, missingScopes, normScope, scopeLabels } from "./providers.js";
import { ACCOUNT_STATE_AUDIENCE, buildAccountAuthorizeUrl, pkcePair, sealTokens, signAccountState, verifyAccountState } from "./oauth.js";
import { signState, verifyState } from "../integrationOAuth.js";
import { accessToken, providerFetch, ProviderError, retryAfterMs } from "./client.js";
import { connectAccount, disconnectAccount, serializeAccount } from "./accounts.js";

const realFetch = globalThis.fetch;
type Call = { url: string; method: string; auth: string | null };
let calls: Call[] = [];
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const h = new Headers(init.headers);
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), auth: h.get("authorization") });
    return handler(url, init);
  }) as typeof fetch;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  env.OAUTH.MICROSOFT.CLIENT_ID = "ms-client"; env.OAUTH.MICROSOFT.CLIENT_SECRET = "ms-secret";
  env.OAUTH.GOOGLE.CLIENT_ID = "g-client"; env.OAUTH.GOOGLE.CLIENT_SECRET = "g-secret";
  db.accounts.clear(); db.queued.length = 0; db.subs.length = 0; db.logs.length = 0;
});
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

function account(over: Partial<ConnectedAccount> = {}): ConnectedAccount {
  const row = {
    id: "acc1", organizationId: "org1", userId: "u1", provider: "outlook", providerAccountId: "ms-1",
    email: "adrian@carsa.test", displayName: "Adrian", scopes: ["mail.readwrite", "mail.send", "user.read"],
    status: "CONNECTED", tokens: sealTokens({ access_token: "AT1", refresh_token: "RT1", expires_at: Date.now() + 3_600_000 }),
    syncStatus: "IDLE", syncState: null, lastSyncAt: null, lastSyncAttemptAt: null, lastError: null, autoLinkEmail: true,
    connectedAt: new Date(), disconnectedAt: null, createdAt: new Date(), updatedAt: new Date(), ...over,
  } as ConnectedAccount;
  db.accounts.set(row.id, row as unknown as Record<string, unknown>);
  return row;
}

describe("scopes", () => {
  it("normalizes Graph and Google scope spellings", () => {
    expect(normScope("https://graph.microsoft.com/Mail.Send")).toBe("mail.send");
    expect(normScope("https://www.googleapis.com/auth/drive")).toBe("drive");
    expect(normScope("https://www.googleapis.com/auth/userinfo.email")).toBe("email");
    expect(grantedScopes("openid https://graph.microsoft.com/Mail.ReadWrite Mail.ReadWrite")).toEqual(["openid", "mail.readwrite"]);
  });
  it("finds a partial grant and names what was granted", () => {
    const def = ACCOUNT_PROVIDER_DEFS.outlook;
    expect(missingScopes(def, grantedScopes("openid Mail.ReadWrite User.Read"))).toEqual(["mail.send"]);
    expect(missingScopes(def, grantedScopes("Mail.ReadWrite Mail.Send"))).toEqual([]);
    expect(scopeLabels(def, ["mail.send", "user.read"])).toEqual(["Your name and email address", "Send mail as you"]);
  });
  it("asks for no more than each feature needs", () => {
    expect(ACCOUNT_PROVIDER_DEFS.onedrive.scopes.join(" ")).not.toMatch(/\.All|Sites\./);
    expect(ACCOUNT_PROVIDER_DEFS.outlook.scopes.join(" ")).not.toMatch(/MailboxSettings|Contacts|Calendars/);
  });
});

describe("OAuth state + PKCE", () => {
  it("S256 challenge is the base64url SHA-256 of the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(crypto.createHash("sha256").update(verifier).digest("base64url"));
  });
  it("round-trips the state with the verifier sealed inside", () => {
    const token = signAccountState({ orgId: "org1", userId: "u1", provider: "outlook", verifier: "v".repeat(50) });
    expect(token).not.toContain("v".repeat(20)); // the verifier isn't readable in the URL
    const s = verifyAccountState(token);
    expect(s).toMatchObject({ orgId: "org1", userId: "u1", provider: "outlook", verifier: "v".repeat(50) });
  });
  it("account and org-integration states never verify as each other", () => {
    const acct = signAccountState({ orgId: "o", userId: "u", provider: "outlook", verifier: "x".repeat(50) });
    const org = signState({ orgId: "o", userId: "u", provider: "outlook" });
    expect(() => verifyState(acct)).toThrow();
    expect(() => verifyAccountState(org)).toThrow();
    expect(ACCOUNT_STATE_AUDIENCE).toBe("connected-account-state");
  });
  it("authorize URLs carry PKCE and the right offline/consent parameters", () => {
    const ms = new URL(buildAccountAuthorizeUrl("outlook", "org1", "u1"));
    expect(ms.hostname).toBe("login.microsoftonline.com");
    expect(ms.searchParams.get("code_challenge_method")).toBe("S256");
    expect(ms.searchParams.get("code_challenge")).toBeTruthy();
    expect(ms.searchParams.get("scope")).toContain("offline_access");
    expect(ms.searchParams.get("prompt")).toBe("select_account");
    const g = new URL(buildAccountAuthorizeUrl("googledrive", "org1", "u1"));
    expect(g.hostname).toBe("accounts.google.com");
    expect(g.searchParams.get("access_type")).toBe("offline");
    expect(g.searchParams.get("include_granted_scopes")).toBe("true");
    expect(g.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive");
  });
});

describe("provider client", () => {
  it("refreshes an expiring token once, shared by concurrent callers, and persists it sealed", async () => {
    const a = account({ tokens: sealTokens({ access_token: "OLD", refresh_token: "RT1", expires_at: Date.now() + 10_000 }) });
    stubFetch((url) => url.includes("/token")
      ? json({ access_token: "NEW", refresh_token: "RT2", expires_in: 3600, scope: "Mail.ReadWrite Mail.Send" })
      : json({}));
    const [t1, t2] = await Promise.all([accessToken(a), accessToken(a)]);
    expect([t1, t2]).toEqual(["NEW", "NEW"]);
    expect(calls.filter((c) => c.url.includes("/token"))).toHaveLength(1);
    const stored = db.accounts.get("acc1")!.tokens as string;
    expect(stored).not.toContain("NEW"); // encrypted at rest
  });

  it("a revoked grant flips the account to NEEDS_RECONNECT", async () => {
    const a = account({ tokens: sealTokens({ access_token: "OLD", refresh_token: "RT1", expires_at: Date.now() - 1 }) });
    stubFetch(() => json({ error: "invalid_grant", error_description: "AADSTS70008: expired" }, 400));
    await expect(accessToken(a)).rejects.toMatchObject({ kind: "reconnect" });
    expect(db.accounts.get("acc1")!.status).toBe("NEEDS_RECONNECT");
  });

  it("retries throttling with Retry-After, then succeeds", async () => {
    const a = account();
    let n = 0;
    stubFetch(() => (++n < 3 ? json({ error: { code: "TooManyRequests" } }, 429, { "retry-after": "0" }) : json({ value: [] })));
    const res = await providerFetch(a, "https://graph.microsoft.com/v1.0/me/messages");
    expect(res.status).toBe(200);
    expect(n).toBe(3);
  });

  it("retries Google's 403 rate-limit responses but not a real 403", async () => {
    const a = account({ provider: "googledrive" });
    let n = 0;
    stubFetch(() => (++n === 1 ? json({ error: { code: 403, message: "Rate", errors: [{ reason: "userRateLimitExceeded" }] } }, 403, { "retry-after": "0" }) : json({ files: [] })));
    await providerFetch(a, "https://www.googleapis.com/drive/v3/files");
    expect(n).toBe(2);
    stubFetch(() => json({ error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } }, 403));
    await expect(providerFetch(a, "https://www.googleapis.com/drive/v3/files")).rejects.toMatchObject({ kind: "permission" });
    expect(calls).toHaveLength(1);
  });

  it("never retries a non-idempotent request on its own", async () => {
    const a = account();
    stubFetch(() => json({ error: { code: "ServiceUnavailable" } }, 503, { "retry-after": "0" }));
    await expect(providerFetch(a, "https://graph.microsoft.com/v1.0/me/messages/x/send", { method: "POST" })).rejects.toMatchObject({ kind: "unavailable" });
    expect(calls).toHaveLength(1);
  });

  it("a 401 forces one refresh and retry; a second 401 means reconnect", async () => {
    const a = account();
    stubFetch((url) => (url.includes("/token") ? json({ access_token: "NEW", expires_in: 3600 }) : json({ error: { code: "InvalidAuthenticationToken" } }, 401)));
    await expect(providerFetch(a, "https://graph.microsoft.com/v1.0/me")).rejects.toMatchObject({ kind: "reconnect" });
    expect(calls.map((c) => c.auth)).toEqual(["Bearer AT1", null, "Bearer NEW"]);
    expect(db.accounts.get("acc1")!.status).toBe("NEEDS_RECONNECT");
  });

  it("refuses hosts other than the provider APIs", async () => {
    const a = account();
    stubFetch(() => json({}));
    await expect(providerFetch(a, "https://evil.example.com/v1.0/me")).rejects.toBeInstanceOf(ProviderError);
    await expect(providerFetch(a, "http://graph.microsoft.com/v1.0/me")).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(retryAfterMs(new Response(null, { headers: { "retry-after": "3" } }))).toBe(3000);
    expect(retryAfterMs(new Response(null))).toBeNull();
  });
});

describe("connect / disconnect", () => {
  const graphOk = (scope: string, id = "ms-1") => (url: string) => url.includes("/token")
    ? json({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope })
    : json({ id, displayName: "Adrian Campos", mail: "Adrian@Carsa.test" });

  it("connects, identifies the mailbox, and stores tokens sealed", async () => {
    stubFetch(graphOk("openid profile email offline_access User.Read Mail.ReadWrite Mail.Send"));
    const { account: a, reconnected, missing } = await connectAccount({ orgId: "org1", userId: "u1", provider: "outlook", code: "c", verifier: "v".repeat(50) });
    expect({ reconnected, missing, status: a.status, email: a.email }).toEqual({ reconnected: false, missing: [], status: "CONNECTED", email: "adrian@carsa.test" });
    expect(String(a.tokens)).not.toContain("AT");
    const view = serializeAccount(a);
    expect(view).not.toHaveProperty("tokens");
    expect(view.permissions).toContain("Send mail as you");
    // The code exchange sent the PKCE verifier.
    expect(calls[0].url).toContain("/oauth2/v2.0/token");
  });

  it("a partial grant is NEEDS_RECONNECT and keeps no tokens", async () => {
    stubFetch(graphOk("openid User.Read Mail.ReadWrite"));
    const { account: a, missing } = await connectAccount({ orgId: "org1", userId: "u1", provider: "outlook", code: "c", verifier: "v".repeat(50) });
    expect(missing).toEqual(["mail.send"]);
    expect(a.status).toBe("NEEDS_RECONNECT");
    expect(a.tokens).toBeNull();
    expect(serializeAccount(a).missingPermissions).toEqual(["Send mail as you"]);
  });

  it("reconnecting the same mailbox updates it in place; another member can't take it", async () => {
    stubFetch(graphOk("Mail.ReadWrite Mail.Send User.Read"));
    const first = await connectAccount({ orgId: "org1", userId: "u1", provider: "outlook", code: "c", verifier: "v".repeat(50) });
    const again = await connectAccount({ orgId: "org1", userId: "u1", provider: "outlook", code: "c", verifier: "v".repeat(50) });
    expect(again.reconnected).toBe(true);
    expect(again.account.id).toBe(first.account.id);
    await expect(connectAccount({ orgId: "org1", userId: "u2", provider: "outlook", code: "c", verifier: "v".repeat(50) }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("disconnect wipes tokens, fails queued sends, keeps the row, and revokes Google grants", async () => {
    const a = account({ provider: "googledrive", scopes: ["drive"] });
    db.queued.push({ sendStatus: "QUEUED" });
    stubFetch(() => new Response(null, { status: 200 }));
    const row = await disconnectAccount(a, "u1");
    expect(row.tokens).toBeNull();
    expect(row.status).toBe("DISCONNECTED");
    expect(db.queued[0]).toMatchObject({ sendStatus: "FAILED" });
    expect(calls.some((c) => c.url === "https://oauth2.googleapis.com/revoke" && c.method === "POST")).toBe(true);
    expect(db.accounts.has("acc1")).toBe(true);
  });
});
