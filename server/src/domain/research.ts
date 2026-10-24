import { monthKey } from "./dates.js";
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

// ---------------------------------------------------------------------------
// Conveyed-interest extraction ("ABC MINERALS LLC – 50%")
// ---------------------------------------------------------------------------
//
// County indexes often write the share conveyed into the party cell itself:
// "ABC MINERALS LLC 50%", "ABC MINERALS LLC – 50% INTEREST", "ABC MINERALS
// LLC (50%)", "SMITH JOHN, AS TO AN UNDIVIDED 1/2 MI". That text is
// transaction data, not part of who the party is — left in the name it splits
// one buyer into many. extractInterest separates the two.

/** Words that may lead the share: "as to", "an undivided". */
const INTEREST_LEAD = String.raw`(?:\bAS\s+TO\s+)?(?:(?:\bAN?\s+)?\b(?:UNDIVIDED|UNDIV|UND)\.?\s+)?`;
/** Words that may follow the share ("of the mineral interest", "MI", "NPRI"). */
const INTEREST_QUAL = String.raw`(?:OF|IN|THE|HIS|HER|THEIR|ITS|SAID|UNDIVIDED|UND|GRANTORS?(?:'S)?|GRANTEES?(?:'S)?|MINERALS?|MIN|ROYALTY|ROYALTIES|ROY|NPRI|ORRI|ORR|NMI|MI|RI|NRI|WI|O&G|OIL\s*(?:&|AND)\s*GAS)`;
const INTEREST_WORD = String.raw`(?:INTERESTS?|INTRS?|INTS?|INTST)`;
/** Trailing qualifiers are consumed only when they END in an interest word
 *  ("50% undivided mineral interest") or run to the end of the party ("50%
 *  MI") — so a share written mid-name never eats the rest of the name. */
const TAIL_WORD = String.raw`(?:\s+${INTEREST_QUAL}\b\.?)*\s*\b${INTEREST_WORD}\b\.?`;
const TAIL_TO_END = String.raw`(?:\s+${INTEREST_QUAL}\b\.?)+(?=\s*[)\]]?\s*$)`;
const AT_END = String.raw`(?=\s*[)\]]?\s*$)`;
/** "50%", "12.5 %", "50 PCT", "50 percent". */
const PCT_RE = new RegExp(
  `${INTEREST_LEAD}(?<![\\w.])(?<num>\\d{1,3}(?:\\.\\d+)?|\\.\\d+)\\s*(?:%|(?:PCT|PERCENT|PER\\s+CENT)\\b\\.?)(?:${TAIL_WORD}|${TAIL_TO_END})?`,
  "gi",
);
/** "1/2" — only as a share: followed by an interest word or ending the party
 *  (never a date like 1/2/2019, never "A/B" party separators). */
const FRACTION_RE = new RegExp(
  `${INTEREST_LEAD}(?<![\\w./])(?<n>\\d{1,4})\\s*\\/\\s*(?<d>\\d{1,5})(?![\\d/]|\\s*\\/)(?:${TAIL_WORD}|${TAIL_TO_END}|${AT_END})`,
  "gi",
);

/** Tidy what is left of a name once the share is removed. */
function tidyPartyName(s: string): string {
  return s
    .replace(/[([]\s*[)\]]/g, " ")            // "ABC LLC ()" → "ABC LLC"
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, "")  // "ABC LLC –" → "ABC LLC"
    .replace(/\s+(?:AS\s+TO|OF)$/i, "")
    .trim();
}

/**
 * Separate a conveyed-interest share from a party name:
 *   "ABC Minerals LLC – 50% interest" → { name: "ABC Minerals LLC", pct: 50, text: "50% interest" }
 *   "ABC Minerals LLC (1/2 MI)"       → { name: "ABC Minerals LLC", pct: 50, text: "1/2 MI" }
 *   "ABC Minerals LLC"                → { name: "ABC Minerals LLC", pct: null, text: null }
 * Only shares in (0, 100] count; anything else is left untouched. When a name
 * carries several shares the first is the value and all are kept in `text`.
 */
