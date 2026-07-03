/**
 * B1 of the RRC import (docs/architecture/0004-rrc-datasets.md): reference
 * tables — every other RRC dataset joins onto these.
 *
 *   rrc.fields     from "Oil & Gas Field Name & Numbers"  (fldtpe, ASCII)
 *   rrc.operators  from "P5 Organization"                 (orf850, ASCII)
 *
 * Fixed-width layouts (verified empirically against the 2026-07 drops):
 *   fldtpe : district 0:3, fieldNo 3:11, suffix 11:14, oil/gas type 15:20,
 *            name 20:52 (per-district rows; PK district+fieldNo)
 *   orf850 : record type 'A ' = organization master; opNo 2:8, name 8:40.
 *            ('U ' activity rows and '1T' code-definition rows are skipped.)
 *
 * Idempotent (upserts). Statewide — these tables are small (~66k fields,
 * ~100k operators), so no county filtering.
 *
 * Usage: npx tsx src/scripts/importRrcRef.ts [--rrc-dir ~/rrc-data]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { prisma } from "../db.js";

const argIdx = process.argv.indexOf("--rrc-dir");
const RRC_DIR = argIdx > -1 ? process.argv[argIdx + 1] : path.join(os.homedir(), "rrc-data");
const FLDTPE = path.join(RRC_DIR, "fldtpe-2.txt");
const ORF850 = path.join(RRC_DIR, "documents_20260703-4", "orf850.txt");

async function ddl(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS rrc`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.fields (
      district text NOT NULL,           -- RRC district, e.g. "01", "7B"
      field_no text NOT NULL,           -- 8-digit RRC field number
      suffix   text,                    -- trailing 3-digit field-id suffix
      type     text,                    -- OIL | GAS | O & G
      name     text NOT NULL,
      PRIMARY KEY (district, field_no, suffix)
    )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS fields_field_no_idx ON rrc.fields (field_no)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS fields_name_idx ON rrc.fields (name)`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.operators (
      op_no text PRIMARY KEY,           -- 6-digit P-5 operator number
      name  text NOT NULL
    )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS operators_name_idx ON rrc.operators (name)`);
}

async function batchUpsert(sql: (values: string) => string, rows: string[][], width: number): Promise<number> {
  const BATCH = 500;
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map((_, j) => `(${Array.from({ length: width }, (_, k) => `$${j * width + k + 1}`).join(",")})`).join(",");
    await prisma.$executeRawUnsafe(sql(values), ...chunk.flat());
    n += chunk.length;
  }
  return n;
}

async function importFields(): Promise<void> {
  const seen = new Set<string>();
  const rows: string[][] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(FLDTPE), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length < 30) continue;
    const district = line.slice(0, 3).trim();
    const fieldNo = line.slice(3, 11).trim();
    const suffix = line.slice(11, 14).trim();
    const type = line.slice(15, 20).trim() || null;
    const name = line.slice(20, 52).trim();
    if (!district || !fieldNo || !name) continue;
    const key = `${district}|${fieldNo}|${suffix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([district, fieldNo, suffix, type ?? "", name]);
  }
  const n = await batchUpsert(
    (v) => `INSERT INTO rrc.fields (district, field_no, suffix, type, name) VALUES ${v}
            ON CONFLICT (district, field_no, suffix) DO UPDATE SET type = EXCLUDED.type, name = EXCLUDED.name`,
    rows, 5,
  );
  console.log(`fields: ${n} rows`);
}

async function importOperators(): Promise<void> {
  const byNo = new Map<string, string>();
  const rl = readline.createInterface({ input: fs.createReadStream(ORF850), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith("A ")) continue; // organization master records only
    const opNo = line.slice(2, 8).trim();
    const name = line.slice(8, 40).trim();
    if (/^\d{6}$/.test(opNo) && name) byNo.set(opNo, name); // last occurrence wins
  }
  const n = await batchUpsert(
    (v) => `INSERT INTO rrc.operators (op_no, name) VALUES ${v}
            ON CONFLICT (op_no) DO UPDATE SET name = EXCLUDED.name`,
    [...byNo.entries()].map(([a, b]) => [a, b]), 2,
  );
  console.log(`operators: ${n} rows`);
}

async function main(): Promise<void> {
  console.log("DDL: rrc schema + reference tables…");
  await ddl();
  await importFields();
  await importOperators();
  // Sanity: known names resolve.
  const probe = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM rrc.fields WHERE name LIKE 'CARTHAGE%' LIMIT 1`);
  console.log("probe CARTHAGE field:", probe[0]?.name ?? "NOT FOUND");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
