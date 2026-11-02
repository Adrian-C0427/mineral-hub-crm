import { abstractNumber, isSectionLabel, surveyLabel } from "./abstracts";

/**
 * Research location fields — Abstract, Survey Name and County — read the same
 * way in the Records table, its filters, CSV exports and the import screens.
 * Mirrors server/src/domain/researchGeo.ts; keep the two in step.
 *
 *   Abstract     the number only: "A-923" → "923" ("15, 47" → 15 and 47)
 *   Survey Name  standardized: "WARNICK, J" → "J. Warnick Survey"
 *   County       "Leon, TX"
 */

/** "A-58, 61 / 102" → ["58", "61", "102"]; parts without a digit are not abstracts. */
export function abstractNumbers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of String(raw).split(/[,;/&]+|\s+and\s+/i)) {
    const p = part.trim();
    if (!/\d/.test(p)) continue;
    const n = isSectionLabel(p) ? p.replace(/\s+/g, " ") : abstractNumber(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** A record's abstract numbers: the stored per-abstract list, else split from the cell as recorded. */
export function recordAbstracts(r: { abstractId?: string | null; abstractIds?: string[] | null }): string[] {
  return r.abstractIds?.length ? r.abstractIds.map((a) => abstractNumbers(a)[0] ?? a) : abstractNumbers(r.abstractId);
}

const LEADING_ABSTRACT = /^\s*(?:abstract|abst|abs|a)\.?\s*(?:no\.?|#)?\s*-?\s*\d+[a-z]?\b[\s,;:·-]*/i;

/** A survey as recorded, standardized: "WARNICK, J" → "J. Warnick Survey"; "" when blank. */
export function surveyName(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(LEADING_ABSTRACT, "").trim().replace(/[\s,;:·-]+$/, "");
  return s && /[a-z]/i.test(s) ? surveyLabel(s) : "";
}

/**
 * A record's Survey Name(s): its own survey when it has one, else each
 * abstract's survey from the GIS abstract index — always by county + number,
 * never by number alone.
 */
export function recordSurveys(
  r: { abstractId?: string | null; abstractIds?: string[] | null; survey?: string | null; county: string; state?: string | null },
  find: (abstract: string, county: string, state?: string | null) => { survey?: string | null } | undefined,
): string[] {
  // The record's own Survey field — one name, or several "; "-separated.
  const own = [...new Set((r.survey ?? "").split(/\s*;\s*/).map(surveyName).filter(Boolean))];
  if (own.length) return own;
  const out: string[] = [];
  for (const a of recordAbstracts(r)) {
    const s = surveyName(find(a, r.county, r.state ?? "TX")?.survey);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** "Leon, TX" — the county with its state code (just the county when the state is unknown). */
export function countySt(county: string | null | undefined, state: string | null | undefined): string {
  return [county?.trim(), state?.trim().toUpperCase()].filter(Boolean).join(", ");
}
