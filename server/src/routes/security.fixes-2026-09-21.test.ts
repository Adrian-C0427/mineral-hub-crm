/**
 * Regression tests for the 2026-09-21 audit fixes: Microsoft SSO email trust,
 * integration OAuth completion bound to the initiating user, and invite-code
 * revocation on member removal.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Server } from "node:http";

vi.mock("../services/rolePermCache.js", () => ({
  getRoleOverride: vi.fn(async () => null),
  invalidateRoleCache: vi.fn(),
}));

import { env } from "../config.js";
import { getProvider } from "../services/oauth.js";
import { revokeInvitesKnownTo } from "../services/org.js";
import { stateMatchesCaller } from "./integrations.js";
import { signState } from "../services/integrationOAuth.js";
import { createApp } from "../app.js";
import type { AuthedRequest } from "../middleware/auth.js";

describe("Microsoft SSO email trust", () => {
  const saved = { ...env.OAUTH.MICROSOFT };
  afterEach(() => Object.assign(env.OAUTH.MICROSOFT, saved));

  function provider(tenant: string) {
    Object.assign(env.OAUTH.MICROSOFT, { CLIENT_ID: "id", CLIENT_SECRET: "secret", TENANT: tenant });
    return getProvider("microsoft")!;
  }

  it("does not trust the email claim under the multi-tenant authority", () => {
    // Any tenant admin can set a user's `email` to someone else's address.
    const p = provider("common").parseProfile({ sub: "s1", email: "victim@co.com" }, {});
    expect(p.email).toBe("victim@co.com");
    expect(p.emailVerified).toBe(false);
  });

  it("ignores preferred_username under the multi-tenant authority", () => {
    const p = provider("common").parseProfile({ sub: "s1" }, { preferred_username: "victim@co.com" });
    expect(p.email).toBeNull();
    expect(p.emailVerified).toBe(false);
  });

  it("trusts the email when Microsoft verified the domain owner (xms_edov)", () => {
    const p = provider("common").parseProfile({ sub: "s1", email: "a@co.com" }, { xms_edov: true });
    expect(p.emailVerified).toBe(true);
  });

  it("trusts emails from a pinned tenant, falling back to the UPN", () => {
    const p = provider("11111111-2222-3333-4444-555555555555").parseProfile({ sub: "s1" }, { preferred_username: "A@co.com" });
    expect(p.email).toBe("a@co.com");
    expect(p.emailVerified).toBe(true);
  });
});

describe("integration OAuth completion", () => {
  const req = (id: string, organizationId: string) => ({ user: { id, organizationId } }) as unknown as AuthedRequest;
  const state = { orgId: "org_a", userId: "admin_a" };

  it("accepts the user who started the flow", () => {
    expect(stateMatchesCaller(state, req("admin_a", "org_a"))).toBe(true);
  });
  it("rejects a different user redeeming a planted authorize link", () => {
    expect(stateMatchesCaller(state, req("victim", "org_b"))).toBe(false);
    expect(stateMatchesCaller(state, req("victim", "org_a"))).toBe(false);
  });
  it("rejects the initiator after they moved to another org", () => {
    expect(stateMatchesCaller(state, req("admin_a", "org_b"))).toBe(false);
  });
});

describe("invite revocation on member removal", () => {
  function fakeTx() {
    const calls: unknown[] = [];
    const tx = { inviteCode: { updateMany: vi.fn(async (args: unknown) => { calls.push(args); return { count: 3 }; }) } };
    return { tx: tx as never, calls };
  }

  it("burns every active code when the member could list them (ADMIN)", async () => {
    const { tx, calls } = fakeTx();
    await revokeInvitesKnownTo("org_a", { id: "u1", orgRole: "ADMIN" }, tx);
    expect(calls[0]).toEqual({ where: { organizationId: "org_a", active: true }, data: { active: false } });
  });

  it("burns only the member's own codes when they could not list them", async () => {
    const { tx, calls } = fakeTx();
    await revokeInvitesKnownTo("org_a", { id: "u1", orgRole: "VIEWER" }, tx);
    expect(calls[0]).toEqual({ where: { organizationId: "org_a", active: true, createdByUserId: "u1" }, data: { active: false } });
  });
});

describe("public integration OAuth callback", () => {
  it("forwards code + state to the SPA fragment instead of redeeming the code", async () => {
    const server = await new Promise<Server>((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      const state = signState({ orgId: "org_a", userId: "admin_a", provider: "outlook" });
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/api/integrations/outlook/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/settings/integrations");
      const frag = new URLSearchParams(loc.hash.slice(1));
      expect(frag.get("oauth")).toBe("outlook");
      expect(frag.get("code")).toBe("abc");
      expect(frag.get("state")).toBe(state);
      expect(loc.search).toBe(""); // code never in the query string
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects an unauthenticated POST to the complete route", async () => {
    const server = await new Promise<Server>((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/integrations/outlook/oauth/complete`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "abc", state: "x" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
