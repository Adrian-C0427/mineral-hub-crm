/**
 * Simple trend forecasting for monthly report series.
 *
 * Uses ordinary least-squares linear regression over the historical points
 * (x = index, y = value) to project the next N periods. This is intentionally
 * lightweight — enough to show management a data-driven trend line, not a
 * statistical model. Projections are floored at 0 (negative revenue/among
 * count metrics is meaningless here).
 */

export interface LinearFit {
  slope: number;
  intercept: number;
  /** R² goodness-of-fit in [0,1]; 0 when it can't be computed. */
  r2: number;
}

export function linearFit(values: number[]): LinearFit {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 };
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += values[i];
    sxy += i * values[i];
    sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n, r2: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;

  // R²
  const mean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * i + intercept;
    ssTot += (values[i] - mean) ** 2;
    ssRes += (values[i] - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

/** Project the next `periods` values from the historical series (floored at 0). */
export function linearForecast(values: number[], periods: number): number[] {
  if (periods <= 0) return [];
  const fit = linearFit(values);
  const n = values.length;
  const out: number[] = [];
  for (let k = 0; k < periods; k++) {
    const x = n + k;
    out.push(Math.max(0, fit.slope * x + fit.intercept));
  }
  return out;
}

/** Advance a "YYYY-MM" month key by n months. */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
