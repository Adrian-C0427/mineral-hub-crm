/**
 * Boot-time re-encryption of stored secrets after an INTEGRATION_SECRET_KEY
 * rotation (services/secrets.ts explains the key handling).
 *
 * Runs only while INTEGRATION_SECRET_KEY_PREVIOUS is set. Every stored secret
 * — the `_secret` inside each Integration's config (API keys, webhook URLs,
 * OAuth token bundles) and each user's TOTP secret — that is not yet sealed
 * under the current key is decrypted with whichever key can read it and
 * written back under the current one. Rows already under the current key are
 * not touched, so the pass is idempotent and a second boot does nothing.
 *
 * A row neither key can read (sealed by some third key, or corrupt) is left as
 * it is and reported: the integration shows as needing reconnection in the
 * app, exactly as it would have without this pass. Legacy plaintext TOTP rows
 * (enrolled before encryption at rest) are not ciphertext and are skipped.
 */
import { prisma } from "../db.js";
import { isSealed, needsReseal, resealSecret, rotationConfigured } from "./secrets.js";

export interface RotationDb {
  integration: {
    findMany(args: { select: { id: true; provider: true; config: true } }): Promise<{ id: string; provider: string; config: unknown }[]>;
    update(args: { where: { id: string }; data: { config: unknown } }): Promise<unknown>;
  };
  user: {
    findMany(args: { where: { totpSecret: { not: null } }; select: { id: true; totpSecret: true } }): Promise<{ id: string; totpSecret: string | null }[]>;
    update(args: { where: { id: string }; data: { totpSecret: string } }): Promise<unknown>;
  };
}

export interface RotationResult {
  integrations: { checked: number; resealed: number; unreadable: string[] };
  totp: { checked: number; resealed: number; unreadable: number };
}

/** The pass itself (exported for tests); `rotateStoredSecrets` wires it to Prisma and the log. */
export async function resealStoredSecrets(db: RotationDb): Promise<RotationResult> {
  const out: RotationResult = { integrations: { checked: 0, resealed: 0, unreadable: [] }, totp: { checked: 0, resealed: 0, unreadable: 0 } };
  for (const row of await db.integration.findMany({ select: { id: true, provider: true, config: true } })) {
    const cfg = row.config && typeof row.config === "object" && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : null;
    const sealed = cfg && typeof cfg._secret === "string" ? cfg._secret : null;
    if (!sealed || !isSealed(sealed)) continue;
    out.integrations.checked++;
    if (!needsReseal(sealed)) continue;
    try {
      await db.integration.update({ where: { id: row.id }, data: { config: { ...cfg, _secret: resealSecret(sealed) } } });
      out.integrations.resealed++;
    } catch {
      out.integrations.unreadable.push(`${row.provider} (${row.id})`);
    }
  }
  for (const u of await db.user.findMany({ where: { totpSecret: { not: null } }, select: { id: true, totpSecret: true } })) {
    if (!u.totpSecret || !isSealed(u.totpSecret)) continue; // legacy plaintext enrollment
    out.totp.checked++;
    if (!needsReseal(u.totpSecret)) continue;
    try {
      await db.user.update({ where: { id: u.id }, data: { totpSecret: resealSecret(u.totpSecret) } });
      out.totp.resealed++;
    } catch {
      out.totp.unreadable++;
    }
  }
  return out;
}

/** Startup entry point (server/src/index.ts). */
export async function rotateStoredSecrets(log: (m: string) => void = (m) => console.log(m)): Promise<RotationResult | null> {
  if (!rotationConfigured()) return null;
  const r = await resealStoredSecrets(prisma as unknown as RotationDb);
  const pending = r.integrations.unreadable.length + r.totp.unreadable;
  log(`[secrets] key rotation: ${r.integrations.resealed}/${r.integrations.checked} integration secrets and ${r.totp.resealed}/${r.totp.checked} TOTP secrets re-encrypted under the current key` +
    (pending ? `; ${pending} unreadable with either key (${[...r.integrations.unreadable, ...(r.totp.unreadable ? [`${r.totp.unreadable} TOTP`] : [])].join(", ")}) — reconnect those integrations / re-enroll` : "") +
    `; everything readable is now under the current key — INTEGRATION_SECRET_KEY_PREVIOUS can be removed.`);
  return r;
}
