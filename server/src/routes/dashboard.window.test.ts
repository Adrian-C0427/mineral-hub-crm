import { describe, it, expect } from "vitest";
import { dashboardWindow, windowBuckets, profitAtAskSeries, projectedProfitSeries } from "./dashboard.js";
import { closingIsExtended, profitClosingDate } from "../domain/dates.js";

const NOW = new Date("2026-07-15T18:00:00Z");

describe("dashboardWindow CUSTOM", () => {
  it("builds an inclusive custom range (end-exclusive internally)", () => {
    const w = dashboardWindow("CUSTOM", NOW, "2025-03-01", "2025-06-30");
    expect(w.label).toBe("Custom");
    expect(w.start.toISOString()).toBe("2025-03-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2025-07-01T00:00:00.000Z"); // June 30 fully included
  });

  it("falls back to YTD on a malformed or inverted range", () => {
    expect(dashboardWindow("CUSTOM", NOW, "garbage", "2025-06-30").label).toBe("YTD");
    expect(dashboardWindow("CUSTOM", NOW, "2025-06-30", "2025-03-01").label).toBe("YTD");
    expect(dashboardWindow("CUSTOM", NOW, undefined, undefined).label).toBe("YTD");
    // The research.ts lesson: absurd-but-parseable years must not pass.
    expect(dashboardWindow("CUSTOM", NOW, "0202-07-09", "2025-06-30").label).toBe("YTD");
  });
});

