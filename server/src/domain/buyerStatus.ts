/**
 * Buyer pipeline status helpers. `status` (BuyerStatus) is the source of truth;
 * `responseStatus` is the legacy column kept for the one-time backfill. Reads
 * use effectiveStatus so rows are correct even before the backfill runs.
 */
export type BuyerStatus =
  | "CONTACTED" | "INTERESTED" | "REVIEWING" | "OFFER_RECEIVED" | "NEGOTIATING" | "PASSED" | "CLOSED";

export const BUYER_STATUSES: BuyerStatus[] = [
  "CONTACTED", "INTERESTED", "REVIEWING", "OFFER_RECEIVED", "NEGOTIATING", "PASSED", "CLOSED",
];

/** Legacy ResponseStatus → new BuyerStatus. */
export const LEGACY_TO_STATUS: Record<string, BuyerStatus> = {
  PENDING: "CONTACTED",
  INTERESTED: "INTERESTED",
  NOT_INTERESTED: "PASSED",
  PASSED: "PASSED",
  OFFER_MADE: "OFFER_RECEIVED",
};

export function effectiveStatus(a: { status?: string | null; responseStatus?: string | null }): BuyerStatus {
  if (a.status) return a.status as BuyerStatus;
  if (a.responseStatus && LEGACY_TO_STATUS[a.responseStatus]) return LEGACY_TO_STATUS[a.responseStatus];
  return "CONTACTED";
}

/** Statuses that count as an engaged/interested buyer (for the deal metrics row). */
export const ENGAGED_STATUSES: BuyerStatus[] = ["INTERESTED", "REVIEWING", "OFFER_RECEIVED", "NEGOTIATING", "CLOSED"];

/** Sort order for the activity table (hottest first). */
export const STATUS_ORDER: Record<BuyerStatus, number> = {
  CLOSED: 0, NEGOTIATING: 1, OFFER_RECEIVED: 2, REVIEWING: 3, INTERESTED: 4, CONTACTED: 5, PASSED: 6,
};
