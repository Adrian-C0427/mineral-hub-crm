/**
 * Encryption-at-rest for integration credentials (AES-256-GCM).
 *
 * Key sourcing: INTEGRATION_SECRET_KEY (32+ chars, set on the Railway service)
 * is preferred. When unset, a key is derived from JWT_SECRET via scrypt so
 * encrypted secrets work out of the box — but rotating JWT_SECRET then also
 * invalidates stored credentials, so production should set the dedicated var
 * (see docs/integrations-audit.md → Secrets management).
 *
 * Ciphertext format: "v1:<iv b64>:<authTag b64>:<ciphertext b64>". Secrets are
 * decrypted only server-side at call time; API responses carry a masked hint
 * (last 4 characters), never the plaintext.
 */
import crypto from "node:crypto";
import { env } from "../config.js";

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) {
    const source = process.env.INTEGRATION_SECRET_KEY || env.JWT_SECRET;
    // scrypt gives us a uniform 32-byte key from either source.
    cachedKey = crypto.scryptSync(source, "mineral-hub-integrations-v1", 32);
  }
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("Malformed secret payload");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** Non-reversible display hint: "…1234" (never enough to reconstruct the key). */
export function secretHint(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return plaintext.length > 4 ? `…${tail}` : "…";
}
