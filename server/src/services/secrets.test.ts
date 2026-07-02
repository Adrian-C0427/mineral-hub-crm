import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret, secretHint } from "./secrets.js";
import { INTEGRATION_CATALOG } from "../domain/integrationCatalog.js";
import { hasSecretValidator, isEnvProvider } from "./integrationProviders.js";

describe("integration secret encryption", () => {
  it("round-trips a credential", () => {
    const secret = "sk-ant-api03-abc123XYZ";
    const enc = encryptSecret(secret);
    expect(enc).not.toContain(secret);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("produces a fresh ciphertext per call (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("topsecret");
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered!").toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("masks all but the last 4 characters", () => {
    expect(secretHint("sk-ant-abcdef1234")).toBe("…1234");
    expect(secretHint("abc")).toBe("…");
  });
});

describe("integration catalog invariants", () => {
  it("every live apikey/webhook provider has a validator and a secret label", () => {
    for (const p of INTEGRATION_CATALOG) {
      if (p.implementation === "live") {
        expect(hasSecretValidator(p.key), `${p.key} needs a validator`).toBe(true);
        expect(p.secretLabel, `${p.key} needs a secretLabel`).toBeTruthy();
      }
    }
  });

  it("every env provider is backed by an env reflector", () => {
    for (const p of INTEGRATION_CATALOG) {
      if (p.implementation === "env") {
        expect(isEnvProvider(p.key), `${p.key} needs an env validator`).toBe(true);
      }
    }
  });

  it("keys are unique", () => {
    const keys = INTEGRATION_CATALOG.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("removed-by-audit providers stay removed", () => {
    // RRC has no API (bulk files only — see tools/rrc); QGIS Server is
    // self-hosted GIS, not a SaaS connection; "customapi" was a placeholder.
    for (const gone of ["rrc", "qgis", "customapi", "apikeys", "webhooks"]) {
      expect(INTEGRATION_CATALOG.some((p) => p.key === gone)).toBe(false);
    }
  });
});
