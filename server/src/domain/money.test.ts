import { describe, it, expect } from "vitest";
import { roundTo, roundMoney, roundMoneyOrNull, sumMoney, avgMoney } from "./money.js";
import { acceptedOffer, closeRate, dealCostBasis, dealNetProfit, dealSalePrice, grossFee, netProfit, profitAtAsk, acquisitionCost } from "./metrics.js";
import { computeKpis, buildMonthlySeries, type AnalyticsDeal } from "./analytics.js";
import { aggregateExpenseDashboard } from "./expenses.js";

describe("money rounding", () => {
  it("rounds half away from zero without binary-float misses", () => {
    expect(Math.round(1.005 * 100) / 100).toBe(1); // the bug this replaces
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(-0.004)).toBe(0); // never -0
    expect(Object.is(roundMoney(-0.004), -0)).toBe(false);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundTo(1.00005, 4)).toBe(1.0001);
    expect(roundTo(1e-7, 2)).toBe(0);
    expect(roundMoneyOrNull(null)).toBeNull();
  });

  it("sums in whole cents so long sums never drift", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney(Array(10).fill(0.1))).toBe(1);
    expect(sumMoney([1234.56, null, undefined, 0.44])).toBe(1235);
    expect(sumMoney([])).toBe(0);
  });

  it("averages to the cent", () => {
    expect(avgMoney([10, 20, 20])).toBe(16.67);
    expect(avgMoney([])).toBe(0);
  });
});

describe("deal profit — one rule everywhere", () => {
  const offers = [
    { id: "a", amount: 50_000, status: "REJECTED" },
    { id: "b", amount: 42_000, status: "ACCEPTED" },
    { id: "c", amount: 45_000, status: "ACTIVE" },
  ];

  it("sale price = the accepted offer (selected, else ACCEPTED status), else the best offer", () => {
    expect(dealSalePrice(offers, "c")).toBe(45_000);          // the deal's selection wins
    expect(dealSalePrice(offers, null)).toBe(42_000);         // ACCEPTED status, not the higher rejected one
    expect(dealSalePrice(offers.map((o) => ({ ...o, status: "ACTIVE" })), null)).toBe(50_000); // best offer
    expect(dealSalePrice([], null)).toBeNull();
    expect(dealSalePrice(undefined, null)).toBeNull();
    expect(acceptedOffer(offers, null)?.id).toBe("b");
  });

  it("netProfit = accepted offer − Our Price − closing costs, to the cent", () => {
    expect(netProfit(40_000.1, 30_000.05, 1234.33)).toBe(8765.72);
    expect(grossFee(40_000.1, 30_000.05)).toBe(10_000.05);
    expect(dealNetProfit(45_000, { ourPrice: 30_000, askPrice: 50_000, estimatedClosingCosts: 1500 })).toBe(13_500);
  });

  it("cost basis: Our Price, else an owned asset's Purchase Price, else Ask Price (legacy)", () => {
    expect(dealCostBasis({ ourPrice: 30_000, askPrice: 50_000, purchasePrice: 20_000 })).toBe(30_000);
    expect(dealCostBasis({ ourPrice: null, askPrice: 50_000, purchasePrice: 20_000 })).toBe(20_000);
    expect(dealCostBasis({ ourPrice: null, askPrice: 50_000 })).toBe(50_000);
    expect(acquisitionCost({ ourPrice: null, purchasePrice: 20_000 })).toBe(20_000);
    expect(profitAtAsk(50_000, acquisitionCost({ ourPrice: null, purchasePrice: 20_000 }), 1000)).toBe(29_000);
    expect(profitAtAsk(50_000, acquisitionCost({ ourPrice: null }), 1000)).toBeNull();
  });

  it("close rate never reads above 100%", () => {
    expect(closeRate(3, 2)).toBe(1);
    expect(closeRate(1, 4)).toBe(0.25);
    expect(closeRate(0, 0)).toBe(0);
  });
});

describe("report aggregates carry no float tails", () => {
  const base: AnalyticsDeal = {
    id: "d", createdAt: new Date("2026-01-05T00:00:00Z"), stage: "CLOSED", states: [], counties: [], basins: [], formations: [], assetTypes: [],
    operator: null, askPrice: null, ourPrice: null, acceptedAmount: null, estimatedClosingCosts: null, relationshipOwnerId: null,
    selectedBuyerId: null, createdByUserId: null, closedByUserId: null, dateUnderContract: null, closedAt: new Date("2026-02-10T00:00:00Z"), deadAt: null,
  };
  const range = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-12-31T23:59:59Z") };
  const deals: AnalyticsDeal[] = [
    { ...base, id: "1", acceptedAmount: 10_000.1, ourPrice: 9_000, estimatedClosingCosts: 0.2 },
    { ...base, id: "2", acceptedAmount: 20_000.2, ourPrice: 18_000, estimatedClosingCosts: 0.1 },
    { ...base, id: "3", acceptedAmount: null, ourPrice: 5_000 }, // closed without a price
  ];
  const expenses = [0.1, 0.2, 0.3].map((amount) => ({ amount, date: new Date("2026-02-01T00:00:00Z"), reimbursed: false }));

  it("KPIs: revenue, closing costs, expenses and net profit to the cent", () => {
    const k = computeKpis(deals, expenses, [], [], range);
    expect(k.revenue).toBe(3000.3);
    expect(k.closingCosts).toBe(0.3);
    expect(k.expenses).toBe(0.6);
    expect(k.grossProfit).toBe(3000);
    expect(k.netProfit).toBe(2999.4);
    expect(k.avgDealSize).toBe(15_000.15);
    expect(k.costPerDeal).toBe(0.2);
    expect(k.closedWithoutPrice).toBe(1);
  });

  it("monthly series sums match the KPIs", () => {
    const feb = buildMonthlySeries(deals, expenses, range, 0).find((p) => p.month === "2026-02")!;
    expect(feb.revenue).toBe(3000.3);
    expect(feb.expenses).toBe(0.6);
    expect(feb.netProfit).toBe(2999.4);
  });

  it("expense dashboard totals", () => {
    const d = aggregateExpenseDashboard([0.1, 0.2, 0.7].map((amount, i) => ({
      amount, date: new Date("2026-03-01T00:00:00Z"), reimbursed: i === 2, reimbursementDate: null, categoryName: null, userId: "u", userName: "U",
    })));
    expect(d.totals.totalExpenses).toBe(1);
    expect(d.totals.totalOutstanding).toBe(0.3);
    expect(d.byUser[0].outstanding).toBe(0.3);
  });
});
