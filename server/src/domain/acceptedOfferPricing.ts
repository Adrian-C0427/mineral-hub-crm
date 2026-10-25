import { perAcreRates } from "./perAcre.js";
import { roundMoney } from "./money.js";
import { royaltyValue } from "./royalty.js";

/**
 * An accepted buyer offer controls the deal's asking price.
 *
 * The accepted amount is the authoritative total; the per-acre figures are
 * derived from it with the ONE per-acre formula every screen uses
 * (perAcreRates: $/NMA = total ÷ NMA, $/NRA through the royalty when the two
 * acreages are linked, else total ÷ NRA). Acreage the deal lacks yields no
 * per-acre figure rather than a wrong one — the total is always kept.
 *
 * Which offer controls: the deal's SELECTED offer (Deal.selectedOfferId —
 * the established primary-offer rule). Accepting an offer makes it the
 * selection; a later edit of that offer's amount re-syncs; an accepted offer
 * that is not the selection never moves the price.
 */
export interface AskPrices { askPrice: number | null; askPricePerNma: number | null; askPricePerNra: number | null }

export function askFromAcceptedOffer(amount: number, deal: { acreageNma: number | null; nra: number | null; royaltyRate: string | null }): AskPrices {
  const total = roundMoney(amount);
  const { perNma, perNra } = perAcreRates(total, deal.acreageNma, deal.nra, royaltyValue(deal.royaltyRate));
  return { askPrice: total, askPricePerNma: perNma, askPricePerNra: perNra };
}

/** True when the deal's asking price already reflects these values (nothing to write). */
export function sameAsk(a: AskPrices, b: AskPrices): boolean {
  const eq = (x: number | null, y: number | null) => (x == null && y == null) || (x != null && y != null && Math.abs(x - y) < 0.005);
  return eq(a.askPrice, b.askPrice) && eq(a.askPricePerNma, b.askPricePerNma) && eq(a.askPricePerNra, b.askPricePerNra);
}

/**
 * Cost basis to keep when the asking price takes the offer's value. Profit
 * est. = accepted offer − cost basis − closing costs, and the cost basis
 * falls back to the asking price for deals recorded before Our Price existed
 * (domain/metrics.ts dealCostBasis). Such a deal would otherwise read its own
 * accepted offer as its cost — so its previous asking price is kept as Our
 * Price first. Null when the deal already has a cost basis of its own.
 */
export function legacyCostBasisToKeep(deal: { ourPrice: number | null; purchasePrice: number | null; askPrice: number | null }): number | null {
  if (deal.ourPrice != null || deal.purchasePrice != null) return null;
  return deal.askPrice != null ? roundMoney(deal.askPrice) : null;
}
