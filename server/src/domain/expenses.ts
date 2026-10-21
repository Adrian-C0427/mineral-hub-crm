import { monthKey } from "./dates.js";
import { roundMoney as r2 } from "./money.js";

/**
 * Expense dashboard aggregation — pure function so the money math is unit-tested
 * independently of the database/route layer.
 */

export interface ExpenseInput {
  amount: number;
  date: Date;
  reimbursed: boolean;
  reimbursementDate: Date | null;
  categoryName: string | null;
  userId: string | null;
  userName: string | null;
}

export interface ExpenseDashboard {
  totals: {
    totalExpenses: number;
    totalReimbursed: number;
    totalOutstanding: number;
    companyOutstanding: number;
    count: number;
  };
  byCategory: { name: string; amount: number }[];
  byMonth: { month: string; expenses: number; reimbursed: number }[];
  byUser: { userId: string; name: string; total: number; outstanding: number }[];
  outstandingByUser: { userId: string; name: string; outstanding: number }[];
}

export function aggregateExpenseDashboard(expenses: ExpenseInput[]): ExpenseDashboard {
  let total = 0;
  let reimbursed = 0;
  const byCategory = new Map<string, number>();
  const byMonth = new Map<string, number>();
  const byUser = new Map<string, { name: string; total: number; outstanding: number }>();
  const reimbursedByMonth = new Map<string, number>();

  // Every running sum is kept in whole cents (an integer), so a long list never
  // drifts by a cent and total − reimbursed is exactly the outstanding figure.
  for (const e of expenses) {
    const amount = Math.round(r2(e.amount) * 100);
    total += amount;
    const catName = e.categoryName ?? "Uncategorized";
    byCategory.set(catName, (byCategory.get(catName) ?? 0) + amount);
    const ym = monthKey(e.date);
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + amount);

    const uid = e.userId ?? "unknown";
    const uname = e.userName ?? "Unknown";
    const u = byUser.get(uid) ?? { name: uname, total: 0, outstanding: 0 };
    u.total += amount;
    if (e.reimbursed) {
      reimbursed += amount;
      const rym = monthKey(e.reimbursementDate ?? e.date);
      reimbursedByMonth.set(rym, (reimbursedByMonth.get(rym) ?? 0) + amount);
    } else {
      u.outstanding += amount;
    }
    byUser.set(uid, u);
  }
  const dollars = (cents: number) => cents / 100;

  const months = Array.from(new Set([...byMonth.keys(), ...reimbursedByMonth.keys()])).sort();

  return {
    totals: {
      // Running sums are rounded to the cent once, here (no float tails).
      totalExpenses: dollars(total),
      totalReimbursed: dollars(reimbursed),
      totalOutstanding: dollars(total - reimbursed),
      companyOutstanding: dollars(total - reimbursed),
      count: expenses.length,
    },
    byCategory: Array.from(byCategory, ([name, amount]) => ({ name, amount: dollars(amount) })).sort((a, b) => b.amount - a.amount),
    byMonth: months.map((ym) => ({
      month: ym,
      expenses: dollars(byMonth.get(ym) ?? 0),
      reimbursed: dollars(reimbursedByMonth.get(ym) ?? 0),
    })),
    byUser: Array.from(byUser, ([userId, v]) => ({ userId, name: v.name, total: dollars(v.total), outstanding: dollars(v.outstanding) })).sort(
      (a, b) => b.total - a.total,
    ),
    outstandingByUser: Array.from(byUser, ([userId, v]) => ({ userId, name: v.name, outstanding: dollars(v.outstanding) }))
      .filter((u) => u.outstanding > 0)
      .sort((a, b) => b.outstanding - a.outstanding),
  };
}
