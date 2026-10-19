import { describe, expect, it } from "vitest";
import { assembleBores, buildAbstracts, primaryEwaRow, stableHash, type BottomRecord, type EwaRec, type LateralRecord, type SurfaceRecord, type WellContext } from "./assemble.js";
import { parseAbstractsDataset, parseProductionDataset, parseWellsDataset, ABSTRACTS_DATASET, PRODUCTION_DATASET, WELLS_DATASET } from "./dataset.js";
import { fitDatumShift, type ControlPoint } from "./datum.js";
import { CsvSplitter, EWA_FIELDS, ewaRecord, parsePermitDetail, parsePermitRootFacts, parseUicRoot } from "./records.js";
import { ringsToMultiPolygon, type Pt, type Shape } from "./shapefile.js";

/** A fixed-width line with values placed at 0-based offsets. */
function fixed(len: number, parts: [number, string][]): string {
  const a = new Array<string>(len).fill(" ");
  for (const [off, s] of parts) for (let i = 0; i < s.length; i++) a[off + i] = s[i];
  return a.join("");
}

describe("CSV + Wellbore Query records", () => {
  it("splits quoted CSV across chunk boundaries, with embedded commas, quotes and tabs", () => {
    const out: string[][] = [];
    const s = new CsvSplitter();
    s.push('"06","001","A, B"', (r) => out.push(r));
    s.push(',"say ""hi""","   1\t"\r\n"07"', (r) => out.push(r));
    s.end((r) => out.push(r));
    expect(out).toEqual([["06", "001", "A, B", 'say "hi"', "   1\t"], ["07"]]);
  });

  it("reads the named fields of a 59-field 2026 row and rejects short / non-API rows", () => {
    const f = new Array<string>(59).fill("");
    f[0] = "05"; f[1] = "289"; f[2] = "28932181"; f[9] = "   1H "; f[18] = "PRODUCING"; f[26] = "Y";
    const r = ewaRecord(f)!;
    expect(r.API_NO).toBe("28932181");
    expect(r.WELL_NO_DISPLAY).toBe("1H");
    expect(r.WELL_TYPE_NAME).toBe("PRODUCING");
    expect(r.ON_SCHEDULE).toBe("Y");
    expect(EWA_FIELDS[42]).toBe("WL_14B2_EXT_STATUS");
    expect(ewaRecord(f.slice(0, 30))).toBeNull();
    expect(ewaRecord(Object.assign([...f], { 2: "289" }))).toBeNull();
  });

  it("prefers the scheduled producing row as the well's primary record", () => {
    const base = Object.fromEntries(EWA_FIELDS.map((k) => [k, ""])) as EwaRec;
    const off = { ...base, ON_SCHEDULE: "N", COMPLETION_DATE: "20250101", OG_WELLBORE_EWA_ID: "9" };
    const ta = { ...base, ON_SCHEDULE: "Y", WELL_TYPE_NAME: "TEMP ABANDONED", COMPLETION_DATE: "20200101", OG_WELLBORE_EWA_ID: "2" };
    const prod = { ...base, ON_SCHEDULE: "Y", WELL_TYPE_NAME: "PRODUCING", COMPLETION_DATE: "19900101", OG_WELLBORE_EWA_ID: "1" };
    expect(primaryEwaRow([off, ta, prod])).toBe(prod);
    expect(primaryEwaRow([off, ta])).toBe(ta);
    expect(primaryEwaRow([])).toBeNull();
  });
});

describe("drilling permit + UIC records", () => {
  it("reads the 02 segment at manual position − 3", () => {
    const line = fixed(510, [
      [0, "02"], [2, "0918465"], [9, "99"], [11, "289"], [48, "1H    "], [54, "17500"], [65, "01"],
      [129, "20260911"], [153, "20260929"], [169, "W"], [178, "20280911"], [186, "00000000"],
      [479, " "], [481, "N"], [482, "N"], [493, "Y"], [502, "28932237"],
    ]);
    expect(parsePermitDetail(line)).toMatchObject({
      key: "091846599289", permitNo: "0918465", api8: "28932237", wellNo: "1H", totalDepth: 17500,
      typeApplication: "01", issued: "20260911", spud: "20260929", wellStatusCode: "W", expires: "20280911",
      cancelled: null, cancelledFlag: "", horizontal: true, directional: false,
    });
    expect(parsePermitDetail(line.slice(0, 400))).toBeNull();
  });

  it("reads the root's approval flag (pos 101)", () => {
    const root = fixed(212, [[0, "01"], [2, "0918465"], [9, "99"], [11, "289"], [14, "FARLEY HG"], [46, "05"], [48, "170038"], [66, "COMSTOCK"], [100, "A"]]);
    expect(parsePermitRootFacts(root)).toMatchObject({ key: "091846599289", countyCode: "289", appFlag: "A", operatorNo: "170038", leaseName: "FARLEY HG" });
  });

  it("reads a UIC root's API and injection type", () => {
    const line = fixed(622, [[0, "01"], [2, "000002722"], [32, "28900507"], [89, "Y"], [90, "20000719"], [114, "2"]]);
    expect(parseUicRoot(line)).toMatchObject({ api8: "28900507", injectionType: "2", activated: true, cancelled: "20000719" });
  });
});