export function extractInterest(raw: string | null | undefined): { name: string; pct: number | null; text: string | null } {
  const src = raw ?? "";
  if (!/\d/.test(src)) return { name: src.trim(), pct: null, text: null };
  let pct: number | null = null;
  const texts: string[] = [];
  const take = (m: string, v: number) => {
    if (!(v > 0 && v <= 100)) return m;
    if (pct == null) pct = round4(v);
    texts.push(m.replace(/^[\s([]+|[\s)\]]+$/g, ""));
    return " ";
  };
  let name = src.replace(PCT_RE, (m: string, ...rest: unknown[]) =>
    take(m, parseFloat((rest[rest.length - 1] as { num: string }).num)));
  name = name.replace(FRACTION_RE, (m: string, ...rest: unknown[]) => {
    const g = rest[rest.length - 1] as { n: string; d: string };
    const n = Number(g.n), d = Number(g.d);
    return d > 0 && n <= d ? take(m, (n / d) * 100) : m;
  });
  if (!texts.length) return { name: src.trim(), pct: null, text: null };
  return { name: tidyPartyName(name), pct, text: texts.join("; ") };
}

const ENTITY_SUFFIXES = [
  "LLC", "L L C", "LP", "L P", "LLP", "LTD", "INC", "INCORPORATED", "CORP",
  "CORPORATION", "CO", "COMPANY", "LC", "PLLC",
];
const ENTITY_NOISE = ["ET UX", "ET AL", "ET VIR", "ETUX", "ETAL", "ETVIR"];

/**
 * Normalize an entity name for grouping: uppercase, strip punctuation,
 * drop spousal/party noise ("et ux"), any conveyed-interest phrase ("– 50%",
 * "(1/2 INT)" — see extractInterest) and trailing legal suffixes so
 * "Blackrock Minerals, LLC", "BLACKROCK MINERALS LP" and "Blackrock Minerals
 * LLC 50%" group together. Returns null for empty input.
 */
export function normalizeEntity(name: string | null | undefined): string | null {
  if (!name) return null;
  let t = extractInterest(name).name.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
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
// Multi-party splitting (co-grantors / co-grantees on one instrument)
// ---------------------------------------------------------------------------

/** One participant of a grantor/grantee cell, with the share of the interest
 *  recorded against it (null when the record states none). */
export interface ParsedParty {
  name: string;          // display name: interest, annotations and role words removed
  norm: string;          // grouping key (normalizeEntity)
  pct: number | null;    // 0–100
  text: string | null;   // the interest phrase as recorded ("50% interest")
  acres: number | null;  // an acreage written against the party ("(40.00 net mineral acres)")
  note: string | null;   // any other bracketed annotation, kept as data ("as to Tract 2")
}

/**
 * Rules version stamped on every ResearchDocument whose party fields were
 * derived by the current parser (ResearchDocument.partyRulesVersion). Bump it
 * when parsePartyCell changes what it produces; the boot backfill re-derives
 * every row below the current version exactly once.
 *   2 — "&"/"and" between two organisations split; bracketed annotations and
 *       role words (Trustee, Partner, Gen Pt, AIF …) leave the name.
 *   3 — an "&" inside an organisation's own name ("BROADMOOR LAND & MINERALS
 *       LLC") no longer blocks the split of the cell it sits in; an unclosed
 *       bracket ("( from Moroney") is an annotation too.
 */
export const PARTY_RULES_VERSION = 3;

/** Legal-form words that mark a text as a COMPLETE organisation name. */
const LEGAL_FORM_RE = /\b(?:L\.?L\.?C|L\.?P|L\.?L\.?P|LTD|INC(?:ORPORATED)?|CORP(?:ORATION)?|CO|COMPANY|LC|PLLC|TRUST|PARTNERSHIP|ESTATE|FOUNDATION|BANK|CHURCH|ASSOCIATION|ASSN|UNIVERSITY|COLLEGE)\.?\b/i;

/** A legal form closing a text ("… LAND & MINERALS LLC"). */
const LEGAL_FORM_END_RE = new RegExp(`${LEGAL_FORM_RE.source}\\s*$`, "i");

/**
 * "A LLC & B LP" names two parties; "SMITH & SONS LLC" and "JOHN & MARY
 * SMITH" name one. Read left to right, an organisation's name runs up to its
 * legal form, so an "&" INSIDE a name ("BROADMOOR LAND & MINERALS LLC") stays
 * inside it and the "&" AFTER a legal form is the boundary. The cell splits
 * only when every resulting party carries its own legal form — text left
 * over without one means the whole cell is one entity, as written.
 */
function splitAmpersand(part: string): string[] {
  // Keep the separators as written so a rebuilt name reads as the record did.
  const bits = part.split(/(\s*(?:&|\bAND\b)\s*)/i);
  if (bits.length < 3) return [part];
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < bits.length; i += 2) {
    const piece = bits[i].trim();
    const sep = bits[i - 1] ?? "";
    if (!piece) continue;
    cur = cur ? `${cur}${sep}${piece}` : piece;
    // The legal form closes the NAME; a share, annotation or role written after
    // it ("… LP (2/3)", "… LLC, Trustee") doesn't keep the party open.
    const bare = stripRole(extractAnnotations(extractInterest(piece).name).name);
    if (/[A-Za-z]/.test(bare) && LEGAL_FORM_END_RE.test(bare)) { out.push(cur.trim()); cur = ""; }
  }
  if (cur.trim()) return [part];
  return out.length >= 2 ? out : [part];
}

