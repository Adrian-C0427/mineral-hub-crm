/**
 * Computed metrics — formulas only, NEVER stored.
 *
 *  Close Rate   = closed-and-won deals ÷ deals with >= 1 offer made (per buyer)
 *  Net Profit   = accepted offer amount − our price − manual closing costs
 *  Profit@Ask   = ask price − our price − manual closing costs (no offer involved)
 *  Gross Fee    = accepted offer amount − our price
 *  Avg Deal Size= mean of accepted offer amounts on closed deals
 *  Win Rate     = closed ÷ (closed + dead) within a period
 *  Implied Margin = (ask price − our price) ÷ our price — markup on cost
 *
 * Mirrored (the parts the client computes) in client/src/lib/metrics.ts.
 *
 * COST BASIS = ourPrice (our acquisition cost). Callers pass `ourPrice ?? askPrice`
 * (dealCostBasis) so pre-Our-Price deals (which recorded their cost in askPrice)
 * stay correct.
 *
 * Money results are rounded to the cent here (the boundary), so every surface
 * that shows the same deal's profit shows the same cents — no float tails like
 * 4999.999999999. Sum them with sumMoney (domain/money.ts).
 */
import { roundMoney } from "./money.js";

export function grossFee(acceptedAmount: number, costBasis: number | null): number {
  return roundMoney(acceptedAmount - (costBasis ?? 0));
}

export function netProfit(
  acceptedAmount: number,
  costBasis: number | null,
  closingCosts: number | null,
): number {
  return roundMoney(acceptedAmount - (costBasis ?? 0) - (closingCosts ?? 0));
}

/**
 * Our cost basis for profit: Our Price; for an owned asset recorded with only a
 * Purchase Price, that purchase price (what the asset pages subtract); else Ask
 * Price for pre-Our-Price deals.
 */
export function dealCostBasis(d: { ourPrice: number | null; askPrice: number | null; purchasePrice?: number | null }): number | null {
  return d.ourPrice ?? d.purchasePrice ?? d.askPrice;
}

/** Acquisition cost for Profit at asking price — Our Price, else an owned
 *  asset's Purchase Price; never the ask itself (see profitAtAsk). */
export function acquisitionCost(d: { ourPrice: number | null; purchasePrice?: number | null }): number | null {
  return d.ourPrice ?? d.purchasePrice ?? null;
}

type OfferLike = { id?: string; amount: number; status?: string };

/**
 * The deal's ACCEPTED offer: the one the deal selected (selectedOfferId), else
 * one whose own status is ACCEPTED. Undefined when none is accepted.
 */
export function acceptedOffer<O extends OfferLike>(offers: O[] | undefined, selectedOfferId: string | null | undefined): O | undefined {
  if (!offers?.length) return undefined;
  return (selectedOfferId ? offers.find((o) => o.id === selectedOfferId) : undefined)
    ?? offers.find((o) => o.status === "ACCEPTED");
}

/**
 * The buyer's price a deal's profit is computed from: the accepted offer once
 * there is one (a higher rejected offer never counts), else the best offer so
 * far; null with no offers. The same rule for the deal serializer (Profit Est.,
 * Buyer Purchase Price), the dashboard Projected KPI and its monthly chart.
 */
export function dealSalePrice(offers: OfferLike[] | undefined, selectedOfferId: string | null | undefined): number | null {
  const acc = acceptedOffer(offers, selectedOfferId);
  if (acc) return acc.amount;
  if (!offers?.length) return null;
  return offers.reduce((m, o) => (o.amount > m ? o.amount : m), -Infinity);
}

/** Net profit of a deal at a given buyer price (accepted/best offer). */
export function dealNetProfit(
  price: number,
  d: { ourPrice: number | null; askPrice: number | null; purchasePrice?: number | null; estimatedClosingCosts: number | null },
): number {
  return netProfit(price, dealCostBasis(d), d.estimatedClosingCosts);
}

/**
 * Profit at asking price: what the deal would make if a buyer paid our current
 * asking price. Null when either price is missing — deliberately NO cost-basis
 * fallback here (unlike netProfit callers, which pass `ourPrice ?? askPrice`):
 * a deal without Our Cost has no meaningful asking-price profit, and falling
 * back to askPrice would make it read as exactly −closing costs.
 */
export function profitAtAsk(
  askPrice: number | null,
  ourPrice: number | null,
  closingCosts: number | null,
): number | null {
  if (askPrice == null || ourPrice == null) return null;
  return netProfit(askPrice, ourPrice, closingCosts);
}

/** Plain mean (0 for an empty list). For money use avgMoney (domain/money.ts). */
export function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Implied margin — the deal page header's "Implied margin" ("Asking price over
 * our cost"): (ask − our price) ÷ our price, as a ratio (0.25 = +25%). The
 * formula is kept as it has always been: markup on cost, closing costs NOT
 * deducted — it describes the asking price, not a realized profit. Null when
 * it can't be computed: either price missing, or Our Price not positive. It
 * reads the deal's own Our Price — no dealCostBasis Ask fallback (that would
 * read as a flat 0%) — and a missing price is never treated as $0.
 */
export function impliedMargin(askPrice: number | null | undefined, ourPrice: number | null | undefined): number | null {
  if (askPrice == null || ourPrice == null || !Number.isFinite(askPrice) || !Number.isFinite(ourPrice) || !(ourPrice > 0)) return null;
  return (askPrice - ourPrice) / ourPrice;
}

/**
 * Average implied margin over a set of deals: the SIMPLE mean of each deal's
 * own impliedMargin — every eligible deal weighs the same (not a
 * dollar-weighted Σask ÷ Σcost), so it reads as "the typical deal's margin".
 * Deals whose margin is null (a price missing, Our Price ≤ 0) are left out of
 * the mean and the count alike. `deals` is how many margins were averaged;
 * `value` is null (N/A) when none qualify.
 */
export function averageImpliedMargin(
  deals: { askPrice: number | null; ourPrice: number | null }[],
): { value: number | null; deals: number } {
  const margins = deals.map((d) => impliedMargin(d.askPrice, d.ourPrice)).filter((m): m is number => m != null);
  return { value: margins.length ? avg(margins) : null, deals: margins.length };
}

/** Per-buyer close rate. dealsWithOffer is the denominator (deals where buyer made an offer). */
export function closeRate(closedWon: number, dealsWithOffer: number): number {
  if (dealsWithOffer === 0) return 0;
  return Math.min(1, closedWon / dealsWithOffer);
}

export function winRate(closed: number, dead: number): number {
  const denom = closed + dead;
  if (denom === 0) return 0;
  return closed / denom;
}
