import { describe, it, expect } from "vitest";
import {
  computeKpis, delta, buildMonthlySeries, buildBreakdowns, realizedClosedAt, countClosedWithoutDate,
  type AnalyticsDeal, type Range,
} from "./analytics.js";

const range: Range = { from: new Date("2026-01-01"), to: new Date("2026-12-31T23:59:59Z") };

const deal = (o: Partial<AnalyticsDeal>): AnalyticsDeal => ({
  id: "d", createdAt: new Date("2026-02-01"), stage: "CLOSED",
  states: [], counties: [], basins: [], formations: [], assetTypes: [], operator: null,
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

describe("closed deals key on the Closing Date", () => {
  it("realizedClosedAt is the Closing Date of a CLOSED deal and nothing else", () => {
    const closing = new Date("2026-03-31");
    expect(realizedClosedAt({ stage: "CLOSED", closedDate: closing })).toBe(closing);
    expect(realizedClosedAt({ stage: "CLOSED", closedDate: null })).toBeNull();
    // A deal moved back out of CLOSED keeps no realized date even if an old one lingers.
    expect(realizedClosedAt({ stage: "CLOSING", closedDate: closing })).toBeNull();
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
