/**
 * Encryption-at-rest for integration credentials and TOTP secrets (AES-256-GCM).
 *
 * Key sourcing: INTEGRATION_SECRET_KEY (32+ chars, set on the Railway service)
 * is the dedicated key. In production it is REQUIRED (assertProductionSecrets()
 * refuses to boot without it) and JWT_SECRET is never used — so rotating
 * session signing can't orphan stored credentials. In development only, if the
 * dedicated key is unset we fall back to a JWT_SECRET-derived key so local runs
 * work out of the box (see docs/integrations-audit.md → Secrets management).
 *
 * Key rotation: set the NEW value in INTEGRATION_SECRET_KEY and move the old
 * one to INTEGRATION_SECRET_KEY_PREVIOUS. Reads accept both keys; writes always
 * use the current one; at boot services/secretsRotation.ts re-encrypts every
 * stored secret that is still under the previous key, after which the previous
 * variable can be removed. Nothing stored is ever unreadable mid-rotation.
 *
 * Ciphertext formats:
 *   "v2:<key id>:<iv b64>:<authTag b64>:<ciphertext b64>"  — written now; the
 *      key id (8 hex chars of a hash of the derived key) says which key sealed
 *      it, so rotation can tell what still needs re-encrypting without trial
 *      decryption, and a payload under an unknown key fails with a clear error.
 *   "v1:<iv b64>:<authTag b64>:<ciphertext b64>"           — pre-rotation rows;
 *      tried against the current key, then the previous one.
 * Secrets are decrypted only server-side at call time; API responses carry a
 * masked hint (last 4 characters), never the plaintext.
 */
import crypto from "node:crypto";
import { env, isProd } from "../config.js";

interface SealingKey { id: string; key: Buffer }

let cached: { current: SealingKey; previous: SealingKey | null } | null = null;

function derive(source: string): SealingKey {
  // scrypt gives us a uniform 32-byte key from the source.
  const key = crypto.scryptSync(source, "mineral-hub-integrations-v1", 32);
  return { id: crypto.createHash("sha256").update(key).digest("hex").slice(0, 8), key };
}

function keys(): { current: SealingKey; previous: SealingKey | null } {
  if (!cached) {
    const dedicated = env.INTEGRATION_SECRET_KEY;
    // Prod is guaranteed a dedicated key by assertProductionSecrets(); dev may
    // derive from JWT_SECRET for convenience but never in production.
    const source = dedicated || (isProd ? "" : env.JWT_SECRET);
    if (!source) throw new Error("INTEGRATION_SECRET_KEY is required to encrypt integration credentials.");
    const previousSource = env.INTEGRATION_SECRET_KEY_PREVIOUS;
    const current = derive(source);
    const previous = previousSource && previousSource !== source ? derive(previousSource) : null;
    cached = { current, previous };
  }
  return cached;
}

/** Tests only: forget the derived keys so a changed env is picked up. */
export function resetSecretKeys(): void { cached = null; }

/** Identifier of the key new writes use (never the key itself). */
export function currentKeyId(): string { return keys().current.id; }

/** True when a previous key is configured, i.e. a rotation is in progress. */
export function rotationConfigured(): boolean { return keys().previous !== null; }

export function encryptSecret(plaintext: string): string {
  const { current } = keys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", current.key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${current.id}:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/** The ciphertext's parts, or null when it is not one of ours. */
function parse(payload: string): { keyId: string | null; iv: Buffer; tag: Buffer; data: Buffer } | null {
  const parts = payload.split(":");
  if (parts[0] === "v2" && parts.length === 5 && parts.slice(1).every(Boolean)) {
    return { keyId: parts[1], iv: Buffer.from(parts[2], "base64"), tag: Buffer.from(parts[3], "base64"), data: Buffer.from(parts[4], "base64") };
  }
  if (parts[0] === "v1" && parts.length === 4 && parts.slice(1).every(Boolean)) {
    return { keyId: null, iv: Buffer.from(parts[1], "base64"), tag: Buffer.from(parts[2], "base64"), data: Buffer.from(parts[3], "base64") };
  }
  return null;
}

/** True for a string in one of our ciphertext formats (a legacy plaintext TOTP secret is not). */
export function isSealed(value: string | null | undefined): boolean {
  return !!value && parse(value) !== null;
}

function open(p: NonNullable<ReturnType<typeof parse>>, k: SealingKey): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", k.key, p.iv);
  decipher.setAuthTag(p.tag);
  return Buffer.concat([decipher.update(p.data), decipher.final()]).toString("utf8");
}

export function decryptSecret(payload: string): string {
  const p = parse(payload);
  if (!p) throw new Error("Malformed secret payload");
  const { current, previous } = keys();
  if (p.keyId) {
    const k = [current, previous].find((x) => x && x.id === p.keyId);
    if (!k) throw new Error("Secret was sealed with a key this server does not have (set INTEGRATION_SECRET_KEY_PREVIOUS to the old key).");
    return open(p, k);
  }
  // v1 carries no key id: the current key first, then the previous one.
  try { return open(p, current); } catch (e) {
    if (!previous) throw e;
    return open(p, previous);
  }
}

/**
 * Whether a stored payload is not (or not provably) under the current key: a
 * v1 payload, or a v2 payload sealed by another key id. Such rows are what the
 * boot rotation re-encrypts; a payload already under the current key is left
 * exactly as it is.
 */
export function needsReseal(payload: string): boolean {
  const p = parse(payload);
  return !!p && p.keyId !== keys().current.id;
}

/** The same plaintext, sealed under the current key (throws when unreadable). */
export function resealSecret(payload: string): string {
  return encryptSecret(decryptSecret(payload));
}

/** Non-reversible display hint: "…1234" (never enough to reconstruct the key). */
export function secretHint(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return plaintext.length > 4 ? `…${tail}` : "…";
}
