/**
 * Reports analytics — pure computation over already-fetched, normalized data.
 * Kept database-free so KPI/series math can be unit-tested directly.
 */
import { linearForecast, addMonths } from "./forecast.js";

export interface AnalyticsDeal {
  id: string;
  createdAt: Date;
  stage: string;
  counties: string[];
  basins: string[];
  formations: string[];
  assetTypes: string[];
  operator: string | null;
  askPrice: number | null;
  ourPrice: number | null;
  acceptedAmount: number | null;
  estimatedClosingCosts: number | null;
  relationshipOwnerId: string | null;
  selectedBuyerId: string | null;
  createdByUserId: string | null;
  closedByUserId: string | null;
  dateUnderContract: Date | null;
  closedAt: Date | null;
  deadAt: Date | null;
}

export interface AnalyticsExpense { amount: number; date: Date; reimbursed: boolean }
export interface AnalyticsBuyer { id: string; createdAt: Date; active: boolean }
export interface AnalyticsActivity { date: Date | null; sentByUserId: string | null }
export interface Range { from: Date; to: Date }

const inRange = (d: Date | null, r: Range): boolean => d != null && d >= r.from && d <= r.to;
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const daysBetween = (a: Date, b: Date): number => Math.round((b.getTime() - a.getTime()) / 86400000);

export interface Kpis {
  totalDeals: number;
  dealsAdded: number;
  dealsClosed: number;
  dealsLost: number;
  winRate: number;
  totalDealValue: number;
  avgDealSize: number;
  avgTimeToClose: number; // days
  revenue: number;
  grossProfit: number;
  netProfit: number;
  expenses: number;
  closingCosts: number;
  reimbursementsOutstanding: number;
  activeBuyers: number;
  newBuyers: number;
  buyerActivity: number;
}

export function computeKpis(
  deals: AnalyticsDeal[],
  expenses: AnalyticsExpense[],
  buyers: AnalyticsBuyer[],
  activities: AnalyticsActivity[],
  range: Range,
): Kpis {
  const added = deals.filter((d) => inRange(d.createdAt, range));
  const closed = deals.filter((d) => inRange(d.closedAt, range));
  const lost = deals.filter((d) => inRange(d.deadAt, range));
  const existedByEnd = deals.filter((d) => d.createdAt <= range.to);

  // Cost basis = Our Price (fall back to askPrice for pre-Our-Price deals).
  const grossFees = closed.reduce(
    (s, d) => s + (d.acceptedAmount != null ? d.acceptedAmount - (d.ourPrice ?? d.askPrice ?? 0) : 0),
    0,
  );
  const closingCosts = closed.reduce((s, d) => s + (d.estimatedClosingCosts ?? 0), 0);
  const periodExpenses = expenses.filter((e) => inRange(e.date, range));
  const expenseTotal = periodExpenses.reduce((s, e) => s + e.amount, 0);
  const outstanding = periodExpenses.filter((e) => !e.reimbursed).reduce((s, e) => s + e.amount, 0);

  const acceptedAmounts = closed.map((d) => d.acceptedAmount).filter((n): n is number => n != null);
  const closeDurations = closed
    .filter((d) => d.dateUnderContract && d.closedAt)
    .map((d) => daysBetween(d.dateUnderContract!, d.closedAt!));

  const grossProfit = grossFees - closingCosts;

  return {
    totalDeals: existedByEnd.length,
    dealsAdded: added.length,
    dealsClosed: closed.length,
    dealsLost: lost.length,
    winRate: closed.length + lost.length === 0 ? 0 : closed.length / (closed.length + lost.length),
    totalDealValue: added.reduce((s, d) => s + (d.askPrice ?? 0), 0),
    avgDealSize: avg(acceptedAmounts),
    avgTimeToClose: avg(closeDurations),
    revenue: grossFees,
    grossProfit,
    netProfit: grossProfit - expenseTotal,
    expenses: expenseTotal,
    closingCosts,
    reimbursementsOutstanding: outstanding,
    activeBuyers: buyers.filter((b) => b.active).length,
    newBuyers: buyers.filter((b) => inRange(b.createdAt, range)).length,
    buyerActivity: activities.filter((a) => inRange(a.date, range)).length,
  };
}

/** Percentage change from previous → current; null when previous is 0. */
export function delta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous);
}

