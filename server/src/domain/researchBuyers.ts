/**
 * Research → Buyer lead-generation logic (pure, unit-tested).
 *
 * Turns a research entity (a grantee aggregated across recorded documents) into
 * a proposed Buyer profile, classifies it against existing buyers (new / exact /
 * possible duplicate), and produces an ADDITIVE merge plan that never overwrites
 * user-entered data.
 */
import { normalizeEntity } from "./research.js";

/** "MINERAL_DEED" -> "Mineral Deed" for display. */
function prettyEnum(v: string): string {
  return v.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(" ");
}

// ---------------------------------------------------------------------------
// Building a buyer proposal from research rows
// ---------------------------------------------------------------------------

export interface ResearchDocLite {
  grantee: string | null;
  granteeNorm: string | null;
  state: string;
  county: string;
  abstractId: string | null;
  docType: string;
  recordingDate: Date;
}

export interface ResearchBuyerData {
  companyName: string;
  normalizedCompany: string;
  aliases: string[];
  counties: string[];
  states: string[];
  abstracts: string[];
  transactionTypes: string[];
  transactionCount: number;
  firstSeen: string | null; // ISO yyyy-mm-dd
  lastSeen: string | null;
  /** Counties where activity is most concentrated (top few by count). */
  concentration: { county: string; state: string; count: number }[];
}

function topByCount<T>(items: T[], key: (t: T) => string | null, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([k]) => k);
}

