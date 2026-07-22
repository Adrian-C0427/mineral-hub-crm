-- Multi-party grantors/grantees: individual participants per recorded instrument.
ALTER TABLE "ResearchDocument" ADD COLUMN "grantorParties" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "ResearchDocument" ADD COLUMN "granteeParties" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "ResearchDocument" ADD COLUMN "grantorNorms" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "ResearchDocument" ADD COLUMN "granteeNorms" TEXT[] NOT NULL DEFAULT '{}';
