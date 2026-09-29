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
  it("keeps the standard contract + 15 days for no/30-day closes", () => {
    expect(fbb(undefined)).toBe("2026-10-16");
    expect(fbb(null)).toBe("2026-10-16");
    expect(fbb(30)).toBe("2026-10-16");
  });

  it("adds every day beyond 30 to the buyer-finding window", () => {
    expect(findBuyerByOffsetDays(40)).toBe(25);
    expect(findBuyerByOffsetDays(75)).toBe(60);
    expect(fbb(60)).toBe("2026-11-15"); // still 15 days before the 60-day close
  });

  it("never shortens the window for closes under 30 days", () => {
    expect(findBuyerByOffsetDays(20)).toBe(15);
  });

  it("an explicit override still wins", () => {
    const d = resolveDealDates({ ...base, daysToClose: 75, findBuyerByDateOverride: new Date("2026-10-05T00:00:00Z") });
    expect(d.findBuyerByDate?.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(d.findBuyerByAuto?.toISOString().slice(0, 10)).toBe("2026-11-30");
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
