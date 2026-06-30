import { PRIORITY_RULES } from "../config.js";
import { daysUntil, resolveDealDates, type DealDateInputs } from "./dates.js";

export type Priority = "HIGH" | "MEDIUM" | "LOW";

export interface PriorityInputs extends DealDateInputs {
  selectedBuyerId: string | null;
}

/**
 * Priority is COMPUTED LIVE, never stored.
 *
 *  High   : no buyer AND Find-Buyer-By overdue or <= 5 days away
 *  Medium : no buyer AND Find-Buyer-By 6-10 days away
 *  Low    : buyer assigned (any date), OR no buyer but > 10 days remain
 */
export function computePriority(deal: PriorityInputs, now: Date = new Date()): Priority {
  if (deal.selectedBuyerId) return "LOW";

  const { findBuyerByDate } = resolveDealDates(deal);
  // No buyer and no deadline known => nothing forcing urgency yet.
  if (!findBuyerByDate) return "LOW";

  const days = daysUntil(findBuyerByDate, now);

  if (days <= PRIORITY_RULES.HIGH_THRESHOLD_DAYS) return "HIGH";
  if (days <= PRIORITY_RULES.MEDIUM_THRESHOLD_DAYS) return "MEDIUM";
  return "LOW";
}

/** A deal is "overdue" when it has no buyer and the effective Find-Buyer-By is past. */
export function isOverdue(deal: PriorityInputs, now: Date = new Date()): boolean {
  if (deal.selectedBuyerId) return false;
  const { findBuyerByDate } = resolveDealDates(deal);
  if (!findBuyerByDate) return false;
  return daysUntil(findBuyerByDate, now) < 0;
}
