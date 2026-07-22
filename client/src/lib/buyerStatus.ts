import type { BuyerStatus } from "../types";

/**
 * SINGLE source for BuyerStatus presentation: the pipeline-ordered option list
 * (dropdowns) and the display rank (most-advanced first, for sorting activity
 * rows). Previously duplicated across LogContactModal and BuyerActivitySection.
 */
export const BUYER_STATUS_OPTIONS: { v: BuyerStatus; label: string }[] = [
  { v: "CONTACTED", label: "Contacted" },
  { v: "INTERESTED", label: "Interested" },
  { v: "REVIEWING", label: "Reviewing" },
  { v: "OFFER_RECEIVED", label: "Offer Received" },
  { v: "NEGOTIATING", label: "Negotiating" },
  { v: "ACCEPTED", label: "Accepted Offer" },
  { v: "PASSED", label: "Passed" },
  { v: "CLOSED", label: "Closed" },
];

/** Sort rank: most-advanced statuses first, PASSED last. */
export const BUYER_STATUS_RANK: Record<string, number> = {
  CLOSED: 0, ACCEPTED: 1, NEGOTIATING: 2, OFFER_RECEIVED: 3, REVIEWING: 4, INTERESTED: 5, CONTACTED: 6, PASSED: 7,
};

/** Display label for a buyer status ("ACCEPTED" → "Accepted Offer"). */
export const buyerStatusLabel = (s: string): string =>
  BUYER_STATUS_OPTIONS.find((o) => o.v === s)?.label ?? s;
