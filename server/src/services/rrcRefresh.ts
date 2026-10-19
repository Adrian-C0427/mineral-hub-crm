/**
 * Boot-time loader for the bundled Texas RRC refresh (server/data/rrc/*,
 * built offline by scripts/buildRrcRefresh.ts) — the same versioned,
 * advisory-locked, single-transaction mechanism as the Louisiana data
 * (services/gisRegions.ts loadVersionedDataset): a gis.dataset_version marker
 * per bundle, so each loads exactly once per content version and every later
 * boot is a cheap no-op.
 *
 * What a load does, per bundle (each in ONE transaction — all or nothing):
 *
 *  wells      Upserts every surface well of the refreshed counties. Status
 *             and its evidence always take the new snapshot; descriptive
 *             attributes (lease, operator, field, dates, cums…) only replace
 *             a stored value when the snapshot has one — a gap in RRC's file
 *             never erases good data. Wells RRC no longer lists (its county
 *             layer is a complete snapshot) are copied whole into
 *             rrc.retired_wells and removed — except any a saved Research
 *             well links to (ResearchWell.sourceRef = fid), which stay,
 *             flagged. Deviated wellbores are replaced from the snapshot
 *             (nothing in the CRM references them). Status history is
 *             appended (never rewritten), including the status each well
 *             showed before its first refresh. Sources + as-of dates go to
 *             rrc.source_snapshot; the counts to rrc.refresh_log.
 *  abstracts  Upserts the counties' abstract polygons (rebuilt from RRC's
 *             survey layer). Stale Texas abstracts there are archived to
 *             gis.abstracts_retired and removed — except any a deal's
 *             abstractIds reference, which stay. Then re-attributes the
 *             counties' wells to abstracts.
 *  production Upserts the newest months of lease production on its natural
 *             key. Never deletes; older history is untouched.
 *
 * Production data is only ever changed here, by the deploy of a reviewed
 * bundle — never by hand.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { batches, loadVersionedDataset, prismaRunner, type GisDb, type GisDbRunner, type VersionedLoadResult } from "./gisRegions.js";
import {
  ABSTRACTS_DATASET, PRODUCTION_DATASET, WELLS_DATASET, parseAbstractsDataset, parseProductionDataset, parseWellsDataset,
  type AbstractsDataset, type ProductionDataset, type WellsDataset,
} from "../ingest/refresh/dataset.js";
import { LEGACY_STATUS, STATUS_CATEGORY } from "../domain/wellStatus.js";

export function rrcDataPath(moduleUrl: string, file: string): string {
  // src/services → server/data/rrc (dist/services resolves the same way).
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../../data/rrc", file);
}

// ---------------------------------------------------------------------------
// DDL — additive only (new columns / tables; nothing dropped or retyped)
// ---------------------------------------------------------------------------

const REFRESH_LOG_DDL = `CREATE TABLE IF NOT EXISTS rrc.refresh_log (
     id              serial PRIMARY KEY,
     dataset         text NOT NULL,
     dataset_version text NOT NULL,
     counts          jsonb NOT NULL,
     summary         jsonb,
     loaded_at       timestamptz NOT NULL DEFAULT now()
   )`;

export const WELLS_DDL: readonly string[] = [
  ...[
    "profile text", "status_detail text", "status_flag text", "status_note text", "status_source text",
    "status_since date", "status_as_of date", "admin_status text", "permit_no text", "permit_date date",
    "permit_expires date", "completion_date date", "shut_in_date date", "injection_type text",
    "location_flag text", "location_note text", "geom_flag text", "sources jsonb", "refreshed_at timestamptz",
    "unit_acres numeric(10,2)", "unit_acres_source text", "assigned_acres numeric(10,3)", "assigned_acres_ym text",
  ].map((c) => `ALTER TABLE rrc.wells ADD COLUMN IF NOT EXISTS ${c}`),
  ...[
    "api8 text", "status text", "status_detail text", "bh_geom geometry(Point, 4326)", "bh_source text",
    "line_source text", "approximate boolean", "geom_flag text", "bh_planned boolean",
  ].map((c) => `ALTER TABLE rrc.wellbores ADD COLUMN IF NOT EXISTS ${c}`),
  `CREATE INDEX IF NOT EXISTS wellbores_bh_gist ON rrc.wellbores USING GIST (bh_geom)`,
  `CREATE INDEX IF NOT EXISTS wellbores_county_idx ON rrc.wellbores (county)`,
  `CREATE TABLE IF NOT EXISTS rrc.well_status_history (
     fid             integer NOT NULL,
     api8            text,
     event           text NOT NULL,          -- permit-issued | spud | completed | shut-in | plugged | status-refresh | previous-status
     event_date      date,                   -- null when RRC records no date
     status          text,
     detail          text,
     source          text NOT NULL,          -- rrc.source_snapshot id (or map-symbol / rrc-refresh)
     dataset_version text,
     recorded_at     timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS well_status_history_uniq ON rrc.well_status_history
     (fid, event, coalesce(event_date, '0001-01-01'::date), source, coalesce(status, ''), coalesce(detail, ''))`,
  `CREATE INDEX IF NOT EXISTS well_status_history_api8_idx ON rrc.well_status_history (api8)`,
  `CREATE TABLE IF NOT EXISTS rrc.retired_wells (
     fid             integer NOT NULL,
     county          text,
     row             jsonb NOT NULL,         -- the full rrc.wells row as it was (geometry as GeoJSON)
     reason          text NOT NULL,
     dataset_version text NOT NULL,
     retired_at      timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS rrc.source_snapshot (
     id              text NOT NULL,
     dataset_version text NOT NULL,
     name            text,
     file            text,
     as_of           date,
     loaded_at       timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (id, dataset_version)
   )`,
  REFRESH_LOG_DDL,
  // rrc.permits (created by the ingest pipeline; created here too for a fresh database).
  `CREATE TABLE IF NOT EXISTS rrc.permits (
     status_no text NOT NULL, api8 text NOT NULL, county text NOT NULL, district text, lease_name text,
     well_no text, operator text, operator_no text, permit_date date, acres numeric(8,2), survey text, abstract text,
     PRIMARY KEY (status_no, api8)
   )`,
  ...["issued_date date", "spud_date date", "expires_date date", "cancelled_date date", "horizontal boolean", "app_status text"]
    .map((c) => `ALTER TABLE rrc.permits ADD COLUMN IF NOT EXISTS ${c}`),
  `CREATE INDEX IF NOT EXISTS permits_api8_idx ON rrc.permits (api8)`,
];

export const ABSTRACTS_DDL: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS rrc`,
  REFRESH_LOG_DDL,
  `CREATE TABLE IF NOT EXISTS gis.abstracts_retired (
     id              text NOT NULL,
     row             jsonb NOT NULL,
     reason          text NOT NULL,
     dataset_version text NOT NULL,
     retired_at      timestamptz NOT NULL DEFAULT now()
   )`,
];

export const PRODUCTION_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rrc.production (
     og_code text NOT NULL, district text NOT NULL, lease_no text NOT NULL,
     cycle_ym integer NOT NULL, county text NOT NULL,
     operator_no text, field_no text, gas_well_no text NOT NULL DEFAULT '',
     oil_bbl integer NOT NULL DEFAULT 0, gas_mcf integer NOT NULL DEFAULT 0,
     cond_bbl integer NOT NULL DEFAULT 0, csgd_mcf integer NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS production_natural_key ON rrc.production (og_code, district, lease_no, gas_well_no, cycle_ym)`,
  `CREATE INDEX IF NOT EXISTS production_lease_idx ON rrc.production (og_code, district, lease_no, cycle_ym)`,
  `CREATE INDEX IF NOT EXISTS production_county_ym_idx ON rrc.production (county, cycle_ym)`,
];

// ---------------------------------------------------------------------------
// Statement builders (pure — exercised in rrcRefresh.test.ts)
// ---------------------------------------------------------------------------

/** Columns written from the bundle; `mode` says how a conflict resolves. */
const WELL_COLUMNS: { col: string; key: keyof WellsDataset["wells"][number] | null; cast?: string; mode: "replace" | "keep-if-null" }[] = [
  { col: "fid", key: "fid", mode: "replace" },
  { col: "api8", key: "api8", mode: "keep-if-null" },
  { col: "api10", key: "api10", mode: "keep-if-null" },
  { col: "well_no", key: "wellNo", mode: "keep-if-null" },
  { col: "well_id", key: "wellId", mode: "keep-if-null" },
  { col: "symbol", key: "symbol", mode: "replace" },
  { col: "type", key: "type", mode: "replace" },
  { col: "status", key: "status", mode: "replace" },
  { col: "category", key: "category", mode: "replace" },
  { col: "county", key: "county", mode: "replace" },
  { col: "district", key: "district", mode: "keep-if-null" },
  { col: "lease_no", key: "leaseNo", mode: "keep-if-null" },
  { col: "lease_name", key: "leaseName", mode: "keep-if-null" },
  { col: "operator", key: "operator", mode: "keep-if-null" },
  { col: "operator_no", key: "operatorNo", mode: "keep-if-null" },
  { col: "field_no", key: "fieldNo", mode: "keep-if-null" },
  { col: "field_name", key: "fieldName", mode: "keep-if-null" },
  { col: "oil_gas", key: "oilGas", mode: "keep-if-null" },
  { col: "formations", key: "formations", cast: "text[]", mode: "keep-if-null" },
  { col: "spud_date", key: "spudDate", cast: "date", mode: "keep-if-null" },
  // Status-bound dates: a well that isn't plugged / shut in has none.
  { col: "plug_date", key: "plugDate", cast: "date", mode: "replace" },
  { col: "shut_in_date", key: "shutInDate", cast: "date", mode: "replace" },
  { col: "cum_oil", key: "cumOil", cast: "float8", mode: "keep-if-null" },
  { col: "cum_gas", key: "cumGas", cast: "float8", mode: "keep-if-null" },
  { col: "last_prod", key: "lastProd", mode: "keep-if-null" },
  { col: "profile", key: "profile", mode: "replace" },
  { col: "status_detail", key: "statusDetail", mode: "replace" },
  { col: "status_flag", key: "statusFlag", mode: "replace" },
  { col: "status_note", key: "statusNote", mode: "replace" },
  { col: "status_source", key: "statusSource", mode: "replace" },
  { col: "status_since", key: "statusSince", cast: "date", mode: "replace" },
  { col: "admin_status", key: "adminStatus", mode: "replace" },
  { col: "permit_no", key: "permitNo", mode: "keep-if-null" },
  { col: "permit_date", key: "permitDate", cast: "date", mode: "keep-if-null" },
  { col: "permit_expires", key: "permitExpires", cast: "date", mode: "keep-if-null" },
  { col: "completion_date", key: "completionDate", cast: "date", mode: "keep-if-null" },
  { col: "injection_type", key: "injectionType", mode: "replace" },
  { col: "unit_acres", key: "unitAcres", cast: "numeric", mode: "keep-if-null" },
  { col: "unit_acres_source", key: "unitAcresSource", mode: "keep-if-null" },
  // Current proration acreage: a well off the schedule has none.
  { col: "assigned_acres", key: "assignedAcres", cast: "numeric", mode: "replace" },
  { col: "assigned_acres_ym", key: "assignedAcresYm", mode: "replace" },
  { col: "location_flag", key: "locationFlag", mode: "replace" },
  { col: "location_note", key: "locationNote", mode: "replace" },
  { col: "geom_flag", key: "geomFlag", mode: "replace" },
  { col: "sources", key: "sources", cast: "jsonb", mode: "replace" },
];

