-- User-supplied geographic context for tract descriptions: which counties and
-- which GIS abstracts the tract sits in. Used as the highest-priority anchor
-- source when the legal description itself doesn't cite an abstract.
ALTER TABLE "TractDescription" ADD COLUMN "counties" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "TractDescription" ADD COLUMN "abstractGisIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
