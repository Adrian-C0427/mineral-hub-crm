import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import {
  batches, loadVersionedDataset, prismaRunner, regionDataPath,
  type GisDb, type GisDbRunner, type VersionedLoadResult,
} from "./gisRegions.js";
import {
  classifyLaBore, classifyLaWell, LA_FID_SPAN, laBoreFid, laWellFid, type MapClass,
} from "../domain/sonrisWells.js";

/**
 * Boot-time load of Louisiana WELL data (SONRIS / Office of Conservation) —
 * wells, surface → bottom-hole lines and monthly unit (LUW) production — into
 * the `sonris` schema, mirroring how Texas RRC wells live in `rrc`.
 *
 * The data ships WITH the server (server/data/gis/la-red-river-wells.json.gz,
 * validated and cleaned before bundling; Louisiana's terms forbid automated
 * access, so nothing here fetches anything) and loads through the shared
 * versioned loader in services/gisRegions.ts:
 *  - databases without the gis tables (dev) are skipped, nothing created;
 *  - additive DDL (CREATE … IF NOT EXISTS) for sonris.wells / wellbores /
 *    production — never touching rrc.* or gis.*;
 *  - a gis.dataset_version marker records the loaded version (a content hash
 *    of the file); when it matches and every row is present, boot only counts;
 *  - otherwise, inside one advisory-locked transaction, this dataset's rows
 *    are replaced (delete by `dataset`, re-insert) and the marker written last.
 *    Readers see the old rows until commit.
 *
 * Map ids, the status vocabulary and unit-production shaping are in
 * domain/sonrisWells.ts.
 */

export const LA_WELLS_DATASET_KEY = "la-red-river-wells";
export const LA_WELLS_DATASET_FILE = "la-red-river-wells.json.gz";
/** The parish this dataset covers (gis.counties name, state 'LA'). */
export const LA_WELLS_PARISH = "Red River";

const WELL_BATCH = 200;
const BORE_BATCH = 300;
const PROD_BATCH = 1000;

// Louisiana's bounding box (with a little margin) — coordinates outside it are
// not a Louisiana location, whatever the file says.
const LA_BBOX = { minLon: -94.1, maxLon: -88.8, minLat: 28.8, maxLat: 33.1 };

