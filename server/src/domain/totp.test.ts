import { describe, expect, it } from "vitest";
import {
  base32Decode, base32Encode, generateRecoveryCode, generateSecret, hashRecoveryCode,
  otpauthUri, totpAt, verifyTotp,
} from "./totp.js";

// The RFC 6238 test seed: ASCII "12345678901234567890" (20 bytes) as base32.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const buf = Buffer.from([0, 1, 2, 253, 254, 255, 42, 7]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
  it("encodes the known RFC seed", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });
  it("tolerates lowercase, spaces and padding on decode", () => {
    const a = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const b = base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==");
    expect(a.equals(b)).toBe(true);
  });
});

describe("totpAt — RFC 6238 SHA-1 test vectors", () => {
  // Table 1 from RFC 6238 (8-digit codes, SHA-1).
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [time, expected] of vectors) {
    it(`t=${time} → ${expected}`, () => {
      expect(totpAt(RFC_SECRET, time, { digits: 8 })).toBe(expected);
    });
  }
});

describe("verifyTotp", () => {
  const secret = generateSecret();
  const now = 1_700_000_000;

  it("accepts the current code", () => {
    const code = totpAt(secret, now);
    expect(verifyTotp(secret, code, { now })).toBe(true);
  });
  it("accepts a code from the previous/next step (drift window)", () => {
    expect(verifyTotp(secret, totpAt(secret, now - 30), { now })).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now + 30), { now })).toBe(true);
  });
  it("rejects a code two steps away", () => {
    expect(verifyTotp(secret, totpAt(secret, now + 60), { now })).toBe(false);
  });
  it("rejects malformed input", () => {
    expect(verifyTotp(secret, "12345", { now })).toBe(false); // too short
    expect(verifyTotp(secret, "abcdef", { now })).toBe(false); // non-numeric
    expect(verifyTotp(secret, "", { now })).toBe(false);
  });
  it("tolerates spaces in the submitted code", () => {
    const code = totpAt(secret, now);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { now })).toBe(true);
  });
});

describe("otpauthUri", () => {
  it("builds a scannable provisioning URI", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "user@example.com", "Mineral Hub");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Mineral+Hub");
    expect(uri).toContain(encodeURIComponent("Mineral Hub:user@example.com"));
  });
});

describe("recovery codes", () => {
  it("formats codes and hashes them stably, ignoring case/dashes", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    const h1 = hashRecoveryCode(code);
    const h2 = hashRecoveryCode(code.toUpperCase().replace(/-/g, ""));
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });
});
