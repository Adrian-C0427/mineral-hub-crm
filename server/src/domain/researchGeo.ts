/**
 * Research geography — the one definition of the three location fields every
 * Research record carries, used by the importer, the boot backfill, the
 * Records API and (mirrored in client/src/lib/researchGeo.ts) the UI:
 *
 *   Abstract     the abstract NUMBER(S) only: "A-923" / "ABST 0923" → "923"
 *                (the cell as recorded stays in `abstractId`; the numbers are
 *                `abstractIds`, one per abstract)
 *   Survey Name  standardized: "WARNICK, J" / "J WARNICK SUR" → "J. Warnick Survey"
 *   County       a bare county name + the state's USPS code ("Leon" + "TX",
 *                shown "Leon, TX"); "Leon County, Texas" yields both
 *
 * An abstract number only identifies land together with its county (and
 * survey): nothing here ever resolves a number without one.
 */
import { abstractNumber, isSectionLabel, surveyLabel } from "./abstractLabel.js";

/**
 * Geography is stored ONE way: state as its USPS code ("TX"), county as a bare
 * title-cased name ("Leon", "McMullen", "De Witt"). County indexes write the
 * same place many ways ("Leon, Texas", "LEON COUNTY", "leon county, tx"), and
 * every variant must land on the same key or Research shows one county twice.
 */
export const STATE_CODES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT",
  DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA",
  KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI",
  MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH",
  OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV",
  WISCONSIN: "WI", WYOMING: "WY", "DISTRICT OF COLUMBIA": "DC",
};
const STATE_CODE_SET = new Set(Object.values(STATE_CODES));

/** "Texas", "TEXAS", "tx", "Tex." → "TX". Unknown text is uppercased as before. */
export function normState(s: string): string {
  const t = s.trim().toUpperCase().replace(/[.,]+$/, "").replace(/\s+/g, " ");
  if (STATE_CODES[t]) return STATE_CODES[t];
  if (t === "TEX") return "TX";
  if (t.startsWith("STATE OF ") && STATE_CODES[t.slice(9)]) return STATE_CODES[t.slice(9)];
  return t;
}

/**
 * A state named at the end of a place ("Leon County, TX", "Leon, New Mexico",
 * "LEON COUNTY STATE OF TEXAS"), split off: { rest: "Leon County", state: "TX" }.
 * Longest match first, so "New Mexico" is never read as "Mexico".
 */
function stateSuffix(s: string): { rest: string; state: string | null } {
  const t = s.trim().replace(/\s+/g, " ");
  for (const words of [3, 2, 1]) {
    const m = new RegExp(`^(.*?\\S)([,\\s]+)((?:[A-Za-z.]+ ){${words - 1}}[A-Za-z.]+)$`).exec(t);
    if (!m) continue;
    // "McMullen Co." is the county word, not Colorado (that needs a comma: "Denver, CO").
    if (/^co\.?$/i.test(m[3]) && !m[2].includes(",")) continue;
    const code = normState(m[3]);
    if (STATE_CODE_SET.has(code)) return { rest: m[1].replace(/[,\s]+$/, ""), state: code };
  }
  return { rest: t, state: null };
}

/** Lower-case particles that stay lower inside a county name ("Isle of Wight"). */
const COUNTY_LOWER = new Set(["OF", "THE", "DE", "LA", "DU", "AND"]);
/** County names that are camel-cased in the static county lists. Keyed by the
 *  upper-cased name; "Mc<Name>" is handled generically (every Mc county is one). */
const COUNTY_CAMEL: Record<string, string> = {
  DEWITT: "DeWitt", DESOTO: "DeSoto", DEKALB: "DeKalb", DEBACA: "DeBaca", LASALLE: "LaSalle", LAMOURE: "LaMoure",
  LAPORTE: "LaPorte", LAGRANGE: "LaGrange", LARUE: "LaRue", MACOUPIN: "Macoupin", MACON: "Macon", MACOMB: "Macomb",
};

/**
 * "LEON COUNTY", "leon", "Leon County, TX", "Leon Co." → "Leon"; "MCMULLEN" →
 * "McMullen", "DEWITT" → "DeWitt", "ST. LANDRY PARISH" → "St. Landry". A
 * trailing ", <state>" the clerk tacked on is dropped (the state is its own
 * field); the county keeps the casing the static county lists use.
 */
