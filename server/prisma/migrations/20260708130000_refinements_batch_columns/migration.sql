-- Buyer: structured mailing address (address + city + zip)
ALTER TABLE "Buyer" ADD COLUMN IF NOT EXISTS "mailingCity" TEXT;
ALTER TABLE "Buyer" ADD COLUMN IF NOT EXISTS "mailingZip" TEXT;

-- Deal: per-deal published Buyer Portal contact (representative for this listing)
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "portalContactName" TEXT;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "portalContactTitle" TEXT;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "portalContactEmail" TEXT;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "portalContactPhone" TEXT;
