-- Portal rate-limit counter + branch schema additions that predate migration
-- history (Deal.closedDate and ExpenseCategory.sortOrder were introduced via
-- `db push` in commit 5beb3fd and never captured in a migration). Additive and
-- idempotent (IF NOT EXISTS) so it applies cleanly on prod (which has neither)
-- and is a no-op for the column adds on any dev DB already synced via db push.

-- Deal.closedDate (auto-stamped on first move to CLOSED; editable afterward).
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "closedDate" TIMESTAMP(3);

-- ExpenseCategory.sortOrder (persisted category ordering).
ALTER TABLE "ExpenseCategory" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Database-backed rate limiter for the public buyer-portal submission endpoints.
CREATE TABLE IF NOT EXISTS "PortalRateHit" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PortalRateHit_pkey" PRIMARY KEY ("key","windowStart")
);

CREATE INDEX IF NOT EXISTS "PortalRateHit_windowStart_idx" ON "PortalRateHit"("windowStart");