export function buildWellUpsert(rows: WellsDataset["wells"], asOf: string): { sql: string; params: unknown[] } {
  const n = WELL_COLUMNS.length + 1; // + geom
  const params: unknown[] = [];
  const values = rows.map((w, j) => {
    const ph = WELL_COLUMNS.map((c, k) => {
      const v = c.key ? w[c.key] : null;
      params.push(c.cast === "jsonb" ? JSON.stringify(v) : v ?? null);
      return `$${j * n + k + 1}${c.cast ? `::${c.cast}` : ""}`;
    });
    params.push(JSON.stringify({ type: "Point", coordinates: [w.lon, w.lat] }));
    return `(${ph.join(", ")}, '${asOf}'::date, now(), ST_SetSRID(ST_GeomFromGeoJSON($${j * n + n}), 4326))`;
  });
  const set = WELL_COLUMNS.filter((c) => c.col !== "fid").map((c) =>
    c.mode === "replace" ? `${c.col} = EXCLUDED.${c.col}` : `${c.col} = COALESCE(EXCLUDED.${c.col}, rrc.wells.${c.col})`);
  return {
    sql: `INSERT INTO rrc.wells (${WELL_COLUMNS.map((c) => c.col).join(", ")}, status_as_of, refreshed_at, geom)
          VALUES ${values.join(", ")}
          ON CONFLICT (fid) DO UPDATE SET ${set.join(", ")},
            status_as_of = EXCLUDED.status_as_of, refreshed_at = EXCLUDED.refreshed_at, geom = EXCLUDED.geom`,
    params,
  };
}

