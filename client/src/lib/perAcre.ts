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

const round2 = (n: number) => Math.round(n * 100) / 100;

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
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
