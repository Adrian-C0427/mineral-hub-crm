-- Seller ↔ Contact link, opportunity documents, Lease-folder backfill marker.
-- Additive only: new nullable / defaulted columns, indexes and foreign keys.
ALTER TABLE "DealSeller" ADD COLUMN "contactId" TEXT;
CREATE INDEX "DealSeller_contactId_idx" ON "DealSeller"("contactId");
ALTER TABLE "DealSeller" ADD CONSTRAINT "DealSeller_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FileAttachment" ADD COLUMN "opportunityId" TEXT;
CREATE INDEX "FileAttachment_opportunityId_idx" ON "FileAttachment"("opportunityId");
ALTER TABLE "FileAttachment" ADD CONSTRAINT "FileAttachment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Opportunity" ADD COLUMN "docFolders" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Deal" ADD COLUMN "docFoldersVersion" INTEGER NOT NULL DEFAULT 0;
