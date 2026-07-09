-- Multi-asset seller transactions: a Deal can group child "asset" Deals.
-- parentDealId is a self-reference; deleting a parent detaches its children
-- (they survive as standalone deals) rather than cascading.
ALTER TABLE "Deal" ADD COLUMN "parentDealId" TEXT;
CREATE INDEX "Deal_parentDealId_idx" ON "Deal"("parentDealId");
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_parentDealId_fkey" FOREIGN KEY ("parentDealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
