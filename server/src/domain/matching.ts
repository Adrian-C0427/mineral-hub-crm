/**
 * Matching engine. Compares a deal against a buyer's buy-box criterion by
 * criterion, weighted to 100 total. Computed LIVE on every request — never cached.
 *
 *   State 20, County 20, Basin 20, Formation 20, Asset Type 10,
 *   Acreage range 5, Price range 5
 *
 * An empty buyer-criteria array matches anything for that criterion.
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

export interface DealForMatch {
  state: string | null;
  county: string | null;
  basin: string | null;
  formation: string | null;
  assetType: string | null;
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
  detail: string;
}

export interface MatchResult {
  /** 0-100, rounded. */
  matchPercent: number;
  matchedWeight: number;
  criteria: CriterionResult[];
  matching: CriterionResult[];
  nonMatching: CriterionResult[];
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
    r: { matched: boolean; detail: string },
  ) => {
    criteria.push({ key, label, weight: MATCH_WEIGHTS[key], matched: r.matched, detail: r.detail });
  };

  push("state", "State", setMatch(deal.state, box.states));
  push("county", "County", setMatch(deal.county, box.counties));
  push("basin", "Basin", setMatch(deal.basin, box.basins));
  push("formation", "Formation", setMatch(deal.formation, box.formations));
  push("assetType", "Asset Type", setMatch(deal.assetType, box.assetTypes));
  push("acreage", "Acreage", rangeMatch(deal.acreageNma, box.minAcreage, box.maxAcreage));
  push("price", "Price", rangeMatch(deal.askPrice, box.minPrice, box.maxPrice));

  const matchedWeight = criteria.filter((c) => c.matched).reduce((sum, c) => sum + c.weight, 0);
  const matchPercent = Math.round((matchedWeight / MATCH_TOTAL_WEIGHT) * 100);

  return {
    matchPercent,
    matchedWeight,
    criteria,
    matching: criteria.filter((c) => c.matched),
    nonMatching: criteria.filter((c) => !c.matched),
  };
}
