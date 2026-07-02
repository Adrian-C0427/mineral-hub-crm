/**
 * Research & Market Intelligence — pure domain logic.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without a database: instrument-type classification, entity-name
 * normalization, period-over-period trend math, statistical hotspot
 * detection, and time-series bucketing. The routes layer feeds these with
 * lightweight rows loaded from Prisma.
 */

export type DocClass = "TRANSACTION" | "LEASE";
export type DocType =
  | "MINERAL_DEED" | "ROYALTY_DEED" | "MINERAL_CONVEYANCE" | "OG_CONVEYANCE"
  | "QUITCLAIM_MINERAL_DEED" | "WARRANTY_MINERAL_DEED" | "ASSIGNMENT" | "RESERVATION"
  | "OG_LEASE" | "LEASE_MEMO" | "LEASE_ASSIGNMENT" | "LEASE_RELEASE"
  | "LEASE_AMENDMENT" | "LEASE_EXTENSION" | "LEASE_RATIFICATION"
  | "OTHER";

export type PermitStatus = "SUBMITTED" | "APPROVED" | "SPUDDED" | "COMPLETED" | "CANCELED";
export type Trajectory = "VERTICAL" | "HORIZONTAL" | "DIRECTIONAL" | "UNKNOWN";

// ---------------------------------------------------------------------------
// Instrument-type classification
// ---------------------------------------------------------------------------

/**
 * Instruments that mention these are NOT mineral transfers (financing liens,
 * plats, easements, probate paperwork) and are rejected outright — a "Deed of
 * Trust" must never count as a deed.
 */
const EXCLUDED = [
  "DEED OF TRUST", "TRUST DEED", "LIEN", "MORTGAGE", "UCC", "PLAT",
  "EASEMENT", "RIGHT OF WAY", "RIGHT-OF-WAY", "FORECLOSURE", "ABSTRACT OF JUDGMENT",
];

/** Full-word mineral/O&G signals (safe as plain substrings). */
const MINERAL_HINTS = ["MINERAL", "ROYALTY", "OIL", "GAS", "O&G", "OGM", "NPRI", "OVERRIDING", "PETROLEUM"];

/**
 * Abbreviation predicates for the terse vocabulary Texas county-clerk index
 * systems emit (shared across a handful of vendors). All are word-bounded so
 * "MIN"/"ORR"/"ROY" don't match inside "ADMIN"/"CORR"/"CORRECTION", etc.
 */
const reMineralAbbr = /\b(ROY|ORR|ORRI|MIN)\b/;      // "ASG ORR ROY INTR", "MIN & ROYALTY DEED"
const reRoyalty = /ROYALTY|\b(ROY|ORR|ORRI)\b/;      // royalty transfers incl. overriding royalty
const reLease = /\bLEASE\b|\bLSE\b|\bLS\b|O&GL|OGL/;  // "OIL-GAS LSE", "REL OIL&GAS LS", "O&GL"
const reAssign = /ASSIGN|ASGMT|\bASG\b|\bASGN\b/;     // "ASGMT OF LEASE", "ASG ROYALTY INTR"
const reRelease = /RELEASE|\bREL\b|TERMINAT|\bCANCEL/;// "REL OIL&GAS LS", "P/REL", "CANCEL LEASE"
const reConvey = /CONVEY/;                            // "CONVEYNC" contains "CONVEY"
const reMineral = /MINERAL|\bMIN\b/;                  // "MINERAL DEED", "MIN & ROYALTY DEED"
const reQuit = /QUITCLAIM|QUIT CLAIM|\bQ C\b/;        // "Q/C MINERAL DEED" -> "Q C ..."

/**
 * Classify a raw recorded instrument-type string into a normalized DocType +
 * DocClass. Returns null when the instrument is clearly not mineral-related
 * (excluded types, or generic instruments with no mineral signal). Handles both
 * full descriptions ("Oil and Gas Lease") and the terse abbreviations Texas
 * county recording systems emit ("O&GL", "ASGMT OF LEASE", "REL OIL&GAS LS").
 */
