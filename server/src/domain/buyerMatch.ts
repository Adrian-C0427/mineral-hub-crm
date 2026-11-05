/**
 * Buyer matching engine — scores how likely each buyer is to want ONE deal.
 * Pure: every input is handed in (the service layer loads it), so the whole
 * model is unit-tested and the same code runs the historical backtest.
 *
 * Five weighted components, each 0–100 on its own, combined into one 0–100
 * score (docs/buyer-matching.md):
 *
 *   geography     where the buyer has actually bought, relative to this deal
 *                 (same abstract → adjacent → within a few miles → same county
 *                 → neighbouring county), from the Research deed records
 *   buyBox        the criteria the buyer stated on their profile
 *   activity      how actively the buyer is buying right now (time-decayed)
 *   relationship  our own history with the buyer (closed deals, offers, passes,
 *                 responses) — never outbound email alone
 *   fit           demonstrated purchase patterns vs this deal (asset type, size)
 *
 * Rules that keep the number honest:
 *  - A component with NO evidence is "unknown": it scores the neutral prior
 *    (NEUTRAL) — never a positive — and lowers the match confidence instead.
 *  - A component with evidence AGAINST (bought only far away, passed on our
 *    deals, fails stated criteria) scores low. Unknown ≠ negative.
 *  - Hard buy-box requirements make a buyer INELIGIBLE; they do not move the
 *    weighted score. Preferences move the score only.
 *  - Confidence (data completeness) is reported beside the score and is never
 *    folded into it.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MatchWeights { geography: number; buyBox: number; activity: number; relationship: number; fit: number }

/**
 * Default weights. The brief's starting point was 35/25/15/15/10; the backtest
 * on Carsa's 35 deals with offers (scripts/buyerMatchBacktest.ts, report in
 * docs/reports) found relationship history more predictive than its 15% and
 * demonstrated-pattern fit barely predictive, so relationship took 10 points
 * from buy box and fit. Geography stays the largest factor. Override per
 * deploy with BUYER_MATCH_WEIGHTS (config.ts).
 */
export const DEFAULT_MATCH_WEIGHTS: MatchWeights = { geography: 35, buyBox: 20, activity: 15, relationship: 25, fit: 5 };

/** What an unknown component scores: compatible but unproven — below any real
 *  positive evidence, above confirmed negative evidence. */
export const NEUTRAL = 25;

export const MATCH_CONFIG = {
  /** Geographic tiers — the value of one acquisition at that distance (0–1). */
  tiers: {
    sameAbstract: 1.0,
    adjacentAbstract: 0.85,
    within2mi: 0.75,
    within5mi: 0.6,
    within10mi: 0.45,
    within25mi: 0.3,
    sameCounty: 0.25,       // same county, farther than 25 mi or not placeable
    neighborCounty: 0.12,
    elsewhere: 0,
  },
  /** Half-lives in months for the time decay. Location footprints persist
   *  longer than buying tempo does. */
  halfLife: { geography: 24, activity: 12 },
  /** An old acquisition still proves the buyer knows the area: decay floor. */
  geoDecayFloor: 0.35,
  /** Share of the geography score carried by the single best-placed
   *  acquisition; the rest rewards concentration (several nearby). */
  geoBestWeight: 0.75,
  /** Acquisition "mass" at which the concentration bonus is ~63% saturated. */
  geoConcentrationScale: 2.0,
  /** Any acquisition in the last year proves the buyer is buying at all. */
  activityFloor: 20,
  /** Decayed acquisitions at which the activity score is ~63% saturated. */
  activityScale: 3,
  /** A range miss within this fraction of the bound is a near miss, not a fail. */
  nearMissFraction: 0.25,
  /** Miles → metres. */
  mile: 1609.344,
} as const;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface MatchDeal {
  state: string | null;
  counties: string[];
  /** GIS abstract ids ("TX-289182"). */
  abstractIds: string[];
  acreageNma: number | null;
  nra: number | null;
  askPrice: number | null;
  assetTypes: string[];
  operator: string | null;
  leaseStatuses: string[];
  /** Lease royalty as a decimal fraction (3/16 → 0.1875). */
  royalty: number | null;
}

export interface MatchBuyBox {
  states: string[];
  counties: string[];
  assetTypes: string[];
  minAcreage: number | null;
  maxAcreage: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  minNra: number | null;
  maxNra: number | null;
  maxPricePerNma: number | null;
  leaseStatuses: string[];
  operators: string[];
  minRoyalty: number | null;
  strictKeys: string[];
}

export const BUY_BOX_KEYS = ["state", "county", "assetType", "acreage", "nra", "price", "pricePerNma", "leaseStatus", "operator", "royalty"] as const;
export type BuyBoxKey = (typeof BUY_BOX_KEYS)[number];
export const BUY_BOX_LABELS: Record<BuyBoxKey, string> = {
  state: "State", county: "County", assetType: "Asset type", acreage: "Acreage (NMA)", nra: "NRA", price: "Deal size",
  pricePerNma: "Price per NMA", leaseStatus: "Lease status", operator: "Operator", royalty: "Royalty rate",
};