function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  let ym = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, "0")}`;
  const end = `${to.getUTCFullYear()}-${String(to.getUTCMonth() + 1).padStart(2, "0")}`;
  // Guard against absurd ranges.
  for (let i = 0; i < 240 && ym <= end; i++) {
    out.push(ym);
    ym = addMonths(ym, 1);
  }
  return out;
}

const ymOf = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export interface MonthPoint {
  month: string;
  dealsAdded: number;
  dealsClosed: number;
  dealsLost: number;
  revenue: number;
  netProfit: number;
  expenses: number;
  forecast?: boolean;
}

/** Monthly time series over the range, with `forecastMonths` projected points appended. */
export function buildMonthlySeries(
  deals: AnalyticsDeal[],
  expenses: AnalyticsExpense[],
  range: Range,
  forecastMonths = 3,
): MonthPoint[] {
  const months = monthsBetween(range.from, range.to);
  const idx = new Map<string, MonthPoint>();
  for (const m of months) {
    idx.set(m, { month: m, dealsAdded: 0, dealsClosed: 0, dealsLost: 0, revenue: 0, netProfit: 0, expenses: 0 });
  }
  for (const d of deals) {
    const a = idx.get(ymOf(d.createdAt));
    if (a) a.dealsAdded++;
    if (d.closedAt) {
      const c = idx.get(ymOf(d.closedAt));
      if (c) {
        c.dealsClosed++;
        const fee = d.acceptedAmount != null ? d.acceptedAmount - (d.ourPrice ?? d.askPrice ?? 0) : 0;
        c.revenue += fee;
        c.netProfit += fee - (d.estimatedClosingCosts ?? 0);
      }
    }
    if (d.deadAt) {
      const l = idx.get(ymOf(d.deadAt));
      if (l) l.dealsLost++;
    }
  }
  for (const e of expenses) {
    const p = idx.get(ymOf(e.date));
    if (p) {
      p.expenses += e.amount;
      p.netProfit -= e.amount;
    }
  }

  const series = months.map((m) => idx.get(m)!);

  if (forecastMonths > 0 && series.length >= 2) {
    const revF = linearForecast(series.map((p) => p.revenue), forecastMonths);
    const npF = linearForecast(series.map((p) => p.netProfit), forecastMonths);
    let last = series[series.length - 1].month;
    for (let k = 0; k < forecastMonths; k++) {
      last = addMonths(last, 1);
      series.push({
        month: last,
        dealsAdded: 0,
        dealsClosed: 0,
        dealsLost: 0,
        revenue: Math.round(revF[k]),
        netProfit: Math.round(npF[k]),
        expenses: 0,
        forecast: true,
      });
    }
  }
  return series;
}

export interface Breakdowns {
  counties: { name: string; count: number }[];
  basins: { name: string; count: number }[];
  formations: { name: string; count: number }[];
  assetTypes: { name: string; count: number }[];
  perUser: { userId: string; created: number; closed: number; activity: number }[];
}

function topCounts(deals: AnalyticsDeal[], pick: (d: AnalyticsDeal) => string[], limit = 10) {
  const m = new Map<string, number>();
  for (const d of deals) for (const v of pick(d)) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}

/** Breakdowns computed over deals ADDED in the range (activity attribution over range). */
export function buildBreakdowns(deals: AnalyticsDeal[], activities: AnalyticsActivity[], range: Range): Breakdowns {
  const added = deals.filter((d) => inRange(d.createdAt, range));
  const perUser = new Map<string, { created: number; closed: number; activity: number }>();
  const bump = (id: string | null, key: "created" | "closed" | "activity") => {
    if (!id) return;
    const u = perUser.get(id) ?? { created: 0, closed: 0, activity: 0 };
    u[key]++;
    perUser.set(id, u);
  };
  for (const d of deals) {
    if (inRange(d.createdAt, range)) bump(d.createdByUserId, "created");
    if (inRange(d.closedAt, range)) bump(d.closedByUserId, "closed");
  }
  for (const a of activities) if (inRange(a.date, range)) bump(a.sentByUserId, "activity");

  return {
    counties: topCounts(added, (d) => d.counties),
    basins: topCounts(added, (d) => d.basins),
    formations: topCounts(added, (d) => d.formations),
    assetTypes: topCounts(added, (d) => d.assetTypes),
    perUser: Array.from(perUser, ([userId, v]) => ({ userId, ...v })),
  };
}
