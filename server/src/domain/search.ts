/**
 * Shared helpers for the free-text search endpoints that run against the
 * centralized reference schemas (`rrc.*`, `gis.*`).
 *
 * These endpoints are the most expensive queries reachable behind a VIEW-only
 * permission, so the rules that keep them indexable live in one place rather
 * than being restated (and drifting) at each call site.
 */

/**
 * Minimum term length for a leading-wildcard search.
 *
 * A trigram index can only be probed once the pattern holds at least one
 * complete trigram; a 1- or 2-character term degrades to a full scan of
 * whatever table it touches no matter how that table is indexed.
 */
export const MIN_SEARCH_CHARS = 3;

/**
 * Escape the LIKE/ILIKE pattern metacharacters in a user-supplied term.
 *
 * `%` and `_` are pattern OPERATORS, not literals, so a term consisting of
 * them (`%%%`, `___`) clears a length check but produces a pattern with no
 * extractable trigram — the planner cannot use the GIN indexes in
 * scripts/ensureSearchIndexes.ts and falls back to exactly the sequential scan
 * those indexes exist to prevent, with `similarity()` then evaluated over every
 * row. Escaping makes them match themselves, which is also what a user typing
 * a literal `%` means.
 *
 * Backslash is escaped first: it is the escape character itself, so doing it
 * later would re-escape the backslashes this function just added.
 *
 * Callers must pair this with `ESCAPE '\'` on the SQL side (Postgres defaults
 * to a backslash escape for LIKE, but `standard_conforming_strings` makes that
 * implicit only for the pattern — being explicit keeps it independent of
 * server settings).
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

/**
 * Does a term still carry enough literal text to probe a trigram index once
 * its wildcards are taken literally? `%%%` escapes to a searchable pattern,
 * but there is no point running it against millions of rows — nothing in the
 * reference data contains three consecutive percent signs. Callers short-
 * circuit to an empty result instead.
 */
export function isSearchableTerm(term: string): boolean {
  return term.trim().length >= MIN_SEARCH_CHARS;
}

/** One entry in a precomputed reference list (operators, fields, formations). */
export interface RefEntry {
  name: string;
  n: number;
  bbox: [number, number, number, number] | null;
}

/**
 * Rank a precomputed reference list against a search term.
 *
 * Replaces a per-request `ORDER BY similarity(col, $1)` over the whole wells
 * table. Ranking is deliberately simple and explainable — exact, then prefix,
 * then substring, each tie-broken by how many wells carry the value — which is
 * what a user picking an operator or field out of a list actually wants.
 */
export function rankRefEntries(entries: RefEntry[], term: string, limit: number): RefEntry[] {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  const scored: { entry: RefEntry; score: number }[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const at = name.indexOf(q);
    if (at < 0) continue;
    scored.push({ entry, score: name === q ? 3 : at === 0 ? 2 : 1 });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.entry.n - a.entry.n) || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit).map((s) => s.entry);
}
