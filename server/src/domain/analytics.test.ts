import { describe, it, expect } from "vitest";
import {
  computeKpis, delta, buildMonthlySeries, buildBreakdowns, realizedClosedAt, countClosedWithoutDate,
  type AnalyticsDeal, type Range,
} from "./analytics.js";
import { impliedMargin, averageImpliedMargin } from "./metrics.js";

const range: Range = { from: new Date("2026-01-01"), to: new Date("2026-12-31T23:59:59Z") };

const deal = (o: Partial<AnalyticsDeal>): AnalyticsDeal => ({
  id: "d", createdAt: new Date("2026-02-01"), stage: "CLOSED",
  states: [], counties: [], assetTypes: [], operator: null,
  askPrice: null, ourPrice: null, acceptedAmount: null, estimatedClosingCosts: null,
  relationshipOwnerId: null, selectedBuyerId: null, createdByUserId: null, closedByUserId: null,
  dateUnderContract: null, closedAt: null, deadAt: null, ...o,
});

describe("computeKpis", () => {
  it("computes revenue, gross/net profit and win rate", () => {
    const deals = [
      deal({ id: "1", askPrice: 100000, acceptedAmount: 130000, estimatedClosingCosts: 5000, closedAt: new Date("2026-03-01"), dateUnderContract: new Date("2026-02-01") }),
      deal({ id: "2", deadAt: new Date("2026-04-01"), stage: "DEAD" }),
    ];
    const expenses = [{ amount: 8000, date: new Date("2026-03-15"), reimbursed: false }];
    const k = computeKpis(deals, expenses, [], [], range);
    expect(k.revenue).toBe(30000);       // 130k - 100k fee
    expect(k.grossProfit).toBe(25000);   // fee - 5k closing costs
    expect(k.netProfit).toBe(17000);     // gross - 8k expenses
    expect(k.expenses).toBe(8000);
    expect(k.reimbursementsOutstanding).toBe(8000);
    expect(k.dealsClosed).toBe(1);
    expect(k.dealsLost).toBe(1);
    expect(k.winRate).toBeCloseTo(0.5);
    expect(k.avgTimeToClose).toBe(28);   // Feb 1 → Mar 1
  });

  it("uses Our Price as cost basis, falling back to Ask Price when null", () => {
    const withOur = computeKpis(
      [deal({ acceptedAmount: 130000, askPrice: 120000, ourPrice: 100000, closedAt: new Date("2026-03-01") })],
      [], [], [], range,
    );
    expect(withOur.revenue).toBe(30000); // 130k - ourPrice 100k (askPrice ignored)

    const fallback = computeKpis(
      [deal({ acceptedAmount: 130000, askPrice: 100000, ourPrice: null, closedAt: new Date("2026-03-01") })],
      [], [], [], range,
    );
    expect(fallback.revenue).toBe(30000); // falls back to askPrice 100k
  });

  it("Cost per Deal = period expenses ÷ deals closed; ROI = net profit ÷ expenses", () => {
    const deals = [
      deal({ id: "1", ourPrice: 100000, acceptedAmount: 160000, estimatedClosingCosts: 4000, closedAt: new Date("2026-03-01") }),
      deal({ id: "2", ourPrice: 50000, acceptedAmount: 70000, closedAt: new Date("2026-05-01") }),
      deal({ id: "3", ourPrice: 90000, acceptedAmount: 200000, closedAt: new Date("2025-12-31") }), // outside the period
    ];
    const expenses = [
      { amount: 6000, date: new Date("2026-02-10"), reimbursed: true },
      { amount: 4000, date: new Date("2026-06-10"), reimbursed: false },
      { amount: 9999, date: new Date("2025-11-01"), reimbursed: false }, // outside the period
    ];
    const k = computeKpis(deals, expenses, [], [], range);
    // revenue 60k + 20k = 80k; closing costs 4k; expenses 10k → net 66k
    expect(k.dealsClosed).toBe(2);
    expect(k.expenses).toBe(10000);
    expect(k.netProfit).toBe(66000);
    expect(k.costPerDeal).toBe(5000);   // 10k ÷ 2
    expect(k.roiMultiple).toBeCloseTo(6.6); // 66k ÷ 10k
    expect(k.closedWithoutPrice).toBe(0);
  });

  it("Cost per Deal / ROI are N/A (null) when they can't be computed reliably", () => {
    const spend = [{ amount: 5000, date: new Date("2026-02-10"), reimbursed: false }];
    // No closed deals → no cost per deal; ROI is the (fully lost) spend.
    const none = computeKpis([], spend, [], [], range);
    expect(none.costPerDeal).toBeNull();
    expect(none.roiMultiple).toBeCloseTo(-1);
    // No expenses → no ROI, cost per deal is $0.
    const free = computeKpis([deal({ ourPrice: 1, acceptedAmount: 2, closedAt: new Date("2026-03-01") })], [], [], [], range);
    expect(free.roiMultiple).toBeNull();
    expect(free.costPerDeal).toBe(0);
    // Closed deals but none priced → revenue unknown → ROI N/A.
    const unpriced = computeKpis([deal({ ourPrice: 1, closedAt: new Date("2026-03-01") })], spend, [], [], range);
    expect(unpriced.closedWithoutPrice).toBe(1);
    expect(unpriced.roiMultiple).toBeNull();
    expect(unpriced.costPerDeal).toBe(5000);
  });

  it("delta is null for an N/A side", () => {
    expect(delta(null, 5)).toBeNull();
    expect(delta(5, null)).toBeNull();
  });

  it("delta returns null when previous is zero and nonzero now", () => {
    expect(delta(10, 0)).toBeNull();
    expect(delta(0, 0)).toBe(0);
    expect(delta(150, 100)).toBeCloseTo(0.5);
  });
});