export function classifyDocType(raw: string): { docType: DocType; docClass: DocClass } | null {
  const t = ` ${raw.toUpperCase().replace(/[^A-Z0-9&]+/g, " ").trim()} `;
  if (!t.trim()) return null;
  if (EXCLUDED.some((x) => t.includes(` ${x} `) || t.trim() === x)) return null;

  const has = (...words: string[]) => words.every((w) => t.includes(w));
  const mineralish = MINERAL_HINTS.some((h) => t.includes(h)) || reMineralAbbr.test(t);

  // Leasing family first — "Assignment of Oil & Gas Lease" is a lease event,
  // not a generic assignment. Coal/surface/grazing/farm/pasture leases are not
  // O&G and are rejected via the mineralish gate below.
  if (reLease.test(t)) {
    if (has("MEMO")) return { docType: "LEASE_MEMO", docClass: "LEASE" };
    if (reAssign.test(t)) return { docType: "LEASE_ASSIGNMENT", docClass: "LEASE" };
    if (reRelease.test(t)) return { docType: "LEASE_RELEASE", docClass: "LEASE" };
    if (has("AMEND")) return { docType: "LEASE_AMENDMENT", docClass: "LEASE" };
    if (has("EXTEN")) return { docType: "LEASE_EXTENSION", docClass: "LEASE" };
    if (has("RATIF")) return { docType: "LEASE_RATIFICATION", docClass: "LEASE" };
    // Plain lease must look like O&G/mineral leasing (not surface/coal/grazing).
    if (mineralish) return { docType: "OG_LEASE", docClass: "LEASE" };
    return null;
  }

  // Ownership-transfer family.
  if (reRoyalty.test(t)) {
    return { docType: "ROYALTY_DEED", docClass: "TRANSACTION" };
  }
  if (reQuit.test(t)) {
    return mineralish ? { docType: "QUITCLAIM_MINERAL_DEED", docClass: "TRANSACTION" } : null;
  }
  if (t.includes("WARRANTY")) {
    return mineralish ? { docType: "WARRANTY_MINERAL_DEED", docClass: "TRANSACTION" } : null;
  }
  if (reMineral.test(t) && t.includes("DEED")) return { docType: "MINERAL_DEED", docClass: "TRANSACTION" };
  if (reMineral.test(t) && (reConvey.test(t) || t.includes("TRANSFER") || t.includes("GRANT")))
    return { docType: "MINERAL_CONVEYANCE", docClass: "TRANSACTION" };
  if ((has("OIL", "GAS") || t.includes("O&G")) && (reConvey.test(t) || t.includes("DEED") || t.includes("GRANT")))
    return { docType: "OG_CONVEYANCE", docClass: "TRANSACTION" };
  if (reAssign.test(t)) {
    return mineralish ? { docType: "ASSIGNMENT", docClass: "TRANSACTION" } : null;
  }
  if (t.includes("RESERVATION") || t.includes("EXCEPTION")) {
    return mineralish ? { docType: "RESERVATION", docClass: "TRANSACTION" } : null;
  }

  // Generic instrument that still clearly concerns minerals ("Mineral Transaction").
  if (mineralish) return { docType: "OTHER", docClass: "TRANSACTION" };
  return null;
}

/** Map a raw permit/well status string to the lifecycle enum. */
export function classifyPermitStatus(raw: string | null | undefined): PermitStatus {
  const t = (raw ?? "").toUpperCase();
  if (t.includes("COMPLET") || t.includes("PRODUC")) return "COMPLETED";
  if (t.includes("SPUD") || t.includes("DRILL")) return "SPUDDED";
  if (t.includes("APPROV") || t.includes("PERMIT GRANTED") || t.includes("ISSUED")) return "APPROVED";
  if (t.includes("CANCEL") || t.includes("WITHDRAW") || t.includes("EXPIR")) return "CANCELED";
  return "SUBMITTED";
}

/** Map a raw wellbore-profile / well-type string to a trajectory. */
export function classifyTrajectory(raw: string | null | undefined): Trajectory {
  const t = (raw ?? "").toUpperCase();
  if (t.includes("HORIZ") || t === "H") return "HORIZONTAL";
  if (t.includes("DIRECTION") || t === "D") return "DIRECTIONAL";
  if (t.includes("VERT") || t === "V") return "VERTICAL";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Entity-name normalization (grouping key for buyers/sellers/operators)
// ---------------------------------------------------------------------------

const ENTITY_SUFFIXES = [
  "LLC", "L L C", "LP", "L P", "LLP", "LTD", "INC", "INCORPORATED", "CORP",
  "CORPORATION", "CO", "COMPANY", "LC", "PLLC",
];
const ENTITY_NOISE = ["ET UX", "ET AL", "ET VIR", "ETUX", "ETAL", "ETVIR"];

/**
 * Normalize an entity name for grouping: uppercase, strip punctuation,
 * drop spousal/party noise ("et ux") and trailing legal suffixes so
 * "Blackrock Minerals, LLC" and "BLACKROCK MINERALS LP" group together.
 * Returns null for empty input.
 */
export function normalizeEntity(name: string | null | undefined): string | null {
  if (!name) return null;
  let t = name.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (const n of ENTITY_NOISE) t = t.replace(new RegExp(` ${n}$`), "").replace(new RegExp(` ${n} `), " ");
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of ENTITY_SUFFIXES) {
      if (t.endsWith(` ${s}`)) { t = t.slice(0, -s.length - 1).trim(); changed = true; }
    }
  }
  t = t.trim();
  return t || null;
}

