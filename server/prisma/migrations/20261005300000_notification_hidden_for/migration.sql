-- Clearing a shared (untargeted) notification now hides it for the person who
-- cleared it instead of deleting the row for every admin/owner. Additive only:
-- existing rows get an empty list, so nothing is hidden from anyone.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "hiddenForUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
