import { COUNTIES, COUNTIES_WITH_WELLS } from "./counties";

/**
 * Operators available within a set of counties, derived from the same well data
 * the Map page uses (per-county {key}-operators.json indexes). Single county →
 * that county's operators; multiple counties → the combined, de-duplicated list.
 * Only counties that have well data contribute; unknown counties are ignored.
 */
const cache = new Map<string, Promise<string[]>>();

function loadCounty(key: string): Promise<string[]> {
  let p = cache.get(key);
  if (!p) {
    p = fetch(`/data/${key}-operators.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    cache.set(key, p);
  }
  return p;
}

export async function operatorsForCounties(countyNames: string[]): Promise<string[]> {
  const keys = [
    ...new Set(
      countyNames
        .map((name) => COUNTIES.find((c) => c.name.toLowerCase() === name.toLowerCase())?.key)
        .filter((k): k is string => !!k && COUNTIES_WITH_WELLS.includes(k)),
    ),
  ];
  const lists = await Promise.all(keys.map(loadCounty));
  return [...new Set(lists.flat())].sort((a, b) => a.localeCompare(b));
}
