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
