/**
 * Serves the bundled W-1 laterals and lease tracts (domain/platOverlays) as
 * GeoJSON — static reference data read, validated and serialized once per
 * process, like services/pooledUnits. Nothing touches the database.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { LEASE_TRACTS_DATASET, W1_LATERALS_DATASET, leaseTractsGeoJSON, parseLeaseTracts, parseW1Laterals, w1LateralsGeoJSON } from "../domain/platOverlays.js";
import { rrcDataPath } from "./rrcRefresh.js";

export interface OverlayPayload { etag: string; body: string; count: number }

const cache = new Map<string, OverlayPayload | null>();

function load(name: string, file: string, build: (raw: Buffer, version: string) => { body: string; count: number }): OverlayPayload | null {
  if (cache.has(name)) return cache.get(name) ?? null;
  if (!fs.existsSync(file)) { cache.set(name, null); return null; }
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  const version = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const { body, count } = build(raw, version);
  const p = { etag: `"${name}-${version}"`, body, count };
  cache.set(name, p);
  return p;
}

/** The W-1 laterals FeatureCollection, or null when no bundle ships with this build. */
export function w1LateralsPayload(file = rrcDataPath(import.meta.url, W1_LATERALS_DATASET.file)): OverlayPayload | null {
  return load("w1-laterals", file, (raw, version) => {
    const ds = parseW1Laterals(raw, version);
    return { body: JSON.stringify(w1LateralsGeoJSON(ds)), count: ds.wells.length };
  });
}

/** The lease-tracts FeatureCollection, or null when no bundle ships with this build. */
export function leaseTractsPayload(file = rrcDataPath(import.meta.url, LEASE_TRACTS_DATASET.file)): OverlayPayload | null {
  return load("lease-tracts", file, (raw, version) => {
    const ds = parseLeaseTracts(raw, version);
    return { body: JSON.stringify(leaseTractsGeoJSON(ds)), count: ds.tracts.length };
  });
}

/** Tests only. */
export function resetPlatOverlaysCache(): void { cache.clear(); }
