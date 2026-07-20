-- Multiple pipelines: Pipeline table, PipelineStage.pipelineId, Deal.pipelineId.
-- Backfill: each org with existing stages gets one default pipeline owning all
-- current stages and deals. Null Deal.pipelineId continues to mean "default".

CREATE TABLE "Pipeline" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Pipeline_organizationId_idx" ON "Pipeline"("organizationId");
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PipelineStage" ADD COLUMN "pipelineId" TEXT;
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_pipelineId_fkey"
    FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Deal" ADD COLUMN "pipelineId" TEXT;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_pipelineId_fkey"
    FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one default pipeline per org that already has stages.
INSERT INTO "Pipeline" ("id", "organizationId", "name", "isDefault", "position")
SELECT 'pl_' || md5(random()::text || o."organizationId"), o."organizationId", 'Sales Pipeline', true, 0
FROM (SELECT DISTINCT "organizationId" FROM "PipelineStage") o;

UPDATE "PipelineStage" ps
SET "pipelineId" = p."id"
FROM "Pipeline" p
WHERE p."organizationId" = ps."organizationId" AND p."isDefault" AND ps."pipelineId" IS NULL;

UPDATE "Deal" d
SET "pipelineId" = p."id"
FROM "Pipeline" p
WHERE p."organizationId" = d."organizationId" AND p."isDefault" AND d."pipelineId" IS NULL;

-- Stage keys are now unique per pipeline, not per org.
DROP INDEX "PipelineStage_organizationId_key_key";
CREATE UNIQUE INDEX "PipelineStage_pipelineId_key_key" ON "PipelineStage"("pipelineId", "key");
