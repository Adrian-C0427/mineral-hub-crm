/**
 * Basins / plays / formations — the service side of domain/geoRegions.ts.
 *
 *  - The two bundles are read, validated and cached once per process; the
 *    county-level answer and the map overlay need no database at all.
 *  - At boot (server/src/index.ts) the region polygons are loaded into
 *    gis.geo_regions through the shared versioned loader (gisRegions.ts), and
 *    gis.abstract_regions — every abstract's area share inside every region —
 *    is then computed county by county in short transactions, each recorded in
 *    gis.abstract_regions_progress with the regions version it was built for.
 *    A new bundle version or a changed abstract count re-runs just that county;
 *    everything else is skipped on later boots. Nothing outside the gis.geo_*
 *    / gis.abstract_regions* tables is ever written.
 *  - geoContext() answers for a record: abstract shares when available, the
 *    county shares from the bundle otherwise, plus the RRC wells on the
 *    abstracts for formation evidence.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { prisma, withDbRetry } from "../db.js";
import {
  FORMATIONS_DATASET, GEO_REGIONS_DATASET, composeGeoContext, contentVersion, parseFormations, parseGeoRegions, regionsGeoJSON,
  type AbstractShareRow, type FormationsDataset, type GeoContext, type GeoRegionsDataset, type RegionKind, type WellEvidenceRow,
} from "../domain/geoRegions.js";
import { batches, loadVersionedDataset, prismaRunner, regionDataPath, type GisDb, type GisDbRunner } from "./gisRegions.js";

// ---------------------------------------------------------------------------
// Bundles (in memory)
// ---------------------------------------------------------------------------

let regionsCache: GeoRegionsDataset | null | undefined;
let formationsCache: FormationsDataset | null | undefined;

/** The regions bundle, or null when none ships with this build. */
export function geoRegionsDataset(file = regionDataPath(import.meta.url, GEO_REGIONS_DATASET.file)): GeoRegionsDataset | null {
  if (regionsCache !== undefined) return regionsCache;
  if (!fs.existsSync(file)) return (regionsCache = null);
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  return (regionsCache = parseGeoRegions(raw, contentVersion(raw)));
}

/** The formations bundle, or null when none ships with this build. */
export function formationsDataset(file = regionDataPath(import.meta.url, FORMATIONS_DATASET.file)): FormationsDataset | null {
  if (formationsCache !== undefined) return formationsCache;
  if (!fs.existsSync(file)) return (formationsCache = null);
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  return (formationsCache = parseFormations(raw, contentVersion(raw)));
}

export interface OverlayPayload { etag: string; body: string; count: number }
const overlayCache = new Map<string, OverlayPayload | null>();

/** Serialized GeoJSON of the regions of the given kinds (map overlay), cached per kind set. */
export function regionsPayload(kinds: readonly RegionKind[]): OverlayPayload | null {
  const key = [...kinds].sort().join(",");
  if (overlayCache.has(key)) return overlayCache.get(key)!;
  const ds = geoRegionsDataset();
  if (!ds) { overlayCache.set(key, null); return null; }
  const fc = regionsGeoJSON(ds, kinds);
  const p = { etag: `"geo-regions-${ds.version}-${key}"`, body: JSON.stringify(fc), count: fc.features.length };
  overlayCache.set(key, p);
  return p;
}

/** Tests only. */
export function resetGeoRegionsCache(): void { regionsCache = undefined; formationsCache = undefined; overlayCache.clear(); ready = false; }

// ---------------------------------------------------------------------------
// Boot load: polygons → gis.geo_regions, then abstract shares per county
// ---------------------------------------------------------------------------

