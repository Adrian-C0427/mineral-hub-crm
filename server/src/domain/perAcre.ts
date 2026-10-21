/**
 * Total price from per-acre pricing — used for both Our Cost (acquisition
 * cost) and Asking Price when the user enters a rate instead of a total.
 *
 * NMA is the primary measure: when both a per-NMA and a per-NRA rate can be
 * applied they describe the same price two ways, so they are never summed —
 * per-NMA × NMA wins and per-NRA × NRA is the fallback. Returns null when no
 * rate has its matching acreage. Mirrored in client/src/lib/perAcre.ts.
 */
import { roundMoney, roundTo } from "./money.js";

export function totalFromPerAcre(
  perNma: number | null | undefined,
  nma: number | null | undefined,
  perNra: number | null | undefined,
  nra: number | null | undefined,
): number | null {
  if (perNma != null && nma != null) return round2(perNma * nma);
  if (perNra != null && nra != null) return round2(perNra * nra);
  return null;
}

// lib/money's rounder, like the client — not Math.round(n * 100) / 100,
// which misses half cents (1.005 → 1).
const round2 = roundMoney;

/**
 * Both per-acre prices for one total. Mirrors client/src/lib/perAcre.ts
 * perAcreRates: per NMA = total ÷ NMA; per NRA goes THROUGH the royalty when
 * NRA is the NMA converted at it (per NMA ÷ (royalty × 8)), else total ÷ NRA.
 */
export function perAcreRates(
  total: number | null | undefined, nma: number | null | undefined, nra: number | null | undefined, royalty: number | null | undefined,
): { perNma: number | null; perNra: number | null } {
  if (total == null || !Number.isFinite(total)) return { perNma: null, perNra: null };
  const m = nma != null && nma > 0 ? nma : null;
  const r = nra != null && nra > 0 ? nra : null;
  const k = royalty != null && royalty > 0 ? royalty * 8 : null;
  const linked = k != null && m != null && r != null && Math.abs(roundTo(m * k, 4) - r) < 0.00005;
  if (linked) return { perNma: roundMoney(total / m!), perNra: roundMoney(total / (m! * k!)) };
  const rate = (acres: number | null) => (acres == null ? null : roundMoney(total / acres));
  return { perNma: rate(m), perNra: rate(r) };
}
