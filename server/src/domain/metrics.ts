/**
 * Computed metrics — formulas only, NEVER stored.
 *
 *  Close Rate   = closed-and-won deals ÷ deals with >= 1 offer made (per buyer)
 *  Net Profit   = accepted offer amount − deal ask price − manual closing costs
 *  Gross Fee    = accepted offer amount − deal ask price
 *  Avg Deal Size= mean of accepted offer amounts on closed deals
 *  Win Rate     = closed ÷ (closed + dead) within a period
 */

export function grossFee(acceptedAmount: number, askPrice: number | null): number {
  return acceptedAmount - (askPrice ?? 0);
}

export function netProfit(
  acceptedAmount: number,
  askPrice: number | null,
  closingCosts: number | null,
): number {
  return acceptedAmount - (askPrice ?? 0) - (closingCosts ?? 0);
}

export function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Per-buyer close rate. dealsWithOffer is the denominator (deals where buyer made an offer). */
export function closeRate(closedWon: number, dealsWithOffer: number): number {
  if (dealsWithOffer === 0) return 0;
  return closedWon / dealsWithOffer;
}

export function winRate(closed: number, dead: number): number {
  const denom = closed + dead;
  if (denom === 0) return 0;
  return closed / denom;
}