export const GEO_REGIONS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS gis.geo_regions (
     id text PRIMARY KEY, name text NOT NULL, kind text NOT NULL, parent text, formation text,
     sources jsonb NOT NULL DEFAULT '[]'::jsonb, version text NOT NULL,
     geom geometry(MultiPolygon, 4326) NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS geo_regions_geom_gist ON gis.geo_regions USING gist (geom)`,
  // Subdivided copies: ST_Intersection against a few hundred small pieces is
  // far cheaper than against one 2,000-vertex basin outline.
  `CREATE TABLE IF NOT EXISTS gis.geo_regions_sub (region_id text NOT NULL, geom geometry(Polygon, 4326) NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS geo_regions_sub_geom_gist ON gis.geo_regions_sub USING gist (geom)`,
  `CREATE INDEX IF NOT EXISTS geo_regions_sub_region_idx ON gis.geo_regions_sub (region_id)`,
  `CREATE TABLE IF NOT EXISTS gis.abstract_regions (
     abstract_id text NOT NULL, region_id text NOT NULL, share real NOT NULL,
     PRIMARY KEY (abstract_id, region_id))`,
  `CREATE INDEX IF NOT EXISTS abstract_regions_region_idx ON gis.abstract_regions (region_id)`,
  `CREATE TABLE IF NOT EXISTS gis.abstract_regions_progress (
     state text NOT NULL, county_fips text NOT NULL, version text NOT NULL, abstracts integer NOT NULL,
     done_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (state, county_fips))`,
];

const REGION_BATCH = 8;

/** One multi-row upsert into gis.geo_regions (geometry made valid and forced to MultiPolygon); the version is the last, shared parameter. */
export function buildRegionUpsert(rows: readonly { id: string; name: string; kind: string; parent: string | null; formation: string | null; sources: unknown; geom: unknown }[], version: string): { sql: string; params: unknown[] } {
  const v = rows.length * 7 + 1;
  const values = rows.map((_, j) => {
    const b = j * 7;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb, $${v}, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($${b + 7}), 4326)), 3)))`;
  });
  return {
    sql: `INSERT INTO gis.geo_regions (id, name, kind, parent, formation, sources, version, geom) VALUES ${values.join(", ")}
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, parent = EXCLUDED.parent,
            formation = EXCLUDED.formation, sources = EXCLUDED.sources, version = EXCLUDED.version, geom = EXCLUDED.geom`,
    params: [...rows.flatMap((r) => [r.id, r.name, r.kind, r.parent, r.formation, JSON.stringify(r.sources), JSON.stringify(r.geom)]), version],
  };
}

/** Rebuild the subdivided copies from gis.geo_regions (whole table — 40 regions). */
export const REBUILD_SUB_SQL = `INSERT INTO gis.geo_regions_sub (region_id, geom)
  SELECT r.id, d.geom
    FROM gis.geo_regions r
    CROSS JOIN LATERAL ST_Subdivide(r.geom, 128) AS s(geom)
    CROSS JOIN LATERAL ST_Dump(s.geom) AS d
   WHERE ST_Dimension(d.geom) = 2`;

/**
 * Area share of every abstract of one county inside every region it touches
 * (≥ 1 %), from the subdivided pieces. Degrees² on both sides of the ratio —
 * the same place, so the projection distortion cancels. Only 2-D abstract
 * geometry takes part.
 */
export const COUNTY_SHARES_SQL = countySharesSql("a.geom");
/** The same computation over repaired abstract geometry — the retry when a county's run hits a topology error. */
export const COUNTY_SHARES_SQL_REPAIRED = countySharesSql("ST_MakeValid(a.geom)");
function countySharesSql(abstractGeom: string): string {
  return `INSERT INTO gis.abstract_regions (abstract_id, region_id, share)
  SELECT a.id, s.region_id, LEAST(1.0, SUM(ST_Area(ST_Intersection(${abstractGeom}, s.geom))) / ST_Area(a.geom))::real
    FROM gis.abstracts a
    JOIN gis.geo_regions_sub s ON s.geom && a.geom AND ST_Intersects(s.geom, ${abstractGeom})
   WHERE a.state = $1 AND a.county_fips = $2 AND ST_Dimension(a.geom) = 2 AND ST_Area(a.geom) > 0
   GROUP BY a.id, s.region_id
  HAVING SUM(ST_Area(ST_Intersection(${abstractGeom}, s.geom))) / ST_Area(a.geom) >= 0.01`;
}

export type GeoRegionsLoadResult = Awaited<ReturnType<typeof loadGeoRegions>>;

