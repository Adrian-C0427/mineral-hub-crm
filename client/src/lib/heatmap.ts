// Production heat-map analytics — pure, framework-free data layer.
//
// Turns the app's existing lease-level monthly production (Record keyed
// "og|district|leaseNo") plus the well point layer into per-well production
// points for a chosen time period, honoring the map's filters. MapView feeds
// these into MapLibre `heatmap` layers and the summary/ranking/hotspot panels.
//
// The framework is deliberately layer-agnostic: `buildPoints` yields weighted
// geographic points, and everything downstream (heat sources, top-producer
// overlay, hotspot detection, rankings, click summaries) consumes that one
// array. A future "leasing activity" or "permits" heat layer only needs to
// produce its own HeatPoint[] to reuse the entire pipeline.

export type ProdMap = Record<string, [number, number, number][]>; // key -> [YYYYMM, oil bbl, gas mcf][]

export type HeatPeriod = "current" | "3m" | "6m" | "12m" | "3y" | "ytd" | "custom";

export interface HeatWell {
  fid: number;
  lon: number;
  lat: number;
  leaseKey: string | null;
  operator: string | null;
  county: string;
  abstract: string | null;
  survey: string | null;
  leaseName: string | null;
  api: string;
  type: string;
  status: string;
  formations: string[];
}

export interface HeatPoint extends HeatWell {
  oil: number; // period oil (bbl) attributed to this well
  gas: number; // period gas (mcf) attributed to this well
}

export interface HeatFilters {
  counties: string[];
  operators: string[];
  wellTypes: string[];
  wellStatuses: string[];
  formations: string[];
}

/** 6 mcf ≈ 1 boe — a rough gas→oil equivalence so oil and gas can be ranked together. */
export const boe = (oil: number, gas: number) => oil + gas / 6;

/** Lease join used across the map: matches the info-panel production key. */
export function leaseKeyOf(p: { oilGas?: unknown; district?: unknown; leaseNo?: unknown }): string | null {
  const leaseNo = p.leaseNo as string | null;
  if (!leaseNo) return null;
  const og = p.oilGas === "Gas" ? "G" : "O";
  const district = (p.district as string) || "05";
  return `${og}|${district}|${leaseNo}`;
}

const monthIndex = (m: number) => Math.floor(m / 100) * 12 + (m % 100) - 1;

/**
 * Latest month with *reported* production — the effective "current" month.
 * RRC production lags 2–4 months, so the newest calendar months in the file are
 * typically all zero; anchoring periods to the last month that actually has
 * output keeps "Current month" / "Last 3 months" meaningful instead of empty.
 */
export function latestMonth(prod: ProdMap): number {
  let mx = 0;
  for (const s of Object.values(prod)) for (const [m, o, g] of s) if ((o > 0 || g > 0) && m > mx) mx = m;
  return mx;
}

export interface PeriodSpec { has: (m: number) => boolean; label: string; from: number; to: number }

/** Resolve a period to an inclusive [from, to] YYYYMM window + membership test. */
export function periodWindow(period: HeatPeriod, latest: number, customFrom?: string, customto?: string): PeriodSpec {
  if (!latest) return { has: () => false, label: "—", from: 0, to: 0 };
  const back = (n: number) => {
    const idx = monthIndex(latest) - n;
    const y = Math.floor(idx / 12), mo = (idx % 12) + 1;
    return y * 100 + mo;
  };
  const parse = (s?: string) => {
    if (!s) return 0;
    const [y, m] = s.split("-");
    return Number(y) * 100 + Number(m);
  };
  let from = latest, to = latest, label = "Current month";
  switch (period) {
    case "current": from = latest; label = "Current month"; break;
    case "3m": from = back(2); label = "Last 3 months"; break;
    case "6m": from = back(5); label = "Last 6 months"; break;
    case "12m": from = back(11); label = "Last 12 months"; break;
    case "3y": from = back(35); label = "Last 3 years"; break;
    case "ytd": from = Math.floor(latest / 100) * 100 + 1; label = "Year to date"; break;
    case "custom": {
      from = parse(customFrom) || latest;
      to = parse(customto) || latest;
      if (from > to) [from, to] = [to, from];
      label = "Custom range";
      break;
    }
  }
  const fi = monthIndex(from), ti = monthIndex(to);
  return { has: (m: number) => { const i = monthIndex(m); return i >= fi && i <= ti; }, label, from, to };
}