/** One recorded acquisition by the buyer (a Research TRANSACTION record where
 *  the buyer, or a confirmed alias, is a grantee). Already de-duplicated. */
export interface Acquisition {
  docId: string;
  date: Date;
  state: string;
  county: string;
  /** GIS abstract ids the record places it in; empty when the record names
   *  no abstract the layer knows (county-level only). */
  abstractIds: string[];
  /** Normalized instrument type (ResearchDocType). */
  docType: string;
  interestPct: number | null;
  /** Acreage conveyed when the record states it. */
  acreage: number | null;
  /** The same recording: county + instrument number (several rows of one instrument are one acquisition). */
  txKey?: string | null;
  /** Same-day closing group (researchFields.txGroupKey): separate instruments that count once. */
  groupKey?: string | null;
}

/** Where this deal sits, and what lies around it. Built once per deal by the
 *  service from PostGIS; the engine only reads it. */
export interface GeoContext {
  /** True when at least one of the deal's abstracts is in the GIS layer, so
   *  distances and adjacency are real tract geometry. */
  dealLocated: boolean;
  /** Metres from the deal's tract(s) to each nearby abstract (0 = overlaps). */
  distanceM: Map<string, number>;
  /** Abstracts sharing a boundary with the deal's tract(s). */
  adjacent: Set<string>;
  /** County keys ("TX|Leon") touching the deal's counties. */
  neighborCounties: Set<string>;
  /** County keys that have Research transaction records at all. A buyer with
   *  nothing near a deal in a county Research does not cover is unknown, not
   *  absent. */
  coveredCounties: Set<string>;
}

export interface CrmHistory {
  /** CLOSED deals where this buyer was the selected buyer. */
  closedDeals: number;
  closedSameCounty: number;
  /** Offers submitted by the buyer (all statuses). */
  offersMade: number;
  offersAccepted: number;
  offersRejected: number;
  /** Deals the buyer PASSED on; same-county subset. */
  passed: number;
  passedSameCounty: number;
  /** Deals we marketed to the buyer (any activity row). */
  contacted: number;
  /** Activities with a recorded response, and with an engaged status. */
  responded: number;
  engaged: number;
  /** Last inbound/meaningful interaction: a reply, call, meeting, negotiation,
   *  offer or status past Contacted. Outbound emails never count. */
  lastMeaningfulAt: Date | null;
  relationshipStatus: "HOT" | "WARM" | "COLD" | null;
  /** NMA / price of deals this buyer offered on or closed — their demonstrated size range. */
  dealSizes: { nma: number | null; price: number | null }[];
}

export interface MatchBuyer {
  id: string;
  buyBox: MatchBuyBox | null;
  acquisitions: Acquisition[];
  crm: CrmHistory;
}

