-- Additive only: new nullable columns. Existing rows are untouched and read as
-- "not set" (no mailing address / no preference, colour by position, invite
-- codes that join as Member and never expire — exactly today's behaviour).
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "preferredContact" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "mailingStreet" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "mailingCity" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "mailingState" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "mailingZip" TEXT;

ALTER TABLE "ExpenseCategory" ADD COLUMN IF NOT EXISTS "color" TEXT;

ALTER TABLE "InviteCode" ADD COLUMN IF NOT EXISTS "role" "OrgRole";
ALTER TABLE "InviteCode" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