describe("datum shift", () => {
  // Synthetic county: a smooth NAD27→NAD83 field, plus two bad coordinate pairs.
  const field = (lon: number, lat: number): [number, number] => [-0.00025 + 0.00001 * (lon + 96), 0.00019 - 0.00002 * (lat - 31)];
  const pts: ControlPoint[] = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
    const lon27 = -96.2 + i * 0.02, lat27 = 31.0 + j * 0.02;
    const [dx, dy] = field(lon27, lat27);
    pts.push({ lon27, lat27, lon83: lon27 + dx, lat83: lat27 + dy });
  }
  pts[5] = { ...pts[5], lat83: pts[5].lat83 + 0.0005 };   // ~180 ft off
  pts[77] = { ...pts[77], lon83: pts[77].lon83 - 0.0004 };

  it("reproduces the field to a fraction of a foot and isolates bad pairs", () => {
    const s = fitDatumShift(pts);
    expect(s.inliers).toBe(pts.length - 2);
    const [lon, lat] = s.apply(-96.1, 31.1);
    const [dx, dy] = field(-96.1, 31.1);
    expect(Math.abs(lon - (-96.1 + dx)) * 311_000).toBeLessThan(0.2);
    expect(Math.abs(lat - (31.1 + dy)) * 364_000).toBeLessThan(0.2);
    expect(s.mismatchFt(pts[5])).toBeGreaterThan(150);
    expect(s.mismatchFt(pts[6])).toBeLessThan(0.2);
  });

  it("refuses to fit too few points", () => {
    expect(() => fitDatumShift(pts.slice(0, 5))).toThrow();
  });
});

describe("abstract polygons", () => {
  const sq = (x: number, y: number, d = 0.01): Pt[] => [[x, y], [x, y + d], [x + d, y + d], [x + d, y], [x, y]]; // clockwise
  const identity = { apply: (lon: number, lat: number): [number, number] => [lon, lat], mismatchFt: () => 0, inliers: 0, total: 0, residualFt: { p50: 0, p90: 0 } };
  const leon = { code: "289", name: "Leon" };

  it("merges split pieces, keeps '?' tracts distinct, ids unnumbered polygons, leaves other counties' abstracts alone", () => {
    const recs = [
      { ABSTRACT_N: "28925", ABSTRACT_L: "A-25", LEVEL1_SUR: "RIONDO, M" },
      { ABSTRACT_N: "28925", ABSTRACT_L: "A-25", LEVEL1_SUR: "RIONDO, M" },
      { ABSTRACT_N: "2895", ABSTRACT_L: "A-5", LEVEL1_SUR: "BREWER, G" },
      { ABSTRACT_N: "289?5", ABSTRACT_L: "A-?5", LEVEL1_SUR: "STATE OF TEXAS" },
      { ABSTRACT_N: "", ABSTRACT_L: "", LEVEL1_SUR: "VACANCY" },
      { ABSTRACT_N: "40112", ABSTRACT_L: "A-12", LEVEL1_SUR: "RUSK SURVEY" },
      { ABSTRACT_N: "2897", ABSTRACT_L: "A-7", LEVEL1_SUR: "SMITH, J" },
      { ABSTRACT_N: "2897", ABSTRACT_L: "A-7", LEVEL1_SUR: "JONES, K" },
    ];
    const shapes: Shape[] = recs.map((_, i) => ({ kind: "polygon", rings: [sq(-96 + i * 0.02, 31, i === 7 ? 0.005 : 0.01)] }));
    const { rows, stats } = buildAbstracts(recs, shapes, leon, identity);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("TX-28925")).toMatchObject({ abstract: "A-25", pieces: 2 });
    expect(byId.get("TX-28925")!.geom).toHaveLength(2);
    expect(byId.get("TX-2895")!.abstract).toBe("A-5");
    expect(byId.get("TX-289?5")!.abstract).toBe("A-?5");
    expect([...byId.keys()].some((k) => k.startsWith("TX-401"))).toBe(false);
    expect(rows.find((r) => r.survey === "VACANCY")!.id).toMatch(/^TX-289-NA-[0-9a-f]{8}$/);
    // Same number, two surveys: both listed; the larger keeps the base id.
    expect(byId.get("TX-2897")!.survey).toBe("SMITH, J");
    expect(byId.get("TX-2897~2")!.survey).toBe("JONES, K");
    expect(stats).toMatchObject({ polygons: 8, mergedPieces: 1, otherCountyPolygons: 1, unnumbered: 1, splitBySurvey: 1, questionLabels: 1 });
  });

  it("nests holes in their outer ring", () => {
    const outer = sq(0, 0, 10);
    const hole: Pt[] = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]; // counter-clockwise
    const mp = ringsToMultiPolygon([outer, hole]);
    expect(mp).toHaveLength(1);
    expect(mp[0]).toHaveLength(2);
    expect(stableHash("x")).toBe(stableHash("x"));
  });
});

