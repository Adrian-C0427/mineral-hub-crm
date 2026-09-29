import { describe, it, expect } from "vitest";
import { resolveDealDates, findBuyerByOffsetDays } from "./dates.js";
import { totalFromPerAcre } from "./perAcre.js";

const base = {
  dateUnderContract: new Date("2026-10-01T00:00:00Z"),
  originalClosingDate: null,
  findBuyerByDateOverride: null,
  finalClosingDateOverride: null,
};
const fbb = (daysToClose: number | null | undefined) =>
  resolveDealDates({ ...base, daysToClose }).findBuyerByDate?.toISOString().slice(0, 10);

describe("Find Buyer By from Days to Close", () => {
  it("gives every contracted day beyond 30 to finding a buyer", () => {
    expect(findBuyerByOffsetDays(30)).toBe(0);
    expect(findBuyerByOffsetDays(40)).toBe(10);
    expect(findBuyerByOffsetDays(50)).toBe(20);
    expect(findBuyerByOffsetDays(60)).toBe(30);
    expect(findBuyerByOffsetDays(75)).toBe(45);
    expect(findBuyerByOffsetDays(90)).toBe(60); // manual entries follow the same rule
    expect(fbb(30)).toBe("2026-10-01");
    expect(fbb(60)).toBe("2026-10-31");
  });

  it("never goes before the contract date for closes under 30 days", () => {
    expect(findBuyerByOffsetDays(20)).toBe(0);
  });

  it("reads the window from the closing date when Days to Close isn't stored", () => {
    const d = resolveDealDates({ ...base, originalClosingDate: new Date("2026-11-30T00:00:00Z") }); // 60-day close
    expect(d.findBuyerByDate?.toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(fbb(undefined)).toBe("2026-10-01"); // no window known → standard 30
  });

  it("an explicit override still wins", () => {
    const d = resolveDealDates({ ...base, daysToClose: 75, findBuyerByDateOverride: new Date("2026-10-05T00:00:00Z") });
    expect(d.findBuyerByDate?.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(d.findBuyerByAuto?.toISOString().slice(0, 10)).toBe("2026-11-15");
  });
});

describe("totalFromPerAcre", () => {
  it("multiplies the per-NMA rate by NMA", () => {
    expect(totalFromPerAcre(2500, 40, null, null)).toBe(100_000);
  });
  it("falls back to per-NRA × NRA", () => {
    expect(totalFromPerAcre(null, 40, 12_000, 5)).toBe(60_000);
    expect(totalFromPerAcre(2500, null, 12_000, 5)).toBe(60_000);
  });
  it("prefers NMA when both rates apply (never sums them)", () => {
    expect(totalFromPerAcre(2500, 40, 12_000, 5)).toBe(100_000);
  });
  it("is null when no rate has its acreage", () => {
    expect(totalFromPerAcre(2500, null, null, 5)).toBeNull();
    expect(totalFromPerAcre(null, null, null, null)).toBeNull();
  });
  it("rounds to cents", () => {
    expect(totalFromPerAcre(1234.567, 3.3333, null, null)).toBe(4115.18);
  });
});