export function buildBoreInsert(rows: WellsDataset["bores"]): { sql: string; params: unknown[] } {
  const n = 16;
  const params: unknown[] = [];
  const values = rows.map((b, j) => {
    params.push(
      b.fid, b.surfaceFid, b.api10, b.profile, b.stcode, b.county, JSON.stringify({ type: "LineString", coordinates: b.path }),
      b.api8, b.status, b.statusDetail, JSON.stringify({ type: "Point", coordinates: b.bh }), b.bhSource, b.lineSource, b.approximate, b.geomFlag,
      b.planned ?? false,
    );
    const p = (k: number) => `$${j * n + k}`;
    return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ST_SetSRID(ST_GeomFromGeoJSON(${p(7)}), 4326), ${p(8)}, ${p(9)}, ${p(10)},
             ST_SetSRID(ST_GeomFromGeoJSON(${p(11)}), 4326), ${p(12)}, ${p(13)}, ${p(14)}::boolean, ${p(15)}, ${p(16)}::boolean)`;
  });
  return {
    sql: `INSERT INTO rrc.wellbores (fid, surface_fid, api10, wellbore_type, stcode, county, geom, api8, status, status_detail, bh_geom, bh_source, line_source, approximate, geom_flag, bh_planned)
          VALUES ${values.join(", ")}
          ON CONFLICT (fid) DO UPDATE SET surface_fid = EXCLUDED.surface_fid, api10 = EXCLUDED.api10, wellbore_type = EXCLUDED.wellbore_type,
            stcode = EXCLUDED.stcode, county = EXCLUDED.county, geom = EXCLUDED.geom, api8 = EXCLUDED.api8, status = EXCLUDED.status,
            status_detail = EXCLUDED.status_detail, bh_geom = EXCLUDED.bh_geom, bh_source = EXCLUDED.bh_source,
            line_source = EXCLUDED.line_source, approximate = EXCLUDED.approximate, geom_flag = EXCLUDED.geom_flag,
            bh_planned = EXCLUDED.bh_planned`,
    params,
  };
}

export function buildHistoryInsert(rows: WellsDataset["history"], version: string): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const values = rows.map((h, j) => {
    params.push(h.fid, h.api8, h.event, h.date, h.status, h.detail, h.source);
    const b = j * 7;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::date, $${b + 5}, $${b + 6}, $${b + 7}, '${version}')`;
  });
  return {
    sql: `INSERT INTO rrc.well_status_history (fid, api8, event, event_date, status, detail, source, dataset_version)
          VALUES ${values.join(", ")} ON CONFLICT DO NOTHING`,
    params,
  };
}

