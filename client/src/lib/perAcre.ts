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

/** Find Buyer By offset: 15 days, plus every contracted day to close beyond 30.
 *  Mirrors findBuyerByOffsetDays in server/src/domain/dates.ts. */
export function findBuyerByOffsetDays(daysToClose: number | null): number {
  return 15 + (daysToClose != null ? Math.max(0, daysToClose - 30) : 0);
}
