import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";

/**
 * Boot-time load of non-Texas cadastral coverage into PostGIS.
 *
 * Louisiana's Haynesville/Bossier parishes and their PLSS sections ship WITH
 * the server (server/data/gis/la-haynesville.json.gz — Census TIGER parish
 * boundaries + BLM CadNSDI first-division sections) and are written into the
 * same tables the Texas data lives in:
 *   gis.counties  ← parishes  (fips "22017", state 'LA')
 *   gis.abstracts ← sections  (id "LA-…", state 'LA', abstract "Sec 12",
 *                              survey = township/range "T17N R13W")
 * so tiles, search, filters and deal footprints serve them with no extra path.
 *
 * Additive and idempotent, like the other startup backfills:
 *  - dev databases without the gis tables are skipped (logged);
 *  - a marker row in gis.dataset_version records which dataset version is
 *    loaded; when it matches the bundled file AND every row is present, boot
 *    does nothing beyond two counts;
 *  - otherwise parishes and sections are upserted in batches inside one
 *    transaction (advisory-locked, so two instances booting together load
 *    once), and the marker is written last;
 *  - every write is scoped to state 'LA' rows whose ids come from the file.
 *    Texas rows are never touched. The only DELETE removes Louisiana section
 *    ids ("LA-…") in this dataset's parishes that a NEWER version of this same
 *    dataset dropped — never on a first load.
 */

export const LA_DATASET_KEY = "la-haynesville";
export const LA_DATASET_FILE = "la-haynesville.json.gz";
const STATE = "LA";
const PARISH_BATCH = 50;
const SECTION_BATCH = 200;

/**
 * server/data/gis/<file>. The module runs from server/src/services (tsx) or
 * server/dist/services (node dist/index.js on Railway) — both two levels
 * below server/, so one relative path serves both.
 */
export function regionDataPath(moduleUrl: string, file = LA_DATASET_FILE): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../../data/gis", file);
}

type Geometry = { type: string; coordinates: unknown };
export interface ParishRow { fips: string; name: string; geom: Geometry }
export interface SectionRow { id: string; countyFips: string; county: string; abstract: string; survey: string; area: number | null; geom: Geometry }
export interface RegionDataset { key: string; version: string; parishes: ParishRow[]; sections: SectionRow[] }

/** "Sec 07" → "Sec 7" (PLSS section labels arrive zero-padded; people type "Sec 7"). */
export function normalizeSectionLabel(raw: string): string {
  const m = /^sec(?:tion)?\.?\s*0*(\d+)([a-z]?)$/i.exec(raw.trim());
  return m ? `Sec ${m[1]}${m[2].toUpperCase()}` : raw.trim();
}

/**
 * Parse + validate the bundled dataset (decompressed JSON bytes). The version
 * is a content hash, so re-bundling identical data never triggers a reload.
 * Throws on anything that isn't a clean Louisiana parish/section set — the
 * loader must never write rows it can't vouch for.
 */
export function parseRegionDataset(json: Buffer | string, key = LA_DATASET_KEY): RegionDataset {
  const text = typeof json === "string" ? json : json.toString("utf8");
  const version = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  const raw = JSON.parse(text) as { parishes?: unknown[]; sections?: unknown[] };
  const isGeom = (g: unknown, types: string[]): g is Geometry =>
    !!g && typeof g === "object" && types.includes((g as Geometry).type) && Array.isArray((g as Geometry).coordinates);
  if (!Array.isArray(raw.parishes) || !raw.parishes.length) throw new Error(`${key}: no parishes`);
  if (!Array.isArray(raw.sections) || !raw.sections.length) throw new Error(`${key}: no sections`);

  const parishes: ParishRow[] = raw.parishes.map((p, i) => {
    const r = p as Record<string, unknown>;
    if (typeof r.fips !== "string" || !/^22\d{3}$/.test(r.fips)) throw new Error(`${key}: parish ${i} has a non-Louisiana fips`);
    if (typeof r.name !== "string" || !r.name.trim()) throw new Error(`${key}: parish ${r.fips} has no name`);
    if (!isGeom(r.geom, ["Polygon", "MultiPolygon"])) throw new Error(`${key}: parish ${r.fips} has no polygon`);
    return { fips: r.fips, name: r.name.trim(), geom: r.geom };
  });
  const parishFips = new Set(parishes.map((p) => p.fips.slice(2)));
  const seen = new Set<string>();
  const sections: SectionRow[] = raw.sections.map((s, i) => {
    const r = s as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^LA-[A-Z0-9]+$/.test(r.id)) throw new Error(`${key}: section ${i} has an id outside the LA- namespace`);
    if (seen.has(r.id)) throw new Error(`${key}: duplicate section id ${r.id}`);
    seen.add(r.id);
    if (typeof r.countyFips !== "string" || !parishFips.has(r.countyFips)) throw new Error(`${key}: section ${r.id} is outside the dataset's parishes`);
    if (typeof r.county !== "string" || typeof r.abstract !== "string" || typeof r.survey !== "string") throw new Error(`${key}: section ${r.id} is missing labels`);
    if (!isGeom(r.geom, ["Polygon", "MultiPolygon"])) throw new Error(`${key}: section ${r.id} has no polygon`);
    return {
      id: r.id, countyFips: r.countyFips, county: r.county.trim(),
      abstract: normalizeSectionLabel(r.abstract), survey: r.survey.trim(),
      area: typeof r.area === "number" && Number.isFinite(r.area) ? r.area : null,
      geom: r.geom,
    };
  });
  return { key, version, parishes, sections };
}