const PERMIT_COLS = [
  ["status_no", "statusNo"], ["api8", "api8"], ["county", "county"], ["district", "district"], ["lease_name", "leaseName"],
  ["well_no", "wellNo"], ["operator", "operator"], ["operator_no", "operatorNo"], ["permit_date", "permitDate"],
  ["acres", "acres"], ["survey", "survey"], ["abstract", "abstract"], ["issued_date", "issuedDate"], ["spud_date", "spudDate"],
  ["expires_date", "expiresDate"], ["cancelled_date", "cancelledDate"], ["horizontal", "horizontal"], ["app_status", "appStatus"],
] as const;
const PERMIT_CASTS: Record<string, string> = { permit_date: "date", acres: "numeric", issued_date: "date", spud_date: "date", expires_date: "date", cancelled_date: "date", horizontal: "boolean" };

export function buildPermitUpsert(rows: WellsDataset["permits"]): { sql: string; params: unknown[] } {
  const n = PERMIT_COLS.length;
  const params: unknown[] = [];
  const values = rows.map((r, j) => `(${PERMIT_COLS.map(([col, key], k) => {
    params.push(r[key] ?? null);
    return `$${j * n + k + 1}${PERMIT_CASTS[col] ? `::${PERMIT_CASTS[col]}` : ""}`;
  }).join(", ")})`);
  const upd = PERMIT_COLS.filter(([c]) => c !== "status_no" && c !== "api8").map(([c]) => `${c} = COALESCE(EXCLUDED.${c}, rrc.permits.${c})`);
  return {
    sql: `INSERT INTO rrc.permits (${PERMIT_COLS.map(([c]) => c).join(", ")}) VALUES ${values.join(", ")}
          ON CONFLICT (status_no, api8) DO UPDATE SET ${upd.join(", ")}`,
    params,
  };
}

