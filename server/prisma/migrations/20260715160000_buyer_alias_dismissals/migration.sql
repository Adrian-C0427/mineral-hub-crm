-- Alias suggestions the user reviewed and rejected, so the profile stops
-- re-prompting for them. Normalized entity keys (see domain/research.ts).
ALTER TABLE "Buyer" ADD COLUMN "dismissedAliasNorms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
