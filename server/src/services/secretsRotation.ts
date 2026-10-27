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
 *
 * Each write is a compare-and-set against the row exactly as it was read, so a
 * request that changes an integration (or re-enrolls 2FA) while the pass runs
 * is never overwritten with the older value. A row that was readable but not
 * saved — it changed underneath, or the write failed — is counted as `failed`
 * and may still be under the previous key, so the log then says to keep
 * INTEGRATION_SECRET_KEY_PREVIOUS and restart rather than to remove it.
 */
import { prisma } from "../db.js";
import { isSealed, needsReseal, resealSecret, rotationConfigured } from "./secrets.js";

export interface RotationDb {
  integration: {
    findMany(args: { select: { id: true; provider: true; config: true } }): Promise<{ id: string; provider: string; config: unknown }[]>;
    updateMany(args: { where: { id: string; config: { equals: unknown } }; data: { config: unknown } }): Promise<{ count: number }>;
  };
  user: {
    findMany(args: { where: { totpSecret: { not: null } }; select: { id: true; totpSecret: true } }): Promise<{ id: string; totpSecret: string | null }[]>;
    updateMany(args: { where: { id: string; totpSecret: string }; data: { totpSecret: string } }): Promise<{ count: number }>;
  };
}

export interface RotationResult {
  integrations: { checked: number; resealed: number; unreadable: string[]; failed: string[] };
  totp: { checked: number; resealed: number; unreadable: number; failed: number };
}

/** The pass itself (exported for tests); `rotateStoredSecrets` wires it to Prisma and the log. */
export async function resealStoredSecrets(db: RotationDb): Promise<RotationResult> {
  const out: RotationResult = { integrations: { checked: 0, resealed: 0, unreadable: [], failed: [] }, totp: { checked: 0, resealed: 0, unreadable: 0, failed: 0 } };
  for (const row of await db.integration.findMany({ select: { id: true, provider: true, config: true } })) {
    const cfg = row.config && typeof row.config === "object" && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : null;
    const sealed = cfg && typeof cfg._secret === "string" ? cfg._secret : null;
    if (!sealed || !isSealed(sealed)) continue;
    out.integrations.checked++;
    if (!needsReseal(sealed)) continue;
    const label = `${row.provider} (${row.id})`;
    let next: string;
    try { next = resealSecret(sealed); } catch { out.integrations.unreadable.push(label); continue; }
    try {
      const { count } = await db.integration.updateMany({ where: { id: row.id, config: { equals: row.config } }, data: { config: { ...cfg, _secret: next } } });
      if (count) out.integrations.resealed++; else out.integrations.failed.push(label);
    } catch {
      out.integrations.failed.push(label);
    }
  }
  for (const u of await db.user.findMany({ where: { totpSecret: { not: null } }, select: { id: true, totpSecret: true } })) {
    if (!u.totpSecret || !isSealed(u.totpSecret)) continue; // legacy plaintext enrollment
    out.totp.checked++;
    if (!needsReseal(u.totpSecret)) continue;
    let next: string;
    try { next = resealSecret(u.totpSecret); } catch { out.totp.unreadable++; continue; }
    try {
      const { count } = await db.user.updateMany({ where: { id: u.id, totpSecret: u.totpSecret }, data: { totpSecret: next } });
      if (count) out.totp.resealed++; else out.totp.failed++;
    } catch {
      out.totp.failed++;
    }
  }
  return out;
}

/** Startup entry point (server/src/index.ts). */
export async function rotateStoredSecrets(log: (m: string) => void = (m) => console.log(m), db: RotationDb = prisma as unknown as RotationDb): Promise<RotationResult | null> {
  if (!rotationConfigured()) return null;
  const r = await resealStoredSecrets(db);
  const unreadable = [...r.integrations.unreadable, ...(r.totp.unreadable ? [`${r.totp.unreadable} TOTP`] : [])];
  const failed = [...r.integrations.failed, ...(r.totp.failed ? [`${r.totp.failed} TOTP`] : [])];
  log(`[secrets] key rotation: ${r.integrations.resealed}/${r.integrations.checked} integration secrets and ${r.totp.resealed}/${r.totp.checked} TOTP secrets re-encrypted under the current key` +
    (unreadable.length ? `; ${unreadable.length} unreadable with either key (${unreadable.join(", ")}) — reconnect those integrations / re-enroll` : "") +
    (failed.length
      ? `; ${failed.length} readable but not saved (${failed.join(", ")}: changed while the pass ran, or the write failed) — keep INTEGRATION_SECRET_KEY_PREVIOUS set and restart to retry.`
      : `; everything readable is now under the current key — INTEGRATION_SECRET_KEY_PREVIOUS can be removed.`));
  return r;
}
