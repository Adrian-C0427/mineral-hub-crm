/**
 * Pooled units drawn from operators' RRC drilling-permit plats (W-1
 * attachments), bundled as server/data/rrc/tx-pooled-units.json.gz by the
 * offline builder in tools/rrc/units/. Each unit is the outline the
 * operator's surveyor drew, placed on the map from the plat's own surveyed
 * points, and kept only if it passed the builder's checks:
 *   - placement: the plat's three surveyed points (surface location, first
 *     take point, bottom hole) fit with every residual ≤ 25 ft;
 *   - shape: the traced outline lines up with the same unit on the placed
 *     well-location plat;
 *   - size: the mapped area is within 2.5% of the acres the plat calls.
 * The bundle carries those measurements per unit so the map can show them.
 */

export const POOLED_UNITS_DATASET = { key: "rrc-tx-pooled-units", file: "tx-pooled-units.json.gz" } as const;

export type LonLat = [number, number];

export interface PooledUnitWell { api: string; lease: string | null; wellNo: string | null; permit: string }

export interface PooledUnit {
  id: string;
  name: string;
  operator: string;
  county: string;
  /** Acres the plat calls for the unit. */
  calledAcres: number;
  /** Area of the mapped outline. */
  mappedAcres: number;
  wells: PooledUnitWell[];
  plat: { permit: string; rrcId: string; url: string; file: string };
  placement: {
    /** "unit-plat" (the unit's own plat, lined up on the well plat) or "well-plat" (drawn on the well plat itself). */
    method: "unit-plat" | "well-plat";
    /** Worst of the well plat's three surveyed points after the fit (ft). */
    controlResidualFt: number;
    /** Share of the outline within ~10 ft of the well plat's drawing (unit-plat method only). */
    within10ftPct: number | null;
  };
  /** Polygon rings, NAD83 [lon, lat]; the first ring is the outer boundary. */
  rings: LonLat[][];
}

export interface PooledUnitsDataset {
  key: string;
  version: string;
  builtAt: string;
  source: { name: string; asOf: string };
  units: PooledUnit[];
}

const isLonLat = (p: unknown): p is LonLat =>
  Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v)) && Math.abs(p[0] as number) <= 180 && Math.abs(p[1] as number) <= 90;

/** Parse + validate the bundle; throws on anything malformed so a bad file never half-serves. */
export function parsePooledUnits(json: Buffer | string, version: string): PooledUnitsDataset {
  const ds = JSON.parse(typeof json === "string" ? json : json.toString("utf8")) as PooledUnitsDataset;
  if (ds.key !== POOLED_UNITS_DATASET.key) throw new Error(`pooled units: unexpected key ${String(ds.key)}`);
  if (!Array.isArray(ds.units)) throw new Error("pooled units: no units array");
  const ids = new Set<string>();
  for (const u of ds.units) {
    if (!u.id || ids.has(u.id)) throw new Error(`pooled units: bad/duplicate id ${String(u.id)}`);
    ids.add(u.id);
    if (!(u.calledAcres > 0) || !(u.mappedAcres > 0)) throw new Error(`pooled units: ${u.id} has no acreage`);
    if (!Array.isArray(u.rings) || !u.rings.length || !u.rings.every((r) => Array.isArray(r) && r.length >= 4 && r.every(isLonLat))) {
      throw new Error(`pooled units: ${u.id} has bad geometry`);
    }
  }
  return { ...ds, version };
}

/** GeoJSON for the map overlay: one Polygon feature per unit, properties flattened for MapLibre. */
export function pooledUnitsGeoJSON(ds: PooledUnitsDataset): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: ds.units.map((u) => ({
      type: "Feature",
      id: u.id,
      geometry: { type: "Polygon", coordinates: u.rings },
      properties: {
        id: u.id,
        name: u.name,
        operator: u.operator,
        county: u.county,
        calledAcres: u.calledAcres,
        mappedAcres: u.mappedAcres,
        label: `${u.name}\n${u.calledAcres.toLocaleString("en-US", { maximumFractionDigits: 2 })} ac`,
        // MapLibre flattens nested properties to strings; keep the structured bits as JSON.
        wells: JSON.stringify(u.wells),
        plat: JSON.stringify(u.plat),
        placement: JSON.stringify(u.placement),
      },
    })),
  };
}
