/**
 * B2 of the RRC import: wells + wellbore laterals into PostGIS.
 *
 * Inputs (produced by the tools/rrc pipeline — see tools/rrc/README.md):
 *   tools/rrc/work12/data/{county}-wells.geojson      built by build_wells.py
 *                                                     then enriched by enrich_wells.py
 *   tools/rrc/work12/data/{county}-wellbores.geojson  built by build_wells.py
 *   tools/rrc/work12/dbf900_parsed.json               per-API wellbore-master data
 *                                                     (spud/plug dates, W-10 field no)
 *
 * After loading, abstract/survey attribution is a PostGIS spatial join against
 * gis.abstracts (point-in-polygon), and field names resolve from rrc.fields —
 * both run here, not in the Python pipeline.
 *
 * Idempotent: wells/wellbores are replaced per county on re-run.
 *
 * Usage: npx tsx src/scripts/importRrcWells.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";
import { ensureWellSearchIndexes } from "./ensureSearchIndexes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATA = path.join(ROOT, "tools/rrc/work12/data");
const DBF900 = path.join(ROOT, "tools/rrc/work12/dbf900_parsed.json");

const COUNTIES = [
  "leon", "freestone", "anderson", "angelina", "cherokee", "houston",
  "limestone", "madison", "panola", "robertson", "sanaugustine", "shelby",
];

interface WellProps {
  fid: number; api8?: string; api?: string; wellNo?: string; wellId?: string;
  symbol?: string; type?: string; status?: string; category?: string; county?: string;
  leaseNo?: string; oilGas?: string; district?: string; operator?: string; operatorNo?: string;
  leaseName?: string; field?: string; formations?: string[];
  cumOil?: number | null; cumGas?: number | null; lastProd?: string | null;
}
interface Feature { properties: WellProps & Record<string, unknown>; geometry: { type: string; coordinates: unknown } }
interface Dbf900 { rootDate?: string; plugDate?: string; w10FieldNo?: string; wellNo?: string }

// RRC dates may carry month/day "00" (partial precision) — clamp to the 1st.
const rrcDate = (s?: string): string | null => {
  if (!s || !/^\d{8}$/.test(s) || s === "00000000") return null;
  const y = Number(s.slice(0, 4));
  const m = Math.min(Math.max(Number(s.slice(4, 6)), 1), 12);
  const d = Math.min(Math.max(Number(s.slice(6, 8)), 1), 28);
  if (y < 1850 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

async function ddl(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS rrc`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.wells (
      fid          integer PRIMARY KEY,       -- RRC map SURFACE_ID
      api8         text,                      -- 8-digit state API (county+seq)
      api10        text,                      -- "42" + api8
      well_no      text,
      well_id      text,
      symbol       text,
      type         text,
      status       text,
      category     text,
      county       text NOT NULL,
      district     text,
      lease_no     text,
      lease_name   text,
      operator     text,
      operator_no  text,
      field_no     text,
      field_name   text,
      oil_gas      text,
      formations   text[],
      spud_date    date,                      -- dbf900 root record date
      plug_date    date,
      cum_oil      double precision,
      cum_gas      double precision,
      last_prod    text,
      abstract_id  text,                      -- filled by spatial join
      abstract     text,
      survey       text,
      geom         geometry(Point, 4326) NOT NULL
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.wellbores (
      fid          integer PRIMARY KEY,       -- RRC map BOTTOM_ID (unique per lateral)
      surface_fid  integer NOT NULL,
      api10        text,
      wellbore_type text,
      stcode       text,
      county       text NOT NULL,
      geom         geometry(LineString, 4326) NOT NULL
    )`);
  for (const sql of [
    `CREATE INDEX IF NOT EXISTS wells_geom_gist ON rrc.wells USING GIST (geom)`,
    `CREATE INDEX IF NOT EXISTS wells_api8_idx ON rrc.wells (api8)`,
    `CREATE INDEX IF NOT EXISTS wells_county_idx ON rrc.wells (county)`,
    `CREATE INDEX IF NOT EXISTS wells_operator_idx ON rrc.wells (operator)`,
    `CREATE INDEX IF NOT EXISTS wells_status_idx ON rrc.wells (status)`,
    `CREATE INDEX IF NOT EXISTS wells_abstract_idx ON rrc.wells (abstract_id)`,
    `CREATE INDEX IF NOT EXISTS wells_lease_idx ON rrc.wells (district, lease_no)`,
    `CREATE INDEX IF NOT EXISTS wellbores_geom_gist ON rrc.wellbores USING GIST (geom)`,
    `CREATE INDEX IF NOT EXISTS wellbores_surface_idx ON rrc.wellbores (surface_fid)`,
  ]) await prisma.$executeRawUnsafe(sql);
  // Trigram/upper() indexes backing /wells/rrc-search and /gis/suggest. The
  // btrees above serve none of those predicates — without these, every search
  // seq-scans the table. See scripts/ensureSearchIndexes.ts.
  await ensureWellSearchIndexes();
}

async function importCounty(key: string, db900: Record<string, Dbf900>): Promise<[number, number]> {
  const wellsFC = JSON.parse(fs.readFileSync(path.join(DATA, `${key}-wells.geojson`), "utf8")) as { features: Feature[] };
  const boresFC = JSON.parse(fs.readFileSync(path.join(DATA, `${key}-wellbores.geojson`), "utf8")) as { features: Feature[] };
  const county = String(wellsFC.features[0]?.properties.county ?? key);

  await prisma.$executeRawUnsafe(`DELETE FROM rrc.wells WHERE county = $1`, county);
  await prisma.$executeRawUnsafe(`DELETE FROM rrc.wellbores WHERE county = $1`, county);

  const W = 24; // columns per wells row
  const BATCH = 200;
  const rows: unknown[][] = [];
  const seen = new Set<number>();
  for (const f of wellsFC.features) {
    const p = f.properties;
    if (seen.has(p.fid)) continue;
    seen.add(p.fid);
    const d = (p.api8 && db900[p.api8]) || {};
    rows.push([
      p.fid, p.api8 || null, p.api || null, p.wellNo || d.wellNo || null, p.wellId || null,
      p.symbol || null, p.type || null, p.status || null, p.category || null, county,
      p.district || null, p.leaseNo || null, p.leaseName || null,
      p.operator || null, p.operatorNo || null,
      d.w10FieldNo || null, (p.field as string) || null, p.oilGas || null,
      p.formations?.length ? p.formations : null,
      rrcDate(d.rootDate), rrcDate(d.plugDate),
      p.cumOil ?? null, p.cumGas ?? null, p.lastProd ?? null,
    ]);
  }
  const geomByFid = new Map(wellsFC.features.map((f) => [f.properties.fid, JSON.stringify(f.geometry)]));
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map((r, j) => {
      const base = j * (W + 1);
      // k 18 = formations text[], k 19/20 = spud/plug dates — cast explicitly.
      const params = Array.from({ length: W }, (_, k) =>
        `$${base + k + 1}${k === 18 ? "::text[]" : k === 19 || k === 20 ? "::date" : ""}`);
      return `(${params.join(",")}, ST_GeomFromGeoJSON($${base + W + 1}))`;
    }).join(",");
    const params = chunk.flatMap((r) => [...r, geomByFid.get(r[0] as number)]);
    await prisma.$executeRawUnsafe(
      `INSERT INTO rrc.wells (fid, api8, api10, well_no, well_id, symbol, type, status, category, county,
         district, lease_no, lease_name, operator, operator_no, field_no, field_name, oil_gas, formations,
         spud_date, plug_date, cum_oil, cum_gas, last_prod, geom)
       VALUES ${values} ON CONFLICT (fid) DO NOTHING`,
      ...params,
    );
  }

  const bseen = new Set<number>();
  const brows = boresFC.features.filter((f) => {
    const fid = f.properties.fid as number;
    if (bseen.has(fid)) return false;
    bseen.add(fid);
    return true;
  });
  for (let i = 0; i < brows.length; i += BATCH) {
    const chunk = brows.slice(i, i + BATCH);
    const values7 = chunk.map((_, j) => {
      const b = j * 7;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}, ST_GeomFromGeoJSON($${b + 7}))`;
    }).join(",");
    const params = chunk.flatMap((f) => [
      f.properties.fid, f.properties.surfaceId ?? 0, (f.properties.api as string) || null,
      (f.properties.wellboreType as string) || null, (f.properties.stcode as string) || null, county,
      JSON.stringify(f.geometry),
    ]);
    await prisma.$executeRawUnsafe(
      `INSERT INTO rrc.wellbores (fid, surface_fid, api10, wellbore_type, stcode, county, geom)
       VALUES ${values7} ON CONFLICT (fid) DO NOTHING`,
      ...params,
    );
  }
  return [rows.length, brows.length];
}

async function main(): Promise<void> {
  console.log("DDL: rrc.wells / rrc.wellbores…");
  await ddl();
  const db900 = JSON.parse(fs.readFileSync(DBF900, "utf8")) as Record<string, Dbf900>;

  let tw = 0, tb = 0;
  for (const key of COUNTIES) {
    const [w, b] = await importCounty(key, db900);
    tw += w; tb += b;
    console.log(`  ${key}: ${w} wells, ${b} wellbores`);
  }

  console.log("Spatial join: abstract/survey attribution from gis.abstracts…");
  const joined = await prisma.$executeRawUnsafe(
    `UPDATE rrc.wells w SET abstract_id = a.id, abstract = a.abstract, survey = COALESCE(w.survey, a.survey)
       FROM gis.abstracts a
      WHERE w.abstract_id IS NULL AND ST_Contains(a.geom, w.geom)`);
  console.log(`  attributed ${joined} wells to abstracts`);

  console.log("Field names from rrc.fields…");
  const named = await prisma.$executeRawUnsafe(
    `UPDATE rrc.wells w SET field_name = f.name
       FROM rrc.fields f
      WHERE w.field_name IS NULL AND w.field_no IS NOT NULL AND f.field_no = w.field_no AND f.district = w.district`);
  console.log(`  resolved ${named} field names`);

  // Validation.
  const counts = await prisma.$queryRawUnsafe<{ county: string; wells: number; withop: number; withabs: number }[]>(
    `SELECT county, count(*)::int AS wells,
            count(operator)::int AS withop, count(abstract_id)::int AS withabs
       FROM rrc.wells GROUP BY county ORDER BY county`);
  for (const c of counts) console.log(`  ${c.county}: ${c.wells} wells, ${c.withop} w/operator, ${c.withabs} w/abstract`);
  console.log(`TOTAL: ${tw} wells, ${tb} wellbores`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
