-- Version stamp for the research party parser. ADDITIVE ONLY: one defaulted
-- column; every existing row starts at 0 and is re-derived once at boot.

-- AlterTable
ALTER TABLE "ResearchDocument" ADD COLUMN     "partyRulesVersion" INTEGER NOT NULL DEFAULT 0;
