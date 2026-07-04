import type { CSSProperties } from "react";

/**
 * Shared recharts <Tooltip> props for a polished, theme-aware, jitter-free
 * tooltip across every chart. isAnimationActive:false stops the position
 * interpolation that makes recharts tooltips flicker/lag behind the cursor;
 * allowEscapeViewBox:false keeps them inside the viewport; the panel/text CSS
 * vars guarantee contrast in both light and dark themes (the old default white
 * background made series text unreadable). Spread as `<Tooltip {...chartTooltip} />`.
 */
export const chartTooltip = {
  contentStyle: {
    background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8,
    boxShadow: "var(--shadow)", fontSize: 12, color: "var(--text)", padding: "8px 11px",
  } as CSSProperties,
  itemStyle: { color: "var(--text)", padding: "1px 0" } as CSSProperties,
  labelStyle: { color: "var(--text-dim)", fontWeight: 600, marginBottom: 4 } as CSSProperties,
  wrapperStyle: { outline: "none", zIndex: 50 } as CSSProperties,
  isAnimationActive: false as const,
  allowEscapeViewBox: { x: false, y: false },
  cursor: { fill: "rgba(148,163,184,0.14)", stroke: "rgba(148,163,184,0.5)" },
};

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
