-- Split Buyer contact name into first/last (additive; legacy contactName kept
-- in sync). Backfill: first token -> first name, remainder -> last name.
ALTER TABLE "Buyer" ADD COLUMN IF NOT EXISTS "contactFirstName" TEXT;
ALTER TABLE "Buyer" ADD COLUMN IF NOT EXISTS "contactLastName" TEXT;

UPDATE "Buyer"
SET "contactFirstName" = NULLIF(split_part(btrim("contactName"), ' ', 1), ''),
    "contactLastName"  = NULLIF(btrim(substr(btrim("contactName"), length(split_part(btrim("contactName"), ' ', 1)) + 1)), '')
WHERE "contactName" IS NOT NULL AND "contactFirstName" IS NULL;