export function buildAbstractUpsert(rows: AbstractsDataset["abstracts"]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const values = rows.map((a, j) => {
    params.push(a.id, a.countyFips, a.county, a.abstract, a.survey, a.area, JSON.stringify({ type: "MultiPolygon", coordinates: a.geom }));
    const b = j * 7;
    return `($${b + 1}, 'TX', $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::float8, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($${b + 7}), 4326)))`;
  });
  return {
    sql: `INSERT INTO gis.abstracts (id, state, county_fips, county, abstract, survey, area_m2, geom) VALUES ${values.join(", ")}
          ON CONFLICT (id) DO UPDATE SET county_fips = EXCLUDED.county_fips, county = EXCLUDED.county, abstract = EXCLUDED.abstract,
            survey = EXCLUDED.survey, area_m2 = EXCLUDED.area_m2, geom = EXCLUDED.geom
          WHERE gis.abstracts.state = 'TX'`,
    params,
  };
}

export function buildProductionUpsert(rows: ProductionDataset["rows"]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const values = rows.map((r, j) => {
    params.push(...r);
    const b = j * 12;
    return `(${Array.from({ length: 12 }, (_, k) => `$${b + k + 1}${k === 3 || k >= 8 ? "::int" : ""}`).join(", ")})`;
  });
  return {
    sql: `INSERT INTO rrc.production (og_code, district, lease_no, cycle_ym, county, operator_no, field_no, gas_well_no, oil_bbl, gas_mcf, cond_bbl, csgd_mcf)
          VALUES ${values.join(", ")}
          ON CONFLICT (og_code, district, lease_no, gas_well_no, cycle_ym) DO UPDATE SET
            county = EXCLUDED.county, operator_no = EXCLUDED.operator_no, field_no = EXCLUDED.field_no,
            oil_bbl = EXCLUDED.oil_bbl, gas_mcf = EXCLUDED.gas_mcf, cond_bbl = EXCLUDED.cond_bbl, csgd_mcf = EXCLUDED.csgd_mcf`,
    params,
  };
}

/**
 * Any Texas well still holding a pre-2026-10 status (one kept only because the
 * CRM links to it, or a county outside a refresh) moves to the normalized
 * vocabulary, so the map's filters and colors see one set of statuses.
 */
