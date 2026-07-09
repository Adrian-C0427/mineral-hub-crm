-- RRC monthly ingestion pipeline: a run log, a source-file registry (checksums
-- for change detection), and the natural-key uniqueness that turns production
-- into an append-only, storage-efficient incremental load. Every statement is
-- idempotent so this migration is safe to re-apply on every deploy.

CREATE SCHEMA IF NOT EXISTS rrc;

-- One row per pipeline execution (monthly cron or a manual run).
CREATE TABLE IF NOT EXISTS rrc.ingest_run (
  id           text PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running',   -- running | ok | partial | failed
  trigger      text NOT NULL DEFAULT 'schedule',  -- schedule | manual
  scope        text,                              -- counties covered, e.g. "Freestone"
  datasets     jsonb NOT NULL DEFAULT '[]',       -- per-dataset [{name,status,inserted,updated,skipped,error}]
  error        text,
  notes        text
);
CREATE INDEX IF NOT EXISTS ingest_run_started_idx ON rrc.ingest_run (started_at DESC);

-- One row per downloaded source file. The checksum lets a later run skip a
-- dataset whose bytes are unchanged since the last successful import.
CREATE TABLE IF NOT EXISTS rrc.source_file (
  id            bigserial PRIMARY KEY,
  run_id        text REFERENCES rrc.ingest_run(id) ON DELETE CASCADE,
  dataset       text NOT NULL,
  url           text,
  filename      text,
  bytes         bigint,
  sha256        text,
  downloaded_at timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'downloaded', -- downloaded|verified|parsed|imported|unchanged|failed
  rows_seen     integer,
  error         text
);
CREATE INDEX IF NOT EXISTS source_file_dataset_idx ON rrc.source_file (dataset, downloaded_at DESC);
CREATE INDEX IF NOT EXISTS source_file_sha_idx ON rrc.source_file (dataset, sha256);

-- Make production append-only: normalize the per-well key to '' (never NULL),
-- drop any pre-existing duplicate natural keys, then enforce one row per
-- (lease, gas well, month) so re-imports UPSERT new/restated months instead of
-- duplicating history. Guarded because rrc.production is created lazily by the
-- loader, so it may not exist on a fresh database yet.
DO $$
BEGIN
  IF to_regclass('rrc.production') IS NOT NULL THEN
    UPDATE rrc.production SET gas_well_no = '' WHERE gas_well_no IS NULL;
    DELETE FROM rrc.production a USING rrc.production b
      WHERE a.ctid < b.ctid
        AND a.og_code = b.og_code AND a.district = b.district AND a.lease_no = b.lease_no
        AND a.gas_well_no = b.gas_well_no AND a.cycle_ym = b.cycle_ym;
    CREATE UNIQUE INDEX IF NOT EXISTS production_natural_key
      ON rrc.production (og_code, district, lease_no, gas_well_no, cycle_ym);
  END IF;
END $$;
