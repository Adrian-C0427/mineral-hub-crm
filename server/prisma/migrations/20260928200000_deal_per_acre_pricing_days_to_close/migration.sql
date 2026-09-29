-- Per-acre pricing + contracted days-to-close on deals (all nullable; existing
-- rows keep their stored totals and the unchanged 15-day Find-Buyer-By rule).
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "ourCostPerNma" DOUBLE PRECISION;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "ourCostPerNra" DOUBLE PRECISION;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "askPricePerNma" DOUBLE PRECISION;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "askPricePerNra" DOUBLE PRECISION;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "daysToClose" INTEGER;
