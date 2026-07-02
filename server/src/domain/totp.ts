/**
 * TOTP (RFC 6238) + Base32 (RFC 4648), implemented on Node's crypto so 2FA
 * needs no external dependency. HMAC-SHA1, 6 digits, 30-second step — the
 * defaults every authenticator app (Google Authenticator, Authy, 1Password…)
 * expects.
 *
 * Pure functions: `now`/`step` are injectable so the whole thing is unit-tested
 * against the RFC 6238 published test vectors.
 */
import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new random base32 TOTP secret (default 20 bytes = 160 bits, per RFC). */
export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

export interface TotpOptions {
  digits?: number;
  stepSeconds?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
}

/** The TOTP code for a given secret at a specific unix time (seconds). */
export function totpAt(secret: string, unixSeconds: number, opts: TotpOptions = {}): string {
  const digits = opts.digits ?? 6;
  const step = opts.stepSeconds ?? 30;
  const algorithm = opts.algorithm ?? "sha1";
  const counter = Math.floor(unixSeconds / step);

  const counterBuf = Buffer.alloc(8);
  // 64-bit big-endian counter.
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac(algorithm, base32Decode(secret)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/**
 * Verify a submitted code, allowing ±`window` steps of clock drift (default ±1
 * = the code before, current, and next — the standard tolerance). Uses a
 * constant-time compare per candidate to avoid timing leaks.
 */
export function verifyTotp(secret: string, token: string, opts: TotpOptions & { window?: number; now?: number } = {}): boolean {
  const cleaned = token.replace(/\s+/g, "");
  const digits = opts.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) return false;
  const window = opts.window ?? 1;
  const step = opts.stepSeconds ?? 30;
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  for (let w = -window; w <= window; w++) {
    const candidate = totpAt(secret, nowSec + w * step, opts);
    if (candidate.length === cleaned.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(cleaned))) {
      return true;
    }
  }
  return false;
}

/** The otpauth:// provisioning URI an authenticator app scans or imports. */
export function otpauthUri(secret: string, accountName: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** Human-friendly recovery code, e.g. "4f8a-2c19-b0d7". */
export function generateRecoveryCode(): string {
  const hex = crypto.randomBytes(6).toString("hex");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/** SHA-256 hash for at-rest storage of a recovery code (normalized). */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.replace(/[\s-]/g, "").toLowerCase()).digest("hex");
}

export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, generateRecoveryCode);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
