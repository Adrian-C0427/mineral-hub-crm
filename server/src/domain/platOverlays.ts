/**
 * Two more reference overlays read off the operators' drilling-permit plats
 * (the same Leon County plats the pooled units come from), bundled under
 * server/data/rrc by tools in ~/rrc-data/unit-plats (merge_qgis_package.py):
 *   - W-1 laterals: each well's surface location, penetration / first take
 *     point and bottom hole exactly as the plat prints them (NAD27 Texas
 *     Central, converted), joined into the plat's lateral lines. These are
 *     the permit's own coordinates — independent of RRC's map layers, which
 *     place some of the same wells up to ~2,000 ft away.
 *   - Lease tracts: lease outlines a lateral crosses that were NOT pooled
 *     into a unit, drawn on the well plats (reference only, not surveys).
 * Static, org-independent; parsed and validated once per process, never from
 * the database.
 */
import type { LonLat } from "./pooledUnits.js";

export const W1_LATERALS_DATASET = { key: "rrc-tx-w1-laterals", file: "tx-w1-laterals.json.gz" } as const;
export const LEASE_TRACTS_DATASET = { key: "rrc-tx-lease-tracts", file: "tx-lease-tracts.json.gz" } as const;

export interface W1Well {
  /** 8-digit API (county + well), e.g. 28932214. */
  api: string;
  well: string;
  operator: string;
  county: string;
  points: { kind: string; lonLat: LonLat }[];
  lines: { kind: string; path: LonLat[] }[];
}
export interface W1LateralsDataset { key: string; version: string; builtAt: string; source: { name: string; asOf: string }; wells: W1Well[] }

export interface LeaseTract {
  id: string;
  lease: string;
  operator: string;
  county: string;
  calledAcres: number;
  mappedAcres: number;
  /** The well whose plat draws the tract. */
  well: string;
  plat: string;
  rings: LonLat[][];
}
export interface LeaseTractsDataset { key: string; version: string; builtAt: string; source: { name: string; asOf: string }; tracts: LeaseTract[] }

const isLonLat = (p: unknown): p is LonLat =>
  Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v)) && Math.abs(p[0] as number) <= 180 && Math.abs(p[1] as number) <= 90;
const text = (json: Buffer | string) => (typeof json === "string" ? json : json.toString("utf8"));

/** Parse + validate the laterals bundle; throws on anything malformed so a bad file never half-serves. */
export function parseW1Laterals(json: Buffer | string, version: string): W1LateralsDataset {
  const ds = JSON.parse(text(json)) as W1LateralsDataset;
  if (ds.key !== W1_LATERALS_DATASET.key) throw new Error(`w1 laterals: unexpected key ${String(ds.key)}`);
  if (!Array.isArray(ds.wells)) throw new Error("w1 laterals: no wells array");
  const seen = new Set<string>();
  for (const w of ds.wells) {
    if (!/^\d{8}$/.test(w.api ?? "") || seen.has(w.api)) throw new Error(`w1 laterals: bad/duplicate api ${String(w.api)}`);
    seen.add(w.api);
    if (!w.well) throw new Error(`w1 laterals: ${w.api} has no name`);
    if (!Array.isArray(w.points) || !w.points.every((p) => p.kind && isLonLat(p.lonLat))) throw new Error(`w1 laterals: ${w.api} has bad points`);
    if (!Array.isArray(w.lines) || !w.lines.every((l) => l.kind && Array.isArray(l.path) && l.path.length >= 2 && l.path.every(isLonLat))) throw new Error(`w1 laterals: ${w.api} has bad lines`);
  }
  return { ...ds, version };
}

/** Parse + validate the lease-tract bundle. */
export function parseLeaseTracts(json: Buffer | string, version: string): LeaseTractsDataset {
  const ds = JSON.parse(text(json)) as LeaseTractsDataset;
  if (ds.key !== LEASE_TRACTS_DATASET.key) throw new Error(`lease tracts: unexpected key ${String(ds.key)}`);
  if (!Array.isArray(ds.tracts)) throw new Error("lease tracts: no tracts array");
  const ids = new Set<string>();
  for (const t of ds.tracts) {
    if (!t.id || ids.has(t.id)) throw new Error(`lease tracts: bad/duplicate id ${String(t.id)}`);
    ids.add(t.id);
    if (!t.lease) throw new Error(`lease tracts: ${t.id} has no lease name`);
    if (!(t.calledAcres > 0) || !(t.mappedAcres > 0)) throw new Error(`lease tracts: ${t.id} has no acreage`);
    if (!Array.isArray(t.rings) || !t.rings.length || !t.rings.every((r) => Array.isArray(r) && r.length >= 4 && r.every(isLonLat))) {
      throw new Error(`lease tracts: ${t.id} has bad geometry`);
    }
  }
  return { ...ds, version };
}

const api10 = (api: string) => `42-${api.slice(0, 3)}-${api.slice(3)}`;

/** GeoJSON for the map: one Point per plat point and one LineString per lateral segment, properties flat for MapLibre. */
export function w1LateralsGeoJSON(ds: W1LateralsDataset): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const w of ds.wells) {
    const base = { api: w.api, apiLabel: api10(w.api), well: w.well, operator: w.operator, county: w.county, pointCount: w.points.length, source: ds.source.name };
    for (const l of w.lines) features.push({ type: "Feature", id: `${w.api}:${l.kind}`, geometry: { type: "LineString", coordinates: l.path }, properties: { ...base, feature: "line", kind: l.kind } });
    for (const p of w.points) features.push({ type: "Feature", id: `${w.api}:${p.kind}`, geometry: { type: "Point", coordinates: p.lonLat }, properties: { ...base, feature: "point", kind: p.kind, role: pointRole(p.kind) } });
  }
  return { type: "FeatureCollection", features };
}
/** Point role for styling: surface / take / bottom. */
export function pointRole(kind: string): "surface" | "bottom" | "take" {
  const k = kind.toLowerCase();
  if (k.startsWith("surface")) return "surface";
  if (k.startsWith("bottom")) return "bottom";
  return "take";
}

/** GeoJSON for the map: one Polygon per lease tract. */
export function leaseTractsGeoJSON(ds: LeaseTractsDataset): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: ds.tracts.map((t) => ({
      type: "Feature",
      id: t.id,
      geometry: { type: "Polygon", coordinates: t.rings },
      properties: {
        id: t.id, lease: t.lease, operator: t.operator, county: t.county, calledAcres: t.calledAcres, mappedAcres: t.mappedAcres, well: t.well, plat: t.plat,
        label: `${t.lease}\n${t.calledAcres.toLocaleString("en-US", { maximumFractionDigits: 2 })} ac (not pooled)`,
      },
    })),
  };
}