/** Load the polygons (versioned, idempotent; see gisRegions.ts loadVersionedDataset). */
export async function loadGeoRegions(db: GisDbRunner, ds: GeoRegionsDataset) {
  return loadVersionedDataset(db, {
    key: ds.key,
    version: ds.version,
    requires: ["gis.counties", "gis.abstracts"],
    ddl: GEO_REGIONS_DDL,
    expected: { regions: ds.regions.length },
    async present(q) {
      const [c] = await q.query<{ regions: number }>(
        `SELECT count(*)::int AS regions FROM gis.geo_regions WHERE version = $1 AND id = ANY($2::text[])`,
        [ds.version, ds.regions.map((r) => r.id)],
      );
      return { regions: Number(c?.regions ?? 0) };
    },
    async write(tx) {
      for (const rows of batches(ds.regions, REGION_BATCH)) {
        const q = buildRegionUpsert(rows, ds.version);
        await tx.execute(q.sql, q.params);
      }
      // This dataset owns the table: regions the file no longer carries go.
      const gone = await tx.query<{ n: number }>(
        `WITH d AS (DELETE FROM gis.geo_regions WHERE NOT (id = ANY($1::text[])) RETURNING 1) SELECT count(*)::int AS n FROM d`,
        [ds.regions.map((r) => r.id)],
      );
      await tx.execute(`DELETE FROM gis.geo_regions_sub`);
      await tx.execute(REBUILD_SUB_SQL);
      return Number(gone[0]?.n ?? 0);
    },
  });
}

export interface ShareProgress { counties: number; computed: number; skipped: number; failed: number; rows: number }

/**
 * Compute gis.abstract_regions for every (state, county) of gis.abstracts whose
 * progress row is missing or built for another regions version / abstract
 * count. One short transaction per county; a failure is logged and skipped so
 * one bad geometry cannot stall the rest.
 */
