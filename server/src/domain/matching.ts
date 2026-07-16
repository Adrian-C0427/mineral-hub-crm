/**
 * Matching engine. Compares a deal against a buyer's buy-box criterion by
 * criterion, weighted to 100 total. Computed LIVE on every request — never cached.
 *
 *   State 20, County 20, Basin 20, Formation 20, Asset Type 10,
 *   Acreage range 5, Price range 5
 *
 * Scoring is deliberately selective so percentages differentiate buyers
 * instead of clustering at 100:
 *  - a criterion the buyer SPECIFIED and the deal satisfies earns full weight
 *  - a criterion the buyer left open ("accepts any") is compatible but weak
 *    evidence of fit — it earns only ANY_CREDIT of its weight
 *  - a specified criterion the deal fails earns nothing
 * A completely empty buy box therefore scores 25%, not 100%; only buyers whose
 * stated criteria genuinely cover the deal approach the top.
 *
 * An empty buyer-criteria array still *matches* (never disqualifies).
 * Acreage/price use inclusive range checks; a null bound is unbounded.
 */

export const MATCH_WEIGHTS = {
  state: 20,
  county: 20,
  basin: 20,
  formation: 20,
  assetType: 10,
  acreage: 5,
  price: 5,
} as const;

export const MATCH_TOTAL_WEIGHT = Object.values(MATCH_WEIGHTS).reduce((a, b) => a + b, 0); // 100

/** Credit multiplier for unspecified ("accepts any") criteria. */
export const ANY_CREDIT = 0.25;

export interface DealForMatch {
  state: string | null;
  counties: string[];
  basins: string[];
  formations: string[];
  assetTypes: string[];
  acreageNma: number | null;
  askPrice: number | null;
}

export interface BuyBoxForMatch {
  states: string[];
  counties: string[];
  basins: string[];
  formations: string[];
  assetTypes: string[];
  minAcreage: number | null;
  maxAcreage: number | null;
  minPrice: number | null;
  maxPrice: number | null;
}

export interface CriterionResult {
  key: keyof typeof MATCH_WEIGHTS;
  label: string;
  weight: number;
  matched: boolean;
  /** Whether the buyer actually constrained this criterion (vs "accepts any"). */
  specified: boolean;
  detail: string;
}

export interface MatchResult {
  /** 0-100, rounded. */
  matchPercent: number;
  matchedWeight: number;
  criteria: CriterionResult[];
  matching: CriterionResult[];
  nonMatching: CriterionResult[];
  /** How many criteria the buyer's box actually specifies (0–7). A high
   *  matchPercent against a sparse box is weak evidence — the UI shows this
   *  count so "100%" can't masquerade as a thoroughly-vetted fit. */
  criteriaSpecified: number;
  criteriaSpecifiedMatched: number;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Empty buy-box list => matches anything. Otherwise case-insensitive membership. */
function setMatch(dealValue: string | null, allowed: string[]): { matched: boolean; detail: string } {
  if (!allowed || allowed.length === 0) return { matched: true, detail: "buyer accepts any" };
  if (!dealValue) return { matched: false, detail: "deal value missing" };
  const matched = allowed.some((a) => norm(a) === norm(dealValue));
  return { matched, detail: matched ? `matches ${dealValue}` : `${dealValue} not in buy-box` };
}

/**
 * Deal now carries multiple values per criterion. Empty buyer list => matches
 * anything; otherwise a match is any overlap between the deal's values and the
 * buyer's accepted values.
 */
function multiMatch(dealValues: string[], allowed: string[]): { matched: boolean; detail: string } {
  if (!allowed || allowed.length === 0) return { matched: true, detail: "buyer accepts any" };
  if (!dealValues || dealValues.length === 0) return { matched: false, detail: "deal value missing" };
  const allowedSet = new Set(allowed.map(norm));
  const hit = dealValues.find((v) => allowedSet.has(norm(v)));
  return hit
    ? { matched: true, detail: `matches ${hit}` }
    : { matched: false, detail: `${dealValues.join(", ")} not in buy-box` };
}

/** Inclusive range check. Null bounds are unbounded. Missing deal value => no match. */
function rangeMatch(
  dealValue: number | null,
  min: number | null,
  max: number | null,
): { matched: boolean; detail: string } {
  if (min == null && max == null) return { matched: true, detail: "buyer accepts any" };
  if (dealValue == null) return { matched: false, detail: "deal value missing" };
  const okMin = min == null || dealValue >= min;
  const okMax = max == null || dealValue <= max;
  const matched = okMin && okMax;
  const bounds = `${min ?? "−∞"}–${max ?? "∞"}`;
  return { matched, detail: matched ? `within ${bounds}` : `outside ${bounds}` };
}

export function computeMatch(deal: DealForMatch, box: BuyBoxForMatch): MatchResult {
  const criteria: CriterionResult[] = [];

  const push = (
    key: keyof typeof MATCH_WEIGHTS,
    label: string,
    specified: boolean,
    r: { matched: boolean; detail: string },
  ) => {
    criteria.push({ key, label, weight: MATCH_WEIGHTS[key], matched: r.matched, specified, detail: r.detail });
  };

  push("state", "State", box.states.length > 0, setMatch(deal.state, box.states));
  push("county", "County", box.counties.length > 0, multiMatch(deal.counties, box.counties));
  push("basin", "Basin", box.basins.length > 0, multiMatch(deal.basins, box.basins));
  push("formation", "Formation", box.formations.length > 0, multiMatch(deal.formations, box.formations));
  push("assetType", "Asset Type", box.assetTypes.length > 0, multiMatch(deal.assetTypes, box.assetTypes));
  push("acreage", "Acreage", box.minAcreage != null || box.maxAcreage != null, rangeMatch(deal.acreageNma, box.minAcreage, box.maxAcreage));
  push("price", "Price", box.minPrice != null || box.maxPrice != null, rangeMatch(deal.askPrice, box.minPrice, box.maxPrice));

  // Full weight only for criteria the buyer actually constrained AND the deal
  // satisfies; open criteria earn a small compatibility credit. This keeps a
  // sparse buy box from masquerading as a perfect fit.
  const matchedWeight = criteria.reduce((sum, c) => {
    if (!c.matched) return sum;
    return sum + (c.specified ? c.weight : c.weight * ANY_CREDIT);
  }, 0);
  const matchPercent = Math.round((matchedWeight / MATCH_TOTAL_WEIGHT) * 100);
  const specified = criteria.filter((c) => c.specified);

  return {
    matchPercent,
    matchedWeight,
    criteria,
    matching: criteria.filter((c) => c.matched),
    nonMatching: criteria.filter((c) => !c.matched),
    criteriaSpecified: specified.length,
    criteriaSpecifiedMatched: specified.filter((c) => c.matched).length,
  };
}
