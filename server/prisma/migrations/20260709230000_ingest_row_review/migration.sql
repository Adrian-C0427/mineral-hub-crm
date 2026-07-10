-- Import review: per-row outcomes for every research ingest run, plus an
-- updated-rows counter on the run. Additive and non-destructive.

ALTER TABLE "ResearchIngestRun" ADD COLUMN "rowsUpdated" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ResearchIngestRow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ingestRunId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "data" JSONB NOT NULL,

    CONSTRAINT "ResearchIngestRow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ResearchIngestRow_ingestRunId_outcome_idx" ON "ResearchIngestRow"("ingestRunId", "outcome");
CREATE INDEX "ResearchIngestRow_organizationId_idx" ON "ResearchIngestRow"("organizationId");

ALTER TABLE "ResearchIngestRow" ADD CONSTRAINT "ResearchIngestRow_ingestRunId_fkey" FOREIGN KEY ("ingestRunId") REFERENCES "ResearchIngestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