export async function ensureAbstractRegionShares(db: GisDbRunner, version: string, log: (m: string) => void = () => {}): Promise<ShareProgress> {
  const counties = await db.query<{ state: string; county_fips: string; n: number }>(
    `SELECT state, county_fips, count(*)::int AS n FROM gis.abstracts GROUP BY state, county_fips ORDER BY state, county_fips`,
  );
  const done = await db.query<{ state: string; county_fips: string; version: string; abstracts: number }>(
    `SELECT state, county_fips, version, abstracts FROM gis.abstract_regions_progress`,
  );
  const doneKey = new Map(done.map((d) => [`${d.state}/${d.county_fips}`, d]));
  const out: ShareProgress = { counties: counties.length, computed: 0, skipped: 0, failed: 0, rows: 0 };
  for (const c of counties) {
    const d = doneKey.get(`${c.state}/${c.county_fips}`);
    if (d && d.version === version && Number(d.abstracts) === Number(c.n)) { out.skipped++; continue; }
    const run = (sql: string) => db.transaction(async (tx) => {
        await tx.execute(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`gis.abstract_regions:${c.state}/${c.county_fips}`]);
        await tx.execute(`DELETE FROM gis.abstract_regions WHERE abstract_id IN (SELECT id FROM gis.abstracts WHERE state = $1 AND county_fips = $2)`, [c.state, c.county_fips]);
        const n = await tx.execute(sql, [c.state, c.county_fips]);
        await tx.execute(
          `INSERT INTO gis.abstract_regions_progress (state, county_fips, version, abstracts, done_at) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (state, county_fips) DO UPDATE SET version = EXCLUDED.version, abstracts = EXCLUDED.abstracts, done_at = EXCLUDED.done_at`,
          [c.state, c.county_fips, version, c.n],
        );
        return typeof n === "number" ? n : 0;
      });
    try {
      let rows: number;
      try { rows = await run(COUNTY_SHARES_SQL); }
      catch (e) {
        // A single invalid abstract ring aborts the whole county's statement
        // (GEOS topology error); repairing the abstract geometry on the fly
        // costs more but gets the county through.
        log(`[gis] abstract shares ${c.state}/${c.county_fips}: retrying with repaired geometry (${e instanceof Error ? e.message : String(e)})`);
        rows = await run(COUNTY_SHARES_SQL_REPAIRED);
      }
      out.computed++; out.rows += rows;
    } catch (e) {
      out.failed++;
      log(`[gis] abstract shares ${c.state}/${c.county_fips}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

let ready = false;
/** True once gis.geo_regions / gis.abstract_regions exist (loaded or found current by this process). */
export function geoRegionsAvailable(): boolean { return ready; }
/** Tests and scripts that prepare the schema themselves. */
export function setGeoRegionsAvailable(v: boolean): void { ready = v; }

/**
 * Startup entry point (server/src/index.ts). Loads the polygons, then builds
 * the abstract shares county by county. Resolves true when the tables became
 * queryable (the caller may then drop caches).
 */
export async function ensureGeoRegions(): Promise<boolean> {
  const ds = geoRegionsDataset();
  if (!ds) { console.warn(`[gis] ${GEO_REGIONS_DATASET.key}: bundled dataset not found — skipped`); return false; }
  const r = await loadGeoRegions(prismaRunner, ds);
  if (r.status === "no-gis") { console.log(`[gis] ${ds.key}: gis.counties/gis.abstracts not present — skipped (county-level answers only)`); return false; }
  if (r.status === "current") console.log(`[gis] ${ds.key}@${ds.version}: up to date (${r.regions} regions)`);
  else console.log(`[gis] ${ds.key}@${ds.version}: loaded ${r.regions} regions${r.pruned ? `, removed ${r.pruned} stale` : ""}`);
  ready = true;
  const p = await ensureAbstractRegionShares(prismaRunner, ds.version, (m) => console.warn(m));
  if (p.computed || p.failed) console.log(`[gis] abstract basin shares: ${p.computed} counties computed (${p.rows} rows), ${p.skipped} current, ${p.failed} failed`);
  return true;
}

// ---------------------------------------------------------------------------
// Answering for a record
// ---------------------------------------------------------------------------

export interface GeoContextQuery { abstractIds: string[]; counties: string[]; state?: string | null }

/** Shares + pending ids for the abstracts, from PostGIS (empty when unavailable). */
async function abstractShares(db: GisDb, ids: string[]): Promise<{ shares: AbstractShareRow[]; pending: string[]; counties: string[] }> {
  if (!ids.length || !ready) return { shares: [], pending: [], counties: [] };
  const rows = await withDbRetry(() => db.query<{ id: string; county: string; state: string; county_fips: string; region_id: string | null; share: number | null; done: boolean }>(
    `SELECT a.id, a.county, a.state, a.county_fips, ar.region_id, ar.share,
            EXISTS (SELECT 1 FROM gis.abstract_regions_progress p WHERE p.state = a.state AND p.county_fips = a.county_fips) AS done
       FROM gis.abstracts a
       LEFT JOIN gis.abstract_regions ar ON ar.abstract_id = a.id
      WHERE a.id = ANY($1::text[])`,
    [ids],
  ));
  const shares: AbstractShareRow[] = [];
  const pending = new Set<string>(); const counties = new Set<string>();
  for (const r of rows) {
    if (r.state === "TX") counties.add(r.county);
    if (r.region_id && r.share != null) shares.push({ abstractId: r.id, regionId: r.region_id, share: Number(r.share) });
    else if (!r.done) pending.add(r.id);
  }
  return { shares, pending: [...pending], counties: [...counties] };
}

/** RRC wells on the abstracts (Texas; the rrc schema may be absent on dev databases). */
async function wellEvidence(db: GisDb, ids: string[]): Promise<WellEvidenceRow[]> {
  if (!ids.length) return [];
  try {
    const rows = await db.query<{ abstract_id: string; field_name: string | null; formations: string[] | null }>(
      `SELECT abstract_id, field_name, formations FROM rrc.wells WHERE abstract_id = ANY($1::text[])`,
      [ids],
    );
    return rows.map((r) => ({ abstractId: r.abstract_id, fieldName: r.field_name, formations: r.formations }));
  } catch {
    return [];
  }
}

const dbReader: GisDb = {
  query: <T>(sql: string, params: unknown[] = []) => prisma.$queryRawUnsafe<T[]>(sql, ...params),
  execute: (sql, params = []) => prisma.$executeRawUnsafe(sql, ...params),
};

/** The basins / sub-basins / plays / formations for a record, or null when no bundle ships. */
export async function geoContext(q: GeoContextQuery, db: GisDb = dbReader): Promise<GeoContext | null> {
  const ds = geoRegionsDataset(); const fds = formationsDataset();
  if (!ds || !fds) return null;
  const ids = [...new Set(q.abstractIds.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 500);
  const texas = !q.state || q.state.toUpperCase() === "TX";
  const [shares, wells] = await Promise.all([abstractShares(db, ids), wellEvidence(db, ids)]);
  const counties = texas ? [...new Set([...q.counties, ...shares.counties])] : [];
  return composeGeoContext({ regions: ds, formations: fds, abstractIds: ids, abstractShares: shares.shares, pendingAbstractIds: shares.pending, counties, wells });
}