export const NORMALIZE_LEGACY_STATUS_SQL = `
  UPDATE rrc.wells SET
    status = CASE status ${Object.entries(LEGACY_STATUS).map(([k, v]) => `WHEN '${k.replace(/'/g, "''")}' THEN '${v}'`).join(" ")} END,
    category = CASE status ${Object.entries(LEGACY_STATUS).map(([k, v]) => `WHEN '${k.replace(/'/g, "''")}' THEN '${STATUS_CATEGORY[v]}'`).join(" ")} END
  WHERE status IN (${Object.keys(LEGACY_STATUS).map((k) => `'${k.replace(/'/g, "''")}'`).join(", ")})`;

/**
 * Point every well of the counties at the abstract containing it (smallest
 * first where survey polygons overlap at a shared line) — or at none.
 */
export const ATTRIBUTE_WELLS_SQL = `
  UPDATE rrc.wells w SET (abstract_id, abstract, survey) = (
    SELECT a.id, a.abstract, a.survey FROM gis.abstracts a
     WHERE a.state = 'TX' AND a.geom && w.geom AND ST_Intersects(a.geom, w.geom)
     ORDER BY a.area_m2 ASC NULLS LAST, a.id LIMIT 1)
   WHERE w.county = ANY($1::text[])`;

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

export type WellsCounts = { wells: number; bores: number };
export type AbstractsCounts = { abstracts: number };
export type ProductionCounts = { rows: number };

async function tableExists(db: GisDb, name: string): Promise<boolean> {
  const [r] = await db.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [name]);
  return !!r?.ok;
}

export async function loadRrcWells(db: GisDbRunner, ds: WellsDataset): Promise<VersionedLoadResult<WellsCounts>> {
  const counties = ds.counties.map((c) => c.name);
  const fids = ds.wells.map((w) => w.fid);
  const boreFids = ds.bores.map((b) => b.fid);
  const asOf = ds.sources.find((s) => s.id === "wellbore-query")?.asOf ?? ds.builtAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`rrc wells dataset: bad as-of date ${asOf}`);
  return loadVersionedDataset<WellsCounts>(db, {
    key: ds.key,
    version: ds.version,
    requires: ["rrc.wells", "rrc.wellbores"],
    ddl: WELLS_DDL,
    expected: { wells: ds.wells.length, bores: ds.bores.length },
    async present(q) {
      const [c] = await q.query<{ wells: number; bores: number }>(
        `SELECT (SELECT count(*)::int FROM rrc.wells WHERE fid = ANY($1::int[]) AND refreshed_at IS NOT NULL) AS wells,
                (SELECT count(*)::int FROM rrc.wellbores WHERE fid = ANY($2::int[]) AND bh_geom IS NOT NULL) AS bores`,
        [fids, boreFids],
      );
      return { wells: Number(c?.wells ?? 0), bores: Number(c?.bores ?? 0) };
    },
    async write(tx) {
      // The state before this load: what each well showed, and whether it had ever been refreshed.
      await tx.execute(`CREATE TEMP TABLE _rrc_prev ON COMMIT DROP AS
                          SELECT fid, status, refreshed_at FROM rrc.wells WHERE county = ANY($1::text[])`, [counties]);
      for (const rows of batches(ds.wells, 250)) {
        const q = buildWellUpsert(rows, asOf);
        await tx.execute(q.sql, q.params);
      }

      // Wells the complete snapshot no longer has: archive + remove, unless the CRM links to them.
      const research = await tableExists(tx, `public."ResearchWell"`);
      const linked = research
        ? `EXISTS (SELECT 1 FROM "ResearchWell" r WHERE r.source = 'rrc' AND r."sourceRef" = w.fid::text)`
        : "false";
      const kept = await tx.query<{ n: number }>(
        `WITH k AS (
           UPDATE rrc.wells w SET status_flag = 'retired-in-source',
             status_note = 'No longer in RRC''s well layer (snapshot ' || $3 || '); kept because a saved research well links to it.'
            WHERE w.county = ANY($1::text[]) AND NOT (w.fid = ANY($2::int[])) AND ${linked}
            RETURNING 1)
         SELECT count(*)::int AS n FROM k`, [counties, fids, asOf]);
      await tx.execute(
        `INSERT INTO rrc.retired_wells (fid, county, row, reason, dataset_version)
         SELECT w.fid, w.county, (to_jsonb(w) - 'geom') || jsonb_build_object('geom', ST_AsGeoJSON(w.geom)::jsonb),
                'Not in RRC''s well layer snapshot ' || $3, $4
           FROM rrc.wells w
          WHERE w.county = ANY($1::text[]) AND NOT (w.fid = ANY($2::int[])) AND NOT ${linked}`,
        [counties, fids, asOf, ds.version]);
      const retired = await tx.query<{ n: number }>(
        `WITH d AS (DELETE FROM rrc.wells w WHERE w.county = ANY($1::text[]) AND NOT (w.fid = ANY($2::int[])) AND NOT ${linked} RETURNING 1)
         SELECT count(*)::int AS n FROM d`, [counties, fids]);

      // Wellbores: the snapshot replaces the counties' set.
      const boresRemoved = await tx.query<{ n: number }>(
        `WITH d AS (DELETE FROM rrc.wellbores WHERE county = ANY($1::text[]) RETURNING 1) SELECT count(*)::int AS n FROM d`, [counties]);
      for (const rows of batches(ds.bores, 300)) {
        const q = buildBoreInsert(rows);
        await tx.execute(q.sql, q.params);
      }

      // History: RRC's dated events, this refresh, and what wells showed before their first refresh.
      for (const rows of batches(ds.history, 500)) {
        const q = buildHistoryInsert(rows, ds.version);
        await tx.execute(q.sql, q.params);
      }
      await tx.execute(
        `INSERT INTO rrc.well_status_history (fid, api8, event, event_date, status, detail, source, dataset_version)
         SELECT w.fid, w.api8, 'previous-status', NULL, p.status,
                'Shown before the first RRC status refresh (from the RRC map symbol)', 'map-symbol', $2
           FROM _rrc_prev p JOIN rrc.wells w ON w.fid = p.fid
          WHERE p.refreshed_at IS NULL AND p.status IS DISTINCT FROM w.status AND w.fid = ANY($1::int[])
         ON CONFLICT DO NOTHING`, [fids, ds.version]);

      for (const rows of batches(ds.permits, 400)) {
        const q = buildPermitUpsert(rows);
        await tx.execute(q.sql, q.params);
      }
      for (const s of ds.sources) {
        await tx.execute(
          `INSERT INTO rrc.source_snapshot (id, dataset_version, name, file, as_of) VALUES ($1, $2, $3, $4, $5::date)
           ON CONFLICT (id, dataset_version) DO UPDATE SET name = EXCLUDED.name, file = EXCLUDED.file, as_of = EXCLUDED.as_of`,
          [s.id, ds.version, s.name, s.file, s.asOf]);
      }
      if (await tableExists(tx, "gis.abstracts")) await tx.execute(ATTRIBUTE_WELLS_SQL, [counties]);
      await tx.execute(NORMALIZE_LEGACY_STATUS_SQL);

      const [c] = await tx.query<{ inserted: number; updated: number; changed: number }>(
        `SELECT count(*) FILTER (WHERE p.fid IS NULL)::int AS inserted,
                count(*) FILTER (WHERE p.fid IS NOT NULL)::int AS updated,
                count(*) FILTER (WHERE p.fid IS NOT NULL AND p.status IS DISTINCT FROM w.status)::int AS changed
           FROM rrc.wells w LEFT JOIN _rrc_prev p ON p.fid = w.fid WHERE w.fid = ANY($1::int[])`, [fids]);
      const counts = {
        wells: ds.wells.length, inserted: c?.inserted ?? 0, updated: c?.updated ?? 0, statusChanged: c?.changed ?? 0,
        retired: retired[0]?.n ?? 0, keptLinked: kept[0]?.n ?? 0,
        boresRemoved: boresRemoved[0]?.n ?? 0, boresLoaded: ds.bores.length, historyRows: ds.history.length, permits: ds.permits.length,
      };
      await tx.execute(`INSERT INTO rrc.refresh_log (dataset, dataset_version, counts, summary) VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
        [ds.key, ds.version, JSON.stringify(counts), JSON.stringify(ds.summary)]);
      console.log(`[rrc] ${ds.key}@${ds.version}: ${JSON.stringify(counts)}`);
      return counts.retired;
    },
  });
}