export interface LaWellRow extends MapClass {
  fid: number; serial: number; api: string | null; name: string; wellNo: string | null;
  operator: string | null; operatorId: string | null; field: string | null; fieldId: string | null;
  statusCode: string; statusText: string; product: string | null; classType: string | null;
  spud: string | null; permit: string | null; completion: string | null; statusDate: string | null;
  md: number | null; tvd: number | null; luw: string | null; section: number | null; township: string | null;
  lon: number; lat: number; locationQuality: "ok" | "flag"; locationNote: string | null;
}
export interface LaBoreRow { fid: number; surfaceFid: number; serial: number; seq: number; md: number | null; tvd: number | null; boreType: string; path: [number, number][] }
export interface LaProductionRow {
  luw: string; ym: number; line: string; operatorId: string; operator: string | null; fieldId: string | null; field: string | null;
  luwName: string | null; luwType: string | null; oil: number; condensate: number; gas: number; wells: number; stateFlag: string | null;
}
export interface LaWellDataset { key: string; version: string; parish: string; wells: LaWellRow[]; bores: LaBoreRow[]; production: LaProductionRow[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const inLa = (lon: unknown, lat: unknown): boolean =>
  typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat) &&
  lon >= LA_BBOX.minLon && lon <= LA_BBOX.maxLon && lat >= LA_BBOX.minLat && lat <= LA_BBOX.maxLat;

/** An ISO calendar date (YYYY-MM-DD) that really exists, 1850..2100, else null-or-throw. */
function isoDate(v: unknown, what: string): string | null {
  if (v == null) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${what}: not an ISO date`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new Error(`${what}: impossible date ${v}`);
  const y = d.getUTCFullYear();
  if (y < 1850 || y > 2100) throw new Error(`${what}: date out of range ${v}`);
  return v;
}
function depth(v: unknown, what: string): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 60_000) throw new Error(`${what}: bad depth`);
  return v;
}
const seqId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v < LA_FID_SPAN;

/**
 * Parse + structurally re-validate the bundled dataset (decompressed JSON
 * bytes). The cleaning happened upstream; this is the loader refusing to
 * write anything it can't vouch for — ids inside the Louisiana fid block,
 * coordinates inside Louisiana, dates real, every bore on a kept well, and
 * production keys unique. The version is a content hash, so re-bundling
 * identical data never reloads.
 */
export function parseLaWellDataset(json: Buffer | string, key = LA_WELLS_DATASET_KEY, parish = LA_WELLS_PARISH): LaWellDataset {
  const text = typeof json === "string" ? json : json.toString("utf8");
  const version = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  const raw = JSON.parse(text) as { key?: unknown; wells?: unknown[]; bores?: unknown[]; production?: unknown[] };
  if (raw.key !== undefined && raw.key !== key) throw new Error(`${key}: file is dataset "${String(raw.key)}"`);
  if (!Array.isArray(raw.wells) || !raw.wells.length) throw new Error(`${key}: no wells`);
  if (!Array.isArray(raw.bores)) throw new Error(`${key}: no bores array`);
  if (!Array.isArray(raw.production)) throw new Error(`${key}: no production array`);

  const serials = new Set<number>();
  const wells: LaWellRow[] = raw.wells.map((w, i) => {
    if (!isObj(w)) throw new Error(`${key}: well ${i} is not an object`);
    if (!seqId(w.serial)) throw new Error(`${key}: well ${i} has a serial outside the Louisiana fid block`);
    const serial = w.serial;
    const at = `${key}: well ${serial}`;
    if (serials.has(serial)) throw new Error(`${at} is duplicated`);
    serials.add(serial);
    if (w.api != null && (typeof w.api !== "string" || !/^\d{14}$/.test(w.api))) throw new Error(`${at} has a malformed API`);
    // SONRIS writes "00000000000000" for wells that never got an API (old
    // wells, expired permits): that is "no API", not an identifier.
    const api = w.api == null || /^0+$/.test(w.api as string) ? null : (w.api as string);
    if (api != null && !api.startsWith("17")) throw new Error(`${at} has a non-Louisiana API`);
    const name = str(w.name);
    if (!name) throw new Error(`${at} has no name`);
    const statusCode = str(w.statusCode), statusText = str(w.status);
    if (!statusCode || !/^\d{2}$/.test(statusCode) || !statusText) throw new Error(`${at} has no status`);
    const product = w.product == null ? null : str(w.product);
    if (product != null && !/^\d{2}$/.test(product)) throw new Error(`${at} has a malformed product code`);
    if (!inLa(w.lon, w.lat)) throw new Error(`${at} is not located in Louisiana`);
    const luw = w.luw == null ? null : str(w.luw);
    if (luw != null && !/^\d{6}$/.test(luw)) throw new Error(`${at} has a malformed LUW code`);
    if (w.section != null && (typeof w.section !== "number" || !Number.isInteger(w.section) || w.section < 0 || w.section > 99)) throw new Error(`${at} has a bad section`);
    const township = w.township == null ? null : str(w.township);
    if (township != null && !/^T\d{1,3}½?[NS] R\d{1,3}½?[EW]$/.test(township)) throw new Error(`${at} has a malformed township/range`);
    const quality = w.locationQuality;
    if (quality !== "ok" && quality !== "flag") throw new Error(`${at} has no location quality`);
    return {
      fid: laWellFid(serial), serial, api, name,
      wellNo: str(w.wellNo), operator: str(w.operator), operatorId: str(w.operatorId),
      field: str(w.field), fieldId: str(w.fieldId),
      statusCode, statusText, product, classType: str(w.classType),
      ...classifyLaWell(statusCode, statusText, product),
      spud: isoDate(w.spud, `${at} spud`), permit: isoDate(w.permit, `${at} permit`),
      completion: isoDate(w.completion, `${at} completion`), statusDate: isoDate(w.statusDate, `${at} status date`),
      md: depth(w.md, `${at} md`), tvd: depth(w.tvd, `${at} tvd`),
      luw, section: (w.section as number | null) ?? null, township,
      lon: w.lon as number, lat: w.lat as number,
      locationQuality: quality, locationNote: quality === "flag" ? (str(w.locationNote) ?? "location flagged") : null,
    };
  });

  const seqs = new Set<number>();
  const bores: LaBoreRow[] = raw.bores.map((b, i) => {
    if (!isObj(b)) throw new Error(`${key}: bore ${i} is not an object`);
    if (!seqId(b.seq)) throw new Error(`${key}: bore ${i} has a sequence outside the Louisiana fid block`);
    const at = `${key}: bore ${b.seq}`;
    if (seqs.has(b.seq)) throw new Error(`${at} is duplicated`);
    seqs.add(b.seq);
    if (!seqId(b.serial) || !serials.has(b.serial)) throw new Error(`${at} is not on a well in this dataset`);
    const path = b.path;
    if (!Array.isArray(path) || path.length < 2 || !path.every((p) => Array.isArray(p) && p.length === 2 && inLa(p[0], p[1]))) {
      throw new Error(`${at} has no Louisiana line`);
    }
    const pts = path as [number, number][];
    if (pts.every((p) => p[0] === pts[0][0] && p[1] === pts[0][1])) throw new Error(`${at} has zero length`);
    const md = depth(b.md, `${at} md`), tvd = depth(b.tvd, `${at} tvd`);
    return { fid: laBoreFid(b.seq), surfaceFid: laWellFid(b.serial), serial: b.serial, seq: b.seq, md, tvd, boreType: classifyLaBore(md, tvd, pts), path: pts };
  });

  const prodKeys = new Set<string>();
  const num = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what}: not a number`);
    return v;
  };
  const production: LaProductionRow[] = raw.production.map((p, i) => {
    if (!isObj(p)) throw new Error(`${key}: production row ${i} is not an object`);
    const luw = str(p.luw), line = str(p.line), operatorId = str(p.operatorId);
    if (!luw || !/^\d{6}$/.test(luw)) throw new Error(`${key}: production row ${i} has a malformed LUW code`);
    if (typeof p.ym !== "number" || !Number.isInteger(p.ym) || p.ym % 100 < 1 || p.ym % 100 > 12 || p.ym < 190001 || p.ym > 210012) {
      throw new Error(`${key}: production row ${i} has a bad month`);
    }
    if (!line || !operatorId) throw new Error(`${key}: production row ${i} is missing its line/operator`);
    // (luw, month, line) alone is NOT unique: a mid-month operator change files
    // the same line once per operator.
    const k = `${luw}|${p.ym}|${line}|${operatorId}`;
    if (prodKeys.has(k)) throw new Error(`${key}: duplicate production row ${k}`);
    prodKeys.add(k);
    const at = `${key}: production ${k}`;
    if (typeof p.wells !== "number" || !Number.isInteger(p.wells) || p.wells < 0) throw new Error(`${at}: bad well count`);
    return {
      luw, ym: p.ym, line, operatorId, operator: str(p.operator), fieldId: str(p.fieldId), field: str(p.field),
      luwName: str(p.luwName), luwType: str(p.luwType),
      oil: num(p.oil, `${at} oil`), condensate: num(p.condensate, `${at} condensate`), gas: num(p.gas, `${at} gas`),
      wells: p.wells, stateFlag: str(p.stateFlag),
    };
  });
  return { key, version, parish, wells, bores, production };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** Additive DDL for the sonris schema. Indexes are only what the queries use. */
