import { prisma } from "../db.js";

/**
 * One-time, idempotent backfill of DealBuyerActivity.status from the legacy
 * responseStatus enum. Runs at startup; only touches rows where status is still
 * NULL, so it's safe to run on every boot and never clobbers a value that was
 * set by the app or a prior backfill.
 *
 *   PENDING        -> CONTACTED
 *   INTERESTED     -> INTERESTED
 *   NOT_INTERESTED -> PASSED
 *   PASSED         -> PASSED
 *   OFFER_MADE     -> OFFER_RECEIVED
 */
export async function backfillBuyerStatus(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    UPDATE "DealBuyerActivity"
    SET "status" = (CASE "responseStatus"
      WHEN 'PENDING' THEN 'CONTACTED'
      WHEN 'INTERESTED' THEN 'INTERESTED'
      WHEN 'NOT_INTERESTED' THEN 'PASSED'
      WHEN 'PASSED' THEN 'PASSED'
      WHEN 'OFFER_MADE' THEN 'OFFER_RECEIVED'
      ELSE 'CONTACTED'
    END)::"BuyerStatus"
    WHERE "status" IS NULL;
  `);
}