export async function loadRrcAbstracts(db: GisDbRunner, ds: AbstractsDataset): Promise<VersionedLoadResult<AbstractsCounts>> {
  const counties = ds.counties.map((c) => c.name);
  const codes = ds.counties.map((c) => c.code);
  const ids = ds.abstracts.map((a) => a.id);
  return loadVersionedDataset<AbstractsCounts>(db, {
    key: ds.key,
    version: ds.version,
    requires: ["gis.abstracts"],
    ddl: ABSTRACTS_DDL,
    expected: { abstracts: ds.abstracts.length },
    async present(q) {
      const [c] = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM gis.abstracts WHERE state = 'TX' AND id = ANY($1::text[])`, [ids]);
      return { abstracts: Number(c?.n ?? 0) };
    },
    async write(tx) {
      for (const rows of batches(ds.abstracts, 150)) {
        const q = buildAbstractUpsert(rows);
        await tx.execute(q.sql, q.params);
      }
      // Stale abstracts of these counties: archive + remove, unless a deal references them.
      const deals = await tableExists(tx, `public."Deal"`);
      const referenced = deals ? `EXISTS (SELECT 1 FROM "Deal" d WHERE a.id = ANY(d."abstractIds"))` : "false";
      const stale = `a.state = 'TX' AND a.county_fips = ANY($1::text[]) AND a.county = ANY($2::text[]) AND NOT (a.id = ANY($3::text[]))`;
      const [kept] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM gis.abstracts a WHERE ${stale} AND ${referenced}`, [codes, counties, ids]);
      await tx.execute(
        `INSERT INTO gis.abstracts_retired (id, row, reason, dataset_version)
         SELECT a.id, (to_jsonb(a) - 'geom') || jsonb_build_object('geom', ST_AsGeoJSON(a.geom)::jsonb),
                'Not in RRC''s survey layer snapshot ' || $4, $5
           FROM gis.abstracts a WHERE ${stale} AND NOT ${referenced}`, [codes, counties, ids, ds.source.asOf, ds.version]);
      const [gone] = await tx.query<{ n: number }>(
        `WITH d AS (DELETE FROM gis.abstracts a WHERE ${stale} AND NOT ${referenced} RETURNING 1) SELECT count(*)::int AS n FROM d`,
        [codes, counties, ids]);
      if (await tableExists(tx, "rrc.wells")) await tx.execute(ATTRIBUTE_WELLS_SQL, [counties]);
      if (await tableExists(tx, "rrc.refresh_log")) {
        await tx.execute(`INSERT INTO rrc.refresh_log (dataset, dataset_version, counts) VALUES ($1, $2, $3::jsonb)`,
          [ds.key, ds.version, JSON.stringify({ abstracts: ds.abstracts.length, retired: gone?.n ?? 0, keptReferenced: kept?.n ?? 0 })]);
      }
      console.log(`[rrc] ${ds.key}@${ds.version}: ${ds.abstracts.length} abstracts, retired ${gone?.n ?? 0}, kept ${kept?.n ?? 0} (deal-referenced)`);
      return gone?.n ?? 0;
    },
  });
}

