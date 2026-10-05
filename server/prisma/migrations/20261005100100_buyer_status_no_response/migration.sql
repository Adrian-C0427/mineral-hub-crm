-- One more buyer status option. Adds a value to the list; no row changes.
-- Kept in its own migration: a new enum value cannot be used in the same
-- transaction that adds it.
ALTER TYPE "BuyerStatus" ADD VALUE IF NOT EXISTS 'NO_RESPONSE';