// ---------------------------------------------------------------------------
// Trend math
// ---------------------------------------------------------------------------

export interface Trend {
  current: number;
  previous: number;
  absoluteChange: number;
  /** Fractional change (0.25 = +25%). null when previous = 0 and current > 0 (new activity). */
  pctChange: number | null;
  direction: "up" | "down" | "flat";
}

export function trend(current: number, previous: number): Trend {
  const absoluteChange = current - previous;
  const pctChange = previous === 0 ? (current === 0 ? 0 : null) : absoluteChange / previous;
  return {
    current,
    previous,
    absoluteChange,
    pctChange,
    direction: absoluteChange > 0 ? "up" : absoluteChange < 0 ? "down" : "flat",
  };
}

/** Centered-nothing trailing rolling average; first (window-1) points average what exists. */
export function rollingAverage(values: number[], window: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out.push(sum / Math.min(i + 1, window));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hotspot / surge detection
// ---------------------------------------------------------------------------

export interface HotspotStats {
  /** z-score of current vs the history windows (null if not computable). */
  zScore: number | null;
  isHotspot: boolean;
  historyMean: number;
}

/**
 * Statistical surge check: compare the current window's count to the mean/std
 * (sample std, n-1) of equal-length history windows. Flags when the current
 * count is at least `minCount` AND sits well above historical variation
 * (z >= 2) AND is a material lift (>= 50% over the historical mean — a z-score
 * alone over-flags low-variance baselines). Flat-zero history with real
 * current volume counts as brand-new activity.
 */
export function detectHotspot(current: number, history: number[], minCount = 5): HotspotStats {
  const n = history.length;
  if (n < 3) return { zScore: null, isHotspot: false, historyMean: n ? history.reduce((a, b) => a + b, 0) / n : 0 };
  const mean = history.reduce((a, b) => a + b, 0) / n;
  const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (std === 0) {
    return { zScore: null, isHotspot: current >= minCount && current > mean * 1.5, historyMean: mean };
  }
  const z = (current - mean) / std;
  return { zScore: z, isHotspot: current >= minCount && z >= 2 && current >= mean * 1.5, historyMean: mean };
}

/**
 * Blend growth and statistical significance into a 0–100 severity score for
 * opportunity ranking. Volume matters: a 300% jump on 4 records should rank
 * below a 120% jump on 60 records.
 */
export function surgeSeverity(current: number, previous: number, zScore: number | null): number {
  const growth = previous === 0 ? (current > 0 ? 2 : 0) : (current - previous) / previous;
  const growthScore = Math.min(1, Math.max(0, growth / 2)); // caps at +200%
  const volumeScore = Math.min(1, Math.log10(Math.max(1, current)) / 2); // caps at 100 records
  const zServing = zScore == null ? 0.5 : Math.min(1, Math.max(0, zScore / 4));
  return Math.round((growthScore * 0.45 + volumeScore * 0.3 + zServing * 0.25) * 100);
}

// ---------------------------------------------------------------------------
// Time bucketing
// ---------------------------------------------------------------------------

export type Granularity = "day" | "week" | "month";

/** Pick a chart granularity that yields a readable number of buckets. */
export function autoGranularity(from: Date, to: Date): Granularity {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));
  if (days <= 95) return "day";
  if (days <= 550) return "week";
  return "month";
}

/** Stable bucket key (UTC): day → YYYY-MM-DD, week → Monday's date, month → YYYY-MM. */
export function bucketKey(d: Date, g: Granularity): string {
  if (g === "month") return d.toISOString().slice(0, 7);
  if (g === "day") return d.toISOString().slice(0, 10);
  const day = d.getUTCDay(); // 0=Sun
  const monday = new Date(d.getTime() - ((day + 6) % 7) * 86400000);
  return monday.toISOString().slice(0, 10);
}

/** All bucket keys covering [from, to] so charts have no gaps. */
export function bucketRange(from: Date, to: Date, g: Granularity): string[] {
  const keys: string[] = [];
  let cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = to.getTime();
  const seen = new Set<string>();
  while (cur.getTime() <= end) {
    const k = bucketKey(cur, g);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
    cur = g === "month"
      ? new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1))
      : new Date(cur.getTime() + 86400000);
  }
  return keys;
}

/**
 * Split the span immediately before `from` into `n` history windows of the
 * same length as [from, to] — the baseline for hotspot z-scores.
 */
export function historyWindows(from: Date, to: Date, n = 6): { from: Date; to: Date }[] {
  const len = to.getTime() - from.getTime() + 86400000; // inclusive span
  const out: { from: Date; to: Date }[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({ from: new Date(from.getTime() - len * i), to: new Date(from.getTime() - len * (i - 1) - 86400000) });
  }
  return out.reverse();
}
