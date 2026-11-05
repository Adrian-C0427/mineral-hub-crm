/**
 * County master-file fields of a Research transaction — the definitions the
 * importer, the boot backfill and the Records API share (pure, unit-tested).
 *
 * Decisions (owner, 2026-11-04):
 *  - PERCENT SOLD is the share of the GRANTOR's own interest the instrument
 *    conveys. A cell listing several values is kept verbatim, never guessed.
 *  - The grantee "(x%)" shares are kept apart from it. Their basis is read per
 *    row: they add up to PERCENT SOLD → "absolute"; they add up to 100 while
 *    PERCENT SOLD is lower → "of-conveyed" (each buyer's split of what was
 *    sold); anything else → "unknown".
 *  - Corrections, certified copies, amendments, gift deeds, stipulations and
 *    rows a county master file leaves out stay on record but never count as a
 *    buyer's acquisition.
 *  - Instruments recorded the same day between the same parties over the same
 *    abstracts are one closing: they share a group key and count once.
 *  - A buyer's score is NOT weighted by the share bought (2% = 100%).
 */
import crypto from "node:crypto";

/** Version of the derived fields below; rows below it are re-derived once at boot (services/researchDerivedBackfill). */
export const DERIVED_FIELDS_VERSION = 1;
import type { PartyInterest } from "./research.js";
import { surveyName } from "./researchGeo.js";

// ---------------------------------------------------------------------------
// Percent sold
// ---------------------------------------------------------------------------

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** One percent value: "66%", "66.6667 %", "66", ".5", "1/2", "2/3rds" → 0–100. */
function onePercent(raw: string): number | null {
  const t = raw.trim().replace(/\s+/g, "");
  if (!t) return null;
  const frac = /^(\d{1,4})\/(\d{1,5})(?:st|nd|rd|th)?s?$/i.exec(t);
  if (frac) {
    const n = Number(frac[1]), d = Number(frac[2]);
    return d > 0 && n <= d ? round4((n / d) * 100) : null;
  }
  const m = /^(\d{1,3}(?:\.\d+)?|\.\d+)%?$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 0 && v <= 100 ? round4(v) : null;
}

export interface PercentSold {
  /** 0–100, or null when blank, unreadable, out of range or several values. */
  pct: number | null;
  /** The cell as recorded (null when blank). */
  raw: string | null;
  /** The cell lists more than one value ("66.67%; 33.33%"). */
  multi: boolean;
  /** A non-blank cell that is not a percent (or is outside 0–100). */
  invalid: boolean;
}

export function parsePercentSold(cell: string | null | undefined): PercentSold {
  const raw = (cell ?? "").trim();
  if (!raw) return { pct: null, raw: null, multi: false, invalid: false };
  const parts = raw.split(/\s*[;|]\s*/).filter(Boolean);
  if (parts.length > 1) {
    const ok = parts.every((p) => onePercent(p) != null);
    return { pct: null, raw, multi: true, invalid: !ok };
  }
  const pct = onePercent(raw);
  return { pct, raw, multi: false, invalid: pct == null };
}

// ---------------------------------------------------------------------------
// Grantee shares: basis and the "[66% TOTAL]" tag
// ---------------------------------------------------------------------------

/** "[66% TOTAL]" / "(TOTAL 66%)" written after a grantee list → 66. */
const TOTAL_TAG_RE = /[([]\s*(?:(\d{1,3}(?:\.\d+)?)\s*%\s*TOTAL|TOTAL\s*:?\s*(\d{1,3}(?:\.\d+)?)\s*%)\s*[)\]]/i;
export function statedTotalPct(granteeCell: string | null | undefined): number | null {
  const m = TOTAL_TAG_RE.exec(granteeCell ?? "");
  if (!m) return null;
  const v = Number(m[1] ?? m[2]);
  return v > 0 && v <= 100 ? round4(v) : null;
}

/** Shares within this of each other are the same figure (16.67% × 6 = 100.02%). */
const TOLERANCE = 0.05;
export type ShareBasis = "absolute" | "of-conveyed" | "unknown";

/**
 * How the grantee shares relate to PERCENT SOLD. Null when there is nothing
 * to compare (no percent sold, or no grantee states a share).
 */