/** Extract well points (with coords + lease key) from the wells FeatureCollection features. */
export function extractWells(features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[]): HeatWell[] {
  const out: HeatWell[] = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) continue;
    const [lon, lat] = g.coordinates as number[];
    const p = f.properties;
    out.push({
      fid: Number(p.fid),
      lon, lat,
      leaseKey: leaseKeyOf(p),
      operator: (p.operator as string) || null,
      county: (p.county as string) || "",
      abstract: (p.abstract as string) || null,
      survey: (p.survey as string) || null,
      leaseName: (p.leaseName as string) || null,
      api: (p.api as string) || "",
      type: (p.type as string) || "",
      status: (p.status as string) || "",
      formations: Array.isArray(p.formations) ? (p.formations as string[]) : (p.formations ? String(p.formations).split(",").map((s) => s.trim()) : []),
    });
  }
  return out;
}

/** Count wells sharing each lease (with coords), so a lease's production splits fairly among its wells. */
export function wellsPerLease(wells: HeatWell[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of wells) if (w.leaseKey) m.set(w.leaseKey, (m.get(w.leaseKey) ?? 0) + 1);
  return m;
}

function passes(w: HeatWell, f: HeatFilters): boolean {
  if (f.counties.length && !f.counties.includes(w.county)) return false;
  if (f.operators.length && !(w.operator && f.operators.includes(w.operator))) return false;
  if (f.wellTypes.length && !f.wellTypes.includes(w.type)) return false;
  if (f.wellStatuses.length && !f.wellStatuses.includes(w.status)) return false;
  if (f.formations.length && !w.formations.some((x) => f.formations.includes(x))) return false;
  return true;
}

/**
 * Build weighted production points for the period. A lease's period production
 * is split equally among every coordinate-bearing well on that lease (so totals
 * stay honest regardless of which wells the filters keep visible).
 */
export function buildPoints(
  wells: HeatWell[],
  perLease: Map<string, number>,
  prod: ProdMap,
  spec: PeriodSpec,
  filters: HeatFilters,
): HeatPoint[] {
  const out: HeatPoint[] = [];
  for (const w of wells) {
    if (!w.leaseKey || !passes(w, filters)) continue;
    const series = prod[w.leaseKey];
    if (!series) continue;
    let oil = 0, gas = 0;
    for (const [m, o, g] of series) if (spec.has(m)) { oil += o; gas += g; }
    if (oil <= 0 && gas <= 0) continue;
    const n = perLease.get(w.leaseKey) ?? 1;
    out.push({ ...w, oil: oil / n, gas: gas / n });
  }
  return out;
}

/** GeoJSON of points for one metric, filtered by min/max threshold, with weight normalized to [0,1]. */
export function metricGeojson(points: HeatPoint[], metric: "oil" | "gas", min: number, max: number, norm: number) {
  const features = [];
  for (const p of points) {
    const v = p[metric];
    if (v <= 0 || v < min || (max > 0 && v > max)) continue;
    features.push({ type: "Feature" as const, properties: { w: norm > 0 ? Math.min(1, v / norm) : 0, v }, geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] } });
  }
  return { type: "FeatureCollection" as const, features };
}

export interface AreaSummary {
  wells: number;
  oil: number;
  gas: number;
  avgOil: number;
  avgGas: number;
  topOperators: { name: string; oil: number; gas: number; wells: number }[];
  topWells: { api: string; leaseName: string | null; operator: string | null; oil: number; gas: number }[];
  counties: string[];
  abstracts: string[];
  surveys: string[];
}

