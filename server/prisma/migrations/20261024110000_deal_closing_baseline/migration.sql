-- Baseline for the automatic Extended Closing. ADDITIVE ONLY: one nullable
-- column; existing deals keep deriving from their current Closing date until
-- the first time it is edited, when the pre-edit date becomes the baseline.

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "closingBaselineDate" TIMESTAMP(3);
