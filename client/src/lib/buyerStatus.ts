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
  { v: "PASSED", label: "Passed" },
  { v: "CLOSED", label: "Closed" },
];

/** Sort rank: most-advanced statuses first, PASSED last. */
export const BUYER_STATUS_RANK: Record<string, number> = {
  CLOSED: 0, NEGOTIATING: 1, OFFER_RECEIVED: 2, REVIEWING: 3, INTERESTED: 4, CONTACTED: 5, PASSED: 6,
};
