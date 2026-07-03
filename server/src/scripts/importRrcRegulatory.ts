/**
 * B3 + B4 of the RRC import: permit history and completion filings.
 *
 * Inputs (tools/rrc pipeline):
 *   tools/rrc/work12/daf802_full.json   parse_daf802_full.py — every permit
 *                                       filing for the imported counties
 *   tools/rrc/work12/completions.json   parse_completions.py — W-2/G-1
 *                                       completion packets (coverage = the
 *                                       daily zips downloaded; the sync worker
 *                                       keeps this current going forward)
 *
 * Idempotent: full replace of both tables on re-run (small tables).
 *
 * Usage: npx tsx src/scripts/importRrcRegulatory.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PERMITS = path.join(ROOT, "tools/rrc/work12/daf802_full.json");
const COMPLETIONS = path.join(ROOT, "tools/rrc/work12/completions.json");

/** RRC 3-digit API county code -> county name (the 12 imported counties). */
const COUNTY: Record<string, string> = {
  "001": "Anderson", "005": "Angelina", "073": "Cherokee", "161": "Freestone",
  "225": "Houston", "289": "Leon", "293": "Limestone", "313": "Madison",
  "365": "Panola", "395": "Robertson", "405": "San Augustine", "419": "Shelby",
};

const yyyymmdd = (s?: string | null): string | null => {
  if (!s || !/^\d{8}$/.test(s) || s === "00000000") return null;
  const y = Number(s.slice(0, 4));
  if (y < 1850 || y > 2100) return null;
  const m = Math.min(Math.max(Number(s.slice(4, 6)), 1), 12);
  const d = Math.min(Math.max(Number(s.slice(6, 8)), 1), 28);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
const mdy = (s?: string | null): string | null => {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};

async function ddl(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS rrc`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.permits (
      status_no   text NOT NULL,     -- RRC permit/status tracking number
      api8        text NOT NULL,
      county      text NOT NULL,
      district    text,
      lease_name  text,
      well_no     text,
      operator    text,              -- operator AT PERMIT TIME (historic)
      operator_no text,
      permit_date date,
      PRIMARY KEY (status_no, api8)
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.completions (
      tracking_no     text NOT NULL,
      api8            text NOT NULL,
      filing_type     text,          -- W-2 (oil) / G-1 (gas) + attachments
      status          text,          -- Submitted / Approved / …
      filed_date      date,
      completion_date date,
      county          text,
      district        text,
      operator_no     text,
      field_no        text,
      field_name      text,          -- reservoir/formation proxy
      well_name       text,
      well_no         text,
      survey          text,
      PRIMARY KEY (tracking_no, api8)
    )`);
  for (const sql of [
    `CREATE INDEX IF NOT EXISTS permits_api8_idx ON rrc.permits (api8)`,
    `CREATE INDEX IF NOT EXISTS permits_county_idx ON rrc.permits (county)`,
    `CREATE INDEX IF NOT EXISTS permits_date_idx ON rrc.permits (permit_date)`,
    `CREATE INDEX IF NOT EXISTS completions_api8_idx ON rrc.completions (api8)`,
    `CREATE INDEX IF NOT EXISTS completions_county_idx ON rrc.completions (county)`,
  ]) await prisma.$executeRawUnsafe(sql);
}

async function batchInsert(table: string, cols: string[], casts: Record<number, string>, rows: unknown[][]): Promise<void> {
  const BATCH = 500;
  const W = cols.length;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map((_, j) => {
      const b = j * W;
      return `(${Array.from({ length: W }, (_, k) => `$${b + k + 1}${casts[k] ?? ""}`).join(",")})`;
    }).join(",");
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${table} (${cols.join(",")}) VALUES ${values} ON CONFLICT DO NOTHING`,
      ...chunk.flat(),
    );
  }
}

async function main(): Promise<void> {
  console.log("DDL: rrc.permits / rrc.completions…");
  await ddl();

  interface P { statusNo: string; api8: string; county: string; leaseName: string; district: string; operatorNo: string; permitDate: string; operator: string; wellNo: string }
  const permits = JSON.parse(fs.readFileSync(PERMITS, "utf8")) as P[];
  await prisma.$executeRawUnsafe(`TRUNCATE rrc.permits`);
  await batchInsert(
    "rrc.permits",
    ["status_no", "api8", "county", "district", "lease_name", "well_no", "operator", "operator_no", "permit_date"],
    { 8: "::date" },
    permits.map((p) => [
      p.statusNo, p.api8, COUNTY[p.county] ?? p.county, p.district || null, p.leaseName || null,
      p.wellNo || null, p.operator || null, p.operatorNo || null, yyyymmdd(p.permitDate),
    ]),
  );
  console.log(`permits: ${permits.length} filings`);

  interface C { trackingNo: string; api8: string; filingType: string | null; status: string; filedDate: string; completionDate: string | null; county: string; district: string | null; operatorNo: string; fieldNo: string | null; fieldName: string | null; wellName: string | null; wellNo: string | null; survey: string | null }
  const comps = JSON.parse(fs.readFileSync(COMPLETIONS, "utf8")) as C[];
  await prisma.$executeRawUnsafe(`TRUNCATE rrc.completions`);
  await batchInsert(
    "rrc.completions",
    ["tracking_no", "api8", "filing_type", "status", "filed_date", "completion_date", "county", "district", "operator_no", "field_no", "field_name", "well_name", "well_no", "survey"],
    { 4: "::date", 5: "::date" },
    comps.map((c) => [
      c.trackingNo, c.api8, c.filingType, c.status, mdy(c.filedDate), mdy(c.completionDate),
      COUNTY[c.county] ?? c.county, c.district, c.operatorNo || null, c.fieldNo, c.fieldName,
      c.wellName, c.wellNo, c.survey,
    ]),
  );
  console.log(`completions: ${comps.length} filings`);

  const stats = await prisma.$queryRawUnsafe<{ t: string; n: number }[]>(
    `SELECT 'permits' AS t, count(*)::int AS n FROM rrc.permits
     UNION ALL SELECT 'completions', count(*)::int FROM rrc.completions
     UNION ALL SELECT 'permits joined to wells', count(DISTINCT p.api8)::int
       FROM rrc.permits p JOIN rrc.wells w ON w.api8 = p.api8`);
  for (const s of stats) console.log(` ${s.t}: ${s.n}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
