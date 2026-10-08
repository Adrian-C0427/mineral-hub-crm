import { describe, it, expect } from "vitest";
import { dashboardWindow, windowBuckets, profitAtAskSeries } from "./dashboard.js";

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
