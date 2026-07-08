-- Deal: multiple per-deal Buyer Portal contacts (ordered JSON array)
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "portalContacts" JSONB;
