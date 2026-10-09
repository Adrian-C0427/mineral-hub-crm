/**
 * Multi-state cadastral keys and query parsing for the map (gis.counties /
 * gis.abstracts hold Texas counties + abstracts AND Louisiana parishes + PLSS
 * sections, distinguished by their `state` column).
 *
 * County NAME alone is not a unique key: Sabine and Red River are both a Texas
 * county and a Louisiana parish. The map's county filter values therefore stay
 * bare names for Texas (every saved filter, URL and preset keeps working) and
 * are state-qualified for everything else: "LA|Sabine". parseCountyKey() reads
 * either shape; countyKey() writes the canonical one.
 *
 * Mirrored client-side in client/src/lib/counties.ts — keep the two in step.
 */

/** States with cadastral coverage in the gis schema. */
export const GIS_STATES = ["TX", "LA"] as const;

export interface CountyRef { state: string; name: string }

/**
 * "Leon" → TX/Leon (legacy, unqualified = Texas); "LA|Sabine" → LA/Sabine;
 * "TX|Sabine" → TX/Sabine. A "Caddo Parish" spelling is read as Louisiana and
 * "Sabine County" as Texas, so typed or pasted labels resolve too.
 */
export function parseCountyKey(raw: string): CountyRef {
  const s = raw.trim();
  const q = /^([A-Za-z]{2})\s*\|\s*(.+)$/.exec(s);
  if (q) return { state: q[1].toUpperCase(), name: q[2].trim() };
  const parish = /^(.+?)\s+parish(?:\s*,\s*(?:la|louisiana))?$/i.exec(s);
  if (parish) return { state: "LA", name: parish[1].trim() };
  const county = /^(.+?)\s+county(?:\s*,\s*(?:tx|texas))?$/i.exec(s);
  if (county) return { state: "TX", name: county[1].trim() };
  return { state: "TX", name: s };
}

/** Canonical filter key: bare name for Texas, "ST|Name" for any other state. */
export function countyKey(name: string, state: string | null | undefined): string {
  const st = (state ?? "TX").trim().toUpperCase() || "TX";
  return st === "TX" ? name : `${st}|${name}`;
}

/** Group county keys by state (names de-duplicated, order kept). */
export function groupCountyKeys(keys: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const k of keys) {
    if (!k.trim()) continue;
    const { state, name } = parseCountyKey(k);
    if (!name) continue;
    const list = out.get(state) ?? [];
    if (!list.includes(name)) list.push(name);
    out.set(state, list);
  }
  return out;
}

/** One state's county/parish names among the keys. */
export function stateCountyNames(keys: readonly string[], state: string): string[] {
  return groupCountyKeys(keys).get(state.toUpperCase()) ?? [];
}

/** Texas names among the keys — the only ones rrc.* (RRC = Texas) can match. */
export function texasCountyNames(keys: readonly string[]): string[] {
  return stateCountyNames(keys, "TX");
}

/** Louisiana parish names among the keys — the only ones sonris.* (SONRIS = Louisiana) can match. */
export function louisianaParishNames(keys: readonly string[]): string[] {
  return stateCountyNames(keys, "LA");
}

/**
 * State-aware county predicate for a gis.* table, appended to a positional
 * parameter list (Prisma/pg `$n`): one `(state = ANY($a) AND <county> = ANY($b))`
 * clause per state, OR-ed. Every value is a parameter — only the column names
 * (hard-coded by callers) are interpolated.
 */
export function countyScopePredicate(
  keys: readonly string[],
  params: unknown[],
  cols: { state: string; county: string } = { state: "state", county: "county" },
): string {
  const groups = [...groupCountyKeys(keys)];
  if (!groups.length) return "FALSE";
  const parts = groups.map(([state, names]) => {
    params.push([state]);
    const a = params.length;
    params.push(names);
    const b = params.length;
    return `(${cols.state} = ANY($${a}::text[]) AND ${cols.county} = ANY($${b}::text[]))`;
  });
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/** "County" / "Parish" — what a state calls its county-level division. */
export function countyNoun(state: string | null | undefined): "County" | "Parish" {
  return (state ?? "").trim().toUpperCase() === "LA" ? "Parish" : "County";
}

/**
 * A map-search term aimed at a county: "Caddo Parish" → { name: "Caddo",
 * state: "LA" }, "Sabine County, TX" → TX, "Sabine" → either state.
 */
export function countySearchTerm(q: string): { name: string; state: string | null } {
  const s = q.trim().replace(/\s+/g, " ");
  const m = /^(.+?)(?:\s+(parish|county))?(?:\s*,?\s*\b(la|louisiana|tx|texas))?$/i.exec(s);
  if (!m) return { name: s, state: null };
  const noun = m[2]?.toLowerCase();
  const st = m[3]?.toLowerCase();
  const state = st ? (st.startsWith("l") ? "LA" : "TX") : noun === "parish" ? "LA" : noun === "county" ? "TX" : null;
  return { name: m[1].trim(), state };
}

/** A parsed PLSS reference ("Sec 12, T17N R13W"); township/range are canonical ("T17N R13W"). */
export interface PlssQuery { section: number | null; township: string | null }

/**
 * Read a Public Land Survey System reference out of a search term. Accepts the
 * usual spellings: "Sec 12 T17N R13W", "Section 12, T17N, R13W", "S12 T17N R13W",
 * "12-17N-13W", "T17N R13W", "Sec 12". Returns null when the term isn't one.
 * Fractional townships (T5½N) keep their ½, matching the stored labels.
 */
export function parsePlssQuery(q: string): PlssQuery | null {
  const s = q.trim().toUpperCase().replace(/\s*1\/2/g, "½").replace(/\s+½/g, "½");
  // Compact "12-17N-13W" (section-township-range) form.
  const compact = /^(\d{1,3})\s*[-\s]\s*(\d{1,3}½?)\s*([NS])\s*[-\s]\s*(\d{1,3}½?)\s*([EW])$/.exec(s);
  if (compact) {
    return { section: Number(compact[1]), township: `T${trimZeros(compact[2])}${compact[3]} R${trimZeros(compact[4])}${compact[5]}` };
  }
  const t = /\bT(?:WP|OWNSHIP)?\.?\s*(\d{1,3}½?)\s*([NS])\b/.exec(s);
  const r = /\bR(?:NG|ANGE)?\.?\s*(\d{1,3}½?)\s*([EW])\b/.exec(s);
  const sec = /(?:^|[\s,])(?:SEC(?:TION)?\.?|S)\s*-?\s*(\d{1,3})\b/.exec(s);
  if (!t && !r && !sec) return null;
  // A township without its range (or vice versa) is too partial to resolve —
  // the ordinary label search handles "T17N" as text.
  if (!!t !== !!r) return null;
  // Everything in the term must be accounted for (so "Smith Survey 12" or an
  // API number never reads as a section).
  const rest = s
    .replace(t?.[0] ?? "", " ").replace(r?.[0] ?? "", " ").replace(sec?.[0] ?? "", " ")
    .replace(/[\s,;·-]+/g, "");
  if (rest) return null;
  return {
    section: sec ? Number(sec[1]) : null,
    township: t && r ? `T${trimZeros(t[1])}${t[2]} R${trimZeros(r[1])}${r[2]}` : null,
  };
}

function trimZeros(n: string): string {
  return n.replace(/^0+(?=\d)/, "");
}
