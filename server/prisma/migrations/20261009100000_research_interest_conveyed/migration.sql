-- Conveyed interest on recorded documents. ADDITIVE ONLY: new nullable
-- columns + an index. No existing value is changed here; older rows are
-- filled by the idempotent boot backfill (services/researchInterestBackfill.ts),
-- which keeps every original cell in grantorAsRecorded / granteeAsRecorded.
ALTER TABLE "ResearchDocument" ADD COLUMN "grantorAsRecorded" TEXT;
ALTER TABLE "ResearchDocument" ADD COLUMN "granteeAsRecorded" TEXT;
ALTER TABLE "ResearchDocument" ADD COLUMN "interestPct" DOUBLE PRECISION;
ALTER TABLE "ResearchDocument" ADD COLUMN "partyInterests" JSONB;

CREATE INDEX "ResearchDocument_organizationId_interestPct_idx" ON "ResearchDocument"("organizationId", "interestPct");
