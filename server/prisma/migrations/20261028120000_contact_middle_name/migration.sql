-- Optional middle name on contacts. ADDITIVE ONLY: one nullable column, empty
-- for every existing contact; no row is changed. (Deal sellers already carry
-- their own "middleName"; a linked contact without one shows the seller's.)

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "middleName" TEXT;
