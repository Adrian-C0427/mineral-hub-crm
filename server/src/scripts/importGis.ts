/**
 * GIS Phase A import: load statewide county boundaries + per-county abstract
 * polygons into PostGIS (the `gis` schema on the existing Neon database).
 *
 * Source files (produced by tools/otls/fetch_abstracts.py):
 *   client/public/data/tx-counties.geojson      — all 254 TX counties
 *   client/public/data/{key}-abstracts.geojson  — one per implemented county
 *
 * Idempotent: extensions/schema/tables are CREATE IF NOT EXISTS, rows are
 * upserted by primary key, and each county's abstracts are replaced wholesale
 * (delete-by-county + insert) so re-running after a data refresh is safe.
 *
 * The source geojson files are TRANSIENT (gitignored): PostGIS is the source of
 * truth. To add/refresh a county: run fetch_abstracts.py, then this script.
 * Counties whose files are absent are simply left untouched in the DB.
 *
 * Usage: npx tsx src/scripts/importGis.ts            (from server/)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";

const dirArg = process.argv.indexOf("--data-dir");
const DATA_DIR = dirArg > -1
  ? path.resolve(process.argv[dirArg + 1].replace(/^~/, process.env.HOME ?? "~"))
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client/public/data");

interface GJFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}
interface GJ { features: GJFeature[] }

function readGeojson(file: string): GJ {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")) as GJ;
}

async function ddl(): Promise<void> {
  // Extensions are cluster-level; Neon supports both natively.
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS postgis`);
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS gis`);
  // `gis` schema keeps spatial tables out of Prisma's managed `public` schema.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS gis.counties (
      fips  text PRIMARY KEY,            -- "48289" (state+county)
      state text NOT NULL DEFAULT 'TX',
      name  text NOT NULL,
      geom  geometry(MultiPolygon, 4326) NOT NULL
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS gis.abstracts (
      id          text PRIMARY KEY,      -- "TX-289001"
      state       text NOT NULL DEFAULT 'TX',
      county_fips text NOT NULL,         -- 3-digit county fips
      county      text NOT NULL,
      abstract    text,                  -- label, e.g. "A-653"
      survey      text,
      area_m2     double precision,
      geom        geometry(Geometry, 4326) NOT NULL
    )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS counties_geom_gist ON gis.counties USING GIST (geom)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS abstracts_geom_gist ON gis.abstracts USING GIST (geom)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS abstracts_county_idx ON gis.abstracts (county)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS abstracts_survey_trgm ON gis.abstracts USING GIN (survey gin_trgm_ops)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS abstracts_label_trgm ON gis.abstracts USING GIN (abstract gin_trgm_ops)`);
}

async function importCounties(): Promise<number> {
  const fc = readGeojson("tx-counties.geojson");
  const BATCH = 50;
  for (let i = 0; i < fc.features.length; i += BATCH) {
    const rows = fc.features.slice(i, i + BATCH);
    // ST_MakeValid can return a GeometryCollection; CollectionExtract(…, 3) keeps polygons.
    const values = rows.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_GeomFromGeoJSON($${j * 3 + 3})), 3)))`).join(",");
    const params = rows.flatMap((f) => [String(f.properties.fips), String(f.properties.name), JSON.stringify(f.geometry)]);
    await prisma.$executeRawUnsafe(
      `INSERT INTO gis.counties (fips, name, geom) VALUES ${values}
       ON CONFLICT (fips) DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom`,
      ...params,
    );
  }
  return fc.features.length;
}

async function importAbstracts(file: string): Promise<{ county: string; count: number }> {
  const fc = readGeojson(file);
  // Dedupe by id — the original hand-built Leon/Freestone files carry a couple
  // of intra-file duplicates that the newer fetch script already filters out.
  const seen = new Set<string>();
  fc.features = fc.features.filter((f) => {
    const id = String(f.properties.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const county = String(fc.features[0]?.properties.county ?? "?");
  const fips = String(fc.features[0]?.properties.countyFips ?? "?");
  // Replace-by-county keeps re-imports clean if the source data changes shape.
  await prisma.$executeRawUnsafe(`DELETE FROM gis.abstracts WHERE county_fips = $1`, fips);
  const BATCH = 200;
  for (let i = 0; i < fc.features.length; i += BATCH) {
    const rows = fc.features.slice(i, i + BATCH);
    const values = rows
      .map((_, j) => {
        const b = j * 7;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, ST_CollectionExtract(ST_MakeValid(ST_GeomFromGeoJSON($${b + 7})), 3))`;
      })
      .join(",");
    const params = rows.flatMap((f) => [
      String(f.properties.id),
      String(f.properties.countyFips),
      String(f.properties.county),
      // Source labels occasionally carry a stray '?' (upstream disambiguator
      // for duplicate abstract numbers) — strip it so labels display cleanly.
      ((f.properties.abstract as string | null) ?? null)?.replace(/\?/g, "") ?? null,
      (f.properties.survey as string | null) ?? null,
      (f.properties.area as number | null) ?? null,
      JSON.stringify(f.geometry),
    ]);
    await prisma.$executeRawUnsafe(
      `INSERT INTO gis.abstracts (id, county_fips, county, abstract, survey, area_m2, geom) VALUES ${values}
       ON CONFLICT (id) DO UPDATE SET county_fips = EXCLUDED.county_fips, county = EXCLUDED.county,
         abstract = EXCLUDED.abstract, survey = EXCLUDED.survey, area_m2 = EXCLUDED.area_m2, geom = EXCLUDED.geom`,
      ...params,
    );
  }
  return { county, count: fc.features.length };
}

async function main(): Promise<void> {
  console.log("DDL: extensions, gis schema, tables, indexes…");
  await ddl();

  if (fs.existsSync(path.join(DATA_DIR, "tx-counties.geojson"))) {
    console.log("Importing tx-counties.geojson…");
    const nCounties = await importCounties();
    console.log(`  counties: ${nCounties}`);
  }

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith("-abstracts.geojson")).sort();
  let total = 0;
  const importedCounties: string[] = [];
  for (const f of files) {
    const { county, count } = await importAbstracts(f);
    total += count;
    importedCounties.push(county);
    console.log(`  ${county}: ${count} abstracts (${f})`);
  }

  // Validation scoped to THIS run's counties (the data dir may hold a subset —
  // e.g. the statewide backfill ran against ~/rrc-data/otls without the
  // original 12 counties' files).
  const [{ n: dbAbstracts }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM gis.abstracts WHERE county = ANY($1::text[])`, importedCounties);
  const [{ n: dbTotal }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM gis.abstracts`);
  const [{ n: invalid }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM gis.abstracts WHERE NOT ST_IsValid(geom)`);
  console.log(`DB: ${dbAbstracts} abstracts for this run's ${importedCounties.length} counties (files: ${total}); ${dbTotal} total; invalid geometries: ${invalid}`);
  if (Number(dbAbstracts) !== total) throw new Error("DB abstract count does not match source files");
  if (Number(invalid) !== 0) throw new Error("invalid geometries present after ST_MakeValid");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
