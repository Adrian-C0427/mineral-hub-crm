/**
 * Rounding helpers for money and other decimal figures. Floats can't represent
 * most cents exactly (0.1 + 0.2 = 0.30000000000000004), so every money figure
 * the API returns goes through these at its boundary:
 *   - roundTo / roundMoney round half away from zero WITHOUT the binary-float
 *     miss that `Math.round(1.005 * 100) / 100` makes (→ 1 instead of 1.01).
 *   - sumMoney adds in whole cents, so a long sum never drifts.
 * Mirrors server/src/domain/money.ts (parity is unit-tested on the server).
 */

/** Round to `dp` decimal places, half away from zero, without float misses. */
export function roundTo(n: number, dp: number): number {
  if (!Number.isFinite(n)) return n;
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  // Shift via the decimal string ("1.005e2" = 100.5 exactly) rather than
  // multiplying (1.005 * 100 = 100.49999999999999).
  const s = String(abs);
  const shifted = s.includes("e") ? abs * 10 ** dp : Number(`${s}e${dp}`);
  const r = Math.round(shifted);
  const back = String(r).includes("e") ? r / 10 ** dp : Number(`${r}e-${dp}`);
  return sign * back || 0; // never -0
}

/** Money to the cent. */
export const roundMoney = (n: number): number => roundTo(n, 2);

/** Money to the cent; null stays null. */
export const roundMoneyOrNull = (n: number | null | undefined): number | null =>
  n == null || !Number.isFinite(n) ? null : roundMoney(n);

/** Sum money exactly: each figure to whole cents, added as integers. */
export function sumMoney(values: Iterable<number | null | undefined>): number {
  let cents = 0;
  for (const v of values) if (v != null && Number.isFinite(v)) cents += Math.round(roundTo(v, 2) * 100);
  return cents / 100;
}

/** Mean of money figures, to the cent; 0 for an empty list (matches avg()). */
export function avgMoney(values: number[]): number {
  return values.length ? roundMoney(sumMoney(values) / values.length) : 0;
}