export interface MatchInput {
  deal: MatchDeal;
  buyer: MatchBuyer;
  geo: GeoContext;
  now: Date;
  weights?: MatchWeights;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type ComponentKey = keyof MatchWeights;
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
export type GeoTier = keyof typeof MATCH_CONFIG.tiers | "none" | "unknown";

export interface MatchComponent {
  key: ComponentKey;
  label: string;
  weight: number;
  /** 0–100, or null when there is no evidence either way. */
  score: number | null;
  /** Plain-language, data-backed reasons (strongest first). */
  reasons: string[];
}

export interface CriterionCheck {
  key: BuyBoxKey;
  label: string;
  specified: boolean;
  strict: boolean;
  /** 1 met, 0.5 near miss, 0 failed; null when the deal lacks the value. */
  result: number | null;
  detail: string;
}

export interface MatchFacts {
  geoTier: GeoTier;
  nearestAcquisitionMiles: number | null;
  nearestAcquisitionDate: string | null;
  sameAbstract: number;
  adjacentAbstract: number;
  within10mi: number;
  sameCounty: number;
  neighborCounty: number;
  totalAcquisitions: number;
  last90d: number;
  last12m: number;
  lastAcquisitionDate: string | null;
  /** The buyer's most recent acquisitions nearest the deal, for display. */
  recentNearby: { docId: string; date: string; county: string; miles: number | null; tier: GeoTier }[];
}

export interface BuyerMatchResult {
  /** 0–100, or null when there is too little evidence to say anything. */
  score: number | null;
  confidence: Confidence;
  /** 0–1 data completeness behind the confidence label. */
  confidenceScore: number;
  eligible: boolean;
  hardConflicts: string[];
  components: MatchComponent[];
  criteria: CriterionCheck[];
  /** The three strongest supporting / opposing facts. */
  highlights: string[];
  facts: MatchFacts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_MONTH = 30.4375 * 86_400_000;
const norm = (s: string) => s.trim().toLowerCase();
const monthsBetween = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / MS_MONTH);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const countyKey = (state: string | null | undefined, county: string) => `${(state ?? "TX").trim().toUpperCase()}|${norm(county)}`;

/** Exponential time decay with a half-life in months. */
export function decay(ageMonths: number, halfLifeMonths: number): number {
  return Math.pow(0.5, ageMonths / halfLifeMonths);
}

/** "Leon" / "Leon County" / "LEON" → the county the deal names, for display. */
function countyLabel(deal: MatchDeal): string {
  const c = deal.counties[0];
  return c ? `${c} County` : "this county";
}

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

interface PlacedAcquisition { acq: Acquisition; tier: GeoTier; value: number; meters: number | null }

/** The closest tier any of the record's abstracts reaches. */
function placeAcquisition(acq: Acquisition, deal: MatchDeal, geo: GeoContext): PlacedAcquisition {
  const T = MATCH_CONFIG.tiers;
  const dealAbstracts = new Set(deal.abstractIds);
  const dealCounties = new Set(deal.counties.map((c) => countyKey(deal.state, c)));
  const inCounty = dealCounties.has(countyKey(acq.state, acq.county));
  let best: { tier: GeoTier; value: number; meters: number | null } = inCounty
    ? { tier: "sameCounty", value: T.sameCounty, meters: null }
    : geo.neighborCounties.has(countyKey(acq.state, acq.county))
      ? { tier: "neighborCounty", value: T.neighborCounty, meters: null }
      : { tier: "none", value: T.elsewhere, meters: null };
  for (const a of acq.abstractIds) {
    let cand: { tier: GeoTier; value: number; meters: number | null } | null = null;
    if (dealAbstracts.has(a)) cand = { tier: "sameAbstract", value: T.sameAbstract, meters: 0 };
    else if (geo.adjacent.has(a)) cand = { tier: "adjacentAbstract", value: T.adjacentAbstract, meters: geo.distanceM.get(a) ?? 0 };
    else {
      const m = geo.distanceM.get(a);
      if (m != null) {
        const mi = m / MATCH_CONFIG.mile;
        if (mi <= 2) cand = { tier: "within2mi", value: T.within2mi, meters: m };
        else if (mi <= 5) cand = { tier: "within5mi", value: T.within5mi, meters: m };
        else if (mi <= 10) cand = { tier: "within10mi", value: T.within10mi, meters: m };
        else if (mi <= 25) cand = { tier: "within25mi", value: T.within25mi, meters: m };
        else if (inCounty) cand = { tier: "sameCounty", value: T.sameCounty, meters: m };
        else cand = { tier: best.tier, value: best.value, meters: m };
      }
    }
    if (cand && (cand.value > best.value || (cand.value === best.value && cand.meters != null && (best.meters == null || cand.meters < best.meters)))) best = cand;
  }
  return { acq, ...best };
}

const TIER_LABEL: Record<GeoTier, string> = {
  sameAbstract: "in the same abstract", adjacentAbstract: "in an adjacent abstract", within2mi: "within 2 miles",
  within5mi: "within 5 miles", within10mi: "within 10 miles", within25mi: "within 25 miles", sameCounty: "in the same county",
  neighborCounty: "in a neighbouring county", elsewhere: "elsewhere", none: "elsewhere", unknown: "at an unknown location",
};

function scoreGeography(deal: MatchDeal, buyer: MatchBuyer, geo: GeoContext, now: Date): { component: MatchComponent; facts: MatchFacts; placed: PlacedAcquisition[] } {
  const placed = buyer.acquisitions.map((a) => placeAcquisition(a, deal, geo));
  const dealCountyKeys = deal.counties.map((c) => countyKey(deal.state, c));
  const covered = dealCountyKeys.some((k) => geo.coveredCounties.has(k));
  const near = placed.filter((p) => p.value > 0);
  const count = (tier: GeoTier) => placed.filter((p) => p.tier === tier).length;
  const within10 = placed.filter((p) => p.meters != null && p.meters <= 10 * MATCH_CONFIG.mile).length;
  const nearest = placed.filter((p) => p.meters != null).sort((a, b) => a.meters! - b.meters!)[0] ?? null;
  const sorted = [...buyer.acquisitions].sort((a, b) => b.date.getTime() - a.date.getTime());
  const months = (d: Date) => monthsBetween(d, now);
  const recentNearby = [...near]
    .sort((a, b) => b.value - a.value || b.acq.date.getTime() - a.acq.date.getTime())
    .slice(0, 5)
    .map((p) => ({ docId: p.acq.docId, date: iso(p.acq.date), county: p.acq.county, miles: p.meters == null ? null : Math.round((p.meters / MATCH_CONFIG.mile) * 10) / 10, tier: p.tier }));
  const bestTier: GeoTier = buyer.acquisitions.length === 0 ? "unknown" : near.sort((a, b) => b.value - a.value)[0]?.tier ?? "none";
  const facts: MatchFacts = {
    geoTier: bestTier,
    nearestAcquisitionMiles: nearest ? Math.round((nearest.meters! / MATCH_CONFIG.mile) * 10) / 10 : null,
    nearestAcquisitionDate: nearest ? iso(nearest.acq.date) : null,
    sameAbstract: count("sameAbstract"), adjacentAbstract: count("adjacentAbstract"), within10mi: within10,
    sameCounty: placed.filter((p) => dealCountyKeys.includes(countyKey(p.acq.state, p.acq.county))).length,
    neighborCounty: count("neighborCounty"),
    totalAcquisitions: buyer.acquisitions.length,
    last90d: buyer.acquisitions.filter((a) => months(a.date) <= 3).length,
    last12m: buyer.acquisitions.filter((a) => months(a.date) <= 12).length,
    lastAcquisitionDate: sorted[0] ? iso(sorted[0].date) : null,
    recentNearby,
  };
  const label = "Geography";
  const weight = 0; // filled by the combiner
  if (buyer.acquisitions.length === 0) {
    return { component: { key: "geography", label, weight, score: null, reasons: ["No recorded acquisitions in Research to place"] }, facts, placed };
  }
  if (near.length === 0) {
    if (!covered) {
      return { component: { key: "geography", label, weight, score: null, reasons: [`Research has no transaction records for ${countyLabel(deal)} yet, so nearby activity cannot be checked`] }, facts, placed };
    }
    return { component: { key: "geography", label, weight, score: 0, reasons: [`No recorded acquisitions in or around ${countyLabel(deal)} (${plural(buyer.acquisitions.length, "acquisition")} recorded elsewhere)`] }, facts, placed };
  }
  // Best placement (an old same-abstract deed still counts for at least half)
  // plus a concentration bonus with diminishing returns.
  let best = 0, mass = 0;
  for (const p of near) {
    const w = Math.max(MATCH_CONFIG.geoDecayFloor, decay(months(p.acq.date), MATCH_CONFIG.halfLife.geography));
    best = Math.max(best, p.value * (0.5 + 0.5 * w));
    mass += p.value * w;
  }
  const concentration = 1 - Math.exp(-mass / MATCH_CONFIG.geoConcentrationScale);
  const bw = MATCH_CONFIG.geoBestWeight;
  const score = Math.round(100 * (bw * best + (1 - bw) * concentration));

  const reasons: string[] = [];
  const ago = (d: Date) => { const m = months(d); return m < 1 ? "this month" : m < 12 ? `${Math.round(m)} mo ago` : `${(m / 12).toFixed(1)} yr ago`; };
  const same = near.filter((p) => p.tier === "sameAbstract");
  const adj = near.filter((p) => p.tier === "adjacentAbstract");
  if (same.length) reasons.push(`Bought ${plural(same.length, "time")} in the same abstract (latest ${ago(same.sort((a, b) => b.acq.date.getTime() - a.acq.date.getTime())[0].acq.date)})`);
  if (adj.length) reasons.push(`${plural(adj.length, "acquisition")} in an adjacent abstract`);
  const close = near.filter((p) => p.meters != null && p.meters <= 10 * MATCH_CONFIG.mile && p.tier !== "sameAbstract" && p.tier !== "adjacentAbstract");
  if (close.length) {
    const recent = close.filter((p) => months(p.acq.date) <= 12).length;
    reasons.push(`${plural(close.length, "acquisition")} within 10 miles${recent ? ` (${recent} in the last 12 months)` : ""}`);
  }
  const county = near.filter((p) => p.tier === "sameCounty" || p.tier === "within25mi");
  if (county.length) reasons.push(`${plural(county.length, "acquisition")} elsewhere in ${countyLabel(deal)}`);
  const neigh = near.filter((p) => p.tier === "neighborCounty");
  if (neigh.length && !same.length && !adj.length && !close.length && !county.length) reasons.push(`Activity only in neighbouring counties (${plural(neigh.length, "acquisition")})`);
  if (!geo.dealLocated && deal.abstractIds.length === 0) reasons.push("Deal has no abstract on file, so distances are county-level only");
  return { component: { key: "geography", label, weight, score, reasons }, facts, placed };
}

// ---------------------------------------------------------------------------
// Buy box
// ---------------------------------------------------------------------------

function rangeCheck(value: number | null, min: number | null, max: number | null, fmt: (n: number) => string): { result: number | null; detail: string } {
  if (value == null) return { result: null, detail: "not entered on the deal" };
  const lo = min == null || value >= min, hi = max == null || value <= max;
  const bounds = `${min != null ? fmt(min) : "any"}–${max != null ? fmt(max) : "any"}`;
  if (lo && hi) return { result: 1, detail: `${fmt(value)} within ${bounds}` };
  const f = MATCH_CONFIG.nearMissFraction;
  const nearLo = min != null && !lo && value >= min * (1 - f);
  const nearHi = max != null && !hi && value <= max * (1 + f);
  if (nearLo || nearHi) return { result: 0.5, detail: `${fmt(value)} just outside ${bounds}` };
  return { result: 0, detail: `${fmt(value)} outside ${bounds}` };
}

function setCheck(values: string[], allowed: string[], what: string): { result: number | null; detail: string } {
  if (values.length === 0) return { result: null, detail: `${what} not entered on the deal` };
  const ok = new Set(allowed.map(norm));
  const hit = values.find((v) => ok.has(norm(v)));
  return hit ? { result: 1, detail: `${hit} is in the buy box` } : { result: 0, detail: `${values.join(", ")} not among ${allowed.join(", ")}` };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const acresFmt = (n: number) => `${Number(n.toFixed(4))} NMA`;
const nraFmt = (n: number) => `${Number(n.toFixed(4))} NRA`;
const pctFmt = (n: number) => `${Number((n * 100).toFixed(4))}%`;

export function checkBuyBox(deal: MatchDeal, box: MatchBuyBox): CriterionCheck[] {
  const strict = new Set(box.strictKeys);
  const out: CriterionCheck[] = [];
  const push = (key: BuyBoxKey, specified: boolean, r: { result: number | null; detail: string }) =>
    out.push({ key, label: BUY_BOX_LABELS[key], specified, strict: strict.has(key), result: specified ? r.result : null, detail: specified ? r.detail : "not stated by the buyer" });
  push("state", box.states.length > 0, setCheck(deal.state ? [deal.state] : [], box.states, "State"));
  push("county", box.counties.length > 0, setCheck(deal.counties, box.counties, "County"));
  push("assetType", box.assetTypes.length > 0, setCheck(deal.assetTypes, box.assetTypes, "Asset type"));
  push("acreage", box.minAcreage != null || box.maxAcreage != null, rangeCheck(deal.acreageNma, box.minAcreage, box.maxAcreage, acresFmt));
  push("nra", box.minNra != null || box.maxNra != null, rangeCheck(deal.nra, box.minNra, box.maxNra, nraFmt));
  push("price", box.minPrice != null || box.maxPrice != null, rangeCheck(deal.askPrice, box.minPrice, box.maxPrice, money));
  const perNma = deal.askPrice != null && deal.acreageNma ? deal.askPrice / deal.acreageNma : null;
  push("pricePerNma", box.maxPricePerNma != null, rangeCheck(perNma, null, box.maxPricePerNma, (n) => `${money(n)}/NMA`));
  push("leaseStatus", box.leaseStatuses.length > 0, setCheck(deal.leaseStatuses, box.leaseStatuses, "Lease status"));
  push("operator", box.operators.length > 0, setCheck(deal.operator ? [deal.operator] : [], box.operators, "Operator"));
  push("royalty", box.minRoyalty != null, rangeCheck(deal.royalty, box.minRoyalty, null, pctFmt));
  return out;
}

function scoreBuyBox(deal: MatchDeal, box: MatchBuyBox | null): { component: MatchComponent; criteria: CriterionCheck[]; hardConflicts: string[] } {
  const label = "Buy box";
  if (!box) return { component: { key: "buyBox", label, weight: 0, score: null, reasons: ["No buy box on the profile"] }, criteria: [], hardConflicts: [] };
  const criteria = checkBuyBox(deal, box);
  const specified = criteria.filter((c) => c.specified);
  const checkable = specified.filter((c) => c.result != null);
  const hardConflicts = specified.filter((c) => c.strict && c.result != null && c.result < 1).map((c) => `${c.label}: ${c.detail} (required)`);
  if (specified.length === 0) return { component: { key: "buyBox", label, weight: 0, score: null, reasons: ["Buy box is empty — no stated criteria"] }, criteria, hardConflicts };
  const reasons: string[] = [];
  const unchecked = specified.filter((c) => c.result == null);
  if (checkable.length === 0) {
    reasons.push(`Buyer states ${specified.map((c) => c.label.toLowerCase()).join(", ")}, but the deal has none of those values entered`);
    return { component: { key: "buyBox", label, weight: 0, score: null, reasons }, criteria, hardConflicts };
  }
  const met = checkable.filter((c) => c.result === 1);
  const nearMiss = checkable.filter((c) => c.result === 0.5);
  const failed = checkable.filter((c) => c.result === 0);
  // Coverage: meeting two stated criteria is weaker evidence than meeting six.
  const coverage = 0.7 + 0.3 * Math.min(1, checkable.length / 5);
  const raw = checkable.reduce((s, c) => s + (c.result ?? 0), 0) / checkable.length;
  const score = Math.round(100 * raw * coverage);
  if (failed.length === 0 && nearMiss.length === 0) reasons.push(`Meets all ${checkable.length} stated ${checkable.length === 1 ? "criterion" : "criteria"} (${met.map((c) => c.label.toLowerCase()).join(", ")})`);
  else {
    for (const c of failed) reasons.push(`${c.label}: ${c.detail}`);
    for (const c of nearMiss) reasons.push(`${c.label}: ${c.detail}`);
    if (met.length) reasons.push(`Meets ${met.map((c) => c.label.toLowerCase()).join(", ")}`);
  }
  if (unchecked.length) reasons.push(`${unchecked.map((c) => c.label).join(", ")} not checked — ${unchecked.length === 1 ? "that value is" : "those values are"} missing on the deal`);
  return { component: { key: "buyBox", label, weight: 0, score, reasons }, criteria, hardConflicts };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function scoreActivity(buyer: MatchBuyer, now: Date): MatchComponent {
  const label = "Recent activity";
  const acqs = buyer.acquisitions;
  const months = (d: Date) => monthsBetween(d, now);
  // A live conversation with us is activity too: a buyer without recent deeds
  // who is talking to us this quarter is not written off.
  const talkedMonths = buyer.crm.lastMeaningfulAt ? months(buyer.crm.lastMeaningfulAt) : null;
  const crmFloor = talkedMonths == null ? 0 : talkedMonths <= 3 ? 40 : talkedMonths <= 12 ? 30 : 0;
  const crmReason = crmFloor ? `In contact with us ${talkedMonths! < 1 ? "this month" : `${Math.round(talkedMonths!)} mo ago`}` : null;
  if (acqs.length === 0) {
    if (crmFloor) return { key: "activity", label, weight: 0, score: crmFloor, reasons: [crmReason!, "No recorded acquisitions in Research"] };
    return { key: "activity", label, weight: 0, score: null, reasons: ["No recorded acquisitions in Research"] };
  }
  const index = acqs.reduce((s, a) => s + decay(months(a.date), MATCH_CONFIG.halfLife.activity), 0);
  const floor = MATCH_CONFIG.activityFloor;
  let score = floor + (100 - floor) * (1 - Math.exp(-index / MATCH_CONFIG.activityScale));
  const last3 = acqs.filter((a) => months(a.date) <= 3).length;
  const last6 = acqs.filter((a) => months(a.date) <= 6).length;
  const prior6 = acqs.filter((a) => months(a.date) > 6 && months(a.date) <= 12).length;
  const last12 = acqs.filter((a) => months(a.date) <= 12).length;
  const last24 = acqs.filter((a) => months(a.date) <= 24).length;
  const reasons: string[] = [];
  if (last3 >= 2) reasons.push(`${plural(last3, "acquisition")} in the last 90 days`);
  if (last12 > 0) reasons.push(`${plural(last12, "acquisition")} in the last 12 months (${plural(acqs.length, "acquisition")} recorded in all)`);
  else {
    score = Math.min(score, 35);
    reasons.push(last24 > 0 ? `No acquisitions in the last 12 months (${plural(last24, "acquisition")} in the 12 before)` : `No acquisitions recorded in the last 24 months`);
  }
  if (last6 >= 3 && last6 >= 2 * Math.max(1, prior6)) { score += 8; reasons.push("Buying pace is accelerating (last 6 months vs the 6 before)"); }
  else if (prior6 >= 3 && last6 <= prior6 / 2) { score -= 8; reasons.push("Buying pace has slowed (last 6 months vs the 6 before)"); }
  if (crmFloor && score < crmFloor) { score = crmFloor; reasons.unshift(crmReason!); }
  return { key: "activity", label, weight: 0, score: Math.round(clamp(score)), reasons };
}

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------

function scoreRelationship(crm: CrmHistory, now: Date): MatchComponent {
  const label = "Relationship";
  const signal = crm.closedDeals || crm.offersMade || crm.passed || crm.contacted || crm.responded || crm.lastMeaningfulAt || (crm.relationshipStatus && crm.relationshipStatus !== "WARM");
  if (!signal) return { key: "relationship", label, weight: 0, score: null, reasons: ["No relationship history yet"] };
  let score = NEUTRAL;
  const reasons: string[] = [];
  // The first closed deal proves they buy from us; the next two add less.
  if (crm.closedDeals) { score += 20 + Math.min(2, crm.closedDeals - 1) * 12; reasons.push(`Closed ${plural(crm.closedDeals, "deal")} with us${crm.closedSameCounty ? ` (${crm.closedSameCounty} in this county)` : ""}`); }
  const openOffers = Math.max(0, crm.offersMade - crm.offersAccepted);
  if (openOffers) { score += Math.min(3, openOffers) * 5; reasons.push(`Made ${plural(crm.offersMade, "offer")} on our deals${crm.offersRejected ? ` (${crm.offersRejected} not accepted)` : ""}`); }
  if (crm.engaged && !crm.closedDeals) { score += Math.min(2, crm.engaged) * 4; reasons.push(`Engaged on ${plural(crm.engaged, "deal")} (interested, reviewing or negotiating)`); }
  else if (crm.responded && !crm.closedDeals && !crm.offersMade) { score += 8; reasons.push(`Responded to ${plural(crm.responded, "outreach", "outreaches")}`); }
  if (crm.passed) { score -= Math.min(3, crm.passed) * 8; reasons.push(`Passed on ${plural(crm.passed, "deal")}${crm.passedSameCounty ? ` (${crm.passedSameCounty} in this county)` : ""}`); }
  if (crm.passedSameCounty) score -= Math.min(2, crm.passedSameCounty) * 6;
  if (crm.contacted >= 3 && crm.responded === 0) { score -= 12; reasons.push(`No response to ${plural(crm.contacted, "deal")} sent`); }
  if (crm.relationshipStatus === "HOT") { score += 8; reasons.push("Marked Hot on the profile"); }
  if (crm.relationshipStatus === "COLD") { score -= 8; reasons.push("Marked Cold on the profile"); }
  if (crm.lastMeaningfulAt) {
    const m = monthsBetween(crm.lastMeaningfulAt, now);
    if (m <= 3) { score += 8; reasons.push(`Last meaningful contact ${m < 1 ? "this month" : `${Math.round(m)} mo ago`}`); }
    else if (m <= 12) { score += 4; reasons.push(`Last meaningful contact ${Math.round(m)} mo ago`); }
    else reasons.push(`Last meaningful contact ${(m / 12).toFixed(1)} yr ago`);
  }
  return { key: "relationship", label, weight: 0, score: Math.round(clamp(score)), reasons };
}

// ---------------------------------------------------------------------------
// Deal fit — demonstrated purchase patterns
// ---------------------------------------------------------------------------

const ROYALTY_TYPES = new Set(["ROYALTY_DEED", "OG_CONVEYANCE"]);
const MINERAL_TYPES = new Set(["MINERAL_DEED", "MINERAL_CONVEYANCE", "QUITCLAIM_MINERAL_DEED", "WARRANTY_MINERAL_DEED", "ASSIGNMENT"]);
const DEAL_ROYALTY = new Set(["RI", "NPRI", "ORRI"]);

function scoreFit(deal: MatchDeal, buyer: MatchBuyer): MatchComponent {
  const label = "Deal fit";
  const subs: number[] = [];
  const reasons: string[] = [];
  // Asset type behaviour from the instrument types the buyer actually takes.
  const typed = buyer.acquisitions.filter((a) => ROYALTY_TYPES.has(a.docType) || MINERAL_TYPES.has(a.docType));
  if (typed.length >= 3 && deal.assetTypes.length) {
    const royaltyShare = typed.filter((a) => ROYALTY_TYPES.has(a.docType)).length / typed.length;
    const wantsRoyalty = deal.assetTypes.some((t) => DEAL_ROYALTY.has(t.toUpperCase()));
    const wantsMineral = deal.assetTypes.some((t) => t.toUpperCase() === "MI");
    const share = Math.max(wantsRoyalty ? royaltyShare : 0, wantsMineral ? 1 - royaltyShare : 0);
    subs.push(share);
    const pct = Math.round(share * 100);
    reasons.push(pct >= 50 ? `${pct}% of recorded acquisitions are ${wantsMineral && share === 1 - royaltyShare ? "mineral" : "royalty"} interests like this deal`
      : `Only ${pct}% of recorded acquisitions are ${wantsMineral && share === 1 - royaltyShare ? "mineral" : "royalty"} interests like this deal`);
  }
  // Size: within the range of deals they have offered on / closed with us, or
  // the acreage their recorded deeds convey.
  const sizes = buyer.crm.dealSizes.map((d) => d.nma).filter((n): n is number => n != null && n > 0);
  const deedAcres = buyer.acquisitions.map((a) => a.acreage).filter((n): n is number => n != null && n > 0);
  const pool = sizes.length >= 2 ? sizes : deedAcres.length >= 3 ? deedAcres : [];
  if (pool.length && deal.acreageNma != null && deal.acreageNma > 0) {
    const lo = Math.min(...pool), hi = Math.max(...pool);
    const inRange = deal.acreageNma >= lo * 0.5 && deal.acreageNma <= hi * 2;
    subs.push(inRange ? 1 : deal.acreageNma < lo * 0.5 ? 0.3 : 0.5);
    reasons.push(inRange ? `Deal size (${acresFmt(deal.acreageNma)}) is within their ${sizes.length >= 2 ? "offer" : "recorded"} range of ${acresFmt(lo)}–${acresFmt(hi)}`
      : `Deal size (${acresFmt(deal.acreageNma)}) is ${deal.acreageNma < lo ? "smaller" : "larger"} than their ${sizes.length >= 2 ? "offer" : "recorded"} range of ${acresFmt(lo)}–${acresFmt(hi)}`);
  }
  const prices = buyer.crm.dealSizes.map((d) => d.price).filter((n): n is number => n != null && n > 0);
  if (prices.length >= 2 && deal.askPrice != null && deal.askPrice > 0 && !pool.length) {
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const inRange = deal.askPrice >= lo * 0.5 && deal.askPrice <= hi * 2;
    subs.push(inRange ? 1 : 0.4);
    reasons.push(inRange ? `Asking price is within the range of deals they have offered on (${money(lo)}–${money(hi)})` : `Asking price is outside the range of deals they have offered on (${money(lo)}–${money(hi)})`);
  }
  if (subs.length === 0) return { key: "fit", label, weight: 0, score: null, reasons: ["Not enough recorded purchases to compare asset type or size"] };
  return { key: "fit", label, weight: 0, score: Math.round(100 * subs.reduce((a, b) => a + b, 0) / subs.length), reasons };
}

// ---------------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------------

export function normalizeWeights(w: Partial<MatchWeights> | null | undefined): MatchWeights {
  const out = { ...DEFAULT_MATCH_WEIGHTS };
  if (w) for (const k of Object.keys(out) as ComponentKey[]) { const v = w[k]; if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v; }
  return out;
}

export function scoreBuyer(input: MatchInput): BuyerMatchResult {
  const { deal, buyer, geo, now } = input;
  const weights = normalizeWeights(input.weights);
  const g = scoreGeography(deal, buyer, geo, now);
  const b = scoreBuyBox(deal, buyer.buyBox);
  const a = scoreActivity(buyer, now);
  const r = scoreRelationship(buyer.crm, now);
  const f = scoreFit(deal, buyer);
  const components: MatchComponent[] = [g.component, b.component, a, r, f].map((c) => ({ ...c, weight: weights[c.key] }));
  const known = components.filter((c) => c.score != null);
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const score = known.length === 0 || totalWeight === 0 ? null
    : Math.round(components.reduce((s, c) => s + c.weight * (c.score ?? NEUTRAL), 0) / totalWeight);

  // Confidence: how much of the evidence we would like to have, we have.
  const boxSpecified = b.criteria.filter((c) => c.specified && c.result != null).length;
  let conf = 0;
  if (g.component.score != null) conf += geo.dealLocated ? 0.35 : 0.2;
  conf += 0.25 * Math.min(1, boxSpecified / 5);
  if (a.score != null) conf += 0.15 * Math.min(1, buyer.acquisitions.length / 3);
  if (r.score != null) conf += 0.15;
  if (f.score != null) conf += 0.1;
  conf = Math.round(conf * 100) / 100;
  const confidence: Confidence = score == null ? "INSUFFICIENT" : conf >= 0.7 ? "HIGH" : conf >= 0.45 ? "MEDIUM" : "LOW";

  const highlights = [
    ...b.hardConflicts,
    ...(g.component.score != null ? g.component.reasons.slice(0, 1) : []),
    ...(r.score != null && r.score !== NEUTRAL ? r.reasons.slice(0, 1) : []),
    ...(b.component.score != null && b.hardConflicts.length === 0 ? b.component.reasons.slice(0, 1) : []),
    ...(a.score != null ? a.reasons.slice(0, 1) : []),
    ...(g.component.score == null ? g.component.reasons.slice(0, 1) : []),
  ].slice(0, 3);

  return {
    score, confidence, confidenceScore: conf,
    eligible: b.hardConflicts.length === 0, hardConflicts: b.hardConflicts,
    components, criteria: b.criteria, highlights, facts: g.facts,
  };
}

/** Ranking order: pinned first, then eligible by score (confidence breaks
 *  ties), then ineligible, excluded last. Buyers without a score sit behind
 *  scored ones in their group. */
export function compareMatches(a: { score: number | null; confidenceScore: number; eligible: boolean; override: string | null; name: string },
  b: { score: number | null; confidenceScore: number; eligible: boolean; override: string | null; name: string }): number {
  const group = (x: typeof a) => (x.override === "EXCLUDE" ? 3 : !x.eligible ? 2 : x.override === "PRIORITIZE" ? 0 : 1);
  const ga = group(a), gb = group(b);
  if (ga !== gb) return ga - gb;
  if ((a.score == null) !== (b.score == null)) return a.score == null ? 1 : -1;
  return (b.score ?? 0) - (a.score ?? 0) || b.confidenceScore - a.confidenceScore || a.name.localeCompare(b.name);
}