export async function loadRrcProduction(db: GisDbRunner, ds: ProductionDataset): Promise<VersionedLoadResult<ProductionCounts>> {
  const cols = [0, 1, 2, 7, 3].map((i) => ds.rows.map((r) => r[i]));
  return loadVersionedDataset<ProductionCounts>(db, {
    key: ds.key,
    version: ds.version,
    requires: ["rrc.wells"],
    ddl: PRODUCTION_DDL,
    expected: { rows: ds.rows.length },
    async present(q) {
      const [c] = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM rrc.production p
           JOIN unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[]) AS k(og, d, l, gw, ym)
             ON p.og_code = k.og AND p.district = k.d AND p.lease_no = k.l AND p.gas_well_no = k.gw AND p.cycle_ym = k.ym`,
        cols);
      return { rows: Number(c?.n ?? 0) };
    },
    async write(tx) {
      for (const rows of batches(ds.rows, 1000)) {
        const q = buildProductionUpsert(rows);
        await tx.execute(q.sql, q.params);
      }
      if (await tableExists(tx, "rrc.refresh_log")) {
        await tx.execute(`INSERT INTO rrc.refresh_log (dataset, dataset_version, counts) VALUES ($1, $2, $3::jsonb)`,
          [ds.key, ds.version, JSON.stringify({ rows: ds.rows.length, fromYm: ds.fromYm, toYm: ds.toYm })]);
      }
      console.log(`[rrc] ${ds.key}@${ds.version}: upserted ${ds.rows.length} production rows (${ds.fromYm}–${ds.toYm})`);
      return 0;
    },
  });
}

// Whether this database has the refresh's columns/tables (the wells DDL ran):
// gates the tile layers and panel queries that read them (routes/gis.ts).
let available = false;
export function rrcRefreshAvailable(): boolean { return available; }
export function setRrcRefreshAvailable(v: boolean): void { available = v; }

/**
 * Startup entry point (server/src/index.ts): abstracts first (the wells load
 * attributes wells to them), then wells, then production. Resolves true when
 * any bundle wrote rows or the refreshed columns just became readable (tiles
 * cached before that lack the bottom-hole layer) — the caller then drops the
 * tile/reference caches.
 */
export async function ensureRrcRefresh(runner: GisDbRunner = prismaRunner): Promise<boolean> {
  let wrote = false;
  const read = (file: string) => {
    const p = rrcDataPath(import.meta.url, file);
    return fs.existsSync(p) ? zlib.gunzipSync(fs.readFileSync(p)) : null;
  };
  const report = <C extends Record<string, number>>(key: string, version: string, r: VersionedLoadResult<C>) => {
    if (r.status === "no-gis") console.log(`[rrc] ${key}: required tables absent — skipped`);
    else if (r.status === "current") console.log(`[rrc] ${key}@${version}: up to date`);
    else wrote = true;
  };
  const abs = read(ABSTRACTS_DATASET.file);
  if (abs) { const ds = parseAbstractsDataset(abs); report(ds.key, ds.version, await loadRrcAbstracts(runner, ds)); }
  const wells = read(WELLS_DATASET.file);
  if (wells) {
    const ds = parseWellsDataset(wells);
    const r = await loadRrcWells(runner, ds);
    if (r.status !== "no-gis") available = true;
    report(ds.key, ds.version, r);
  }
  const prod = read(PRODUCTION_DATASET.file);
  if (prod) { const ds = parseProductionDataset(prod); report(ds.key, ds.version, await loadRrcProduction(runner, ds)); }
  return wrote || available;
}
