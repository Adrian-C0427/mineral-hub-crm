import { describe, expect, it } from "vitest";
import { signState, verifyState, isOAuthProvider, OAUTH_PROVIDER_KEYS, oauthConfigured } from "./integrationOAuth.js";
import { INTEGRATION_CATALOG } from "../domain/integrationCatalog.js";

describe("integration OAuth state", () => {
  it("round-trips a signed state token", () => {
    const token = signState({ orgId: "org_1", userId: "user_1", provider: "outlook" });
    const state = verifyState(token);
    expect(state.orgId).toBe("org_1");
    expect(state.userId).toBe("user_1");
    expect(state.provider).toBe("outlook");
    expect(state.nonce).toBeTruthy();
  });

  it("rejects a tampered state token", () => {
    const token = signState({ orgId: "org_1", userId: "user_1", provider: "outlook" });
    expect(() => verifyState(token.slice(0, -3) + "xxx")).toThrow();
  });
});

describe("integration OAuth catalog parity", () => {
  it("every catalog entry with implementation 'oauth' is a known OAuth provider", () => {
    for (const p of INTEGRATION_CATALOG) {
      if (p.implementation === "oauth") {
        expect(isOAuthProvider(p.key), `${p.key} missing from OAuth registry`).toBe(true);
        expect(p.auth).toBe("oauth");
      }
    }
  });

  it("every OAuth provider key has a catalog entry", () => {
    const keys = new Set(INTEGRATION_CATALOG.map((p) => p.key));
    for (const k of OAUTH_PROVIDER_KEYS) expect(keys.has(k), `${k} missing from catalog`).toBe(true);
  });

  it("providers are inert (not connectable) until client credentials are configured", () => {
    // No OAuth client env vars are set in the test environment.
    for (const k of OAUTH_PROVIDER_KEYS) expect(oauthConfigured(k)).toBe(false);
  });
});
