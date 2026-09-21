-- Imported shapefile tract boundaries (one row per polygon feature, WGS84).
CREATE TABLE "MapTract" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "properties" JSONB,
    "geometry" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MapTract_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MapTract_organizationId_importId_idx" ON "MapTract"("organizationId", "importId");

ALTER TABLE "MapTract" ADD CONSTRAINT "MapTract_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
