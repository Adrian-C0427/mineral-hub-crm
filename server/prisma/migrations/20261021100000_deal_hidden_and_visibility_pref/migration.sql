-- Hide / Unhide deals on the Deals list, plus the per-user list visibility
-- choice. ADDITIVE ONLY: two nullable columns; no existing value changes and
-- every current deal stays visible (hiddenAt null).

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "hiddenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dealsVisibility" TEXT;
