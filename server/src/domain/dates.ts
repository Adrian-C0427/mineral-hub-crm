import { DEADLINE_RULES } from "../config.js";

/**
 * SINGLE SOURCE OF TRUTH for deadline math.
 *
 * Find Buyer By  = Date Under Contract + (Days to Close − 30)  (override wins)
 *                  (30 → contract + 0, 40 → +10, 60 → +30, 75 → +45)
 *                  Without a stored Days to Close, the window is read from
 *                  Original Closing − Date Under Contract; failing that, 30.
 * Final Closing  = Original Closing    + 15 calendar days  (override wins)
 *
 * Every consumer (priority calc, banners, tables, cards, reports) MUST call
 * resolveDealDates — never reimplement this math anywhere else.
 */

export interface DealDateInputs {
  dateUnderContract: Date | null;
  originalClosingDate: Date | null;
  findBuyerByDateOverride: Date | null;
  finalClosingDateOverride: Date | null;
  /** Contracted days to close; null/absent = derived from the closing date. */
  daysToClose?: number | null;
}

export interface ResolvedDealDates {
  dateUnderContract: Date | null;
  originalClosingDate: Date | null;
  /** Effective Find Buyer By (override if present, else auto from contract date). */
  findBuyerByDate: Date | null;
  /** Effective Final Closing (override if present, else auto from original closing). */
  finalClosingDate: Date | null;
  findBuyerByIsOverridden: boolean;
  finalClosingIsOverridden: boolean;
  /** The auto-computed values, regardless of override (for "revert to auto" UI). */
  findBuyerByAuto: Date | null;
  finalClosingAuto: Date | null;
}

export function addCalendarDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Calendar days from contract to the auto Find-Buyer-By for a given close
 *  window: every contracted day beyond 30 (never negative). */
export function findBuyerByOffsetDays(daysToClose: number | null | undefined): number {
  return Math.max(0, (daysToClose ?? DEADLINE_RULES.STANDARD_DAYS_TO_CLOSE) - DEADLINE_RULES.STANDARD_DAYS_TO_CLOSE);
}

/** The deal's close window: stored Days to Close, else Original Closing − Date Under Contract. */
export function effectiveDaysToClose(deal: Pick<DealDateInputs, "daysToClose" | "dateUnderContract" | "originalClosingDate">): number | null {
  if (deal.daysToClose != null) return deal.daysToClose;
  if (deal.dateUnderContract && deal.originalClosingDate) {
    const d = daysUntil(deal.originalClosingDate, deal.dateUnderContract);
    return d > 0 ? d : null;
  }
  return null;
}

export function resolveDealDates(deal: DealDateInputs): ResolvedDealDates {
  const findBuyerByAuto = deal.dateUnderContract
    ? addCalendarDays(deal.dateUnderContract, findBuyerByOffsetDays(effectiveDaysToClose(deal)))
    : null;

  const finalClosingAuto = deal.originalClosingDate
    ? addCalendarDays(deal.originalClosingDate, DEADLINE_RULES.FINAL_CLOSING_DAYS_AFTER_ORIGINAL)
    : null;

  return {
    dateUnderContract: deal.dateUnderContract,
    originalClosingDate: deal.originalClosingDate,
    findBuyerByDate: deal.findBuyerByDateOverride ?? findBuyerByAuto,
    finalClosingDate: deal.finalClosingDateOverride ?? finalClosingAuto,
    findBuyerByIsOverridden: deal.findBuyerByDateOverride != null,
    finalClosingIsOverridden: deal.finalClosingDateOverride != null,
    findBuyerByAuto,
    finalClosingAuto,
  };
}

/** Calendar-month bucket key, e.g. "2026-07" (UTC). */
export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Whole calendar days from `from` until `target` (negative = target is in the past). */
export function daysUntil(target: Date, from: Date = new Date()): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const a = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  const b = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.round((a - b) / MS_PER_DAY);
}