/**
 * Whether boot has work to do. Load when nothing (or a different version) was
 * recorded, or when rows went missing since; prune stale ids only when a
 * previous version of this dataset was loaded and the file has changed.
 */
export function decideLoad(
  marker: { version: string } | null,
  version: string,
  present: { parishes: number; sections: number },
  expected: { parishes: number; sections: number },
): { load: boolean; pruneStale: boolean } {
  const complete = present.parishes === expected.parishes && present.sections === expected.sections;
  const sameVersion = marker?.version === version;
  return { load: !sameVersion || !complete, pruneStale: !!marker && !sameVersion };
}

export function batches<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * One multi-row upsert into gis.counties. State is a literal ('LA'), and the
 * ON CONFLICT update only ever rewrites a row that is already Louisiana's.
 */
export function buildParishUpsert(rows: readonly ParishRow[]): { sql: string; params: unknown[] } {
  const values = rows.map((_, j) => `($${j * 3 + 1}, '${STATE}', $${j * 3 + 2}, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($${j * 3 + 3}), 4326)))`);
  return {
    sql: `INSERT INTO gis.counties (fips, state, name, geom) VALUES ${values.join(", ")}
          ON CONFLICT (fips) DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom
          WHERE gis.counties.state = '${STATE}'`,
    params: rows.flatMap((p) => [p.fips, p.name, JSON.stringify(p.geom)]),
  };
}

/** One multi-row upsert into gis.abstracts (same Louisiana-only guard). */
export function buildSectionUpsert(rows: readonly SectionRow[]): { sql: string; params: unknown[] } {
  const values = rows.map((_, j) => {
    const b = j * 7;
    return `($${b + 1}, '${STATE}', $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::float8, ST_SetSRID(ST_GeomFromGeoJSON($${b + 7}), 4326))`;
  });
  return {
    sql: `INSERT INTO gis.abstracts (id, state, county_fips, county, abstract, survey, area_m2, geom) VALUES ${values.join(", ")}
          ON CONFLICT (id) DO UPDATE SET county_fips = EXCLUDED.county_fips, county = EXCLUDED.county,
            abstract = EXCLUDED.abstract, survey = EXCLUDED.survey, area_m2 = EXCLUDED.area_m2, geom = EXCLUDED.geom
          WHERE gis.abstracts.state = '${STATE}'`,
    params: rows.flatMap((s) => [s.id, s.countyFips, s.county, s.abstract, s.survey, s.area, JSON.stringify(s.geom)]),
  };
}

/** The SQL surface the loader needs — Prisma in the app, anything pg-shaped in tests. */
export interface GisDb {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}
export interface GisDbRunner extends GisDb {
  transaction<T>(fn: (tx: GisDb) => Promise<T>): Promise<T>;
}

export type RegionLoadResult =
  | { status: "no-gis" }
  | { status: "current"; parishes: number; sections: number }
  | { status: "loaded"; parishes: number; sections: number; pruned: number };

async function readState(db: GisDb, ds: RegionDataset) {
  const [m] = await db.query<{ version: string }>(`SELECT version FROM gis.dataset_version WHERE key = $1`, [ds.key]);
  const [c] = await db.query<{ parishes: number; sections: number }>(
    `SELECT (SELECT count(*)::int FROM gis.counties WHERE state = '${STATE}' AND fips = ANY($1::text[])) AS parishes,
            (SELECT count(*)::int FROM gis.abstracts WHERE state = '${STATE}' AND id = ANY($2::text[])) AS sections`,
    [ds.parishes.map((p) => p.fips), ds.sections.map((s) => s.id)],
  );
  return { marker: m ?? null, present: { parishes: Number(c?.parishes ?? 0), sections: Number(c?.sections ?? 0) } };
}

