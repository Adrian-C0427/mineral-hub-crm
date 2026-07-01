import { describe, it, expect } from "vitest";
import { aggregateExpenseDashboard, type ExpenseInput } from "./expenses.js";

const e = (o: Partial<ExpenseInput>): ExpenseInput => ({
  amount: 0,
  date: new Date("2026-01-15"),
  reimbursed: false,
  reimbursementDate: null,
  categoryName: null,
  userId: "u1",
  userName: "Alice",
  ...o,
});

describe("aggregateExpenseDashboard", () => {
  it("computes totals, reimbursed, and outstanding", () => {
    const d = aggregateExpenseDashboard([
      e({ amount: 100, reimbursed: true, reimbursementDate: new Date("2026-01-20") }),
      e({ amount: 250, reimbursed: false }),
      e({ amount: 50, reimbursed: false, userId: "u2", userName: "Bob" }),
    ]);
    expect(d.totals.totalExpenses).toBe(400);
    expect(d.totals.totalReimbursed).toBe(100);
    expect(d.totals.totalOutstanding).toBe(300);
    expect(d.totals.companyOutstanding).toBe(300);
    expect(d.totals.count).toBe(3);
  });

  it("breaks down outstanding by user (only users with a balance)", () => {
    const d = aggregateExpenseDashboard([
      e({ amount: 100, reimbursed: true, reimbursementDate: new Date("2026-01-20"), userId: "u1", userName: "Alice" }),
      e({ amount: 250, reimbursed: false, userId: "u2", userName: "Bob" }),
    ]);
    expect(d.outstandingByUser).toEqual([{ userId: "u2", name: "Bob", outstanding: 250 }]);
    expect(d.byUser.find((u) => u.userId === "u1")?.outstanding).toBe(0);
  });

  it("groups by category and month, sorted", () => {
    const d = aggregateExpenseDashboard([
      e({ amount: 30, categoryName: "SMS", date: new Date("2026-02-01") }),
      e({ amount: 70, categoryName: "Dialer", date: new Date("2026-01-10") }),
      e({ amount: 10, categoryName: null, date: new Date("2026-01-10") }),
    ]);
    expect(d.byCategory[0]).toEqual({ name: "Dialer", amount: 70 });
    expect(d.byCategory.find((c) => c.name === "Uncategorized")?.amount).toBe(10);
    expect(d.byMonth.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(d.byMonth[0].expenses).toBe(80);
  });
});
