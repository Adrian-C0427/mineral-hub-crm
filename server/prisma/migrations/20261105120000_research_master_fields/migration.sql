-- County master-file support for Research transactions (additive only).
--
-- New nullable / defaulted columns on "ResearchDocument"; no existing value is
-- changed or removed here. The derived columns for existing rows are filled by
-- the boot backfill (services/researchDerivedBackfill.ts), versioned through
-- "derivedVersion" so it runs once per row.
--
-- archive.research_document_history keeps the full previous row every time a
-- master-file import updates a record in place, so any update can be undone:
--   SELECT row FROM archive.research_document_history WHERE document_id = '…' ORDER BY archived_at DESC;

ALTER TABLE "ResearchDocument"
  ADD COLUMN "percentSold" DOUBLE PRECISION,
  ADD COLUMN "percentSoldRaw" TEXT,
  ADD COLUMN "shareBasis" TEXT,
  ADD COLUMN "granteeStatedTotalPct" DOUBLE PRECISION,
  ADD COLUMN "surveys" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "surveyAsRecorded" TEXT,
  ADD COLUMN "tracts" JSONB,
  ADD COLUMN "abstractSource" TEXT,
  ADD COLUMN "docFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "countsAsAcquisition" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "txGroupKey" TEXT,
  ADD COLUMN "sourceRow" JSONB,
  ADD COLUMN "derivedVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updatedAt" TIMESTAMP(3),
  ADD COLUMN "updatedByRunId" TEXT;

CREATE INDEX "ResearchDocument_organizationId_state_county_instrumentNumb_idx" ON "ResearchDocument"("organizationId", "state", "county", "instrumentNumber");
CREATE INDEX "ResearchDocument_organizationId_percentSold_idx" ON "ResearchDocument"("organizationId", "percentSold");
CREATE INDEX "ResearchDocument_organizationId_txGroupKey_idx" ON "ResearchDocument"("organizationId", "txGroupKey");
CREATE INDEX "ResearchDocument_surveys_idx" ON "ResearchDocument" USING GIN ("surveys");
CREATE INDEX "ResearchDocument_abstractIds_idx" ON "ResearchDocument" USING GIN ("abstractIds");

CREATE SCHEMA IF NOT EXISTS archive;
CREATE TABLE IF NOT EXISTS archive.research_document_history (
  id              BIGSERIAL PRIMARY KEY,
  document_id     TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  run_id          TEXT,
  reason          TEXT NOT NULL,
  row             JSONB NOT NULL,
  archived_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_document_history_doc_idx ON archive.research_document_history (document_id, archived_at DESC);
