import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { LEASE_TRACTS_DATASET, W1_LATERALS_DATASET, leaseTractsGeoJSON, parseLeaseTracts, parseW1Laterals, pointRole, w1LateralsGeoJSON } from "./platOverlays.js";
import { leaseTractsPayload, resetPlatOverlaysCache, w1LateralsPayload } from "../services/platOverlays.js";

const ring: [number, number][] = [[-96.24, 31.23], [-96.22, 31.23], [-96.22, 31.21], [-96.24, 31.21], [-96.24, 31.23]];
const lats = (wells: unknown[]) => JSON.stringify({ key: W1_LATERALS_DATASET.key, builtAt: "2026-10-23T00:00:00Z", source: { name: "W-1 plats", asOf: "2026-10-21" }, wells });
const well = () => ({ api: "28932214", well: "Kiker BK 1H", operator: "Comstock", county: "Leon",
  points: [{ kind: "Surface location", lonLat: [-96.2, 31.2] }, { kind: "Penetration point / first take point", lonLat: [-96.21, 31.21] }, { kind: "Bottom hole / bottom perf", lonLat: [-96.23, 31.23] }],
  lines: [{ kind: "Surface location to Penetration point", path: [[-96.2, 31.2], [-96.21, 31.21]] }, { kind: "Penetration point to Bottom hole", path: [[-96.21, 31.21], [-96.23, 31.23]] }] });
const tracts = (t: unknown[]) => JSON.stringify({ key: LEASE_TRACTS_DATASET.key, builtAt: "2026-10-23T00:00:00Z", source: { name: "well plats", asOf: "2026-10-21" }, tracts: t });
const tract = (o: Record<string, unknown> = {}) => ({ id: "TX-LEASE-medford-burrell-610.13", lease: "Medford Burrell lease", operator: "Comstock", county: "Leon", calledAcres: 610.13, mappedAcres: 619.67, well: "DeOrnellas PB A 1H (API 42-289-32189)", plat: "JDS Surveying revised well plat 1/03/2024", rings: [ring], ...o });

describe("W-1 laterals bundle", () => {
  it("turns each well into its plat points and lateral lines with flat properties", () => {
    const fc = w1LateralsGeoJSON(parseW1Laterals(lats([well()]), "v1"));
    expect(fc.features).toHaveLength(5);
    const pts = fc.features.filter((f) => f.geometry.type === "Point");
    expect(pts.map((f) => f.properties?.role)).toEqual(["surface", "take", "bottom"]);
    expect(pts[0].properties).toMatchObject({ api: "28932214", apiLabel: "42-289-32214", well: "Kiker BK 1H", feature: "point" });
    expect(fc.features.find((f) => f.geometry.type === "LineString")?.properties).toMatchObject({ feature: "line", kind: "Surface location to Penetration point" });
  });
  it("classifies point kinds for styling", () => {
    expect(pointRole("Surface location")).toBe("surface");
    expect(pointRole("Bottom hole / bottom perf")).toBe("bottom");
    expect(pointRole("Top perf point")).toBe("take");
  });
  it("rejects a malformed bundle instead of half-serving it", () => {
    expect(() => parseW1Laterals(JSON.stringify({ key: "other", wells: [] }), "v")).toThrow(/unexpected key/);
    expect(() => parseW1Laterals(lats([well(), well()]), "v")).toThrow(/duplicate/);
    expect(() => parseW1Laterals(lats([{ ...well(), lines: [{ kind: "x", path: [[-96.2, 31.2]] }] }]), "v")).toThrow(/bad lines/);
    expect(() => parseW1Laterals(lats([{ ...well(), api: "42-289" }]), "v")).toThrow(/api/);
  });
});

describe("lease tracts bundle", () => {
  it("turns each tract into a Polygon with a not-pooled label", () => {
    const fc = leaseTractsGeoJSON(parseLeaseTracts(tracts([tract()]), "v1"));
    expect(fc.features[0].geometry).toEqual({ type: "Polygon", coordinates: [ring] });
    expect(fc.features[0].properties).toMatchObject({ lease: "Medford Burrell lease", calledAcres: 610.13, label: "Medford Burrell lease\n610.13 ac (not pooled)" });
  });
  it("rejects bad geometry, missing acreage and duplicates", () => {
    expect(() => parseLeaseTracts(tracts([tract({ rings: [[[-96.2, 31.2], [-96.1, 31.2]]] })]), "v")).toThrow(/bad geometry/);
    expect(() => parseLeaseTracts(tracts([tract({ calledAcres: 0 })]), "v")).toThrow(/acreage/);
    expect(() => parseLeaseTracts(tracts([tract(), tract()]), "v")).toThrow(/duplicate/);
  });
});

describe("overlay payloads", () => {
  it("serve one cached payload per bundle with a content ETag, or nothing when a bundle is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plat-overlays-"));
    const lf = path.join(dir, "lats.json.gz"); fs.writeFileSync(lf, zlib.gzipSync(lats([well()])));
    resetPlatOverlaysCache();
    const a = w1LateralsPayload(lf)!; const b = w1LateralsPayload(lf)!;
    expect(a).toBe(b);
    expect(a.count).toBe(1);
    expect(a.etag).toMatch(/^"w1-laterals-[0-9a-f]{16}"$/);
    expect(JSON.parse(a.body).features).toHaveLength(5);
    expect(leaseTractsPayload(path.join(dir, "missing.json.gz"))).toBeNull();
    resetPlatOverlaysCache();
  });
});
