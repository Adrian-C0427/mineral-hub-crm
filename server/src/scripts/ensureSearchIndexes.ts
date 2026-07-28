/**
 * Idempotent search indexes for rrc.wells.
 *
 * `/api/wells/rrc-search` and `/api/gis/suggest` match a well by whatever
 * identifier the user happens to have — API number, RRC lease number, well
 * name/number, operator, lease name, county, survey, abstract, field. Every one
 * of those predicates is either a leading-wildcard `ILIKE '%x%'` or a
 * case-insensitive exact compare, and NONE of them can use the plain btree
 * indexes importRrcWells.ts creates. Without the indexes below, each search
 * sequentially scans the whole wells table, so any authenticated caller can
 * loop the endpoint and saturate the connection pool.
 *
 * Two index families, matching the two predicate shapes:
 *   - GIN + gin_trgm_ops for the free-text columns searched with `%x%`.
 *   - btree on upper(col) for the identifier columns compared case-insensitively
 *     exactly (the route uses upper(col) = upper($1), which matches these).
 *
 * Run against a live database with `npm run db:search-indexes` (server/). Also
 * invoked by importRrcWells.ts so a fresh import is indexed from the start.
 *
 * NOT `CONCURRENTLY`: a failed concurrent build leaves an INVALID index that
 * `IF NOT EXISTS` then skips forever, silently restoring the seq-scan. A plain
 * build takes a SHARE lock — it blocks writes to rrc.wells (which happen only
 * during the monthly ingest) and never blocks the reads the API serves.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";

/** Columns searched with a leading wildcard (`ILIKE '%x%'`) → trigram GIN. */
const TRIGRAM_COLUMNS = [
  "lease_name", "operator", "survey", "field_name", "lease_no", "api8", "api10",
  // well_id is matched only by /gis/suggest, but it is the same table and the
  // same seq-scan exposure, so it is indexed here rather than left behind.
  "well_id",
] as const;

/** Columns compared case-insensitively exact (`upper(col) = upper($1)`) → btree. */
const UPPER_COLUMNS = ["well_no", "county", "abstract", "abstract_id"] as const;

export async function ensureWellSearchIndexes(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  for (const col of TRIGRAM_COLUMNS) {
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS wells_${col}_trgm ON rrc.wells USING GIN (${col} gin_trgm_ops)`,
    );
  }
  for (const col of UPPER_COLUMNS) {
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS wells_${col}_upper_idx ON rrc.wells (upper(${col}))`,
    );
  }
  // The planner needs fresh stats to pick the new indexes over a seq scan.
  await prisma.$executeRawUnsafe(`ANALYZE rrc.wells`);
}

// Direct invocation only (`npm run db:search-indexes`) — importRrcWells.ts
// imports the function above and must not trigger a run by loading the module.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ensureWellSearchIndexes()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log(`rrc.wells search indexes ensured (${TRIGRAM_COLUMNS.length} trigram, ${UPPER_COLUMNS.length} upper).`);
    })
    .catch((e) => {
      console.error("Index creation failed:", e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
