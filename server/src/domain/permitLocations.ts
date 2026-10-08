/**
 * Drilling permits → map locations (pure; no DB).
 *
 * The Research "Drilling permits" metrics count a merged set of org-imported
 * ResearchPermit rows and platform RRC W-1 permits (rrc.permits). Clicking one
 * opens the map with exactly that set highlighted, so the same rows the metric
 * counted are resolved here to points:
 *
 *   1. by 8-digit API → the rrc.wells surface location (the well the map
 *      draws from vector tiles, identified by its tile feature id `fid`);
 *   2. else (org imports only) by the permit's own latitude/longitude;
 *   3. else the permit is "unlocated" and only counted.
 *
 * Several permits can resolve to one well (amended / re-filed W-1s), so the
 * response distinguishes permits located from distinct wells highlighted.
 */

export type BBox = [number, number, number, number];

/** A counted permit, reduced to what locating it needs. */
export interface PermitLocatable {
  api8: string | null;
  lat?: number | null;
  lon?: number | null;
}

/** A surface well from rrc.wells (`fid` = its vector-tile feature id). */
export interface WellLocation { fid: number; api8: string; lon: number; lat: number }

/** One highlighted point: a tile well (fid) or a bare permit coordinate. */
export interface PermitPoint { fid: number | null; lon: number; lat: number; permits: number }

export interface PermitLocations {
  /** Permits counted by the metric (== the KPI value). */
  total: number;
  /** Of those, permits placed on the map. */
  located: number;
  unlocated: number;
  /** Distinct points highlighted (wells + coordinate-only permits). */
  wells: number;
  /** Points omitted from `points` past the cap (bbox still covers them). */
  truncated: boolean;
  /** Framing extent of every located permit, padded for a sensible zoom. */
  bbox: BBox | null;
  points: PermitPoint[];
}

/**
 * 8-digit RRC API (county code + unique number) from any API spelling:
 * "42-289-31234", "4228931234", "42289312340000" or a bare "28931234". The
 * Texas state code (42) is stripped only from a longer number — a bare api8
 * whose county code starts with 42 (Smith = 423, …) stays intact.
 */
export function permitApi8(api: string | null | undefined): string | null {
  const d = (api ?? "").replace(/\D/g, "");
  const s = (d.length > 8 && d.startsWith("42") ? d.slice(2) : d).slice(0, 8);
  return s.length === 8 ? s : null;
}

const validCoord = (lat: number | null | undefined, lon: number | null | undefined): boolean =>
  typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) &&
  Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

/**
 * Pad an extent so it never collapses to a point: a single well (or a tight
 * cluster) frames with ~`minSpan` degrees of context instead of the map's max
 * zoom. Larger extents pass through unchanged.
 */
export function frameExtent(bbox: BBox, minSpan = 0.05): BBox {
  let [w, s, e, n] = bbox;
  if (e - w < minSpan) { const c = (w + e) / 2; w = c - minSpan / 2; e = c + minSpan / 2; }
  if (n - s < minSpan) { const c = (s + n) / 2; s = c - minSpan / 2; n = c + minSpan / 2; }
  return [w, s, e, n];
}

/** Locate the counted permits (see module doc). `maxPoints` bounds the payload. */
export function resolvePermitLocations(
  permits: PermitLocatable[],
  wells: WellLocation[],
  maxPoints = 5000,
): PermitLocations {
  const byApi = new Map<string, WellLocation[]>();
  for (const w of wells) {
    if (!validCoord(w.lat, w.lon)) continue;
    const l = byApi.get(w.api8);
    if (l) l.push(w); else byApi.set(w.api8, [w]);
  }
  const points = new Map<string, PermitPoint>();
  const add = (key: string, fid: number | null, lon: number, lat: number) => {
    const p = points.get(key);
    if (p) p.permits++; else points.set(key, { fid, lon, lat, permits: 1 });
  };
  let located = 0;
  for (const p of permits) {
    const ws = p.api8 ? byApi.get(p.api8) : undefined;
    if (ws?.length) {
      // An api8 with more than one surface record (re-plotted location) marks
      // each — they are the same well on the map.
      for (const w of ws) add(`f:${w.fid}`, w.fid, w.lon, w.lat);
      located++;
    } else if (validCoord(p.lat, p.lon)) {
      add(`c:${p.lon!.toFixed(6)},${p.lat!.toFixed(6)}`, null, p.lon!, p.lat!);
      located++;
    }
  }
  const all = [...points.values()];
  let bbox: BBox | null = null;
  if (all.length) {
    let w = 180, s = 90, e = -180, n = -90;
    for (const p of all) { if (p.lon < w) w = p.lon; if (p.lon > e) e = p.lon; if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat; }
    bbox = frameExtent([w, s, e, n]);
  }
  return {
    total: permits.length,
    located,
    unlocated: permits.length - located,
    wells: all.length,
    truncated: all.length > maxPoints,
    bbox,
    points: all.slice(0, maxPoints),
  };
}
