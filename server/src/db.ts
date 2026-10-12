import { PrismaClient } from "@prisma/client";
import { isTransientDbError } from "./dbErrors.js";

/**
 * The URL the app's runtime queries go over. schema.prisma intends `url` to be
 * Neon's *pooled* endpoint, but production's DATABASE_URL was never switched
 * off the direct host — confirmed by the hostname in MINERAL-HUB-API-8/-9 — so
 * the pooler never absorbed the reconnect blips it was adopted for. Rather than
 * depend on that env change, derive the pooled host here: a Neon direct
 * endpoint `ep-<id>.<region>.aws.neon.tech` has its pooler at
 * `ep-<id>-pooler.<region>.aws.neon.tech`, same credentials and database.
 *
 * Runtime only. The Prisma CLI (migrate) still reads DATABASE_URL/DIRECT_URL
 * from the env untouched, so migrations keep the direct endpoint they need for
 * session-scoped advisory locks. Any non-Neon or already-pooled URL is returned
 * as-is; set DB_DISABLE_POOLER_REWRITE=1 to opt out entirely.
 */
export function runtimeDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw || process.env.DB_DISABLE_POOLER_REWRITE === "1") return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const m = /^(ep-[a-z0-9-]+?)(\.[a-z0-9.-]+\.neon\.tech)$/i.exec(url.hostname);
  if (!m || m[1].endsWith("-pooler")) return raw;
  url.hostname = `${m[1]}-pooler${m[2]}`;
  return url.toString();
}

const datasourceUrl = runtimeDatabaseUrl(process.env.DATABASE_URL);

export const prisma = new PrismaClient({
  ...(datasourceUrl ? { datasourceUrl } : {}),
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/**
 * Run a DB operation, retrying only on transient connection errors. The happy
 * path is unchanged (the op runs once and returns); retries kick in solely for
 * the Neon reconnect/pool blips seen on hot routes — the vector-tile fetch, the
 * dashboard read batch, and the wide fan-out Research analytics queries. Wrap an
 * idempotent read (or a whole `Promise.all` batch of them) so a re-run is safe.
 * Backoff is exponential from `baseDelayMs` (100ms, 200ms by default).
 */
export async function withDbRetry<T>(
  op: () => Promise<T>,
  retries = 2,
  baseDelayMs = 100,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (attempt >= retries || !isTransientDbError(err)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
}
