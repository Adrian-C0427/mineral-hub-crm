-- Session invalidation on password change.
-- Stamped into every session JWT; attachUser rejects tokens carrying a stale
-- value. Default 0 matches the implicit epoch of already-issued tokens, so
-- existing sessions survive the deploy.
ALTER TABLE "User" ADD COLUMN "sessionEpoch" INTEGER NOT NULL DEFAULT 0;
