-- Deal Characteristics: Railroad Commission identifier(s).
-- Free-text (comma-separated for multiple RRC lease/district/operator numbers).
ALTER TABLE "Deal" ADD COLUMN "rrc" TEXT;
