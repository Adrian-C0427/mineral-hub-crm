/**
 * The "All" time frame, shared by every period-scoped endpoint (Research,
 * Reports, Dashboard).
 *
 * Clients send `?period=ALL` instead of inventing a from/to, so an endpoint
 * whose default for a missing range is "last 90 days" / "this year" can never
 * silently fall back to it. Each endpoint resolves All to the span its own
 * data actually covers (allTimeSpan) — charts start at the first record rather
 * than at an arbitrary epoch — and skips previous-period comparisons, which
 * have no meaning when nothing precedes the window.
 */
export const ALL_PERIOD = "ALL";

export const isAllPeriod = (v: unknown): boolean => v === ALL_PERIOD;

const DAY = 86_400_000;
const dayFloor = (t: number) => new Date(Math.floor(t / DAY) * DAY);

/**
 * Inclusive [from, to] UTC-day span covering every given date, always
 * reaching today (so "All" never ends before now, and future-dated records —
 * e.g. projected closings — stay on the axis). With no dates it collapses to
 * today. Null/invalid dates are ignored.
 */
export function allTimeSpan(dates: Iterable<Date | null | undefined>, now: Date): { from: Date; to: Date } {
  let min = now.getTime(), max = now.getTime();
  for (const d of dates) {
    const t = d?.getTime();
    if (t == null || Number.isNaN(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return { from: dayFloor(min), to: dayFloor(max) };
}