describe("wellbores", () => {
  const leon = { code: "289", name: "Leon" };
  const identity = { apply: (lon: number, lat: number): [number, number] => [lon + 0.0001, lat + 0.0001], mismatchFt: () => 0, inliers: 0, total: 0, residualFt: { p50: 0, p90: 0 } };
  const ctx: WellContext = { ewa: new Map(), permits: new Map(), uic: new Map(), formations: new Map(), dbfPlug: new Map(), production: new Map(), prodNewestYm: "202607", asOf: "20261018" };
  const surf = { rec: { SURFACE_ID: "100", SYMNUM: "86", API: "28932181" }, county: leon, lonLat83: [-96.238143, 31.234578] as [number, number] };

  it("builds approximate surface → bottom-hole paths; vertical holes get none; neighbor-county bottoms come from RRC's line end", () => {
    const bottoms = new Map<number, BottomRecord>([
      [200, { rec: { BOTTOM_ID: "200", SURFACE_ID: "100", API: "28932181", API10: "28932181H1", STCODE: "H1", SYMNUM: "5", LONG83: "-96.215786", LAT83: "31.214694" }, county: leon }],
      [300, { rec: { BOTTOM_ID: "300", SURFACE_ID: "300", API: "28930001", STCODE: "", SYMNUM: "7", LONG83: "-96.1", LAT83: "31.1" }, county: leon }],
    ]);
    const surfaces = new Map<number, SurfaceRecord>([[100, surf], [300, { rec: { SURFACE_ID: "300", SYMNUM: "7", API: "28930001" }, county: leon, lonLat83: [-96.1, 31.1] as [number, number] }]]);
    const laterals = new Map<number, LateralRecord>([
      [200, { rec: { BOTTOM_ID: "200", SURFACE_ID: "100", API: "28932181", STCODE: "H1" }, county: leon, line27: [[-96.2383, 31.2344], [-96.2159, 31.2145]] as Pt[], shift: identity }],
      [400, { rec: { BOTTOM_ID: "400", SURFACE_ID: "100", API: "28932181", API10: "28932181H2", STCODE: "H2" }, county: leon, line27: [[-96.2383, 31.2344], [-96.25, 31.26]] as Pt[], shift: identity }],
    ]);
    const { bores, verticalBottoms } = assembleBores(bottoms, laterals, surfaces, new Map(), ctx);
    expect(verticalBottoms).toBe(1);
    expect(bores.map((b) => b.fid)).toEqual([200, 400]);
    expect(bores[0]).toMatchObject({ profile: "Horizontal", bhSource: "rrc-bottom-hole", lineSource: "rrc-lateral", approximate: true, path: [[-96.238143, 31.234578], [-96.215786, 31.214694]] });
    expect(bores[1]).toMatchObject({ bhSource: "rrc-lateral-end", bh: [-96.2499, 31.2601], approximate: true });
  });
});

describe("bundled datasets validate", () => {
  const well = { fid: 1, county: "Leon", status: "Producing", lon: -96, lat: 31 };
  const wells = { key: WELLS_DATASET.key, counties: [{ code: "289", name: "Leon" }], wells: [well], bores: [], history: [] };
  it("accepts a good bundle and versions it by content", () => {
    const a = parseWellsDataset(JSON.stringify(wells));
    expect(a.version).toHaveLength(16);
    expect(parseWellsDataset(JSON.stringify({ ...wells, builtAt: "x" })).version).not.toBe(a.version);
  });
  it("rejects bad statuses, duplicate fids, Louisiana-range fids, out-of-scope rows", () => {
    expect(() => parseWellsDataset(JSON.stringify({ ...wells, wells: [{ ...well, status: "Active" }] }))).toThrow();
    expect(() => parseWellsDataset(JSON.stringify({ ...wells, wells: [well, well] }))).toThrow();
    expect(() => parseWellsDataset(JSON.stringify({ ...wells, wells: [{ ...well, fid: 2_000_000_001 }] }))).toThrow();
    expect(() => parseWellsDataset(JSON.stringify({ ...wells, wells: [{ ...well, county: "Anderson" }] }))).toThrow();
    expect(() => parseAbstractsDataset(JSON.stringify({ key: ABSTRACTS_DATASET.key, counties: [{ code: "289", name: "Leon" }], abstracts: [{ id: "TX-1", county: "Leon", countyFips: "161", geom: [] }] }))).toThrow();
    expect(() => parseProductionDataset(JSON.stringify({ key: PRODUCTION_DATASET.key, counties: [{ code: "289", name: "Leon" }], fromYm: 202508, toYm: 202607, rows: [["O", "05", "1", 202401, "Leon", "", "", "", 1, 0, 0, 0]] }))).toThrow();
  });
});
