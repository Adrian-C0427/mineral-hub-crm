/**
 * B5 of the RRC import: lease-level monthly production history (PDQ dump).
 *
 * Input: a TSV extracted from the RRC "Production Data Query Dump"
 * county-lease-cycle file (OG_COUNTY_LEASE_CYCLE_DATA_TABLE.dsv), filtered to
 * the counties being imported, columns in this order:
 *
 *   og_code district lease_no cycle_ym county_no operator_no field_no
 *   gas_well_no oil_bbl gas_mcf cond_bbl csgd_mcf lease_name operator_name field_name
 *
 * (awk -F'}' '$6=="<county_no>" {print $1,$2,$3,$9,$6,$7,$8,$11,$13,$16,$19,$22,$30,$31,$32}' OFS='\t')
 *
 * All-zero months are dropped — inactive leases file zero reports for years
 * and the charts treat missing months as zero anyway. Names are NOT stored;
 * operator_no/field_no join to rrc.operators / rrc.fields (B1), lease names
 * live on rrc.wells (B2).
 *
 * Idempotent: rows are replaced per county on re-run.
 *
 * Usage: npx tsx src/scripts/importRrcProduction.ts <tsv-path> <CountyName>
 */
import fs from "node:fs";
import readline from "node:readline";
import { prisma } from "../db.js";

const [tsvPath, countyName] = process.argv.slice(2);
if (!tsvPath || !countyName || !fs.existsSync(tsvPath)) {
  console.error("Usage: npx tsx src/scripts/importRrcProduction.ts <tsv-path> <CountyName>");
  process.exit(1);
}

async function ddl(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS rrc`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.production (
      og_code     text NOT NULL,      -- O / G
      district    text NOT NULL,
      lease_no    text NOT NULL,      -- unique within district (per RRC)
      cycle_ym    integer NOT NULL,   -- yyyymm
      county      text NOT NULL,
      operator_no text,
      field_no    text,
      gas_well_no text,               -- gas leases are per-well
      oil_bbl     integer NOT NULL DEFAULT 0,
      gas_mcf     integer NOT NULL DEFAULT 0,
      cond_bbl    integer NOT NULL DEFAULT 0,
      csgd_mcf    integer NOT NULL DEFAULT 0
    )`);
  for (const sql of [
    `CREATE INDEX IF NOT EXISTS production_lease_idx ON rrc.production (og_code, district, lease_no, cycle_ym)`,
    `CREATE INDEX IF NOT EXISTS production_county_ym_idx ON rrc.production (county, cycle_ym)`,
  ]) await prisma.$executeRawUnsafe(sql);
}

const esc = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const int = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

async function main(): Promise<void> {
  await ddl();
  await prisma.$executeRawUnsafe(`DELETE FROM rrc.production WHERE county = $1`, countyName);

  const rl = readline.createInterface({ input: fs.createReadStream(tsvPath), crlfDelay: Infinity });
  let batch: string[] = [];
  let inserted = 0, skippedZero = 0;
  const flush = async () => {
    if (!batch.length) return;
    await prisma.$executeRawUnsafe(
      `INSERT INTO rrc.production
         (og_code, district, lease_no, cycle_ym, county, operator_no, field_no, gas_well_no,
          oil_bbl, gas_mcf, cond_bbl, csgd_mcf)
       VALUES ${batch.join(",")}`,
    );
    inserted += batch.length;
    batch = [];
    if (inserted % 50000 < 2000) console.log(`  inserted ${inserted}...`);
  };

  for await (const line of rl) {
    const c = line.split("\t");
    if (c.length < 12) continue;
    const [og, district, leaseNo, ym, , operatorNo, fieldNo, gasWellNo, oil, gas, cond, csgd] = c;
    const [o, g, cn, cs] = [int(oil), int(gas), int(cond), int(csgd)];
    if (o === 0 && g === 0 && cn === 0 && cs === 0) { skippedZero++; continue; }
    const cycleYm = int(ym);
    if (!cycleYm || (og !== "O" && og !== "G")) continue;
    batch.push(
      `(${esc(og)},${esc(district)},${esc(leaseNo)},${cycleYm},${esc(countyName)},` +
      `${esc(operatorNo.trim())},${esc(fieldNo.trim())},${esc(gasWellNo.trim())},${o},${g},${cn},${cs})`,
    );
    if (batch.length >= 2000) await flush();
  }
  await flush();

  const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM rrc.production WHERE county = $1`, countyName);
  console.log(`${countyName}: ${n} production rows loaded (${skippedZero} all-zero months dropped)`);
  await prisma.$executeRawUnsafe(`ANALYZE rrc.production`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
