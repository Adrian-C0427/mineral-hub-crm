-- Basin / formation removal, step 2 of 2: archive, verify, then drop.
--
-- Step 1 removed every reader and writer of these columns, so nothing in the
-- app uses them. Before anything is dropped, every non-empty value is copied
-- into archive.basin_formation_20261027 and the copy is checked row by row;
-- if any value is missing the migration raises and, because Postgres runs the
-- whole file as one transaction, nothing below is applied (the deploy fails
-- and the previous build keeps serving).
--
-- No deal, opportunity, buyer, permit or well row is deleted — only these
-- columns. To put the values back:
--   ALTER TABLE "Deal" ADD COLUMN "basins" TEXT[], ADD COLUMN "formations" TEXT[];
--   UPDATE "Deal" d SET basins = a.basins, formations = a.formations
--     FROM archive.basin_formation_20261027 a
--    WHERE a.source_table = 'Deal' AND a.row_id = d.id;
--   (same shape for "Opportunity" and "BuyBoxCriteria"; "ResearchPermit" and
--   "ResearchWell" restore the single "formation" column.)

CREATE SCHEMA IF NOT EXISTS archive;

CREATE TABLE IF NOT EXISTS archive.basin_formation_20261027 (
  source_table text NOT NULL,
  row_id       text NOT NULL,
  basins       text[],
  formations   text[],
  formation    text,
  archived_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, row_id)
);

-- 1. Archive every row that carries a value.
INSERT INTO archive.basin_formation_20261027 (source_table, row_id, basins, formations)
SELECT 'Deal', "id", "basins", "formations" FROM "Deal"
 WHERE cardinality(coalesce("basins", '{}')) > 0 OR cardinality(coalesce("formations", '{}')) > 0
ON CONFLICT (source_table, row_id) DO UPDATE SET basins = EXCLUDED.basins, formations = EXCLUDED.formations;

INSERT INTO archive.basin_formation_20261027 (source_table, row_id, basins, formations)
SELECT 'Opportunity', "id", "basins", "formations" FROM "Opportunity"
 WHERE cardinality(coalesce("basins", '{}')) > 0 OR cardinality(coalesce("formations", '{}')) > 0
ON CONFLICT (source_table, row_id) DO UPDATE SET basins = EXCLUDED.basins, formations = EXCLUDED.formations;

INSERT INTO archive.basin_formation_20261027 (source_table, row_id, basins, formations)
SELECT 'BuyBoxCriteria', "id", "basins", "formations" FROM "BuyBoxCriteria"
 WHERE cardinality(coalesce("basins", '{}')) > 0 OR cardinality(coalesce("formations", '{}')) > 0
ON CONFLICT (source_table, row_id) DO UPDATE SET basins = EXCLUDED.basins, formations = EXCLUDED.formations;

INSERT INTO archive.basin_formation_20261027 (source_table, row_id, formation)
SELECT 'ResearchPermit', "id", "formation" FROM "ResearchPermit"
 WHERE coalesce("formation", '') <> ''
ON CONFLICT (source_table, row_id) DO UPDATE SET formation = EXCLUDED.formation;

INSERT INTO archive.basin_formation_20261027 (source_table, row_id, formation)
SELECT 'ResearchWell', "id", "formation" FROM "ResearchWell"
 WHERE coalesce("formation", '') <> ''
ON CONFLICT (source_table, row_id) DO UPDATE SET formation = EXCLUDED.formation;

