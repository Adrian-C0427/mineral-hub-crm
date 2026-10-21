import { roundMoney, roundTo } from "./money";

/**
 * Total price from per-acre pricing (Our Cost / Asking Price). NMA is the
 * primary measure: per-NMA × NMA wins, per-NRA × NRA is the fallback — the two
 * rates describe the same price, so they are never summed. Null when no rate
 * has its matching acreage. Mirrors server/src/domain/perAcre.ts.
 */
export function totalFromPerAcre(
  perNma: number | null, nma: number | null, perNra: number | null, nra: number | null,
): { total: number; basis: "NMA" | "NRA" } | null {
  if (perNma != null && nma != null) return { total: round2(perNma * nma), basis: "NMA" };
  if (perNra != null && nra != null) return { total: round2(perNra * nra), basis: "NRA" };
  return null;
}

const round2 = roundMoney;

/** Per-acre price: total ÷ acres, to the cent; null without a positive acreage. */
export function perAcreRate(total: number | null | undefined, acres: number | null | undefined): number | null {
  if (total == null || !Number.isFinite(total) || acres == null || !(acres > 0)) return null;
  return roundMoney(total / acres);
}

/**
 * True when NRA is NMA converted at this royalty (to the 4 places both carry),
 * i.e. the pair describes ONE acreage two ways rather than two measurements.
 */
export function acreageLinked(nma: number | null | undefined, nra: number | null | undefined, royalty: number | null | undefined): boolean {
  const v = nraFromNma(nma ?? null, royalty ?? null);
  return v != null && nra != null && Math.abs(v - nra) < 0.00005;
}

/**
 * Both per-acre prices for one total — THE way the app turns a total into
 * $/NMA and $/NRA (lists, deal page, asset pages, editors all use this):
 *   per NMA = total ÷ NMA, to the cent.
 *   per NRA = per NMA ÷ (royalty × 8) when the acreage pair is linked by the
 *             royalty, i.e. computed through the royalty and the NMA — never
 *             through the 4-decimal NRA. So $7,000/NMA at 1/5 is exactly
 *             $4,375/NRA on every deal, whatever its acreage; otherwise
 *             (NRA entered on its own) total ÷ NRA.
 * Mirrors server/src/domain/perAcre.ts.
 */
export function perAcreRates(
  total: number | null | undefined, nma: number | null | undefined, nra: number | null | undefined, royalty: number | null | undefined,
): { perNma: number | null; perNra: number | null } {
  if (total == null || !Number.isFinite(total)) return { perNma: null, perNra: null };
  const m = nma != null && nma > 0 ? nma : null;
  const r = nra != null && nra > 0 ? nra : null;
  const k = royalty != null && royalty > 0 ? royalty * 8 : null;
  if (k != null && m != null && r != null && acreageLinked(m, r, royalty)) {
    return { perNma: roundMoney(total / m), perNra: roundMoney(total / (m * k)) };
  }
  if (k != null && m == null && r != null) return { perNma: null, perNra: roundMoney(total / r) };
  return { perNma: perAcreRate(total, m), perNra: perAcreRate(total, r) };
}
/** Amount from a per-acre price: rate × acres, to the cent; null without a positive acreage. */
export function amountFromRate(rate: number | null | undefined, acres: number | null | undefined): number | null {
  if (rate == null || !Number.isFinite(rate) || acres == null || !(acres > 0)) return null;
  return roundMoney(rate * acres);
}

/** Find Buyer By offset: every contracted day to close beyond 30 (30 → 0,
 *  40 → 10, 60 → 30, 75 → 45). Mirrors findBuyerByOffsetDays in
 *  server/src/domain/dates.ts. */
export function findBuyerByOffsetDays(daysToClose: number | null): number {
  return Math.max(0, (daysToClose ?? 30) - 30);
}

/**
 * NMA ↔ NRA at a lease royalty rate. NRA is normalized to a 1/8 royalty:
 * NRA = NMA × royalty ÷ 1/8 (10 NMA at 1/4 → 20 NRA; at 1/8 NRA = NMA).
 * Rounded to 4 decimals; null when either input is missing.
 */
export function nraFromNma(nma: number | null, royalty: number | null): number | null {
  if (nma == null || royalty == null || !(royalty > 0)) return null;
  return round4(nma * royalty * 8);
}
export function nmaFromNra(nra: number | null, royalty: number | null): number | null {
  if (nra == null || royalty == null || !(royalty > 0)) return null;
  return round4(nra / (royalty * 8));
}
// The one 4-place rounder (lib/money's string-shift rounding, so 1.00005 →
// 1.0001 rather than the binary miss Math.round(n * 10_000) / 10_000 makes).
const round4 = (n: number) => roundTo(n, 4);
