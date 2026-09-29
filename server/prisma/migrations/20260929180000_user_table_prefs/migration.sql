-- Per-user saved table layouts (Customize View column order / hidden / pinned).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tablePrefs" JSONB;
