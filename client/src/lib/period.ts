/**
 * The "All" time frame — one definition shared by every period selector
 * (Research, Reports, Dashboard).
 *
 * All is sent as `?period=ALL` and never as a from/to of its own: the server
 * resolves it to the full available history (server/src/domain/period.ts)
 * instead of falling back to its default window. There is no previous period
 * before "everything", so period comparisons are switched off while it's on.
 */
export const ALL_PERIOD = "ALL" as const;
export type AllPeriod = typeof ALL_PERIOD;

/** Header/range label while All is selected. */
export const ALL_PERIOD_LABEL = "All time";

export const isAllPeriod = (p: string): p is AllPeriod => p === ALL_PERIOD;

/**
 * A page's presets with the shared All option added — just before "Custom"
 * (or last), so every selector orders it the same way.
 */
export function withAllPeriod<T extends string>(presets: readonly (readonly [T, string])[]): [T | AllPeriod, string][] {
  const all: [AllPeriod, string] = [ALL_PERIOD, "All"];
  const out: [T | AllPeriod, string][] = presets.map(([v, l]) => [v, l]);
  const i = out.findIndex(([v]) => v === "CUSTOM");
  out.splice(i < 0 ? out.length : i, 0, all);
  return out;
}

/**
 * A custom reporting range: two calendar days as "YYYY-MM-DD" ("" = not
 * chosen yet), the DateField contract. Both ends are inclusive — the server
 * counts the "to" day in full (server/src/routes/dashboard.ts).
 */
export interface DayRange { from: string; to: string }

export const EMPTY_RANGE: DayRange = { from: "", to: "" };

/** A real calendar day in "YYYY-MM-DD" form (rejects 2026-02-30 and friends). */
export function isIsoDay(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo && t.getUTCDate() === d;
}

/**
 * Why a custom range can't be applied yet, or null when it can. A range is
 * applied (and fetched) only once it is complete, well-formed and in order —
 * never half-picked — so reports don't reload on every intermediate pick. A
 * single day (from === to) is a valid range.
 */
export function rangeIssue(r: DayRange): "incomplete" | "invalid" | "order" | null {
  if (!r.from || !r.to) return "incomplete";
  if (!isIsoDay(r.from) || !isIsoDay(r.to)) return "invalid";
  if (r.from > r.to) return "order"; // ISO day strings sort chronologically
  return null;
}

/** Days covered by a valid range, both ends included (null when not applicable). */
export function rangeDays(r: DayRange): number | null {
  if (rangeIssue(r)) return null;
  const ms = Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

export const sameRange = (a: DayRange, b: DayRange): boolean => a.from === b.from && a.to === b.to;
