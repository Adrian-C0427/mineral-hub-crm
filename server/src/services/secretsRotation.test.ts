import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config.js";
import { currentKeyId, decryptSecret, encryptSecret, isSealed, needsReseal, resetSecretKeys, resealSecret, rotationConfigured } from "./secrets.js";
import { resealStoredSecrets, type RotationDb } from "./secretsRotation.js";

// The rotation pass rewrites live credentials unattended, so what it reads,
// what it writes and what it leaves alone are pinned here.

const OLD = "old-integration-key-0123456789abcdef-old";
const NEW = "new-integration-key-fedcba9876543210-new";
const envRef = env as unknown as { INTEGRATION_SECRET_KEY: string; INTEGRATION_SECRET_KEY_PREVIOUS: string };
const saved = { cur: envRef.INTEGRATION_SECRET_KEY, prev: envRef.INTEGRATION_SECRET_KEY_PREVIOUS };
function setKeys(current: string, previous = "") { envRef.INTEGRATION_SECRET_KEY = current; envRef.INTEGRATION_SECRET_KEY_PREVIOUS = previous; resetSecretKeys(); }
afterEach(() => { envRef.INTEGRATION_SECRET_KEY = saved.cur; envRef.INTEGRATION_SECRET_KEY_PREVIOUS = saved.prev; resetSecretKeys(); });

/** A v1 payload as the pre-rotation code wrote it (no key id). */
function v1Under(keySource: string, plaintext: string): string {
  setKeys(keySource);
  const v2 = encryptSecret(plaintext);
  const [, , iv, tag, data] = v2.split(":");
  return `v1:${iv}:${tag}:${data}`;
}

describe("key rotation reads", () => {
  it("reads v1 and v2 payloads under the previous key, writes v2 under the current key", () => {
    const legacy = v1Under(OLD, "hl-token");
    setKeys(OLD);
    const underOld = encryptSecret("drive-bundle");
    const oldId = currentKeyId();
    setKeys(NEW, OLD);
    expect(rotationConfigured()).toBe(true);
    expect(currentKeyId()).not.toBe(oldId);
    expect(decryptSecret(legacy)).toBe("hl-token");
    expect(decryptSecret(underOld)).toBe("drive-bundle");
    expect(needsReseal(legacy)).toBe(true);
    expect(needsReseal(underOld)).toBe(true);
    const resealed = resealSecret(underOld);
    expect(resealed.startsWith(`v2:${currentKeyId()}:`)).toBe(true);
    expect(needsReseal(resealed)).toBe(false);
    expect(decryptSecret(resealed)).toBe("drive-bundle");
  });
  it("refuses a payload under a key the server does not have, with a clear message", () => {
    const legacy = v1Under(OLD, "y");
    setKeys(OLD);
    const foreign = encryptSecret("x");
    setKeys(NEW);
    expect(rotationConfigured()).toBe(false);
    expect(() => decryptSecret(foreign)).toThrow(/INTEGRATION_SECRET_KEY_PREVIOUS/);
    expect(() => decryptSecret(legacy)).toThrow();
  });
  it("tells ciphertext from a legacy plaintext TOTP secret", () => {
    setKeys(NEW);
    expect(isSealed("JBSWY3DPEHPK3PXP")).toBe(false);
    expect(isSealed(encryptSecret("JBSWY3DPEHPK3PXP"))).toBe(true);
    expect(isSealed("")).toBe(false);
    expect(isSealed(null)).toBe(false);
  });
});

describe("resealStoredSecrets", () => {
  let integrations: { id: string; provider: string; config: unknown }[];
  let users: { id: string; totpSecret: string | null }[];
  const writes: string[] = [];
  const db: RotationDb = {
    integration: {
      findMany: async () => integrations,
      update: async ({ where, data }) => { writes.push(`integration:${where.id}`); const r = integrations.find((i) => i.id === where.id)!; r.config = data.config; },
    },
    user: {
      findMany: async () => users.filter((u) => u.totpSecret != null),
      update: async ({ where, data }) => { writes.push(`user:${where.id}`); users.find((u) => u.id === where.id)!.totpSecret = data.totpSecret; },
    },
  };
  beforeEach(() => { writes.length = 0; });

  it("re-encrypts what the previous key sealed, keeps everything else byte-for-byte, and is idempotent", async () => {
    const legacyV1 = v1Under(OLD, "hl-key");
    setKeys(OLD);
    const oauthUnderOld = encryptSecret(JSON.stringify({ access: "a", refresh: "r" }));
    const totpUnderOld = encryptSecret("JBSWY3DPEHPK3PXP");
    setKeys(NEW, OLD);
    const alreadyCurrent = encryptSecret("sentry-dsn");
    integrations = [
      { id: "i1", provider: "highlevel", config: { apiBase: "x", _secret: legacyV1, _hint: "…-key" } },
      { id: "i2", provider: "gdrive", config: { _secret: oauthUnderOld, _hint: "OAuth" } },
      { id: "i3", provider: "sentry", config: { _secret: alreadyCurrent } },
      { id: "i4", provider: "teams", config: { webhookLabel: "no secret yet" } },
      { id: "i5", provider: "broken", config: { _secret: "v2:deadbeef:AAAA:BBBB:CCCC" } },
      { id: "i6", provider: "null", config: null },
    ];
    users = [{ id: "u1", totpSecret: totpUnderOld }, { id: "u2", totpSecret: "JBSWY3DPEHPK3PXP" }, { id: "u3", totpSecret: null }];

    const r = await resealStoredSecrets(db);
    expect(r).toEqual({ integrations: { checked: 4, resealed: 2, unreadable: ["broken (i5)"] }, totp: { checked: 1, resealed: 1, unreadable: 0 } });
    expect(writes.sort()).toEqual(["integration:i1", "integration:i2", "user:u1"]);
    const c1 = integrations[0].config as Record<string, string>;
    expect(c1.apiBase).toBe("x"); expect(c1._hint).toBe("…-key");
    expect(c1._secret.startsWith(`v2:${currentKeyId()}:`)).toBe(true);
    expect(decryptSecret(c1._secret)).toBe("hl-key");
    expect(JSON.parse(decryptSecret((integrations[1].config as Record<string, string>)._secret))).toEqual({ access: "a", refresh: "r" });
    expect((integrations[2].config as Record<string, string>)._secret).toBe(alreadyCurrent);
    expect((integrations[4].config as Record<string, string>)._secret).toBe("v2:deadbeef:AAAA:BBBB:CCCC");
    expect(decryptSecret(users[0].totpSecret!)).toBe("JBSWY3DPEHPK3PXP");
    expect(users[1].totpSecret).toBe("JBSWY3DPEHPK3PXP");

    writes.length = 0;
    const again = await resealStoredSecrets(db);
    expect(again.integrations.resealed + again.totp.resealed).toBe(0);
    expect(writes).toEqual([]);
  });
});
