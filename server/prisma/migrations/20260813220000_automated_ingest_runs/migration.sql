-- Flag scheduled/headless imports so the user-facing Import history can show
-- only user uploads. Existing runs with no acting user were automation.
ALTER TABLE "ResearchIngestRun" ADD COLUMN "automated" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ResearchIngestRun" SET "automated" = true WHERE "createdByUserId" IS NULL;
