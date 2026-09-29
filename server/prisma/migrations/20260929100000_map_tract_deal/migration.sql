-- Shapefile tracts imported from a deal's map keep a link to that deal (one
-- stored copy renders on both the deal map and the main map).
-- The retired "TractDescription" table is intentionally left in place (no
-- DROP) so existing rows are preserved; the application no longer uses it.
ALTER TABLE "MapTract" ADD COLUMN IF NOT EXISTS "dealId" TEXT;
CREATE INDEX IF NOT EXISTS "MapTract_dealId_idx" ON "MapTract"("dealId");
DO $$ BEGIN
  ALTER TABLE "MapTract" ADD CONSTRAINT "MapTract_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
