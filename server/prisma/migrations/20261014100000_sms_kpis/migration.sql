-- SMS KPIs: wrong numbers, cost (segments), speed to lead, the minerals filter
-- and HighLevel opportunities. ADDITIVE ONLY: new nullable/defaulted columns on
-- the two HighLevel tables added in 20261013100000, two new tables, indexes.
-- No existing value changes; the sync fills the new columns.

-- AlterTable
ALTER TABLE "HighLevelContact" ADD COLUMN     "answeredByHlUserId" TEXT,
ADD COLUMN     "line" TEXT,
ADD COLUMN     "replyAnsweredSeconds" INTEGER,
ADD COLUMN     "wrongNumberAt" TIMESTAMP(3),
ADD COLUMN     "wrongNumberTouch" INTEGER;

-- AlterTable
ALTER TABLE "HighLevelMessage" ADD COLUMN     "segments" INTEGER,
ADD COLUMN     "wrongNumber" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "HighLevelOpportunity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "hlId" TEXT NOT NULL,
    "hlContactId" TEXT,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT,
    "status" TEXT,
    "monetaryValue" DOUBLE PRECISION,
    "assignedToHlUserId" TEXT,
    "source" TEXT,
    "name" TEXT,
    "step" TEXT NOT NULL,
    "maxRank" INTEGER NOT NULL DEFAULT 1,
    "hlCreatedAt" TIMESTAMP(3),
    "hlUpdatedAt" TIMESTAMP(3),
    "lastStageChangeAt" TIMESTAMP(3),
    "offerAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "contractAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "deadAt" TIMESTAMP(3),
    "deletedInHl" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HighLevelOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HighLevelStageEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "opportunityHlId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "fromStageId" TEXT,
    "toStageId" TEXT,
    "fromStep" TEXT,
    "toStep" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HighLevelStageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HighLevelOpportunity_organizationId_hlContactId_idx" ON "HighLevelOpportunity"("organizationId", "hlContactId");

-- CreateIndex
CREATE INDEX "HighLevelOpportunity_organizationId_pipelineId_idx" ON "HighLevelOpportunity"("organizationId", "pipelineId");

-- CreateIndex
CREATE UNIQUE INDEX "HighLevelOpportunity_organizationId_hlId_key" ON "HighLevelOpportunity"("organizationId", "hlId");

-- CreateIndex
CREATE INDEX "HighLevelStageEvent_organizationId_at_idx" ON "HighLevelStageEvent"("organizationId", "at");

-- CreateIndex
CREATE INDEX "HighLevelStageEvent_organizationId_opportunityHlId_idx" ON "HighLevelStageEvent"("organizationId", "opportunityHlId");

-- CreateIndex
CREATE INDEX "HighLevelContact_organizationId_line_firstOutboundAt_idx" ON "HighLevelContact"("organizationId", "line", "firstOutboundAt");

-- AddForeignKey
ALTER TABLE "HighLevelOpportunity" ADD CONSTRAINT "HighLevelOpportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HighLevelStageEvent" ADD CONSTRAINT "HighLevelStageEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

