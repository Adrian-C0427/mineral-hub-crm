-- Mineral Hub-written HighLevel tags: one flag per HighLevel contact saying
-- its tags need writing. ADDITIVE ONLY: a defaulted column and an index on
-- the HighLevelContact table; no existing value changes.

-- AlterTable
ALTER TABLE "HighLevelContact" ADD COLUMN     "crmTagsPending" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "HighLevelContact_organizationId_crmTagsPending_idx" ON "HighLevelContact"("organizationId", "crmTagsPending");