describe("dashboardWindow ALL", () => {
  it("covers whole months across the deals' full span", () => {
    const w = dashboardWindow("ALL", NOW, undefined, undefined, { from: new Date("2023-04-18"), to: new Date("2026-07-15") });
    expect(w.label).toBe("All");
    expect(w.start.toISOString()).toBe("2023-04-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    // > 24 months → yearly buckets, current year flagged.
    expect(windowBuckets(w, NOW).map((b) => b.label)).toEqual(["2023", "2024", "2025", "2026"]);
  });

  it("is the current month when there are no dated deals", () => {
    const w = dashboardWindow("ALL", NOW);
    expect(w.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("leaves the existing periods unchanged", () => {
    expect(dashboardWindow(undefined, NOW).label).toBe("YTD");
    expect(dashboardWindow("THIS_MONTH", NOW).label).toBe("This Month");
  });
});

describe("windowBuckets", () => {
  it("spans YTD as the twelve current-year months with the current one flagged", () => {
    const b = windowBuckets(dashboardWindow("YTD", NOW), NOW);
    expect(b).toHaveLength(12);
    expect(b[0].label).toBe("Jan");
    expect(b.findIndex((x) => x.isCurrent)).toBe(6); // July
  });

  it("spans a quarter as three months and a single month as one", () => {
    expect(windowBuckets(dashboardWindow("THIS_QUARTER", NOW), NOW).map((b) => b.label)).toEqual(["Jul", "Aug", "Sep"]);
    expect(windowBuckets(dashboardWindow("LAST_MONTH", NOW), NOW).map((b) => b.label)).toEqual(["Jun"]);
  });

  it("year-qualifies labels outside the current calendar year", () => {
    const b = windowBuckets(dashboardWindow("CUSTOM", NOW, "2025-11-01", "2026-02-28"), NOW);
    expect(b.map((x) => x.label)).toEqual(["Nov '25", "Dec '25", "Jan", "Feb"]);
    expect(b.every((x) => !x.isCurrent)).toBe(true);
  });

  it("switches to yearly buckets past 24 months", () => {
    const b = windowBuckets(dashboardWindow("CUSTOM", NOW, "2020-01-01", "2026-12-31"), NOW);
    expect(b.map((x) => x.label)).toEqual(["2020", "2021", "2022", "2023", "2024", "2025", "2026"]);
    expect(b.filter((x) => x.isCurrent).map((x) => x.label)).toEqual(["2026"]);
  });
});

describe("profitAtAskSeries", () => {
  // Same bucket resolver the route builds over the window's buckets.
  const buckets = windowBuckets(dashboardWindow("YTD", NOW), NOW);
  const bucketIdx = (dt: Date) => buckets.findIndex((b) => dt.getUTCFullYear() === b.y && dt.getUTCMonth() === b.m);
  const deal = (o: { id: string; ask: number | null; our: number | null; costs?: number | null; offers?: number[]; closing?: string | null }) => ({
    id: o.id, name: o.id, stage: "ACTIVE", askPrice: o.ask, ourPrice: o.our, estimatedClosingCosts: o.costs ?? null,
    offers: (o.offers ?? []).map((amount) => ({ amount })), closing: o.closing ?? null,
  });

  it("counts only active deals with no offer and both prices; ask − our cost − closing costs", () => {
    const s = profitAtAskSeries([
      deal({ id: "a", ask: 150000, our: 100000, costs: 5000, closing: "2026-03-10" }),
      deal({ id: "hasOffer", ask: 150000, our: 100000, offers: [120000], closing: "2026-03-10" }), // projected, not here
      deal({ id: "noCost", ask: 150000, our: null, closing: "2026-03-10" }), // no Our Cost → no asking-price profit
      deal({ id: "noAsk", ask: null, our: 100000, closing: "2026-03-10" }),
    ], (d) => d.closing, bucketIdx);
    expect(s.total).toBe(45000);
    expect([...s.byBucket.entries()]).toEqual([[2, 45000]]); // March
    expect(s.bucketDeals).toEqual([{ i: 2, entry: { id: "a", name: "a", stage: "ACTIVE", kind: "atAsk", amount: 150000, profit: 45000, date: "2026-03-10" } }]);
  });

  it("keeps undated and out-of-window deals in the total but off the bars", () => {
    const s = profitAtAskSeries([
      deal({ id: "dated", ask: 50000, our: 40000, closing: "2026-07-01" }),
      deal({ id: "undated", ask: 50000, our: 30000, closing: null }),
      deal({ id: "lastYear", ask: 50000, our: 45000, closing: "2025-12-31" }),
    ], (d) => d.closing, bucketIdx);
    expect(s.total).toBe(10000 + 20000 + 5000);
    expect([...s.byBucket.entries()]).toEqual([[6, 10000]]); // July only
    expect(s.bucketDeals.map((x) => x.entry.id)).toEqual(["dated"]);
  });

  it("sums several deals into one bucket and carries a negative margin through", () => {
    const s = profitAtAskSeries([
      deal({ id: "x", ask: 100000, our: 80000, closing: "2026-05-05" }),
      deal({ id: "y", ask: 100000, our: 110000, costs: 1000, closing: "2026-05-20" }),
    ], (d) => d.closing, bucketIdx);
    expect(s.total).toBe(20000 - 11000);
    expect(s.byBucket.get(4)).toBe(9000);
  });
});

describe("projected and at-asking series — closing month", () => {
  const buckets = windowBuckets(dashboardWindow("YTD", NOW), NOW);
  const bucketIdx = (dt: Date) => buckets.findIndex((b) => dt.getUTCFullYear() === b.y && dt.getUTCMonth() === b.m);
  const day = (s: string) => new Date(`${s}T00:00:00Z`);
  // The same closing rule the route passes to both series.
  type D = ReturnType<typeof deal>;
  const closingOf = (d: D) => profitClosingDate(d);
  const extendedOf = (d: D) => closingIsExtended(d);
  // Closing Mar 25: the auto Extended closing (Closing + 15) is Apr 9.
  const deal = (o: { id: string; offers?: number[]; ask?: number | null; closing?: string | null; override?: string | null; extensions?: number }) => ({
    id: o.id, name: o.id, stage: "ACTIVE", askPrice: o.ask ?? 150000, ourPrice: 100000, estimatedClosingCosts: null,
    offers: (o.offers ?? []).map((amount): { id?: string; amount: number } => ({ amount })), selectedOfferId: null as string | null,
    dateUnderContract: null, originalClosingDate: o.closing === undefined ? day("2026-03-25") : o.closing ? day(o.closing) : null,
    findBuyerByDateOverride: null, finalClosingDateOverride: o.override ? day(o.override) : null, daysToClose: null,
    extensionCount: o.extensions ?? 0,
  });
  const months = (s: { bucketDeals: { i: number; entry: { id: string } }[] }) => Object.fromEntries(s.bucketDeals.map((x) => [x.entry.id, buckets[x.i].label]));

  it("keeps unextended deals in their Closing month in both series, even with a stored Extended closing", () => {
    const deals = [
      deal({ id: "proj", offers: [130000] }),
      deal({ id: "ask" }),
      deal({ id: "projStored", offers: [130000], override: "2026-04-09" }),
      deal({ id: "askStored", override: "2026-04-09" }),
    ];
    expect(months(projectedProfitSeries(deals, closingOf, bucketIdx, extendedOf))).toEqual({ proj: "Mar", projStored: "Mar" });
    expect(months(profitAtAskSeries(deals, closingOf, bucketIdx, extendedOf))).toEqual({ ask: "Mar", askStored: "Mar" });
  });

  it("moves explicitly extended deals to their Extended closing month in both series and flags them", () => {
    const deals = [deal({ id: "proj", offers: [130000], override: "2026-04-24", extensions: 1 }), deal({ id: "ask", override: "2026-04-24", extensions: 1 })];
    const proj = projectedProfitSeries(deals, closingOf, bucketIdx, extendedOf);
    const ask = profitAtAskSeries(deals, closingOf, bucketIdx, extendedOf);
    expect(months(proj)).toEqual({ proj: "Apr" });
    expect(months(ask)).toEqual({ ask: "Apr" });
    expect(proj.bucketDeals[0].entry).toMatchObject({ date: "2026-04-24", extended: true, kind: "projected", profit: 30000 });
    expect(ask.bucketDeals[0].entry).toMatchObject({ date: "2026-04-24", extended: true, kind: "atAsk", profit: 50000 });
  });

  it("re-buckets as soon as the extension status or a date changes", () => {
    const before = deal({ id: "d", offers: [130000] });
    const extended = { ...before, finalClosingDateOverride: day("2026-04-24"), extensionCount: 1 };
    const reExtended = { ...extended, finalClosingDateOverride: day("2026-05-09"), extensionCount: 2 };
    const closingEdited = { ...before, originalClosingDate: day("2026-06-03") };
    for (const [d, m] of [[before, "Mar"], [extended, "Apr"], [reExtended, "May"], [closingEdited, "Jun"]] as const) {
      expect(months(projectedProfitSeries([d], closingOf, bucketIdx, extendedOf))).toEqual({ d: m });
    }
    expect(projectedProfitSeries([before], closingOf, bucketIdx, extendedOf).bucketDeals[0].entry.extended).toBeUndefined();
  });

  it("projected totals match the KPI population: accepted offer wins, every offered deal counts, dated or not", () => {
    const s = projectedProfitSeries([
      { ...deal({ id: "acc", offers: [] }), offers: [{ id: "o1", amount: 120000 }, { id: "o2", amount: 140000 }], selectedOfferId: "o1" },
      deal({ id: "best", offers: [110000, 125000] }),
      deal({ id: "undated", offers: [105000], closing: null }),
      deal({ id: "noOffer" }),
    ], closingOf, bucketIdx, extendedOf);
    expect(s.total).toBe(20000 + 25000 + 5000);
    expect(s.byBucket.get(2)).toBe(45000); // March: acc + best; undated is in the total only
  });
});
