-- Research data hygiene (2026-07 audit): the soft-archive feature hid records
-- from every list while still counting them in import duplicate detection —
-- users saw "duplicate" reports with seemingly no data present. Deletion is
-- now permanent and the archive concept is removed. Purge any archived
-- residuals, then drop the columns so no hidden state can exist again.
DELETE FROM "ResearchDocument" WHERE "archivedAt" IS NOT NULL;
DELETE FROM "ResearchPermit" WHERE "archivedAt" IS NOT NULL;
ALTER TABLE "ResearchDocument" DROP COLUMN IF EXISTS "archivedAt";
ALTER TABLE "ResearchPermit" DROP COLUMN IF EXISTS "archivedAt";
