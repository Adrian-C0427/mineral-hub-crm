/**
 * Run-logging: every download, import, update, and error is recorded so a
 * monthly unattended run is auditable and a failure can be diagnosed after the
 * fact. Writes rrc.ingest_run (one row per run) and rrc.source_file (one row
 * per downloaded dataset). Schema is ensured here too so the logger works in
 * dev before the migration has been applied.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";

export interface DatasetResult {
  name: string;
  status: "imported" | "unchanged" | "skipped" | "pending" | "failed";
  inserted?: number;
  updated?: number;
  skipped?: number;
  error?: string;
}

export interface SourceFileRecord {
  dataset: string;
  url?: string;
  filename?: string;
  bytes?: number;
  sha256?: string;
  status?: string;
  rowsSeen?: number;
  error?: string;
}

export async function ensureIngestSchema(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS rrc`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.ingest_run (
      id text PRIMARY KEY,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      status text NOT NULL DEFAULT 'running',
      trigger text NOT NULL DEFAULT 'schedule',
      scope text,
      datasets jsonb NOT NULL DEFAULT '[]',
      error text,
      notes text
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rrc.source_file (
      id bigserial PRIMARY KEY,
      run_id text REFERENCES rrc.ingest_run(id) ON DELETE CASCADE,
      dataset text NOT NULL,
      url text, filename text, bytes bigint, sha256 text,
      downloaded_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'downloaded',
      rows_seen integer, error text
    )`);
}

export async function startRun(trigger: "schedule" | "manual", scope: string): Promise<string> {
  await ensureIngestSchema();
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO rrc.ingest_run (id, status, trigger, scope) VALUES ($1, 'running', $2, $3)`,
    id, trigger, scope,
  );
  return id;
}

export async function finishRun(
  id: string,
  status: "ok" | "partial" | "failed",
  datasets: DatasetResult[],
  error?: string,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE rrc.ingest_run
        SET finished_at = now(), status = $2, datasets = $3::jsonb, error = $4
      WHERE id = $1`,
    id, status, JSON.stringify(datasets), error ?? null,
  );
}

export async function recordFile(runId: string, rec: SourceFileRecord): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO rrc.source_file
       (run_id, dataset, url, filename, bytes, sha256, status, rows_seen, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    runId, rec.dataset, rec.url ?? null, rec.filename ?? null, rec.bytes ?? null,
    rec.sha256 ?? null, rec.status ?? "downloaded", rec.rowsSeen ?? null, rec.error ?? null,
  );
}

/** Convenience wrapper for isDatasetChanged() bound to the real DB. */
export function queryLastChecksum(sql: string, ...args: unknown[]): Promise<{ sha256: string | null }[]> {
  return prisma.$queryRawUnsafe<{ sha256: string | null }[]>(sql, ...args);
}
