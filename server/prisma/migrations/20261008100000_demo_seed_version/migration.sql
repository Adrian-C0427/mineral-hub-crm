-- Demo dataset version marker (additive, nullable; NULL for every org).
ALTER TABLE "Organization" ADD COLUMN "demoSeedVersion" INTEGER;