export async function loadRegionDataset(db: GisDbRunner, ds: RegionDataset): Promise<RegionLoadResult> {
  const [t] = await db.query<{ ok: boolean }>(
    `SELECT (to_regclass('gis.counties') IS NOT NULL AND to_regclass('gis.abstracts') IS NOT NULL) AS ok`,
  );
  if (!t?.ok) return { status: "no-gis" };
  await db.execute(`CREATE TABLE IF NOT EXISTS gis.dataset_version (
    key       text PRIMARY KEY,
    version   text NOT NULL,
    loaded_at timestamptz NOT NULL DEFAULT now()
  )`);
  const expected = { parishes: ds.parishes.length, sections: ds.sections.length };

  // Cheap pre-check outside the transaction: the steady state on every boot.
  const before = await readState(db, ds);
  if (!decideLoad(before.marker, ds.version, before.present, expected).load) return { status: "current", ...expected };

  return db.transaction(async (tx) => {
    // Serialize concurrent boots (two replicas, an overlapping deploy); the
    // loser re-reads the state below and finds the work already done.
    await tx.execute(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`gis.dataset:${ds.key}`]);
    const cur = await readState(tx, ds);
    const plan = decideLoad(cur.marker, ds.version, cur.present, expected);
    if (!plan.load) return { status: "current" as const, ...expected };

    for (const rows of batches(ds.parishes, PARISH_BATCH)) {
      const q = buildParishUpsert(rows);
      await tx.execute(q.sql, q.params);
    }
    for (const rows of batches(ds.sections, SECTION_BATCH)) {
      const q = buildSectionUpsert(rows);
      await tx.execute(q.sql, q.params);
    }
    let pruned = 0;
    if (plan.pruneStale) {
      const gone = await tx.query<{ n: number }>(
        `WITH d AS (
           DELETE FROM gis.abstracts
            WHERE state = '${STATE}' AND id LIKE 'LA-%'
              AND county_fips = ANY($1::text[]) AND NOT (id = ANY($2::text[]))
            RETURNING 1)
         SELECT count(*)::int AS n FROM d`,
        [[...new Set(ds.parishes.map((p) => p.fips.slice(2)))], ds.sections.map((s) => s.id)],
      );
      pruned = Number(gone[0]?.n ?? 0);
    }
    await tx.execute(
      `INSERT INTO gis.dataset_version (key, version, loaded_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET version = EXCLUDED.version, loaded_at = EXCLUDED.loaded_at`,
      [ds.key, ds.version],
    );
    return { status: "loaded" as const, ...expected, pruned };
  });
}

const prismaRunner: GisDbRunner = {
  query: <T>(sql: string, params: unknown[] = []) => prisma.$queryRawUnsafe<T[]>(sql, ...params),
  execute: (sql, params = []) => prisma.$executeRawUnsafe(sql, ...params),
  transaction: (fn) => prisma.$transaction(
    (tx) => fn({
      query: <T>(sql: string, params: unknown[] = []) => tx.$queryRawUnsafe<T[]>(sql, ...params),
      execute: (sql, params = []) => tx.$executeRawUnsafe(sql, ...params),
    }),
    // ~3.5 MB of geometry in ~35 statements: far past Prisma's 5s default.
    { maxWait: 30_000, timeout: 10 * 60_000 },
  ),
};

/**
 * Startup entry point (server/src/index.ts). Resolves true when rows were
 * written — the caller then drops the in-process tile/reference caches.
 */
export async function ensureGisRegions(): Promise<boolean> {
  const file = regionDataPath(import.meta.url);
  if (!fs.existsSync(file)) {
    console.warn(`[gis] ${LA_DATASET_KEY}: bundled dataset not found (${file}) — skipped`);
    return false;
  }
  const ds = parseRegionDataset(zlib.gunzipSync(fs.readFileSync(file)));
  const r = await loadRegionDataset(prismaRunner, ds);
  if (r.status === "no-gis") console.log(`[gis] ${ds.key}: gis.counties/gis.abstracts not present — skipped`);
  else if (r.status === "current") console.log(`[gis] ${ds.key}@${ds.version}: up to date (${r.parishes} parishes, ${r.sections} sections)`);
  else console.log(`[gis] ${ds.key}@${ds.version}: loaded ${r.parishes} parishes, ${r.sections} sections${r.pruned ? `, removed ${r.pruned} stale sections` : ""}`);
  return r.status === "loaded";
}