export const SONRIS_DDL: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS sonris`,
  `CREATE TABLE IF NOT EXISTS sonris.wells (
     fid              integer PRIMARY KEY,        -- 2,000,000,000 + serial (map feature id; domain/sonrisWells)
     serial           integer NOT NULL,           -- Louisiana well serial number
     dataset          text NOT NULL,              -- bundled dataset key (gis.dataset_version)
     api              text,                       -- 14-digit API ("17…"), when the state has a real one
     name             text NOT NULL,
     well_no          text,
     operator         text,
     operator_id      text,
     field            text,
     field_id         text,
     status_code      text NOT NULL,              -- SONRIS status code ("10", "30"…)
     status_text      text NOT NULL,              -- the state's wording, verbatim
     status           text NOT NULL,              -- map bucket, Texas vocabulary (Producing, Shut-In…)
     type             text NOT NULL,              -- Oil / Gas / Location / Dry Hole / Injection/Disposal / Unknown
     symbol           text NOT NULL,
     product          text,                       -- SONRIS product code ("10" oil, "20" gas, "25" dry gas)
     class_type       text,
     spud_date        date,
     permit_date      date,
     completion_date  date,
     status_date      date,
     md               double precision,           -- measured depth, ft
     tvd              double precision,           -- true vertical depth, ft
     luw              text,                       -- production unit (Lease/Unit/Well) code
     section          integer,
     township         text,                       -- "T12N R10W" (matches gis.abstracts.survey)
     parish           text NOT NULL,
     location_quality text NOT NULL,              -- 'ok' | 'flag'
     location_note    text,
     geom             geometry(Point, 4326) NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sonris_wells_geom_gist ON sonris.wells USING GIST (geom)`,
  `CREATE INDEX IF NOT EXISTS sonris_wells_luw_idx ON sonris.wells (luw)`,
  `CREATE TABLE IF NOT EXISTS sonris.wellbores (
     fid          integer PRIMARY KEY,            -- 2,000,000,000 + SONRIS bore sequence
     surface_fid  integer NOT NULL,               -- sonris.wells.fid
     dataset      text NOT NULL,
     seq          integer NOT NULL,
     md           double precision,
     tvd          double precision,
     wellbore_type text NOT NULL,                 -- Horizontal / Directional (map color)
     geom         geometry(LineString, 4326) NOT NULL  -- straight surface → bottom-hole line
   )`,
  `CREATE INDEX IF NOT EXISTS sonris_wellbores_geom_gist ON sonris.wellbores USING GIST (geom)`,
  `CREATE INDEX IF NOT EXISTS sonris_wellbores_surface_idx ON sonris.wellbores (surface_fid)`,
  `CREATE TABLE IF NOT EXISTS sonris.production (
     luw          text NOT NULL,
     ym           integer NOT NULL,               -- YYYYMM
     line         text NOT NULL,                  -- report line
     operator_id  text NOT NULL,
     dataset      text NOT NULL,
     operator     text,
     field_id     text,
     field        text,
     luw_name     text,
     luw_type     text,
     oil          double precision NOT NULL,      -- bbl, condensate included
     condensate   double precision NOT NULL,      -- bbl, the condensate part of oil
     gas          double precision NOT NULL,      -- mcf
     wells        integer NOT NULL,               -- wells reported on the unit that month
     state_flag   text,                           -- the state's own error/notice text
     PRIMARY KEY (luw, ym, line, operator_id)
   )`,
];

const WELL_COLS = [
  "fid", "serial", "dataset", "api", "name", "well_no", "operator", "operator_id", "field", "field_id",
  "status_code", "status_text", "status", "type", "symbol", "product", "class_type",
  "spud_date", "permit_date", "completion_date", "status_date", "md", "tvd", "luw", "section", "township",
  "parish", "location_quality", "location_note",
] as const;
const WELL_CASTS: Partial<Record<(typeof WELL_COLS)[number], string>> = {
  fid: "int", serial: "int", section: "int", spud_date: "date", permit_date: "date", completion_date: "date",
  status_date: "date", md: "float8", tvd: "float8",
};

/** One multi-row insert into sonris.wells (fid conflict → this dataset takes the row). */
export function buildWellInsert(rows: readonly LaWellRow[], ds: { key: string; parish: string }): { sql: string; params: unknown[] } {
  const per = WELL_COLS.length + 2; // + lon, lat
  const values = rows.map((_, j) => {
    const b = j * per;
    const cols = WELL_COLS.map((c, k) => `$${b + k + 1}${WELL_CASTS[c] ? `::${WELL_CASTS[c]}` : ""}`);
    return `(${cols.join(", ")}, ST_SetSRID(ST_MakePoint($${b + per - 1}::float8, $${b + per}::float8), 4326))`;
  });
  const params = rows.flatMap((w) => [
    w.fid, w.serial, ds.key, w.api, w.name, w.wellNo, w.operator, w.operatorId, w.field, w.fieldId,
    w.statusCode, w.statusText, w.status, w.type, w.symbol, w.product, w.classType,
    w.spud, w.permit, w.completion, w.statusDate, w.md, w.tvd, w.luw, w.section, w.township,
    ds.parish, w.locationQuality, w.locationNote, w.lon, w.lat,
  ]);
  return {
    sql: `INSERT INTO sonris.wells (${WELL_COLS.join(", ")}, geom) VALUES ${values.join(", ")}
          ON CONFLICT (fid) DO UPDATE SET ${WELL_COLS.filter((c) => c !== "fid").map((c) => `${c} = EXCLUDED.${c}`).join(", ")}, geom = EXCLUDED.geom`,
    params,
  };
}

export function buildBoreInsert(rows: readonly LaBoreRow[], ds: { key: string }): { sql: string; params: unknown[] } {
  const vals = rows.map((_, j) => {
    const b = j * 8;
    return `($${b + 1}::int, $${b + 2}::int, $${b + 3}, $${b + 4}::int, $${b + 5}::float8, $${b + 6}::float8, $${b + 7}, ST_SetSRID(ST_GeomFromGeoJSON($${b + 8}), 4326))`;
  });
  return {
    sql: `INSERT INTO sonris.wellbores (fid, surface_fid, dataset, seq, md, tvd, wellbore_type, geom) VALUES ${vals.join(", ")}
          ON CONFLICT (fid) DO UPDATE SET surface_fid = EXCLUDED.surface_fid, dataset = EXCLUDED.dataset, seq = EXCLUDED.seq,
            md = EXCLUDED.md, tvd = EXCLUDED.tvd, wellbore_type = EXCLUDED.wellbore_type, geom = EXCLUDED.geom`,
    params: rows.flatMap((r) => [r.fid, r.surfaceFid, ds.key, r.seq, r.md, r.tvd, r.boreType, JSON.stringify({ type: "LineString", coordinates: r.path })]),
  };
}

const PROD_COLS = ["luw", "ym", "line", "operator_id", "dataset", "operator", "field_id", "field", "luw_name", "luw_type", "oil", "condensate", "gas", "wells", "state_flag"] as const;
const PROD_CASTS: Partial<Record<(typeof PROD_COLS)[number], string>> = { ym: "int", oil: "float8", condensate: "float8", gas: "float8", wells: "int" };

export function buildProductionInsert(rows: readonly LaProductionRow[], ds: { key: string }): { sql: string; params: unknown[] } {
  const n = PROD_COLS.length;
  const values = rows.map((_, j) => `(${PROD_COLS.map((c, k) => `$${j * n + k + 1}${PROD_CASTS[c] ? `::${PROD_CASTS[c]}` : ""}`).join(", ")})`);
  return {
    sql: `INSERT INTO sonris.production (${PROD_COLS.join(", ")}) VALUES ${values.join(", ")}
          ON CONFLICT (luw, ym, line, operator_id) DO UPDATE SET ${PROD_COLS.slice(4).map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`,
    params: rows.flatMap((r) => [r.luw, r.ym, r.line, r.operatorId, ds.key, r.operator, r.fieldId, r.field, r.luwName, r.luwType, r.oil, r.condensate, r.gas, r.wells, r.stateFlag]),
  };
}

export type LaWellCounts = { wells: number; bores: number; production: number };
export type LaWellLoadResult = VersionedLoadResult<LaWellCounts>;

export async function loadLaWellDataset(db: GisDbRunner, ds: LaWellDataset): Promise<LaWellLoadResult> {
  return loadVersionedDataset<LaWellCounts>(db, {
    key: ds.key,
    version: ds.version,
    requires: ["gis.counties", "gis.abstracts"],
    ddl: SONRIS_DDL,
    expected: { wells: ds.wells.length, bores: ds.bores.length, production: ds.production.length },
    async present(q: GisDb) {
      const [c] = await q.query<LaWellCounts>(
        `SELECT (SELECT count(*)::int FROM sonris.wells WHERE dataset = $1) AS wells,
                (SELECT count(*)::int FROM sonris.wellbores WHERE dataset = $1) AS bores,
                (SELECT count(*)::int FROM sonris.production WHERE dataset = $1) AS production`,
        [ds.key],
      );
      return { wells: Number(c?.wells ?? 0), bores: Number(c?.bores ?? 0), production: Number(c?.production ?? 0) };
    },
    async write(tx: GisDb) {
      // Replace this dataset's rows wholesale: the tables belong to bundled
      // datasets only, scoped by `dataset`, so nothing else is ever removed.
      let removed = 0;
      for (const t of ["production", "wellbores", "wells"]) {
        const r = await tx.query<{ n: number }>(`WITH d AS (DELETE FROM sonris.${t} WHERE dataset = $1 RETURNING 1) SELECT count(*)::int AS n FROM d`, [ds.key]);
        removed += Number(r[0]?.n ?? 0);
      }
      for (const rows of batches(ds.wells, WELL_BATCH)) { const q = buildWellInsert(rows, ds); await tx.execute(q.sql, q.params); }
      for (const rows of batches(ds.bores, BORE_BATCH)) { const q = buildBoreInsert(rows, ds); await tx.execute(q.sql, q.params); }
      for (const rows of batches(ds.production, PROD_BATCH)) { const q = buildProductionInsert(rows, ds); await tx.execute(q.sql, q.params); }
      const kept = ds.wells.length + ds.bores.length + ds.production.length;
      // Rows the previous version had that this one doesn't (0 on a first load).
      return Math.max(0, removed - kept);
    },
  });
}

// ---------------------------------------------------------------------------
// Readiness — routes only query sonris.* once it is known to exist, so a
// database without it (dev, or the first instants of a first boot) serves
// Texas exactly as before instead of erroring.
// ---------------------------------------------------------------------------

let ready = false;
/** True once sonris.* is present (this process loaded it or found it current). */
export function sonrisWellsAvailable(): boolean { return ready; }
/** For tests and scripts that prepare the schema themselves. */
export function setSonrisWellsAvailable(v: boolean): void { ready = v; }

/**
 * Startup entry point (server/src/index.ts). Resolves true when the sonris
 * tables became queryable — the caller then drops the tile/reference caches
 * so nothing served before the load outlives it.
 */
export async function ensureSonrisWells(): Promise<boolean> {
  const file = regionDataPath(import.meta.url, LA_WELLS_DATASET_FILE);
  if (!fs.existsSync(file)) {
    console.warn(`[gis] ${LA_WELLS_DATASET_KEY}: bundled dataset not found (${file}) — skipped`);
    return false;
  }
  const ds = parseLaWellDataset(zlib.gunzipSync(fs.readFileSync(file)));
  const r = await loadLaWellDataset(prismaRunner, ds);
  if (r.status === "no-gis") {
    console.log(`[gis] ${ds.key}: gis.counties/gis.abstracts not present — skipped`);
    return false;
  }
  if (r.status === "current") console.log(`[gis] ${ds.key}@${ds.version}: up to date (${r.wells} wells, ${r.bores} bores, ${r.production} production rows)`);
  else console.log(`[gis] ${ds.key}@${ds.version}: loaded ${r.wells} wells, ${r.bores} bores, ${r.production} production rows${r.pruned ? `, removed ${r.pruned} stale rows` : ""}`);
  ready = true;
  return true;
}
