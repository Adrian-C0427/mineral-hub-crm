-- Custom pipeline stages. Deal.stage / DealStageHistory stage columns become
-- plain text (values preserved), and a per-org PipelineStage table maps a stage
-- key -> label / position / terminal. The Stage enum is dropped once nothing
-- references it. Non-destructive: existing stage values are cast to text as-is.

-- Deal.stage: enum -> text
ALTER TABLE "Deal" ALTER COLUMN "stage" DROP DEFAULT;
ALTER TABLE "Deal" ALTER COLUMN "stage" TYPE TEXT USING "stage"::TEXT;
ALTER TABLE "Deal" ALTER COLUMN "stage" SET DEFAULT 'UNDER_CONTRACT';

-- DealStageHistory: enum -> text
ALTER TABLE "DealStageHistory" ALTER COLUMN "fromStage" TYPE TEXT USING "fromStage"::TEXT;
ALTER TABLE "DealStageHistory" ALTER COLUMN "toStage" TYPE TEXT USING "toStage"::TEXT;

-- Drop the now-unused enum type
DROP TYPE "Stage";

-- Per-organization customizable stages
CREATE TABLE "PipelineStage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PipelineStage_organizationId_key_key" ON "PipelineStage"("organizationId", "key");
CREATE INDEX "PipelineStage_organizationId_idx" ON "PipelineStage"("organizationId");
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
