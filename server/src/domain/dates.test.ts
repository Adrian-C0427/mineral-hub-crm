import { describe, expect, it } from "vitest";
import { CONTRACT_EXTENSION_DAYS, closingIsExtended, formatCalendarDay, nextContractExtension, profitClosingDate } from "./dates.js";

const day = (s: string) => new Date(`${s}T00:00:00Z`);

describe("nextContractExtension", () => {
  const deal = { dateUnderContract: null, originalClosingDate: day("2026-10-01"), findBuyerByDateOverride: null, finalClosingDateOverride: null, daysToClose: null };

  it("extends the auto final closing (original + 15) by 15 calendar days", () => {
    expect(nextContractExtension(deal)).toEqual({ fromDate: day("2026-10-16"), toDate: day("2026-10-31"), days: CONTRACT_EXTENSION_DAYS });
  });

  it("chains from the override once one exists (the previous extension)", () => {
    expect(nextContractExtension({ ...deal, finalClosingDateOverride: day("2026-10-31") })).toEqual({ fromDate: day("2026-10-31"), toDate: day("2026-11-15"), days: 15 });
  });

  it("is null when there is no closing date to extend", () => {
    expect(nextContractExtension({ ...deal, originalClosingDate: null })).toBeNull();
  });
});

describe("formatCalendarDay", () => {
  it("renders the UTC calendar day", () => {
    expect(formatCalendarDay(day("2026-10-31"))).toBe("Oct 31, 2026");
  });
});

describe("profitClosingDate / closingIsExtended", () => {
  // Closing on Mar 25 → the auto Extended closing (Closing + 15) is Apr 9, a different month.
  const base = { dateUnderContract: null, originalClosingDate: day("2026-03-25"), findBuyerByDateOverride: null, finalClosingDateOverride: null, daysToClose: null, extensionCount: 0 };

  it("uses the Closing date when the closing was never extended — never the auto Closing + 15", () => {
    expect(closingIsExtended(base)).toBe(false);
    expect(profitClosingDate(base)).toEqual(day("2026-03-25"));
  });

  it("ignores a stored Extended closing that no Extend action wrote", () => {
    const stored = { ...base, finalClosingDateOverride: day("2026-04-09") };
    expect(closingIsExtended(stored)).toBe(false);
    expect(profitClosingDate(stored)).toEqual(day("2026-03-25"));
  });

  it("uses the Extended closing once Extend Closing ran, and keeps the Closing date as entered", () => {
    const extended = { ...base, finalClosingDateOverride: day("2026-04-24"), extensionCount: 1 };
    expect(closingIsExtended(extended)).toBe(true);
    expect(profitClosingDate(extended)).toEqual(day("2026-04-24"));
    expect(extended.originalClosingDate).toEqual(day("2026-03-25"));
  });

  it("follows edits: a changed Closing date on an unextended deal, a changed Extended closing on an extended one", () => {
    expect(profitClosingDate({ ...base, originalClosingDate: day("2026-05-02") })).toEqual(day("2026-05-02"));
    expect(profitClosingDate({ ...base, originalClosingDate: day("2026-05-02"), finalClosingDateOverride: day("2026-06-01"), extensionCount: 2 })).toEqual(day("2026-06-01"));
  });

  it("falls back to the Closing date when an extension's date was cleared", () => {
    expect(closingIsExtended({ ...base, extensionCount: 1 })).toBe(false);
    expect(profitClosingDate({ ...base, extensionCount: 1 })).toEqual(day("2026-03-25"));
  });

  it("is null for an unextended deal with no Closing date", () => {
    expect(profitClosingDate({ ...base, originalClosingDate: null })).toBeNull();
  });
});
