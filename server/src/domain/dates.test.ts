import { describe, expect, it } from "vitest";
import { CONTRACT_EXTENSION_DAYS, formatCalendarDay, nextContractExtension } from "./dates.js";

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
