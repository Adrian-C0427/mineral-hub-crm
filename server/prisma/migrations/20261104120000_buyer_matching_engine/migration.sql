-- Buyer matching engine (docs/buyer-matching.md): further buy-box criteria and
-- per-deal manual overrides.
--
-- ADDITIVE ONLY: nullable / defaulted columns on "BuyBoxCriteria" (every
-- existing buy box keeps its values; the new columns read as "not stated") and
-- one new table. No existing table, column or row is changed or removed.

-- AlterTable
ALTER TABLE "BuyBoxCriteria" ADD COLUMN IF NOT EXISTS "minNra" DOUBLE PRECISION;
ALTER TABLE "BuyBoxCriteria" ADD COLUMN IF NOT EXISTS "maxNra" DOUBLE PRECISION;
ALTER TABLE "BuyBoxCriteria" ADD COLUMN IF NOT EXISTS "maxPricePerNma" DOUBLE PRECISION;
ALTER TABLE "BuyBoxCriteria" ADD COLUMN IF NOT EXISTS "leaseStatuses" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "BuyBoxCriteria" ADD COLUMN IF NOT EXISTS "operators" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "BuyBoxCriteria" ADD COLUMN IF NOT EXISTS "minRoyalty" DOUBLE PRECISION;
ALTER TABLE "BuyBoxCriteria" ADD COLUMN IF NOT EXISTS "strictKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "BuyBoxCriteria" ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "DealBuyerMatchOverride" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealBuyerMatchOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DealBuyerMatchOverride_dealId_buyerId_key" ON "DealBuyerMatchOverride"("dealId", "buyerId");
CREATE INDEX IF NOT EXISTS "DealBuyerMatchOverride_buyerId_idx" ON "DealBuyerMatchOverride"("buyerId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "DealBuyerMatchOverride" ADD CONSTRAINT "DealBuyerMatchOverride_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DealBuyerMatchOverride" ADD CONSTRAINT "DealBuyerMatchOverride_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DealBuyerMatchOverride" ADD CONSTRAINT "DealBuyerMatchOverride_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
