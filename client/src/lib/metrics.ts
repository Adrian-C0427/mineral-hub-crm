/**
 * Computed deal metrics the client shows itself. Mirrors
 * server/src/domain/metrics.ts (parity is unit-tested on the server), so the
 * deal page and the Reports KPIs compute from one formula.
 */

/**
 * Implied margin — the deal page header's "Implied margin" ("Asking price over
 * our cost"): (ask − our price) ÷ our price, as a ratio (0.25 = +25%). The
 * formula is kept as it has always been: markup on cost, closing costs NOT
 * deducted. Null when either price is missing or Our Price isn't positive — a
 * missing price is never treated as $0.
 */
export function impliedMargin(askPrice: number | null | undefined, ourPrice: number | null | undefined): number | null {
  if (askPrice == null || ourPrice == null || !Number.isFinite(askPrice) || !Number.isFinite(ourPrice) || !(ourPrice > 0)) return null;
  return (askPrice - ourPrice) / ourPrice;
}