-- 2. Verify: every value that is about to be dropped is in the archive, exactly.
DO $$
DECLARE missing bigint;
BEGIN
  SELECT count(*) INTO missing FROM "Deal" t
   WHERE (cardinality(coalesce(t."basins", '{}')) > 0 OR cardinality(coalesce(t."formations", '{}')) > 0)
     AND NOT EXISTS (SELECT 1 FROM archive.basin_formation_20261027 a
                      WHERE a.source_table = 'Deal' AND a.row_id = t."id"
                        AND a.basins IS NOT DISTINCT FROM t."basins" AND a.formations IS NOT DISTINCT FROM t."formations");
  IF missing > 0 THEN RAISE EXCEPTION 'basin/formation archive incomplete: % Deal rows', missing; END IF;

  SELECT count(*) INTO missing FROM "Opportunity" t
   WHERE (cardinality(coalesce(t."basins", '{}')) > 0 OR cardinality(coalesce(t."formations", '{}')) > 0)
     AND NOT EXISTS (SELECT 1 FROM archive.basin_formation_20261027 a
                      WHERE a.source_table = 'Opportunity' AND a.row_id = t."id"
                        AND a.basins IS NOT DISTINCT FROM t."basins" AND a.formations IS NOT DISTINCT FROM t."formations");
  IF missing > 0 THEN RAISE EXCEPTION 'basin/formation archive incomplete: % Opportunity rows', missing; END IF;

  SELECT count(*) INTO missing FROM "BuyBoxCriteria" t
   WHERE (cardinality(coalesce(t."basins", '{}')) > 0 OR cardinality(coalesce(t."formations", '{}')) > 0)
     AND NOT EXISTS (SELECT 1 FROM archive.basin_formation_20261027 a
                      WHERE a.source_table = 'BuyBoxCriteria' AND a.row_id = t."id"
                        AND a.basins IS NOT DISTINCT FROM t."basins" AND a.formations IS NOT DISTINCT FROM t."formations");
  IF missing > 0 THEN RAISE EXCEPTION 'basin/formation archive incomplete: % BuyBoxCriteria rows', missing; END IF;

  SELECT count(*) INTO missing FROM "ResearchPermit" t
   WHERE coalesce(t."formation", '') <> ''
     AND NOT EXISTS (SELECT 1 FROM archive.basin_formation_20261027 a
                      WHERE a.source_table = 'ResearchPermit' AND a.row_id = t."id" AND a.formation = t."formation");
  IF missing > 0 THEN RAISE EXCEPTION 'basin/formation archive incomplete: % ResearchPermit rows', missing; END IF;

  SELECT count(*) INTO missing FROM "ResearchWell" t
   WHERE coalesce(t."formation", '') <> ''
     AND NOT EXISTS (SELECT 1 FROM archive.basin_formation_20261027 a
                      WHERE a.source_table = 'ResearchWell' AND a.row_id = t."id" AND a.formation = t."formation");
  IF missing > 0 THEN RAISE EXCEPTION 'basin/formation archive incomplete: % ResearchWell rows', missing; END IF;
END $$;

-- 3. Drop the columns.
ALTER TABLE "Deal" DROP COLUMN IF EXISTS "basins", DROP COLUMN IF EXISTS "formations";
ALTER TABLE "Opportunity" DROP COLUMN IF EXISTS "basins", DROP COLUMN IF EXISTS "formations";
ALTER TABLE "BuyBoxCriteria" DROP COLUMN IF EXISTS "basins", DROP COLUMN IF EXISTS "formations";
ALTER TABLE "ResearchPermit" DROP COLUMN IF EXISTS "formation";
ALTER TABLE "ResearchWell" DROP COLUMN IF EXISTS "formation";

-- 4. Reference tables and data the removed boot loader built at runtime (not
-- user data: they were derived from the bundled basin / play files, which
-- remain in git history), plus the statewide RRC wells' formations attribute
-- (public RRC data; the bundled RRC well snapshot and RRC's own dbf900 file
-- still carry it). Each step is skipped where the table does not exist.
DO $$
BEGIN
  DROP TABLE IF EXISTS gis.abstract_regions_progress;
  DROP TABLE IF EXISTS gis.abstract_regions;
  DROP TABLE IF EXISTS gis.geo_regions_sub;
  DROP TABLE IF EXISTS gis.geo_regions;
  IF to_regclass('gis.dataset_version') IS NOT NULL THEN
    DELETE FROM gis.dataset_version WHERE key IN ('tx-geo-regions', 'tx-formations');
  END IF;
  IF to_regclass('rrc.wells') IS NOT NULL THEN
    ALTER TABLE rrc.wells DROP COLUMN IF EXISTS formations;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'rrc' AND table_name = 'wells' AND column_name = 'sources') THEN
      UPDATE rrc.wells SET sources = sources - 'formations' WHERE sources ? 'formations';
    END IF;
  END IF;
END $$;
