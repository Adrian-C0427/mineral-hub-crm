-- Buyer-portal offer submissions start as PENDING_REVIEW (listed on the deal,
-- counted nowhere) until a person confirms them. Existing rows keep their status.
ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'PENDING_REVIEW';
