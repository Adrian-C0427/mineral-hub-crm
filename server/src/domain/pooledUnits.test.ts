import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { POOLED_UNITS_DATASET, parsePooledUnits, pooledUnitsGeoJSON, type PooledUnit } from "./pooledUnits.js";
import { pooledUnitsPayload, resetPooledUnitsCache } from "../services/pooledUnits.js";

const ring: [number, number][] = [[-96.24, 31.23], [-96.22, 31.23], [-96.22, 31.21], [-96.24, 31.21], [-96.24, 31.23]];
const unit = (o: Partial<PooledUnit> = {}): PooledUnit => ({
  id: "TX-UNIT-eva-lanier-gas-unit-701.4459", name: "Eva Lanier Gas Unit", operator: "Comstock", county: "Leon",
  calledAcres: 701.4459, mappedAcres: 699.76,
  wells: [{ api: "28932181", lease: "LANIER CW", wellNo: "1H", permit: "887233" }],
  plat: { permit: "887233", rrcId: "6760114", url: "https://webapps.rrc.state.tx.us/dpimages/r/6760114", file: "Lanier unit plat.pdf" },
  placement: { method: "unit-plat", controlResidualFt: 0.3, within10ftPct: 98 },
  rings: [ring], ...o,
});
const bundle = (units: PooledUnit[]) => JSON.stringify({ key: POOLED_UNITS_DATASET.key, builtAt: "2026-10-20T00:00:00Z", source: { name: "RRC permit plats", asOf: "2026-10-19" }, units });

describe("pooled units bundle", () => {
  it("parses and turns every unit into a Polygon feature with flat properties", () => {
    const ds = parsePooledUnits(bundle([unit()]), "v1");
    const fc = pooledUnitsGeoJSON(ds);
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f.geometry).toEqual({ type: "Polygon", coordinates: [ring] });
    expect(f.properties).toMatchObject({ name: "Eva Lanier Gas Unit", operator: "Comstock", calledAcres: 701.4459, label: "Eva Lanier Gas Unit\n701.45 ac" });
    expect(JSON.parse(String(f.properties?.wells))).toEqual([{ api: "28932181", lease: "LANIER CW", wellNo: "1H", permit: "887233" }]);
    expect(JSON.parse(String(f.properties?.placement))).toMatchObject({ method: "unit-plat", within10ftPct: 98 });
    expect(f.properties?.drawnVsCalledPct).toBeNull();
  });

  it("carries the drawn-vs-called note when the plat's drawing differs from its called acres", () => {
    const fc = pooledUnitsGeoJSON(parsePooledUnits(bundle([unit({ mappedAcres: 750.3, drawnVsCalledPct: 7.0 })]), "v1"));
    expect(fc.features[0].properties).toMatchObject({ mappedAcres: 750.3, drawnVsCalledPct: 7.0 });
    expect(() => parsePooledUnits(bundle([unit({ drawnVsCalledPct: 40 })]), "v")).toThrow(/drawnVsCalledPct/);
  });

  it("accepts the survey-line placement basis of older scanned plats and rejects unknown ones", () => {
    const old = unit({ placement: { method: "well-plat", basis: "survey-lines", controlResidualFt: 0, within10ftPct: null } });
    expect(JSON.parse(String(pooledUnitsGeoJSON(parsePooledUnits(bundle([old]), "v")).features[0].properties?.placement))).toMatchObject({ basis: "survey-lines" });
    const bad = unit({ placement: { method: "well-plat", basis: "guess" as never, controlResidualFt: 0, within10ftPct: null } });
    expect(() => parsePooledUnits(bundle([bad]), "v")).toThrow(/placement basis/);
  });

  it("rejects a malformed bundle instead of half-serving it", () => {
    expect(() => parsePooledUnits(JSON.stringify({ key: "other", units: [] }), "v")).toThrow(/unexpected key/);
    expect(() => parsePooledUnits(bundle([unit(), unit()]), "v")).toThrow(/duplicate/);
    expect(() => parsePooledUnits(bundle([unit({ rings: [[[-96.2, 31.2], [-96.1, 31.2]]] })]), "v")).toThrow(/bad geometry/);
    expect(() => parsePooledUnits(bundle([unit({ calledAcres: 0 })]), "v")).toThrow(/acreage/);
  });

  it("serves one cached payload with a content ETag, or nothing when no bundle ships", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "units-"));
    const file = path.join(dir, POOLED_UNITS_DATASET.file);
    resetPooledUnitsCache();
    expect(pooledUnitsPayload(file)).toBeNull();
    resetPooledUnitsCache();
    fs.writeFileSync(file, zlib.gzipSync(bundle([unit()])));
    const p = pooledUnitsPayload(file)!;
    expect(p.count).toBe(1);
    expect(p.etag).toMatch(/^"pooled-units-[0-9a-f]{16}"$/);
    expect(JSON.parse(p.body).features[0].id).toBe("TX-UNIT-eva-lanier-gas-unit-701.4459");
    resetPooledUnitsCache();
  });
});
