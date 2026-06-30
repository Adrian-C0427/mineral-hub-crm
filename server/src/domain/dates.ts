import { DEADLINE_RULES } from "../config.js";

/**
 * SINGLE SOURCE OF TRUTH for deadline math.
 *
 * Find Buyer By  = Date Under Contract + 15 calendar days  (override wins)
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

export function resolveDealDates(deal: DealDateInputs): ResolvedDealDates {
  const findBuyerByAuto = deal.dateUnderContract
    ? addCalendarDays(deal.dateUnderContract, DEADLINE_RULES.FIND_BUYER_BY_DAYS_AFTER_CONTRACT)
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

/** Whole calendar days from `from` until `target` (negative = target is in the past). */
export function daysUntil(target: Date, from: Date = new Date()): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const a = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  const b = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.round((a - b) / MS_PER_DAY);
}
