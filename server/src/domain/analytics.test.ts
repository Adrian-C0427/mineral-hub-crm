import { describe, it, expect } from "vitest";
import { computeKpis, delta, buildMonthlySeries, type AnalyticsDeal, type Range } from "./analytics.js";

const range: Range = { from: new Date("2026-01-01"), to: new Date("2026-12-31T23:59:59Z") };

const deal = (o: Partial<AnalyticsDeal>): AnalyticsDeal => ({
  id: "d", createdAt: new Date("2026-02-01"), stage: "CLOSED",
  counties: [], basins: [], formations: [], assetTypes: [], operator: null,
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
