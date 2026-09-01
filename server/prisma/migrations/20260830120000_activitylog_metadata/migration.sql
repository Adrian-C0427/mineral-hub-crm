-- Structured event payload on the audit log. Buyer merges snapshot the
-- absorbed record here, enabling an admin undo of an incorrect merge.
ALTER TABLE "ActivityLog" ADD COLUMN "metadata" JSONB;
