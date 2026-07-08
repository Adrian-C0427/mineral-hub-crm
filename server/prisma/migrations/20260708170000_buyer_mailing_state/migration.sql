-- Buyer: structured mailing address — add state
ALTER TABLE "Buyer" ADD COLUMN IF NOT EXISTS "mailingState" TEXT;