export function shareBasis(percentSold: number | null, interests: readonly PartyInterest[] | null | undefined): ShareBasis | null {
  const shares = (interests ?? []).filter((i) => i.side === "GRANTEE" && i.pct != null).map((i) => i.pct as number);
  if (percentSold == null || !shares.length) return null;
  const sum = round4(shares.reduce((a, b) => a + b, 0));
  if (Math.abs(sum - percentSold) <= TOLERANCE) return "absolute";
  if (Math.abs(sum - 100) <= TOLERANCE && percentSold < 100 - TOLERANCE) return "of-conveyed";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Flags: instruments that are not a buyer's acquisition, and estate sellers
// ---------------------------------------------------------------------------

export const DOC_FLAGS = [
  "correction", "certified-copy", "amendment", "gift", "stipulation", "outside-master-list", "estate-or-trust-seller",
] as const;
export type DocFlag = (typeof DOC_FLAGS)[number];

/** Flags that keep a record out of buyer acquisition counts and matching. */
export const NON_ACQUISITION_FLAGS: ReadonlySet<string> = new Set<DocFlag>([
  "correction", "certified-copy", "amendment", "gift", "stipulation", "outside-master-list",
]);

export const DOC_FLAG_LABEL: Record<DocFlag, string> = {
  correction: "Correction",
  "certified-copy": "Certified copy",
  amendment: "Amendment",
  gift: "Gift",
  stipulation: "Stipulation of interest",
  "outside-master-list": "Outside the master list",
  "estate-or-trust-seller": "Estate or trust seller",
};

/** Flags the instrument type itself carries ("COR MINERAL DEED", "C C MINERAL DEED", "GIFT DEED"…). */
export function docTypeFlags(docTypeRaw: string | null | undefined): DocFlag[] {
  const t = ` ${(docTypeRaw ?? "").toUpperCase().replace(/[^A-Z0-9&]+/g, " ").trim()} `;
  const out: DocFlag[] = [];
  if (/ (COR|CORR|CORRECTION|CORRECTED|CORRECTIVE) /.test(t)) out.push("correction");
  if (/ C C | CC |CERTIFIED COPY/.test(t)) out.push("certified-copy");
  if (/ (AMD|AMENDED|AMENDMENT|AMENDATORY) /.test(t)) out.push("amendment");
  if (/ GIFT /.test(t)) out.push("gift");
  if (/STIPULATION| STIP /.test(t)) out.push("stipulation");
  return out;
}

/** The seller is an estate, an heirship or a trust ("ESTATE OF …", "… DECEASED", "… TRUSTEE"). */
const ESTATE_RE = /\b(?:ESTATE|DECEASED|DEC'?D|HEIRS|TRUSTS?|TRUSTEES?|TTEES?|EXECUT(?:OR|RIX)S?|ADMINISTRAT(?:OR|RIX)S?)\b/i;
export function sellerFlags(grantorCell: string | null | undefined): DocFlag[] {
  return grantorCell && ESTATE_RE.test(grantorCell) ? ["estate-or-trust-seller"] : [];
}

/** Every derived flag of a record, plus a flag set elsewhere that must survive (outside-master-list). */
export function documentFlags(docTypeRaw: string | null | undefined, grantorCell: string | null | undefined, keep: readonly string[] = []): string[] {
  const out = new Set<string>([...docTypeFlags(docTypeRaw), ...sellerFlags(grantorCell)]);
  for (const k of keep) if (k === "outside-master-list") out.add(k);
  return DOC_FLAGS.filter((f) => out.has(f));
}

export const countsAsAcquisition = (flags: readonly string[]): boolean => !flags.some((f) => NON_ACQUISITION_FLAGS.has(f));

// ---------------------------------------------------------------------------
// Same-day closing groups
// ---------------------------------------------------------------------------

/**
 * Key shared by separate instruments recorded the same day between the same
 * grantor and grantee over the same abstracts (one closing recorded as several
 * instruments). Transactions only; null when either side is unknown.
 */
export function txGroupKey(p: {
  docClass: string; state: string; county: string; recordingDate: Date;
  grantorNorm: string | null; granteeNorm: string | null; abstractIds: readonly string[];
}): string | null {
  if (p.docClass !== "TRANSACTION" || !p.grantorNorm || !p.granteeNorm) return null;
  const parts = [
    p.state.toUpperCase(), p.county.toUpperCase(), p.recordingDate.toISOString().slice(0, 10),
    p.grantorNorm, p.granteeNorm, [...p.abstractIds].sort().join(","),
  ];
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 20);
}

// ---------------------------------------------------------------------------
// Surveys and abstract ↔ survey pairs
// ---------------------------------------------------------------------------

const splitList = (cell: string | null | undefined) => (cell ?? "").split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean);

/** Each survey of a Survey cell, standardized, in order, without repeats. */
export function surveyList(cell: string | null | undefined): string[] {
  const out: string[] = [];
  for (const s of splitList(cell)) { const n = surveyName(s); if (n && !out.includes(n)) out.push(n); }
  return out;
}

export interface Tract { abstract: string; survey: string }
/**
 * The n-th abstract with the n-th survey, as the file lists them — only when
 * both cells are ";"-lists of the same length (the county master files pair
 * them positionally). Null otherwise.
 */
export function pairTracts(abstractCell: string | null | undefined, surveyCell: string | null | undefined): Tract[] | null {
  const a = splitList(abstractCell), s = splitList(surveyCell);
  if (!a.length || a.length !== s.length) return null;
  return a.map((abstract, i) => ({ abstract, survey: s[i] }));
}

/** Letters only, upper-cased: "J. Y. Aquilera Survey" and "Jy Aquilera Survey" compare equal. */
export const surveyKey = (name: string | null | undefined): string => (name ?? "").toUpperCase().replace(/[^A-Z]/g, "");

// ---------------------------------------------------------------------------
// The source row
// ---------------------------------------------------------------------------

const MAX_SOURCE_ROW_CHARS = 20_000;
/** Every column of the row as recorded, or null when it is implausibly large. */
export function sourceRowOf(row: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) if (k) out[k] = v ?? "";
  return JSON.stringify(out).length <= MAX_SOURCE_ROW_CHARS ? out : null;
}
