-- Opportunities: three new tables plus four nullable/defaulted columns on
-- Pipeline (kind defaults to DEALS, so every existing pipeline keeps working
-- exactly as before). No existing row is modified.
-- AlterTable
ALTER TABLE "Pipeline" ADD COLUMN     "convertMode" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "convertStageKey" TEXT,
ADD COLUMN     "convertToPipelineId" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'DEALS';


-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "currentStageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerId" TEXT,
    "contactId" TEXT,
    "sellerName" TEXT,
    "companyName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "state" TEXT,
    "county" TEXT,
    "abstract" TEXT,
    "survey" TEXT,
    "estAcres" DOUBLE PRECISION,
    "estNma" DOUBLE PRECISION,
    "estNra" DOUBLE PRECISION,
    "source" TEXT,
    "notes" TEXT,
    "lastActivityAt" TIMESTAMP(3),
    "nextFollowUpDate" TIMESTAMP(3),
    "closeReason" TEXT,
    "convertedDealId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityStageHistory" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fromStage" TEXT NOT NULL,
    "toStage" TEXT NOT NULL,
    "reason" TEXT,
    "changedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityStageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityActivity" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_convertedDealId_key" ON "Opportunity"("convertedDealId");

-- CreateIndex
CREATE INDEX "Opportunity_organizationId_pipelineId_stage_idx" ON "Opportunity"("organizationId", "pipelineId", "stage");

-- CreateIndex
CREATE INDEX "Opportunity_contactId_idx" ON "Opportunity"("contactId");

-- CreateIndex
CREATE INDEX "OpportunityStageHistory_opportunityId_createdAt_idx" ON "OpportunityStageHistory"("opportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "OpportunityActivity_opportunityId_createdAt_idx" ON "OpportunityActivity"("opportunityId", "createdAt");

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_convertedDealId_fkey" FOREIGN KEY ("convertedDealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityStageHistory" ADD CONSTRAINT "OpportunityStageHistory_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityActivity" ADD CONSTRAINT "OpportunityActivity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