/** Aggregate one grantee's research rows into a proposed buyer. */
export function buildResearchBuyer(rows: ResearchDocLite[]): ResearchBuyerData | null {
  if (rows.length === 0) return null;
  const norm = rows.find((r) => r.granteeNorm)?.granteeNorm ?? normalizeEntity(rows[0].grantee);
  if (!norm) return null;

  // Display name = the most common raw spelling; other spellings become aliases.
  const rawCounts = new Map<string, number>();
  for (const r of rows) if (r.grantee?.trim()) rawCounts.set(r.grantee.trim(), (rawCounts.get(r.grantee.trim()) ?? 0) + 1);
  const rawSorted = [...rawCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const companyName = rawSorted[0] ?? norm;
  const aliases = rawSorted.slice(1).filter((a) => a.toUpperCase() !== companyName.toUpperCase());

  const counties = [...new Set(rows.map((r) => r.county).filter(Boolean))].sort();
  const states = [...new Set(rows.map((r) => r.state).filter(Boolean))].sort();
  const abstracts = topByCount(rows, (r) => r.abstractId, 12);
  const transactionTypes = topByCount(rows, (r) => r.docType, 8).map(prettyEnum);

  const times = rows.map((r) => r.recordingDate.getTime()).sort((a, b) => a - b);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

  const geoCounts = new Map<string, { county: string; state: string; count: number }>();
  for (const r of rows) {
    const k = `${r.state}|${r.county}`;
    const g = geoCounts.get(k) ?? { county: r.county, state: r.state, count: 0 };
    g.count++;
    geoCounts.set(k, g);
  }
  const concentration = [...geoCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  return {
    companyName,
    normalizedCompany: norm,
    aliases,
    counties,
    states,
    abstracts,
    transactionTypes,
    transactionCount: rows.length,
    firstSeen: times.length ? iso(times[0]) : null,
    lastSeen: times.length ? iso(times[times.length - 1]) : null,
    concentration,
  };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/** Normalized token set of a company name (for Jaccard similarity). */
function tokens(s: string): Set<string> {
  return new Set((normalizeEntity(s) ?? "").split(" ").filter(Boolean));
}

/** Levenshtein distance (small strings). */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Similarity in [0,1] between two company names. Blends token-set Jaccard,
 * containment (parent/subsidiary), and edit-distance ratio (minor spelling),
 * taking the strongest signal.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeEntity(a) ?? "";
  const nb = normalizeEntity(b) ?? "";
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = tokens(a), tb = tokens(b);
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = union ? inter / union : 0;

  // Containment: shorter token set fully inside the longer (subsidiary/parent).
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  const containment = small.size ? [...small].filter((t) => big.has(t)).length / small.size : 0;

  const edit = 1 - editDistance(na, nb) / Math.max(na.length, nb.length);

  return Math.max(jaccard, containment * 0.95, edit);
}

export interface ExistingBuyerLite {
  id: string;
  companyName: string;
  normalizedCompany: string;
  aliases: string[];
}

export type MatchResult =
  | { outcome: "new" }
  | { outcome: "exact"; buyerId: string }
  | { outcome: "possible"; buyerId: string; confidence: number };

/** Threshold above which a non-exact match is surfaced for user review. */
export const POSSIBLE_THRESHOLD = 0.6;

/**
 * Classify an imported buyer against existing buyers:
 * - exact: normalized name equals an existing normalized name or alias.
 * - possible: best similarity >= POSSIBLE_THRESHOLD (needs user review).
 * - new: otherwise.
 */
export function classifyMatch(imported: ResearchBuyerData, existing: ExistingBuyerLite[]): MatchResult {
  const impNorm = imported.normalizedCompany;
  const impAliasNorms = new Set([impNorm, ...imported.aliases.map((a) => normalizeEntity(a) ?? "")].filter(Boolean));

  for (const e of existing) {
    const eNorms = new Set([e.normalizedCompany, ...e.aliases.map((a) => normalizeEntity(a) ?? "")].filter(Boolean));
    for (const n of impAliasNorms) if (eNorms.has(n)) return { outcome: "exact", buyerId: e.id };
  }

  let best: { id: string; conf: number } | null = null;
  for (const e of existing) {
    const conf = Math.max(
      nameSimilarity(imported.companyName, e.companyName),
      ...e.aliases.map((a) => nameSimilarity(imported.companyName, a)),
    );
    if (conf >= POSSIBLE_THRESHOLD && (!best || conf > best.conf)) best = { id: e.id, conf };
  }
  if (best) return { outcome: "possible", buyerId: best.id, confidence: Math.round(best.conf * 100) / 100 };
  return { outcome: "new" };
}

// ---------------------------------------------------------------------------
// Additive merge plan
// ---------------------------------------------------------------------------

export interface ExistingBuyerForMerge {
  aliases: string[];
  source: string | null;
  researchSummary: ResearchSummary | null;
  buyBoxCounties: string[];
  buyBoxStates: string[];
}

export interface ResearchSummary {
  counties: string[];
  states: string[];
  abstracts: string[];
  transactionTypes: string[];
  transactionCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface MergePlan {
  addAliases: string[];
  addCounties: string[];
  addStates: string[];
  markResearch: boolean; // set source="research" only if currently unset
  summary: ResearchSummary;
  changed: boolean;
}

const uniqCI = (list: string[]): string[] => {
  const seen = new Map<string, string>();
  for (const v of list) { const k = v.trim().toUpperCase(); if (v.trim() && !seen.has(k)) seen.set(k, v.trim()); }
  return [...seen.values()];
};
const missing = (have: string[], want: string[]): string[] => {
  const haveSet = new Set(have.map((v) => v.trim().toUpperCase()));
  return uniqCI(want).filter((v) => !haveSet.has(v.toUpperCase()));
};

/** Build the additive changes to enrich an existing buyer from imported data. */
export function mergePlan(existing: ExistingBuyerForMerge, imported: ResearchBuyerData): MergePlan {
  const addAliases = missing([...existing.aliases], [imported.companyName, ...imported.aliases]);
  const addCounties = missing(existing.buyBoxCounties, imported.counties);
  const addStates = missing(existing.buyBoxStates, imported.states);

  const prev = existing.researchSummary;
  const summary: ResearchSummary = {
    counties: uniqCI([...(prev?.counties ?? []), ...imported.counties]),
    states: uniqCI([...(prev?.states ?? []), ...imported.states]),
    abstracts: uniqCI([...(prev?.abstracts ?? []), ...imported.abstracts]),
    transactionTypes: uniqCI([...(prev?.transactionTypes ?? []), ...imported.transactionTypes]),
    transactionCount: (prev?.transactionCount ?? 0) + imported.transactionCount,
    firstSeen: minDate(prev?.firstSeen ?? null, imported.firstSeen),
    lastSeen: maxDate(prev?.lastSeen ?? null, imported.lastSeen),
  };

  const markResearch = !existing.source;
  const changed = addAliases.length > 0 || addCounties.length > 0 || addStates.length > 0 || markResearch;
  return { addAliases, addCounties, addStates, markResearch, summary, changed };
}

function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** The research summary for a brand-new buyer (no prior data to merge). */
export function summaryFor(d: ResearchBuyerData): ResearchSummary {
  return {
    counties: d.counties, states: d.states, abstracts: d.abstracts,
    transactionTypes: d.transactionTypes, transactionCount: d.transactionCount,
    firstSeen: d.firstSeen, lastSeen: d.lastSeen,
  };
}
