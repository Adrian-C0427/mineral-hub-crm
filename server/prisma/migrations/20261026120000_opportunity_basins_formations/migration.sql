-- Basin / formation tags on opportunities (same shape as Deal.basins / Deal.formations).
-- Additive only: two defaulted array columns.
ALTER TABLE "Opportunity" ADD COLUMN "basins" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Opportunity" ADD COLUMN "formations" TEXT[] DEFAULT ARRAY[]::TEXT[];
