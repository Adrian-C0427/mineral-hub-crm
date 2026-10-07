-- Data correction requested by the owner (2026-10-06): on every deal that is
-- already CLOSED, the WINNING buyer's activity record must read CLOSED. The
-- winner is the deal's selected buyer, else the buyer of its selected or
-- accepted offer — the same rule the close action applies going forward.
-- Only the `status` column changes; notes, messages, offers, dates and every
-- other buyer's record are untouched. Idempotent.
UPDATE "DealBuyerActivity" a
SET "status" = 'CLOSED'
FROM "Deal" d
WHERE a."dealId" = d.id
  AND d.stage = 'CLOSED'
  AND a."status" IS DISTINCT FROM 'CLOSED'
  AND (
    a."buyerId" = d."selectedBuyerId"
    OR a."buyerId" IN (
      SELECT o."buyerId" FROM "Offer" o
      WHERE o."dealId" = d.id AND (o.id = d."selectedOfferId" OR o."status" = 'ACCEPTED')
    )
  );