/**
 * Role / capacity words written after a party ("… LLC, Partner", "… Gen Pt",
 * "John Smith, Trustee", "… as AIF") describe the party's part in that one
 * instrument, not who it is. Dropped from the name (the user's call: dropped,
 * not kept).
 */
const ROLE_RE = /(?:^|[\s,;:\-–—]+)(?:AS\s+)?(?:GENERAL\s+PARTNER|GEN(?:ERAL)?\.?\s*PT(?:NR)?\.?|MANAGING\s+(?:MEMBER|PARTNER|GENERAL\s+PARTNER)|CO-?TRUSTEES?|SUCCESSOR\s+(?:CO-?)?TRUSTEES?|TRUSTEES?|TTEES?|INDEPENDENT\s+(?:CO-?)?EXECUT(?:OR|RIX)S?|EXECUT(?:OR|RIX)S?|ADMINISTRAT(?:OR|RIX)S?|ATTORNEY[\s-]+IN[\s-]+FACT|A\.?I\.?F\.?|AGENT|GUARDIAN|PARTNER|MEMBER|MANAGER|PRESIDENT|INDIVIDUALLY|INDIV\.?|P\.?O\.?A\.?|D\/?B\/?A)\.?\s*$/i;
function stripRole(name: string): string {
  let t = name;
  for (let i = 0; i < 4; i++) {
    const next = t.replace(ROLE_RE, "");
    if (next === t) break;
    t = next;
  }
  return tidyPartyName(t);
}

/** Bracketed text that only restates the conveyed interest once the share itself is gone. */
const INTEREST_REMNANT_WORDS = new Set(["OF", "THE", "GRANTOR", "GRANTORS", "GRANTOR'S", "GRANTEE", "GRANTEES", "INTEREST", "INTERESTS", "INT", "UNDIVIDED", "MI", "RI", "MINERAL", "MINERALS", "ROYALTY", "S", "AN", "A", "IN", "AND", "TO", "ALL"]);
const ACRES_RE = /(\d+(?:\.\d+)?)\s*(?:NET\s+MINERAL\s+ACRES?|NET\s+ROYALTY\s+ACRES?|NMA|NRA|ACRES?|AC\.?)\b/i;

/**
 * Bracketed annotations leave the name. An acreage ("(40.00 net mineral
 * acres)") is kept as data; the empty shell a removed share leaves behind
 * ("( of Grantor's interest)") is dropped; anything else is kept as a note.
 */
