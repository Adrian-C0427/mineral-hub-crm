-- Individual abstract numbers per document. The recorded cell may hold
-- several ("15, 47, 209"); each becomes its own array element so a filter or
-- search for any one abstract finds the transaction, while `abstractId`
-- keeps the cell exactly as recorded for display.
ALTER TABLE "ResearchDocument" ADD COLUMN "abstractIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "ResearchDocument" d
SET "abstractIds" = COALESCE(
  (SELECT array_agg(DISTINCT btrim(x))
     FROM unnest(regexp_split_to_array(d."abstractId", '[,;]')) AS x
    WHERE btrim(x) <> ''),
  ARRAY[]::TEXT[])
WHERE d."abstractId" IS NOT NULL AND btrim(d."abstractId") <> '';

-- GIN index so `hasSome` filters on the array are indexed like the scalar was.
CREATE INDEX "ResearchDocument_organizationId_abstractIds_idx"
  ON "ResearchDocument" USING GIN ("abstractIds");
