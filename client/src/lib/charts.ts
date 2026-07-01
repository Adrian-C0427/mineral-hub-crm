/** Shared chart palette so Expenses and Reports look consistent. */
export const CHART_COLORS = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#14b8a6", // teal
];

export const COLOR_EXPENSE = "#ef4444";
export const COLOR_REIMBURSED = "#22c55e";
export const COLOR_REVENUE = "#3b82f6";
export const COLOR_PROFIT = "#22c55e";
export const COLOR_FORECAST = "#8b5cf6";

/** Format a "YYYY-MM" month key as "Mon YY" for chart axes. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}
