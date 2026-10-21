import { nmaFromNra, nraFromNma } from "./perAcre";
import { royaltyValue } from "./royalty";
import { roundMoney, roundTo, sumMoney } from "./money";
import type { DealSummary } from "../types";

/**
 * Blended (weighted-average) acquisition cost per acre across a set of deals:
 *   blended $/NMA = Σ Our cost ÷ Σ NMA        blended $/NRA = Σ Our cost ÷ Σ NRA
 * — the sum of costs over the sum of acreage, NOT the average of each deal's
 * own per-acre price (a $1M/100-acre deal must outweigh a $10K/1-acre one).
 *
 * Per deal: cost is Our Price (acquisition cost); for a seller package the
 * rolled-up figure (own + child assets, each counted once — children never
 * appear in the list themselves) so Additional Assets are included without
 * double-counting. Acreage follows the same roll-up, and either measure fills
 * in from the other at the deal's royalty rate (incl. custom rates) with the
 * app's NMA ↔ NRA conversion. A deal only enters a metric when it has BOTH a
 * cost and that acreage — a priced deal with no NMA would otherwise inflate
 * the blend by adding dollars over zero acres; it is reported in `skipped`.
 */
export type BlendedDeal = Pick<DealSummary,
  "recordType" | "ourPrice" | "purchasePrice" | "acreageNma" | "nra" | "royaltyRate"
> & Partial<Pick<DealSummary, "aggOurPrice" | "aggAcreageNma" | "aggNra" | "assetCount">>;

/** Acquisition cost for the blend: package roll-up, else Our Price, else (owned
 *  assets being sold) what we paid for the asset. Null = no recorded cost. */
export function dealAcquisitionCost(d: BlendedDeal): number | null {
  const c = d.aggOurPrice ?? d.ourPrice ?? (d.recordType === "OWNED_ASSET" ? d.purchasePrice : null) ?? null;
  return c != null && Number.isFinite(c) && c > 0 ? c : null;
}

/** NMA for the blend: roll-up, own value, or converted from NRA at the deal's royalty. */
export function dealNma(d: BlendedDeal): number | null {
  return acreage(d.aggAcreageNma ?? d.acreageNma, () => nmaFromNra(d.aggNra ?? d.nra ?? null, royaltyValue(d.royaltyRate))).value;
}

/** NRA for the blend: roll-up, own value, or converted from NMA at the deal's royalty. */
export function dealNra(d: BlendedDeal): number | null {
  return acreage(d.aggNra ?? d.nra, () => nraFromNma(d.aggAcreageNma ?? d.acreageNma ?? null, royaltyValue(d.royaltyRate))).value;
}

/** The entered acreage when it's positive, else the royalty conversion (flagged). */
function acreage(own: number | null | undefined, convert: () => number | null): { value: number | null; converted: boolean } {
  if (own != null && Number.isFinite(own)) return { value: own > 0 ? own : null, converted: false };
  const v = convert();
  return { value: v != null && v > 0 ? v : null, converted: v != null && v > 0 };
}

export interface BlendedCost {
  /** Σ cost ÷ Σ NMA over the deals that have both; null when that acreage is 0. */
  perNma: number | null;
  perNra: number | null;
  /** The sums behind each rate (what the sub-line explains). */
  costNma: number; nma: number; countNma: number;
  costNra: number; nra: number; countNra: number;
  /** Deals with a recorded cost, and Σ of those costs (all of them, acreage or not). */
  priced: number; cost: number;
  /** Priced deals left out of each rate for lacking that acreage. */
  skippedNma: number; skippedNra: number;
  /** Counted deals whose acreage came from the royalty conversion (not entered). */
  convertedNma: number; convertedNra: number;
}

export function blendedCost(rows: readonly BlendedDeal[]): BlendedCost {
  const costsNma: number[] = []; const costsNra: number[] = []; const costs: number[] = [];
  let nma = 0; let nra = 0; let skippedNma = 0; let skippedNra = 0; let convertedNma = 0; let convertedNra = 0;
  for (const d of rows) {
    const cost = dealAcquisitionCost(d);
    if (cost == null) continue;
    costs.push(cost);
    const a = acreage(d.aggAcreageNma ?? d.acreageNma, () => nmaFromNra(d.aggNra ?? d.nra ?? null, royaltyValue(d.royaltyRate)));
    if (a.value != null) { costsNma.push(cost); nma += a.value; if (a.converted) convertedNma++; } else skippedNma++;
    const r = acreage(d.aggNra ?? d.nra, () => nraFromNma(d.aggAcreageNma ?? d.acreageNma ?? null, royaltyValue(d.royaltyRate)));
    if (r.value != null) { costsNra.push(cost); nra += r.value; if (r.converted) convertedNra++; } else skippedNra++;
  }
  const costNma = sumMoney(costsNma); const costNra = sumMoney(costsNra);
  // Acreage is summed at the 4 places NMA ↔ NRA uses so float tails never show.
  nma = roundTo(nma, 4); nra = roundTo(nra, 4);
  return {
    perNma: nma > 0 ? roundMoney(costNma / nma) : null,
    perNra: nra > 0 ? roundMoney(costNra / nra) : null,
    costNma, nma, countNma: costsNma.length,
    costNra, nra, countNra: costsNra.length,
    priced: costs.length, cost: sumMoney(costs),
    skippedNma, skippedNra, convertedNma, convertedNra,
  };
}
