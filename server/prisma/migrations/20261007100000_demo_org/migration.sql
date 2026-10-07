-- Demo / showcase workspace flags. Additive only: two new columns with safe
-- defaults; no existing row changes meaning (every org stays isDemo = false,
-- referenceOrgId = NULL).
ALTER TABLE "Organization" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ADD COLUMN "referenceOrgId" TEXT;