function extractAnnotations(name: string): { name: string; acres: number | null; note: string | null } {
  let acres: number | null = null;
  const notes: string[] = [];
  const take = (inner: string): string => {
    inner = inner.trim();
    if (!inner) return " ";
    const m = ACRES_RE.exec(inner);
    if (m) { if (acres == null) acres = Number(m[1]); return " "; }
    const words = inner.toUpperCase().replace(/[^A-Z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
    if (words.every((w) => INTEREST_REMNANT_WORDS.has(w))) return " ";
    notes.push(inner);
    return " ";
  };
  const stripped = name
    .replace(/\(([^()]*)\)|\[([^\]]*)\]/g, (_m, a: string | undefined, b: string | undefined) => take(a ?? b ?? ""))
    // An opening bracket never closed ("… LLC ( from Moroney") annotates to the end.
    .replace(/[([]([^()[\]]*)$/, (_m, a: string) => take(a));
  return { name: tidyPartyName(stripped), acres, note: notes.length ? notes.join("; ") : null };
}

/** One part of a cell, fully cleaned: share, annotations and role words removed. */
function cleanPart(part: string): { name: string; pct: number | null; text: string | null; acres: number | null; note: string | null } {
  const ex = extractInterest(part);
  const an = extractAnnotations(ex.name);
  return { name: stripRole(an.name), pct: ex.pct, text: ex.text, acres: an.acres, note: an.note };
}

/**
 * STRICT separator set — exactly commas, semicolons, and forward slashes.
 * Nothing else splits: "&", "AND", "ET UX" and similar joiners stay inside a
 * single party name (they are part of how a party is written, not a party
 * boundary), so "SMITH & SONS LLC" remains one entity. A slash BETWEEN DIGITS
 * is a fraction ("1/2 INT"), never a party boundary.
 */
const PARTY_SEPARATOR = /(?:[,;]|(?<!\d\s*)\/(?!\s*\d))+/;

/**
 * Parse a raw grantor/grantee cell into its individual parties, each with its
 * conveyed interest split out ("ABC MINERALS LLC – 50%" → ABC MINERALS LLC at
 * 50%). A part that is ONLY an interest phrase ("ABC LLC, 50%" — the comma
 * split it off) belongs to the party before it (or after it, when it leads).
 *
 * Likewise a part that is ONLY a legal suffix or party noise ("ABC MINERALS,
 * LLC", "SMITH JOHN, ET AL") is part of the name before it — never a party
 * called "LLC".
 *
 * Parts that normalize to nothing are dropped; parts that normalize to the
 * same entity key are de-duplicated (first spelling wins). `hasInterest` is
 * true when any interest text was found in the cell.
 */
/** Words that mark a part as an organisation, not a person's given names. */
const ENTITY_WORDS = /\b(TRUST|ESTATE|HEIRS|RANCH|MINERALS?|ROYALT(?:Y|IES)|PARTNERS(?:HIP)?|ENERGY|RESOURCES|OIL|GAS|LAND|HOLDINGS?|FUND|BANK|CHURCH|FAMILY|INVESTMENTS?|PROPERTIES|GROUP|CAPITAL|ASSOCIATES|ACQUISITIONS?|VENTURES?|FARMS?|CATTLE|INC|LLC|LP|LTD|CORP|CO|COMPANY|TRUSTEE|TRUSTEES|DECD|DECEASED)\b/;

/**
 * "GARCIA, MARIA" / "Smith, John et ux" / "Thompson, Robert et al": the way
 * county indexes write ONE person (surname first). Treated as a single party,
 * not two. Only the narrow shape qualifies — a one-word surname before the
 * comma, one to three given-name words after it, no digits and no company
 * words on either side — so "Company A, Company B" (two multi-word names)
 * and "Blackrock Minerals, LLC" (a suffix) still follow the separator rules.
 */
function isSurnameFirstPerson(raw: string): boolean {
  const parts = raw.split(",");
  if (parts.length !== 2 || /[;/]/.test(raw)) return false;
  const [last, given] = parts.map((x) => x.trim());
  if (!last || !given || /\d/.test(raw)) return false;
  const words = (x: string) => x.toUpperCase().replace(/[^A-Z' ]+/g, " ").split(/\s+/).filter(Boolean);
  const lastWords = words(last);
  const givenWords = words(given).filter((w) => !["ET", "UX", "AL", "VIR", "ETUX", "ETAL", "ETVIR", "JR", "SR", "II", "III", "IV"].includes(w));
  if (lastWords.length !== 1 || givenWords.length < 1 || givenWords.length > 3) return false;
  if (ENTITY_WORDS.test(last.toUpperCase()) || ENTITY_WORDS.test(given.toUpperCase())) return false;
  return true;
}

export function parsePartyCell(raw: string | null | undefined): { parties: ParsedParty[]; hasInterest: boolean } {
  if (!raw) return { parties: [], hasInterest: false };
  const out: ParsedParty[] = [];
  const byNorm = new Map<string, ParsedParty>();
  let hasInterest = false;
  let leading: { pct: number; text: string | null } | null = null;
  // A role written after the whole cell ("THOMPSON, ROBERT, TRUSTEE") goes
  // first, so the surname-first shape underneath is still recognised.
  const cell = stripRole(String(raw));
  if (!cell) return { parties: [], hasInterest: false };
  const parts = (isSurnameFirstPerson(cell) ? [cell] : cell.split(PARTY_SEPARATOR)).flatMap(splitAmpersand);
  for (const part of parts) {
    const ex = cleanPart(part);
    if (ex.pct != null) hasInterest = true;
    const prev = out[out.length - 1];
    if (prev && isSuffixOnly(ex.name)) {
      prev.name = `${prev.name}, ${ex.name}`;
      if (prev.pct == null && ex.pct != null) { prev.pct = ex.pct; prev.text = ex.text; }
      if (prev.acres == null && ex.acres != null) prev.acres = ex.acres;
      continue;
    }
    const norm = normalizeEntity(ex.name);
    if (!norm) {
      if (ex.pct == null) continue;
      if (!prev) leading = { pct: ex.pct, text: ex.text };
      else if (prev.pct == null) { prev.pct = ex.pct; prev.text = ex.text; }
      continue;
    }
    const seen = byNorm.get(norm);
    if (seen) {
      if (seen.pct == null && ex.pct != null) { seen.pct = ex.pct; seen.text = ex.text; }
      if (seen.acres == null && ex.acres != null) seen.acres = ex.acres;
      continue;
    }
    const p: ParsedParty = { name: ex.name, norm, pct: ex.pct, text: ex.text, acres: ex.acres, note: ex.note };
    if (p.pct == null && leading) { p.pct = leading.pct; p.text = leading.text; }
    leading = null;
    byNorm.set(norm, p);
    out.push(p);
  }
  return { parties: out, hasInterest };
}

/** "LLC", "L.L.C.", "Inc.", "et al" — a part made only of legal suffixes /
 *  party noise, which normalizeEntity strips from the end of a name. */
function isSuffixOnly(part: string): boolean {
  return /[A-Za-z]/.test(part) && normalizeEntity(`X ${part}`) === "X";
}

/**
 * Split a raw grantor/grantee cell into its individual party names (conveyed-
 * interest text removed — see parsePartyCell). A single-party cell returns a
 * one-element array.
 */
export function splitParties(raw: string | null | undefined): string[] {
  return parsePartyCell(raw).parties.map((p) => p.name);
}

/**
 * Per-party detail recorded against one party of a document: its share of
 * the conveyed interest and/or an annotation the clerk wrote against it
 * (an acreage, a note). Data, never part of the name.
 */
export interface PartyInterest {
  side: "GRANTOR" | "GRANTEE";
  party: string;        // clean display name
  norm: string;         // grouping key
  pct: number | null;   // 0–100, null when the record states no share for this party
  text: string | null;  // as recorded ("50% undivided interest")
  acres?: number | null; // "(40.00 net mineral acres)"
  note?: string | null;  // any other bracketed annotation
}

/** Every party-name field of a ResearchDocument, derived from the raw cells. */
export interface DocumentPartyFields {
  /** Display cells with interest text removed (the raw cell when there was none). */
  grantor: string | null;
  grantee: string | null;
  /** The cell exactly as recorded — set only when interest text was removed. */
  grantorAsRecorded: string | null;
  granteeAsRecorded: string | null;
  grantorNorm: string | null;
  granteeNorm: string | null;
  grantorParties: string[];
  granteeParties: string[];
  grantorNorms: string[];
  granteeNorms: string[];
  /** Interest conveyed by the instrument (0–100), or null when not stated or
   *  ambiguous — see documentInterestPct. Per-party detail: partyInterests. */
  interestPct: number | null;
  partyInterests: PartyInterest[];
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * The single "interest conveyed" figure for a document: the stated share, or
 * the total when several parties on ONE side each state theirs ("A 50%; B 50%"
 * → 100). When both sides state shares they must agree, else it is ambiguous
 * (null) and only the per-party detail is kept. Never above 100.
 */
export function documentInterestPct(interests: PartyInterest[]): number | null {
  const total = (side: PartyInterest["side"]) => {
    const xs = interests.filter((i) => i.side === side && i.pct != null);
    return xs.length ? round4(xs.reduce((a, i) => a + (i.pct ?? 0), 0)) : null;
  };
  const g = total("GRANTOR"), t = total("GRANTEE");
  const v = g != null && t != null ? (g === t ? g : null) : g ?? t;
  return v != null && v > 0 && v <= 100 ? v : null;
}

/**
 * Derive every party field of a recorded document from its raw grantor and
 * grantee cells — the single path used by imports, the sample seeder and the
 * existing-record backfill, so names, grouping keys and conveyed interests are
 * identical however a record arrived. The percentage is DATA (interestPct +
 * partyInterests), never part of a name; the raw cell is kept as recorded.
 */
export function documentPartyFields(grantorRaw: string | null | undefined, granteeRaw: string | null | undefined): DocumentPartyFields {
  const side = (raw: string | null | undefined, which: PartyInterest["side"]) => {
    const cell = raw && raw.trim() ? raw : null;
    const { parties } = parsePartyCell(cell);
    // The displayed cell is the clean party list whenever cleaning changed
    // anything — a share, an annotation, a role word, an "&" split — so no
    // screen ever shows text the parties behind it have dropped. The cell as
    // recorded is kept alongside (grantorAsRecorded / granteeAsRecorded).
    const names = parties.map((p) => p.name);
    const joined = names.join("; ");
    // Separators alone don't count as a change ("A, B" stays as recorded).
    const rawParts = cell ? cell.split(PARTY_SEPARATOR).map((t) => t.trim()).filter(Boolean) : [];
    const changed = cell != null && joined !== cell.trim() && (rawParts.length !== names.length || rawParts.some((t, i) => t !== names[i]));
    const clean = changed ? joined || null : cell;
    return {
      cell: clean,
      recorded: changed ? cell : null,
      norm: normalizeEntity(clean),
      names: parties.map((p) => p.name),
      norms: parties.map((p) => p.norm),
      interests: parties.filter((p) => p.pct != null || p.acres != null || p.note != null)
        .map((p): PartyInterest => ({
          side: which, party: p.name, norm: p.norm,
          pct: p.pct, text: p.pct != null ? (p.text ?? `${p.pct}%`) : null,
          ...(p.acres != null ? { acres: p.acres } : {}), ...(p.note != null ? { note: p.note } : {}),
        })),
    };
  };
  const gr = side(grantorRaw, "GRANTOR");
  const ge = side(granteeRaw, "GRANTEE");
  const partyInterests = [...gr.interests, ...ge.interests];
  return {
    grantor: gr.cell, grantee: ge.cell,
    grantorAsRecorded: gr.recorded, granteeAsRecorded: ge.recorded,
    grantorNorm: gr.norm, granteeNorm: ge.norm,
    grantorParties: gr.names, granteeParties: ge.names,
    grantorNorms: gr.norms, granteeNorms: ge.norms,
    interestPct: documentInterestPct(partyInterests),
    partyInterests,
  };
}

/** Stable signature of a document's conveyed interests for duplicate
 *  detection ("" when none): the same deed at 50% and at 25% is two records. */
export function interestSignature(interests: PartyInterest[] | null | undefined): string {
  return (interests ?? []).filter((i) => i.pct != null).map((i) => `${i.side[0]}:${i.norm}:${i.pct}`).sort().join(",");
}

/**
 * Split a recorded abstract cell into its individual abstract numbers.
 * County exports list every abstract a tract touches in one cell ("15, 47,
 * 209"; some clerks use ";"). The record stays ONE transaction — the raw cell
 * is kept for display — but each number is stored separately so filtering or
 * searching for any single abstract finds it. Mirrors the migration backfill
 * (split on , or ; then trim), so old and new rows filter identically.
 */
export function splitAbstracts(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw).split(/[,;]+/)) {
    const p = part.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recorded-document duplicate detection
// ---------------------------------------------------------------------------

/** Normalize an instrument / document number for comparison: uppercase and
 *  strip all whitespace, so "2026 00412" and "2026-00412 " compare equal to
 *  their tidy forms without collapsing genuinely different numbers. */
export function normInstrument(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/\s+/g, "");
}

/** Normalize a free-text field for comparison: trim + collapse whitespace +
 *  uppercase, with null/empty treated as equal. */
export function normField(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * The full recording signature used to detect TRUE duplicate documents: a row
 * is a duplicate only when EVERY mapped field matches an existing record.
 * Instrument number ALONE is not unique — county-clerk exports repeat one
 * instrument across each grantor/grantee and legal tract, so keying on it alone
 * falsely flags distinct rows. The signature covers geography + normalized
 * instrument + recording date + doc type + normalized parties + volume/page +
 * abstract.
 */
export function documentDedupeKey(p: {
  state: string;
  county: string;
  instrumentNumber: string | null;
  recordingDate: Date;
  docType: string;
  grantorNorm: string | null;
  granteeNorm: string | null;
  volume?: string | null;
  page?: string | null;
  abstractId?: string | null;
  /** interestSignature(partyInterests) — empty for records stating none. */
  interests?: string | null;
}): string {
  return [
    p.state.toUpperCase(),
    p.county.toUpperCase(),
    normInstrument(p.instrumentNumber),
    p.recordingDate.toISOString().slice(0, 10),
    p.docType,
    p.grantorNorm ?? "",
    p.granteeNorm ?? "",
    normField(p.volume),
    normField(p.page),
    normField(p.abstractId),
    // Appended only when present, so keys of records stating no interest are
    // exactly what they were before interests were extracted.
    ...(p.interests ? [p.interests] : []),
  ].join("|");
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

export type Granularity = "day" | "week" | "month" | "year";

/**
 * Pick a chart granularity that yields a readable number of buckets.
 * `longSpans` (the "All" time frame, which can reach back decades) adds a
 * yearly tier past ~5 years; bounded presets and custom ranges keep the
 * day/week/month tiers unchanged.
 */
export function autoGranularity(from: Date, to: Date, longSpans = false): Granularity {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));
  if (days <= 95) return "day";
  if (days <= 550) return "week";
  if (longSpans && days > 1830) return "year";
  return "month";
}

/** Stable bucket key (UTC): day → YYYY-MM-DD, week → Monday's date, month → YYYY-MM, year → YYYY. */
export function bucketKey(d: Date, g: Granularity): string {
  if (g === "year") return String(d.getUTCFullYear());
  if (g === "month") return monthKey(d);
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
    cur = g === "year"
      ? new Date(Date.UTC(cur.getUTCFullYear() + 1, 0, 1))
      : g === "month"
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