export function titleCounty(s: string): string {
  // "Leon County, TX" / "Leon, Texas": the state belongs in its own column.
  let t = stateSuffix(s).rest;
  t = t.replace(/[\s,]+(county|co\.?|parish|borough)$/i, "").replace(/[,\s]+$/, "").trim();
  const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x);
  const words = t.split(" ").map((w, i) => {
    const up = w.toUpperCase();
    if (i > 0 && COUNTY_LOWER.has(up)) return up.toLowerCase();
    if (COUNTY_CAMEL[up]) return COUNTY_CAMEL[up];
    if (/^MC[A-Z]/i.test(w) && w.length > 3) return "Mc" + cap(w.slice(2));
    // Hyphenated / apostrophe parts each get a capital ("O'Brien", "Miami-Dade").
    return w.split(/(['-])/).map((part) => (part === "'" || part === "-" ? part : cap(part))).join("");
  });
  return words.join(" ");
}


/**
 * A County cell as county + state: "Leon County, Texas" → { Leon, TX },
 * "LEON" → { Leon, null }. The state is only taken when the cell names one
 * after the county; otherwise it comes from the State column (or the file's
 * assigned state).
 */
export function countyCell(cell: string): { county: string; state: string | null } {
  return { county: titleCounty(cell), state: stateSuffix(cell).state };
}

/**
 * An Abstract cell's abstract numbers, one per abstract: "A-58, 61 / 102" →
 * ["58", "61", "102"]; "ABST 0923" → ["923"]; "A-923 J WARNICK SURVEY" →
 * ["923"]. Parts without a digit ("N/A") are not abstracts. Louisiana
 * sections ("Sec 12") are kept as written.
 */
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

/** A leading abstract token on a survey cell ("A-923 J WARNICK SURVEY"). */
const LEADING_ABSTRACT = /^\s*(?:abstract|abst|abs|a)\.?\s*(?:no\.?|#)?\s*-?\s*\d+[a-z]?\b[\s,;:·-]*/i;

/**
 * A Survey cell, standardized: "WARNICK, J" → "J. Warnick Survey"; a leading
 * abstract number is dropped first. Null for a blank (or number-only) cell.
 */
export function surveyName(cell: string | null | undefined): string | null {
  const s = (cell ?? "").replace(LEADING_ABSTRACT, "").trim().replace(/[\s,;:·-]+$/, "");
  if (!s || !/[a-z]/i.test(s)) return null;
  return surveyLabel(s) || null;
}

/**
 * A record over several abstracts can lie in several surveys: the Survey
 * field then lists each, "; "-separated ("T. Ragsdale Survey; J. Warnick
 * Survey"), the way the abstract cell lists several numbers.
 */
export const SURVEY_SEP = "; ";
export function splitSurveys(stored: string | null | undefined): string[] {
  return (stored ?? "").split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean);
}
export function joinSurveys(names: readonly (string | null | undefined)[]): string | null {
  const out: string[] = [];
  for (const n of names) if (n && !out.includes(n)) out.push(n);
  return out.length ? out.join(SURVEY_SEP) : null;
}

export interface LegalGeography { abstracts: string[]; survey: string | null; county: string | null; state: string | null }

/** A cell naming more than one location part ("A-923 J. Warnick Survey, Leon County"). */
export function isCombinedLocation(cell: string | null | undefined): boolean {
  const t = cell ?? "";
  const parts = [/\b(?:abstract|abst|abs)\b\.?\s*(?:no\.?|#)?\s*\d|\bA-\s?\d/i, /\b(?:survey|surv|sur|svy|league|labor|grant)\b/i, /\b(?:county|parish)\b/i];
  return parts.filter((re) => re.test(t)).length >= 2;
}

/**
 * The three location fields from the cells mapped to them. A plain cell is
 * read as its own field; a combined one (the same location column mapped to
 * several fields) gives each field only its own part, and only where the text
 * names it outright (parseLegalGeography). Blank stays blank.
 */
export function locationFields(cells: { abstract: string; survey: string; county: string }): {
  abstracts: string[]; abstractCell: string | null; survey: string | null; county: string | null; state: string | null; combined: string | null;
} {
  const combined = [cells.abstract, cells.survey, cells.county].find(isCombinedLocation) ?? null;
  const parsed = (cell: string) => (isCombinedLocation(cell) ? parseLegalGeography(cell) : null);
  const a = parsed(cells.abstract), sv = parsed(cells.survey), c = parsed(cells.county);
  const abstracts = a ? a.abstracts : abstractNumbers(cells.abstract);
  const cc = !c && cells.county ? countyCell(cells.county) : null;
  return {
    abstracts,
    // The abstract cell as recorded — for a combined cell, just its numbers
    // (the whole text is kept as the record's legal description).
    abstractCell: a ? (abstracts.join(", ") || null) : cells.abstract || null,
    // A survey cell may list several ("WARNICK, J; RAGSDALE, T").
    survey: sv ? sv.survey : joinSurveys(cells.survey.split(/\s*;\s*/).map(surveyName)),
    county: c ? c.county : cc?.county ?? null,
    state: c ? c.state : cc?.state ?? null,
    combined,
  };
}

const STOP_WORDS = new Set(["OF", "THE", "IN", "OUT", "BEING", "AND", "AC", "ACRE", "ACRES", "TRACT", "LOT", "BLOCK", "BLK", "SECTION", "SEC", "PART", "ALL", "SITUATED", "LOCATED"]);
const SURVEY_WORD = /^(SURVEY|SURV|SUR|SVY|LEAGUE|LABOR|GRANT)\.?,?$/i;

/**
 * Abstract, survey and county named in a combined legal-description cell
 * ("Abstract 923 · J. Warnick Survey · Leon County, Texas", "50 AC OUT OF THE
 * J. WARNICK SURVEY, A-923, LEON COUNTY, TX"). Only what the text marks
 * explicitly is taken — an abstract needs its "A-" / "Abst" / "Abstract"
 * prefix, a survey its "Survey" (or Sur / League / Labor / Grant) word, a
 * county its "County" / "Parish" word — and anything named twice
 * differently (two surveys, two counties) is left out rather than guessed.
 */
export function parseLegalGeography(text: string | null | undefined): LegalGeography {
  const none: LegalGeography = { abstracts: [], survey: null, county: null, state: null };
  let t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return none;

  // County: "<name> County|Parish[, <state>]" right after the start or a separator.
  const counties = new Map<string, string | null>();
  t = t.replace(/(^|[·|;,]\s*)([A-Za-z][A-Za-z.'-]*(?: [A-Za-z][A-Za-z.'-]*){0,2}) (?:COUNTY|CO\.|PARISH)\b(?:,? ?(?:STATE OF )?([A-Za-z]+(?: [A-Za-z]+)?))?/gi,
    (whole, lead: string, name: string, st: string | undefined) => {
      if (/\b(SURVEY|SUR|ABST|ABSTRACT)\b/i.test(name)) return whole;
      // The words after "County": a state ("Texas", "New Mexico", "TX"), else
      // they belong to the text that follows.
      const [w1 = "", w2 = ""] = (st ?? "").split(" ");
      const state = st && STATE_CODE_SET.has(normState(st)) ? normState(st) : STATE_CODE_SET.has(normState(w1)) ? normState(w1) : null;
      const rest = !st ? "" : state && STATE_CODE_SET.has(normState(st)) ? "" : state ? w2 : st;
      const key = titleCounty(name);
      counties.set(key, counties.get(key) ?? state);
      return `${lead} ${rest}`;
    });

  // Abstracts: explicitly marked numbers only.
  const abstracts: string[] = [];
  t = t.replace(/\b(?:ABSTRACT|ABST|ABS)\.?\s*(?:NO\.?|#)?\s*0*(\d+[A-Z]?)\b|\bA-\s?0*(\d+[A-Z]?)\b/gi, (_m, a: string | undefined, b: string | undefined) => {
    const n = (a ?? b ?? "").toUpperCase();
    if (n && !abstracts.includes(n)) abstracts.push(n);
    return " ";
  });

  // Survey: the words just before a survey word, back to a stop word or number.
  const surveys = new Set<string>();
  const words = t.split(" ").filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (!SURVEY_WORD.test(words[i])) continue;
    const name: string[] = [];
    for (let j = i - 1; j >= 0 && name.length < 5; j--) {
      const w = words[j].replace(/[·|;]+$/, "");
      if (!w || STOP_WORDS.has(w.toUpperCase().replace(/[.,]+$/, "")) || /\d/.test(w) || /[·|;]/.test(words[j])) break;
      name.unshift(w);
    }
    const label = name.length ? surveyName(`${name.join(" ")} ${words[i].replace(/,$/, "")}`) : null;
    if (label) surveys.add(label);
  }

  const county = counties.size === 1 ? [...counties.keys()][0] : null;
  return {
    abstracts,
    survey: surveys.size === 1 ? [...surveys][0] : null,
    county,
    state: county ? counties.get(county) ?? null : null,
  };
}
