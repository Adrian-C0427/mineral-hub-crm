-- Mineral Asset lease redesign: multi-select lease statuses, royalty rate,
-- and structured current-lease effective/expiration dates. Additive only —
-- the deprecated leaseStatus/leaseInfo/divisionOrdersNote/taxInfo columns are
-- left in place (removed from the UI) to avoid a destructive drop.
ALTER TABLE "Deal" ADD COLUMN "leaseStatuses" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Deal" ADD COLUMN "royaltyRate" TEXT;
ALTER TABLE "Deal" ADD COLUMN "leaseEffectiveDate" TIMESTAMP(3);
ALTER TABLE "Deal" ADD COLUMN "leaseExpirationDate" TIMESTAMP(3);