/** Summary of the production points falling inside a clicked area. */
export function summarize(points: HeatPoint[]): AreaSummary {
  const oil = points.reduce((s, p) => s + p.oil, 0);
  const gas = points.reduce((s, p) => s + p.gas, 0);
  const byOp = new Map<string, { oil: number; gas: number; wells: number }>();
  for (const p of points) {
    const k = p.operator || "(unknown)";
    const e = byOp.get(k) ?? { oil: 0, gas: 0, wells: 0 };
    e.oil += p.oil; e.gas += p.gas; e.wells += 1; byOp.set(k, e);
  }
  const topOperators = [...byOp.entries()].map(([name, e]) => ({ name, ...e })).sort((a, b) => boe(b.oil, b.gas) - boe(a.oil, a.gas)).slice(0, 5);
  const topWells = [...points].sort((a, b) => boe(b.oil, b.gas) - boe(a.oil, a.gas)).slice(0, 5)
    .map((p) => ({ api: p.api, leaseName: p.leaseName, operator: p.operator, oil: p.oil, gas: p.gas }));
  const uniq = (a: (string | null)[]) => [...new Set(a.filter(Boolean) as string[])].sort();
  return {
    wells: points.length, oil, gas,
    avgOil: points.length ? oil / points.length : 0,
    avgGas: points.length ? gas / points.length : 0,
    topOperators, topWells,
    counties: uniq(points.map((p) => p.county)),
    abstracts: uniq(points.map((p) => p.abstract)),
    surveys: uniq(points.map((p) => p.survey)),
  };
}

export interface RankRow { name: string; oil: number; gas: number; wells: number }
export interface Rankings { counties: RankRow[]; operators: RankRow[]; formations: RankRow[] }

function rankBy(points: HeatPoint[], key: (p: HeatPoint) => string[]): RankRow[] {
  const m = new Map<string, RankRow>();
  for (const p of points) for (const name of key(p)) {
    if (!name) continue;
    const e = m.get(name) ?? { name, oil: 0, gas: 0, wells: 0 };
    e.oil += p.oil; e.gas += p.gas; e.wells += 1; m.set(name, e);
  }
  return [...m.values()].sort((a, b) => boe(b.oil, b.gas) - boe(a.oil, a.gas)).slice(0, 5);
}

/** Top counties / operators / formations for the active point set. */
export function rankings(points: HeatPoint[]): Rankings {
  return {
    counties: rankBy(points, (p) => [p.county]),
    operators: rankBy(points, (p) => [p.operator || ""]),
    formations: rankBy(points, (p) => p.formations),
  };
}

export interface Hotspot { lon: number; lat: number; oil: number; gas: number; wells: number; operator: string | null }

/**
 * Bin points into a grid over `bounds` and return the highest-producing cells —
 * the concentrated hotspots within the current view.
 */
export function detectHotspots(points: HeatPoint[], bounds: [number, number, number, number], cells = 24, top = 3): Hotspot[] {
  const [minX, minY, maxX, maxY] = bounds;
  const sx = (maxX - minX) / cells || 1, sy = (maxY - minY) / cells || 1;
  const grid = new Map<string, { oil: number; gas: number; wells: number; sx: number; sy: number; ops: Map<string, number> }>();
  for (const p of points) {
    if (p.lon < minX || p.lon > maxX || p.lat < minY || p.lat > maxY) continue;
    const gx = Math.floor((p.lon - minX) / sx), gy = Math.floor((p.lat - minY) / sy);
    const k = `${gx}|${gy}`;
    const e = grid.get(k) ?? { oil: 0, gas: 0, wells: 0, sx: 0, sy: 0, ops: new Map() };
    e.oil += p.oil; e.gas += p.gas; e.wells += 1; e.sx += p.lon; e.sy += p.lat;
    if (p.operator) e.ops.set(p.operator, (e.ops.get(p.operator) ?? 0) + boe(p.oil, p.gas));
    grid.set(k, e);
  }
  return [...grid.values()]
    .sort((a, b) => boe(b.oil, b.gas) - boe(a.oil, a.gas))
    .slice(0, top)
    .map((e) => ({
      lon: e.sx / e.wells, lat: e.sy / e.wells, oil: e.oil, gas: e.gas, wells: e.wells,
      operator: [...e.ops.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }));
}
