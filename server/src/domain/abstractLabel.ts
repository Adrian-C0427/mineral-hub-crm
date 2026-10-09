/**
 * How the app identifies an abstract to a person:
 *   "Abstract 15 · J Smith Survey · Leon County, Texas"   (formatAbstract)
 *   "A-15 · J Smith Survey"   (abstractShortLabel — pickers/selectors, where
 *                              the county is already chosen)
 * Abstract numbers arrive in several shapes ("A-15" GIS labels, "15" research
 * cells, "ABST 015"), so everything goes through abstractNumber() first.
 * Mirrors client/src/lib/abstracts.ts — keep the two in step.
 */

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming",
};

export function stateName(code: string | null | undefined): string {
  if (!code) return "";
  return STATE_NAMES[code.trim().toUpperCase()] ?? code.trim();
}

/** "A-15" / "a15" / "ABST 015" / "15" → "15" (a trailing letter is kept: "A-15B" → "15B"). */
export function abstractNumber(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  const m = s.match(/^(?:a(?:bs(?:t(?:ract)?)?)?\.?\s*[-#]?\s*)?0*(\d+[a-z]?)\b/i);
  if (m) return m[1].toUpperCase();
  return s.replace(/^a\s*-\s*/i, "");
}

/** Numeric sort key of an abstract number ("15B" → 15; a PLSS "Sec 12" → 12); non-numeric sorts last. */
export function abstractSortKey(raw: string | null | undefined): number {
  const n = parseInt(sectionNumber(raw) ?? abstractNumber(raw), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Louisiana cadastral units are PLSS sections, stored in the same slots as a
 * Texas abstract: label "Sec 12", survey = township/range "T17N R13W". They are
 * recognised by the label itself, so every caller formats them correctly even
 * where the row's state isn't at hand.
 */
export function isSectionLabel(raw: string | null | undefined): boolean {
  return /^sec(?:tion)?\.?\s*\d/i.test((raw ?? "").trim());
}

/** "Sec 07" / "Section 7" → "7"; null when the label isn't a section. */
export function sectionNumber(raw: string | null | undefined): string | null {
  const m = /^sec(?:tion)?\.?\s*0*(\d+[a-z]?)\b/i.exec((raw ?? "").trim());
  return m ? m[1].toUpperCase() : null;
}

/** "T17N R13W" — a PLSS township/range (fractional townships carry a ½). */
export function isTownshipRange(raw: string | null | undefined): boolean {
  return /^T\d+½?[NS]\s+R\d+½?[EW]$/i.test((raw ?? "").trim());
}

/** "Sec 12 · T17N R13W" — a section with its township/range. */
export function sectionLabel(p: { abstract: string | null | undefined; survey?: string | null }): string {
  const n = sectionNumber(p.abstract);
  return [n ? `Sec ${n}` : (p.abstract ?? "").trim() || "Section", (p.survey ?? "").trim().toUpperCase()].filter(Boolean).join(" · ");
}

// Grantee names that are organizations/grants, not "Last, First" people.
const NON_PERSON = /\b(SURVEY|SURV|LEAGUE|LABOR|GRANT|SECTION|SEC|BLOCK|BLK|RR|RY|CO|INC|CSL|SCH|SCHOOL|LAND|CITY|COUNTY|STATE|UNIV|UNIVERSITY|HEIRS|ESTATE)\b/i;
// A lone initial reads as one: "W" → "W.".
const titleWord = (w: string) => (/^[A-Z]\.?$/i.test(w) ? `${w[0].toUpperCase()}.` : w.length <= 1 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase());

/**
 * Survey names are stored as recorded — "WOODS, R", "S SANCHEZ SUR",
 * "SA&MG RR CO". People read "R. Woods Survey": flip "Last, First" names,
 * title-case them, and make every name read as a survey.
 */
export function surveyLabel(survey: string | null | undefined): string {
  let s = (survey ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  // A PLSS township/range is not a survey name — it reads as recorded.
  if (isTownshipRange(s)) return s.toUpperCase();
  s = s.replace(/\s*\bSUR\.?$/i, "");
  // A trailing grant type ("SANCHEZ, S LEAGUE") names the survey itself.
  const kind = s.match(/\s+(SURVEY|LEAGUE|LABOR|GRANT)$/i)?.[1] ?? "";
  if (kind) s = s.slice(0, -kind.length).trim();
  const person = s.match(/^([^,]+),\s*([^,]+)$/);
  if (person && !NON_PERSON.test(s)) s = `${person[2]} ${person[1]}`;
  if (!NON_PERSON.test(s)) s = s.split(" ").map(titleWord).join(" ");
  return `${s} ${kind ? titleWord(kind) : "Survey"}`;
}

/** "Leon County" / "Caddo Parish" — Louisiana's county-level division is the parish. */
export function countyLabel(county: string | null | undefined, state: string | null | undefined): string {
  const c = (county ?? "").trim();
  if (!c) return "";
  if (/\b(county|parish)$/i.test(c)) return c;
  return `${c} ${(state ?? "").trim().toUpperCase() === "LA" ? "Parish" : "County"}`;
}

/** "Leon County, Texas" / "Caddo Parish, Louisiana" — whichever parts are known. */
export function countyStateLabel(county: string | null | undefined, state: string | null | undefined): string {
  const c = countyLabel(county, state);
  const st = stateName(state);
  if (c) return `${c}${st ? `, ${st}` : ""}`;
  return st;
}

export interface AbstractParts { abstract: string | null | undefined; survey?: string | null; county?: string | null; state?: string | null }

/**
 * "Abstract 15 · J Dunn Survey · Leon County, Texas" (parts that are unknown are
 * omitted); a Louisiana section reads "Sec 12 · T17N R13W · Caddo Parish, Louisiana".
 */
export function formatAbstract(p: AbstractParts): string {
  if (isSectionLabel(p.abstract)) {
    return [sectionLabel(p), countyStateLabel(p.county, p.state ?? (p.county ? "LA" : null))].filter(Boolean).join(" · ");
  }
  const num = abstractNumber(p.abstract);
  return [num ? `Abstract ${num}` : "Abstract", surveyLabel(p.survey), countyStateLabel(p.county, p.state)]
    .filter(Boolean)
    .join(" · ");
}

/** "A-3 · W Dwight Survey" (or "Sec 12 · T17N R13W") — abstract selectors, where the county is already chosen. */
export function abstractShortLabel(p: { abstract: string | null | undefined; survey?: string | null }): string {
  if (isSectionLabel(p.abstract)) return sectionLabel(p);
  const num = abstractNumber(p.abstract);
  return [num ? `A-${num}` : "Abstract", surveyLabel(p.survey)].filter(Boolean).join(" · ");
}

/**
 * Order abstracts for a typed query so the intended one is on top:
 *  - a number in the query ranks exact abstract-number matches first, then
 *    numbers starting with it, then numbers containing it, then text-only
 *    matches (survey / county);
 *  - within each tier, ascending by abstract number (15 before 115 before 150).
 * Items matching neither the number nor the text are dropped. An empty query
 * keeps every item, numerically ordered.
 */
export function rankAbstracts<T>(items: readonly T[], query: string, get: (t: T) => { abstract: string | null | undefined; text: string }): T[] {
  const q = query.trim().toLowerCase();
  const digits = q.match(/\d+/)?.[0]?.replace(/^0+(?=\d)/, "") ?? "";
  // Words other than an "abstract"/"a-" prefix must also match the item's text.
  const words = q.replace(/\d+[a-z]?/g, " ").split(/[\s,.#—·-]+/)
    .filter((w) => w && !/^(a|ab|abs|abst|abstr|abstra|abstrac|abstract|sec|section)$/.test(w));
  const scored: { t: T; tier: number; key: number; text: string }[] = [];
  for (const t of items) {
    const { abstract, text } = get(t);
    const num = (sectionNumber(abstract) ?? abstractNumber(abstract)).toLowerCase();
    const hay = text.toLowerCase();
    let tier: number;
    if (!q) tier = 0;
    else if (digits) {
      tier = num === digits ? 0 : num.startsWith(digits) ? 1 : num.includes(digits) ? 2 : hay.includes(q) ? 3 : -1;
      if (tier >= 0 && tier < 3 && words.length && !words.every((w) => hay.includes(w))) tier = -1;
    } else tier = hay.includes(q) || (words.length > 0 && words.every((w) => hay.includes(w))) ? 3 : -1;
    if (tier >= 0) scored.push({ t, tier, key: abstractSortKey(abstract), text: hay });
  }
  scored.sort((a, b) => a.tier - b.tier || a.key - b.key || a.text.localeCompare(b.text));
  return scored.map((s) => s.t);
}
