-- Scope BuyerTag to an organization. Previously BuyerTag.name was globally
-- unique, so one tenant's tag rows were shared across every organization. This
-- migration adds organizationId, splits any shared tag into per-org copies,
-- repoints the buyer<->tag join rows, and enforces (organizationId, name).
--
-- Runs inside a single transaction (Postgres transactional DDL), so any failure
-- rolls the whole thing back — it is safe to re-apply after a rolled-back state.

-- 1. Add the column (nullable for the duration of the backfill).
ALTER TABLE "BuyerTag" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- 2. Drop the OLD global-name unique index FIRST. The per-org backfill below
--    inserts rows that reuse a name already present on the legacy global row
--    (and shares names across orgs), which would violate this index if it were
--    still in place — this ordering is the whole fix for the failed deploy.
DROP INDEX IF EXISTS "BuyerTag_name_key";

-- 3. Create one org-scoped tag per (organization, name) actually in use.
--    DISTINCT runs in the subquery so each pair yields exactly one new row; the
--    id is generated in the outer SELECT (cuid-shaped, unique per row).
INSERT INTO "BuyerTag" ("id", "organizationId", "name")
SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text || u.org || u.name), 1, 24), u.org, u.name
FROM (
  SELECT DISTINCT b."organizationId" AS org, t."name" AS name
  FROM "BuyerTagOnBuyer" j
  JOIN "Buyer" b ON b."id" = j."buyerId"
  JOIN "BuyerTag" t ON t."id" = j."tagId"
  WHERE b."organizationId" IS NOT NULL
) u;

-- 4. Repoint each join row from the old global tag to its org-scoped copy.
UPDATE "BuyerTagOnBuyer" j
SET "tagId" = nt."id"
FROM "Buyer" b, "BuyerTag" ot, "BuyerTag" nt
WHERE j."buyerId" = b."id"
  AND j."tagId" = ot."id"
  AND ot."organizationId" IS NULL
  AND nt."organizationId" = b."organizationId"
  AND nt."name" = ot."name";

-- 5. Delete the now-orphaned global rows. Any join rows still pointing at them
--    belong to org-less (defunct) buyers and cascade away via the FK.
DELETE FROM "BuyerTag" WHERE "organizationId" IS NULL;

-- 6. Enforce the new shape: required org, per-org unique name, FK with cascade.
ALTER TABLE "BuyerTag" ALTER COLUMN "organizationId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "BuyerTag_organizationId_name_key" ON "BuyerTag"("organizationId", "name");
ALTER TABLE "BuyerTag"
  ADD CONSTRAINT "BuyerTag_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
