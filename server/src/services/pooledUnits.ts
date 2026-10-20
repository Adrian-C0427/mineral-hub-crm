/**
 * Serves the bundled pooled-unit outlines (domain/pooledUnits) as GeoJSON.
 * The bundle is static reference data shipped with the build, so it is read,
 * validated and serialized once per process; nothing touches the database.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { POOLED_UNITS_DATASET, parsePooledUnits, pooledUnitsGeoJSON } from "../domain/pooledUnits.js";
import { rrcDataPath } from "./rrcRefresh.js";

export interface PooledUnitsPayload { etag: string; body: string; count: number }

let cached: PooledUnitsPayload | null | undefined;

/** The serialized FeatureCollection, or null when no bundle ships with this build. */
export function pooledUnitsPayload(file = rrcDataPath(import.meta.url, POOLED_UNITS_DATASET.file)): PooledUnitsPayload | null {
  if (cached !== undefined) return cached;
  if (!fs.existsSync(file)) return (cached = null);
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  const version = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const ds = parsePooledUnits(raw, version);
  cached = { etag: `"pooled-units-${version}"`, body: JSON.stringify(pooledUnitsGeoJSON(ds)), count: ds.units.length };
  return cached;
}

/** Tests only. */
export function resetPooledUnitsCache(): void { cached = undefined; }
