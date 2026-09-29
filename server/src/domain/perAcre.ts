/**
 * Total price from per-acre pricing — used for both Our Cost (acquisition
 * cost) and Asking Price when the user enters a rate instead of a total.
 *
 * NMA is the primary measure: when both a per-NMA and a per-NRA rate can be
 * applied they describe the same price two ways, so they are never summed —
 * per-NMA × NMA wins and per-NRA × NRA is the fallback. Returns null when no
 * rate has its matching acreage. Mirrored in client/src/lib/perAcre.ts.
 */
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

const round2 = (n: number) => Math.round(n * 100) / 100;
