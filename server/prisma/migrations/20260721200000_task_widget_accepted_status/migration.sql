-- Task widget metadata + Accepted Offer buyer status.
ALTER TYPE "BuyerStatus" ADD VALUE IF NOT EXISTS 'ACCEPTED';

ALTER TABLE "ContactActivity" ADD COLUMN "priority" TEXT;
ALTER TABLE "ContactActivity" ADD COLUMN "assignedToId" TEXT;
ALTER TABLE "ContactActivity" ADD CONSTRAINT "ContactActivity_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ContactActivity_organizationId_dueDate_idx" ON "ContactActivity"("organizationId", "dueDate");