describe("implied margin (deal page header) and its Reports average", () => {
  it("is (ask − our price) ÷ our price: markup on cost, closing costs ignored", () => {
    expect(impliedMargin(150_000, 100_000)).toBeCloseTo(0.5);
    expect(impliedMargin(80_000, 100_000)).toBeCloseTo(-0.2);
    expect(impliedMargin(100_000, 100_000)).toBe(0);
    // The deal page shows Math.round(margin × 100): +33% for 40k over 30k.
    expect(Math.round(impliedMargin(40_000, 30_000)! * 100)).toBe(33);
  });

  it("is null (never 0%) when an input is missing or Our Price isn't positive", () => {
    expect(impliedMargin(null, 100_000)).toBeNull();
    expect(impliedMargin(150_000, null)).toBeNull();
    expect(impliedMargin(undefined, undefined)).toBeNull();
    expect(impliedMargin(150_000, 0)).toBeNull();
    expect(impliedMargin(150_000, -5)).toBeNull();
    expect(impliedMargin(Number.NaN, 100_000)).toBeNull();
    expect(impliedMargin(150_000, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("averages per-deal margins (simple mean), skipping deals it can't compute", () => {
    const r = averageImpliedMargin([
      { askPrice: 150_000, ourPrice: 100_000 }, // +50%
      { askPrice: 20_000, ourPrice: 10_000 },   // +100%
      { askPrice: 90_000, ourPrice: 100_000 },  // −10%
      { askPrice: null, ourPrice: 100_000 },    // no ask → excluded
      { askPrice: 50_000, ourPrice: null },     // no cost → excluded
      { askPrice: 50_000, ourPrice: 0 },        // zero cost → excluded
    ]);
    expect(r.deals).toBe(3);
    expect(r.value).toBeCloseTo((0.5 + 1 - 0.1) / 3); // 46.67%, not Σask ÷ Σcost (8.7%)
  });

  it("is N/A (null, 0 deals) with nothing eligible", () => {
    expect(averageImpliedMargin([])).toEqual({ value: null, deals: 0 });
    expect(averageImpliedMargin([{ askPrice: null, ourPrice: null }, { askPrice: 1, ourPrice: 0 }])).toEqual({ value: null, deals: 0 });
  });

  it("KPI covers exactly the deals closed in the period (Closing date), like the other closed-deal KPIs", () => {
    const deals = [
      deal({ id: "1", askPrice: 150_000, ourPrice: 100_000, closedAt: new Date("2026-03-01") }),     // +50%
      deal({ id: "2", askPrice: 110_000, ourPrice: 100_000, closedAt: new Date("2026-06-30") }),     // +10%
      deal({ id: "3", askPrice: 120_000, ourPrice: null, acceptedAmount: 130_000, closedAt: new Date("2026-04-01") }), // no Our Price → excluded
      deal({ id: "4", askPrice: 300_000, ourPrice: 100_000, closedAt: new Date("2025-12-31") }),     // before the period
      deal({ id: "5", askPrice: 300_000, ourPrice: 100_000, closedAt: null }),                       // closed, no Closing date
      deal({ id: "6", stage: "MARKETING", askPrice: 300_000, ourPrice: 100_000 }),                    // open deal
    ];
    const k = computeKpis(deals, [], [], [], range);
    expect(k.dealsClosed).toBe(3);
    expect(k.impliedMarginDeals).toBe(2);
    expect(k.avgImpliedMargin).toBeCloseTo(0.3);
    // The All period / a wider window picks the 2025 deal up too.
    const wide = computeKpis(deals, [], [], [], { from: new Date("2000-01-01"), to: range.to });
    expect(wide.impliedMarginDeals).toBe(3);
    expect(wide.avgImpliedMargin).toBeCloseTo((0.5 + 0.1 + 2) / 3);
    // No eligible closed deal → N/A, and no comparison delta.
    const none = computeKpis([deals[2]], [], [], [], range);
    expect(none.avgImpliedMargin).toBeNull();
    expect(none.impliedMarginDeals).toBe(0);
    expect(delta(none.avgImpliedMargin, k.avgImpliedMargin)).toBeNull();
  });
});

describe("buildMonthlySeries", () => {
  it("appends forecast points flagged forecast=true", () => {
    const deals = [
      deal({ id: "1", acceptedAmount: 110000, askPrice: 100000, closedAt: new Date("2026-01-15") }),
      deal({ id: "2", acceptedAmount: 120000, askPrice: 100000, closedAt: new Date("2026-02-15") }),
    ];
    const s = buildMonthlySeries(deals, [], { from: new Date("2026-01-01"), to: new Date("2026-02-28T23:59:59Z") }, 3);
    expect(s.filter((p) => p.forecast).length).toBe(3);
    expect(s[0].revenue).toBe(10000);
    expect(s[1].revenue).toBe(20000);
  });
});

describe("closed deals key on the Contract Timeline Closing date (originalClosingDate)", () => {
  it("realizedClosedAt is the Closing date of a CLOSED deal and nothing else", () => {
    const closing = new Date("2026-03-31");
    expect(realizedClosedAt({ stage: "CLOSED", originalClosingDate: closing })).toBe(closing);
    expect(realizedClosedAt({ stage: "CLOSED", originalClosingDate: null })).toBeNull();
    // A deal moved back out of CLOSED keeps no realized date even if an old one lingers.
    expect(realizedClosedAt({ stage: "CLOSING", originalClosingDate: closing })).toBeNull();
  });

  it("a CLOSED deal with no Closing Date is in no period, month or per-user count", () => {
    const deals = [
      deal({ id: "dated", ourPrice: 100000, acceptedAmount: 150000, closedAt: new Date("2026-03-01"), closedByUserId: "u1" }),
      deal({ id: "undated", ourPrice: 100000, acceptedAmount: 150000, closedAt: null, closedByUserId: "u1" }),
    ];
    const k = computeKpis(deals, [], [], [], range);
    expect(k.dealsClosed).toBe(1);
    expect(k.revenue).toBe(50000);
    const s = buildMonthlySeries(deals, [], range, 0);
    expect(s.reduce((n, p) => n + p.dealsClosed, 0)).toBe(1);
    expect(buildBreakdowns(deals, [], range).perUser).toEqual([{ userId: "u1", created: 0, closed: 1, activity: 0 }]);
    expect(countClosedWithoutDate(deals)).toBe(1);
    // Only CLOSED deals count as "closed without a date".
    expect(countClosedWithoutDate([deal({ stage: "CLOSING", closedAt: null })])).toBe(0);
  });

  it("the month a deal lands in follows its Closing Date, not when it was entered", () => {
    // Entered in April (createdAt irrelevant to the series' closed bucket), closed on March 31.
    const d = deal({ id: "1", createdAt: new Date("2026-04-02"), ourPrice: 100000, acceptedAmount: 120000, closedAt: new Date("2026-03-31T12:00:00Z") });
    const s = buildMonthlySeries([d], [], { from: new Date("2026-01-01"), to: new Date("2026-06-30T23:59:59Z") }, 0);
    expect(s.find((p) => p.month === "2026-03")?.dealsClosed).toBe(1);
    expect(s.find((p) => p.month === "2026-03")?.revenue).toBe(20000);
    expect(s.find((p) => p.month === "2026-04")?.dealsClosed).toBe(0);
  });
});
