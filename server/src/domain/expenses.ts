import { monthKey } from "./dates.js";

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

  for (const e of expenses) {
    total += e.amount;
    const catName = e.categoryName ?? "Uncategorized";
    byCategory.set(catName, (byCategory.get(catName) ?? 0) + e.amount);
    const ym = monthKey(e.date);
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + e.amount);

    const uid = e.userId ?? "unknown";
    const uname = e.userName ?? "Unknown";
    const u = byUser.get(uid) ?? { name: uname, total: 0, outstanding: 0 };
    u.total += e.amount;
    if (e.reimbursed) {
      reimbursed += e.amount;
      const rym = monthKey(e.reimbursementDate ?? e.date);
      reimbursedByMonth.set(rym, (reimbursedByMonth.get(rym) ?? 0) + e.amount);
    } else {
      u.outstanding += e.amount;
    }
    byUser.set(uid, u);
  }

  const months = Array.from(new Set([...byMonth.keys(), ...reimbursedByMonth.keys()])).sort();

  return {
    totals: {
      totalExpenses: total,
      totalReimbursed: reimbursed,
      totalOutstanding: total - reimbursed,
      companyOutstanding: total - reimbursed,
      count: expenses.length,
    },
    byCategory: Array.from(byCategory, ([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
    byMonth: months.map((ym) => ({
      month: ym,
      expenses: byMonth.get(ym) ?? 0,
      reimbursed: reimbursedByMonth.get(ym) ?? 0,
    })),
    byUser: Array.from(byUser, ([userId, v]) => ({ userId, name: v.name, total: v.total, outstanding: v.outstanding })).sort(
      (a, b) => b.total - a.total,
    ),
    outstandingByUser: Array.from(byUser, ([userId, v]) => ({ userId, name: v.name, outstanding: v.outstanding }))
      .filter((u) => u.outstanding > 0)
      .sort((a, b) => b.outstanding - a.outstanding),
  };
}
