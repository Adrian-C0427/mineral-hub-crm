/**
 * Incremental, append-only production loader. Replaces the old
 * "DELETE county then re-insert all history" approach (importRrcProduction.ts):
 * this reads the county-filtered PDQ DSV, keeps existing history untouched, and
 * UPSERTs only a trailing restatement window plus any newly-released months —
 * so the table grows by the new data each run instead of being rewritten.
 *
 * Storage/throughput win: given the newest stored month (the watermark) we only
 * send rows at or after (watermark − RESTATE_WINDOW_MONTHS) to the DB. New
 * months INSERT; RRC's late restatements of recent months UPDATE their volumes;
 * everything older is already stored and is never rewritten.
 */
import fs from "node:fs";
import readline from "node:readline";
import { prisma } from "../db.js";
import { mergeSql, watermarkSql, type MergeSpec } from "./merge.js";

const RESTATE_WINDOW_MONTHS = Number(process.env.RRC_RESTATE_WINDOW ?? 6);

const PRODUCTION_SPEC: MergeSpec = {
  schema: "rrc",
  table: "production",
  columns: [
    "og_code", "district", "lease_no", "cycle_ym", "county", "operator_no",
    "field_no", "gas_well_no", "oil_bbl", "gas_mcf", "cond_bbl", "csgd_mcf",
  ],
  conflict: ["og_code", "district", "lease_no", "gas_well_no", "cycle_ym"],
  // A restated month overwrites its volumes (and any corrected operator/field).
  update: ["operator_no", "field_no", "oil_bbl", "gas_mcf", "cond_bbl", "csgd_mcf"],
};

const int = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/** yyyymm minus `n` months, staying a valid yyyymm. Pure — unit-tested. */
export function subtractMonths(ym: number, n: number): number {
  if (!ym) return 0;
  const y = Math.floor(ym / 100);
  const m = ym % 100;
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  return ny * 100 + nm;
}

/**
 * Parse one tab-separated PDQ line into the production column tuple, or null to
 * drop it (malformed, non-O/G, or an all-zero month — inactive leases file zero
 * reports for years and the charts treat a missing month as zero). Column order
 * matches the awk extraction documented in importRrcProduction.ts.
 */
export function normalizeProductionLine(line: string, county: string): (string | number)[] | null {
  const c = line.split("\t");
  if (c.length < 12) return null;
  const [og, district, leaseNo, ym, , operatorNo, fieldNo, gasWellNo, oil, gas, cond, csgd] = c;
  if (og !== "O" && og !== "G") return null;
  const cycleYm = int(ym);
  if (!cycleYm) return null;
  const [o, g, cn, cs] = [int(oil), int(gas), int(cond), int(csgd)];
  if (o === 0 && g === 0 && cn === 0 && cs === 0) return null;
  return [
    og, district.trim(), leaseNo.trim(), cycleYm, county,
    (operatorNo ?? "").trim(), (fieldNo ?? "").trim(), (gasWellNo ?? "").trim(),
    o, g, cn, cs,
  ];
}

async function ensureProductionSchema(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS rrc`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.production (
      og_code text NOT NULL, district text NOT NULL, lease_no text NOT NULL,
      cycle_ym integer NOT NULL, county text NOT NULL,
      operator_no text, field_no text, gas_well_no text NOT NULL DEFAULT '',
      oil_bbl integer NOT NULL DEFAULT 0, gas_mcf integer NOT NULL DEFAULT 0,
      cond_bbl integer NOT NULL DEFAULT 0, csgd_mcf integer NOT NULL DEFAULT 0
    )`);
  await prisma.$executeRawUnsafe(`UPDATE rrc.production SET gas_well_no = '' WHERE gas_well_no IS NULL`);
  for (const sql of [
    `CREATE INDEX IF NOT EXISTS production_lease_idx ON rrc.production (og_code, district, lease_no, cycle_ym)`,
    `CREATE INDEX IF NOT EXISTS production_county_ym_idx ON rrc.production (county, cycle_ym)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS production_natural_key ON rrc.production (og_code, district, lease_no, gas_well_no, cycle_ym)`,
  ]) await prisma.$executeRawUnsafe(sql);
}

export interface LoadStats { seen: number; merged: number; dropped: number; belowWindow: number; watermark: number; threshold: number; }

export async function loadProduction(tsvPath: string, county: string): Promise<LoadStats> {
  await ensureProductionSchema();

  const [{ watermark }] = await prisma.$queryRawUnsafe<{ watermark: number }[]>(watermarkSql(), county);
  const threshold = watermark ? subtractMonths(watermark, RESTATE_WINDOW_MONTHS) : 0;

  const rl = readline.createInterface({ input: fs.createReadStream(tsvPath), crlfDelay: Infinity });
  let batch: (string | number)[][] = [];
  const stats: LoadStats = { seen: 0, merged: 0, dropped: 0, belowWindow: 0, watermark, threshold };

  const flush = async () => {
    if (!batch.length) return;
    await prisma.$executeRawUnsafe(mergeSql(PRODUCTION_SPEC, batch.length), ...batch.flat());
    stats.merged += batch.length;
    batch = [];
  };

  for await (const line of rl) {
    const row = normalizeProductionLine(line, county);
    if (!row) { stats.dropped++; continue; }
    stats.seen++;
    if ((row[3] as number) < threshold) { stats.belowWindow++; continue; } // already stored; skip
    batch.push(row);
    if (batch.length >= 2000) await flush();
  }
  await flush();
  await prisma.$executeRawUnsafe(`ANALYZE rrc.production`);
  return stats;
}
