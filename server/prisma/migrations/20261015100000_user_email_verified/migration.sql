-- Account-security columns on User. ADDITIVE ONLY: two nullable columns.
-- Proven-email marker for SSO auto-linking (see User.emailVerifiedAt).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);

-- Grandfather every existing account as verified, so no current user loses
-- "Sign in with Google/Microsoft". Only addresses set from now on must be proven.
UPDATE "User" SET "emailVerifiedAt" = CURRENT_TIMESTAMP WHERE "emailVerifiedAt" IS NULL;

-- Last accepted TOTP time step (replay protection; see User.totpLastUsedStep).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpLastUsedStep" INTEGER;
