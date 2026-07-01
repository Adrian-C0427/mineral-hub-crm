import { describe, it, expect } from "vitest";
import { resolveDealDates, daysUntil, addCalendarDays } from "./dates.js";
import { computePriority, isOverdue } from "./priority.js";
import { computeMatch } from "./matching.js";
import { winRate, netProfit, grossFee, closeRate } from "./metrics.js";

const d = (s: string) => new Date(s + "T00:00:00Z");

describe("dates resolver", () => {
  it("auto-computes Find Buyer By as contract + 15 days", () => {
    const r = resolveDealDates({
      dateUnderContract: d("2026-06-01"),
      originalClosingDate: null,
      findBuyerByDateOverride: null,
      finalClosingDateOverride: null,
    });
    expect(r.findBuyerByDate?.toISOString().slice(0, 10)).toBe("2026-06-16");
    expect(r.findBuyerByIsOverridden).toBe(false);
  });

  it("auto-computes Final Closing as original closing + 15 days", () => {
    const r = resolveDealDates({
      dateUnderContract: null,
      originalClosingDate: d("2026-07-01"),
      findBuyerByDateOverride: null,
      finalClosingDateOverride: null,
    });
    expect(r.finalClosingDate?.toISOString().slice(0, 10)).toBe("2026-07-16");
  });

  it("override wins over auto and keeps the auto value available", () => {
    const r = resolveDealDates({
      dateUnderContract: d("2026-06-01"),
      originalClosingDate: null,
      findBuyerByDateOverride: d("2026-06-10"),
      finalClosingDateOverride: null,
    });
    expect(r.findBuyerByDate?.toISOString().slice(0, 10)).toBe("2026-06-10");
    expect(r.findBuyerByIsOverridden).toBe(true);
    expect(r.findBuyerByAuto?.toISOString().slice(0, 10)).toBe("2026-06-16");
  });
});

describe("priority", () => {
  const base = {
    dateUnderContract: null,
    originalClosingDate: null,
    findBuyerByDateOverride: null,
    finalClosingDateOverride: null,
  };
  const now = d("2026-06-30");

  it("buyer assigned => Low regardless of date", () => {
    expect(
      computePriority({ ...base, findBuyerByDateOverride: d("2026-06-01"), selectedBuyerId: "b1" }, now),
    ).toBe("LOW");
  });
  it("no buyer, overdue => High", () => {
    expect(computePriority({ ...base, findBuyerByDateOverride: d("2026-06-25"), selectedBuyerId: null }, now)).toBe("HIGH");
    expect(isOverdue({ ...base, findBuyerByDateOverride: d("2026-06-25"), selectedBuyerId: null }, now)).toBe(true);
  });
  it("no buyer, 5 days away => High", () => {
    expect(computePriority({ ...base, findBuyerByDateOverride: d("2026-07-05"), selectedBuyerId: null }, now)).toBe("HIGH");
  });
  it("no buyer, 8 days away => Medium", () => {
    expect(computePriority({ ...base, findBuyerByDateOverride: d("2026-07-08"), selectedBuyerId: null }, now)).toBe("MEDIUM");
  });
  it("no buyer, 20 days away => Low", () => {
    expect(computePriority({ ...base, findBuyerByDateOverride: d("2026-07-20"), selectedBuyerId: null }, now)).toBe("LOW");
  });
});

describe("matching engine", () => {
  const deal = {
    state: "TX", counties: ["Cherokee"], basins: ["Permian"], formations: ["Wolfcamp"],
    assetTypes: ["Minerals"], acreageNma: 40, askPrice: 100000,
  };
  it("empty buy-box matches everything = 100%", () => {
    const r = computeMatch(deal, {
      states: [], counties: [], basins: [], formations: [], assetTypes: [],
      minAcreage: null, maxAcreage: null, minPrice: null, maxPrice: null,
    });
    expect(r.matchPercent).toBe(100);
  });
  it("partial match sums weights correctly", () => {
    const r = computeMatch(deal, {
      states: ["TX"], counties: ["Other"], basins: [], formations: [], assetTypes: [],
      minAcreage: null, maxAcreage: null, minPrice: null, maxPrice: null,
    });
    // state(20) matched, county(20) not, basin/formation/assetType/acreage/price all open(20+20+10+5+5)=60
    expect(r.matchedWeight).toBe(80);
    expect(r.matchPercent).toBe(80);
  });
  it("range check is inclusive with null bound unbounded", () => {
    const r = computeMatch(deal, {
      states: [], counties: [], basins: [], formations: [], assetTypes: [],
      minAcreage: 40, maxAcreage: null, minPrice: null, maxPrice: 50000,
    });
    const acreage = r.criteria.find((c) => c.key === "acreage")!;
    const price = r.criteria.find((c) => c.key === "price")!;
    expect(acreage.matched).toBe(true); // 40 >= 40 inclusive
    expect(price.matched).toBe(false); // 100000 > 50000
  });
});

describe("metrics", () => {
  it("net profit subtracts ask price and closing costs", () => {
    expect(netProfit(150000, 100000, 5000)).toBe(45000);
    expect(grossFee(150000, 100000)).toBe(50000);
  });
  it("win rate = closed / (closed + dead)", () => {
    expect(winRate(3, 1)).toBe(0.75);
    expect(winRate(0, 0)).toBe(0);
  });
  it("close rate guards divide-by-zero", () => {
    expect(closeRate(2, 4)).toBe(0.5);
    expect(closeRate(0, 0)).toBe(0);
  });
  it("addCalendarDays / daysUntil round-trip", () => {
    expect(daysUntil(addCalendarDays(d("2026-06-01"), 15), d("2026-06-01"))).toBe(15);
  });
});
