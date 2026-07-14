/**
 * Shared loader plumbing: batched natural-key merges through the increment-1
 * merge core, and idempotent DDL for the rrc.* tables the new loaders feed.
 * DDL matches the original importRrc* scripts byte-for-byte where tables
 * already exist in production — CREATE IF NOT EXISTS never fights them.
 */
import { prisma } from "../../db.js";
import { mergeSql, type MergeSpec } from "../merge.js";

const BATCH = 1000;

/** Upsert `rows` through `spec` in batches; returns rows sent. */
export async function mergeRows(spec: MergeSpec, rows: (string | number | null)[][]): Promise<number> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await prisma.$executeRawUnsafe(mergeSql(spec, chunk.length), ...chunk.flat());
  }
  return rows.length;
}

export async function ensureRegulatoryTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS rrc`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.permits (
      status_no   text NOT NULL,
      api8        text NOT NULL,
      county      text NOT NULL,
      district    text,
      lease_name  text,
      well_no     text,
      operator    text,
      operator_no text,
      permit_date date,
      PRIMARY KEY (status_no, api8)
    )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS permits_api8_idx ON rrc.permits (api8)`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.completions (
      tracking_no     text NOT NULL,
      api8            text NOT NULL,
      filing_type     text,
      status          text,
      filed_date      date,
      completion_date date,
      county          text,
      district        text,
      operator_no     text,
      field_no        text,
      field_name      text,
      well_name       text,
      well_no         text,
      survey          text,
      PRIMARY KEY (tracking_no, api8)
    )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS completions_api8_idx ON rrc.completions (api8)`);
}

export async function ensureRefTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS rrc`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.fields (
      district text NOT NULL,
      field_no text NOT NULL,
      suffix   text,
      type     text,
      name     text NOT NULL,
      PRIMARY KEY (district, field_no, suffix)
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.operators (
      op_no text PRIMARY KEY,
      name  text NOT NULL
    )`);
}

export async function ensureWellStatusTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS rrc`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.well_status (
      og_code     text NOT NULL,           -- O / G
      district    text NOT NULL,
      rrc_id      text NOT NULL,           -- gas RRC id / oil lease no
      operator_no text,
      status_year integer,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (og_code, district, rrc_id)
    )`);
}

/** yyyymmdd digits → ISO date string, or null when blank/implausible. */
export function yyyymmddToIso(s: string | null | undefined): string | null {
  if (!s || !/^\d{8}$/.test(s) || s === "00000000") return null;
  const y = Number(s.slice(0, 4));
  if (y < 1850 || y > 2100) return null;
  const m = Math.min(Math.max(Number(s.slice(4, 6)), 1), 12);
  const d = Math.min(Math.max(Number(s.slice(6, 8)), 1), 28);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
