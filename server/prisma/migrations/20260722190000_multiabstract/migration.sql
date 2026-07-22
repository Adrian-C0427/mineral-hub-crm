-- Multi-abstract transactions: individual normalized abstract numbers per record.
ALTER TABLE "ResearchDocument" ADD COLUMN "abstractIds" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: extract digit runs from the original cell (numbers only, leading
-- zeros stripped, deduped) so existing records credit each abstract too.
UPDATE "ResearchDocument"
SET "abstractIds" = (
  SELECT coalesce(array_agg(v), '{}')
  FROM (
    SELECT DISTINCT coalesce(nullif(ltrim(m[1], '0'), ''), '0') AS v
    FROM regexp_matches("abstractId", '[0-9]+', 'g') AS m
  ) t
)
WHERE "abstractId" IS NOT NULL;
