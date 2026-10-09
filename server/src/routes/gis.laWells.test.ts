import { describe, it, expect } from "vitest";
import { buildTileSql, laSuggestLabel, mergeRefEntries, planExtentQuery } from "./gis.js";
import { laResearchWellData } from "./wells.js";
import { identifierDigits, LA_WELL_SQL, shapeLaWellDetail, type LaUnitSummary, type LaWellRecord } from "../services/sonrisQueries.js";

// Louisiana (SONRIS) wells ride the same map surfaces as Texas RRC wells:
// tiles, search, filter options, extent, the well panel and Well Analysis.
// Texas behavior must be unchanged whenever the sonris schema is absent.

describe("tile SQL", () => {
  it("is exactly the Texas query when sonris is unavailable (plus the state tag)", () => {
    const sql = buildTileSql(false);
    expect(sql).not.toContain("sonris");
    expect(sql).toContain("FROM rrc.wells wl");
    expect(sql).toContain("'TX'::text AS state");
  });
  it("unions Louisiana wells/bores into the SAME wells/wellbores layers with matching columns", () => {
    const sql = buildTileSql(true);
    expect(sql).toContain("FROM sonris.wells lw, wanted w WHERE lw.geom && w.box");
    expect(sql).toContain("FROM sonris.wellbores lb");
    expect(sql).toContain("LEFT JOIN sonris.wells lsw ON lsw.fid = lb.surface_fid");
    expect(sql.match(/UNION ALL/g)?.length).toBe(2);
    // Only one 'wells' and one 'wellbores' layer exist.
    expect(sql.match(/ST_AsMVT\(well_mvt, 'wells'/g)?.length).toBe(1);
    expect(sql.match(/ST_AsMVT\(bore_mvt, 'wellbores'/g)?.length).toBe(1);
    // Same 12 columns (geom … state) in both halves of the wells union.
    const wellMvt = sql.slice(sql.indexOf("well_mvt AS ("), sql.indexOf("bore_mvt AS ("));
    const [tx, la] = wellMvt.split("UNION ALL");
    const cols = (part: string) => part.slice(part.indexOf("SELECT"), part.indexOf("FROM")).split(/,(?![^(]*\))/).length;
    expect(cols(la)).toBe(cols(tx));
    expect(la).toContain("'LA'::text AS state");
    expect(la).toContain("NULL::text AS api8");
  });
});

describe("extent with Louisiana wells", () => {
  it("keeps the Texas-only plan when sonris is off", () => {
    const plan = planExtentQuery({ wellTypes: "Gas" })!;
    expect(plan.sql).toBe("SELECT ST_Extent(geom)::text AS ext FROM rrc.wells WHERE type = ANY($1::text[])");
  });
  it("unions sonris.wells under the same filters, parishes by name", () => {
    const plan = planExtentQuery({ counties: ["Leon", "LA|Red River"], operators: "COMSTOCK", wellStatuses: "Producing" }, { sonris: true })!;
    expect(plan.sql).toContain("SELECT geom FROM rrc.wells WHERE county = ANY($1::text[]) AND status = ANY($2::text[]) AND operator = ANY($3::text[])");
    expect(plan.sql).toContain("SELECT geom FROM sonris.wells WHERE parish = ANY($4::text[]) AND status = ANY($5::text[]) AND operator = ANY($6::text[])");
    expect(plan.params).toEqual([["Leon"], ["Producing"], ["COMSTOCK"], ["Red River"], ["Producing"], ["COMSTOCK"]]);
  });
  it("matches townships as surveys and 'Sec N' as abstracts on the Louisiana side", () => {
    const plan = planExtentQuery({ surveys: "T14N R9W", abstracts: "Sec 4", wellTypes: "Gas" }, { sonris: true })!;
    expect(plan.sql).toContain("township = ANY($4::text[])");
    expect(plan.sql).toContain("('Sec ' || section) = ANY($5::text[])");
  });
  it("leaves the geographic (non-well) plans untouched", () => {
    expect(planExtentQuery({ counties: "LA|Red River" }, { sonris: true })!.sql).toContain("FROM gis.counties");
  });
});

describe("reference index merge", () => {
  it("merges an operator active in both states into one entry (counts add, extents union)", () => {
    const out = mergeRefEntries(
      [{ name: "A", n: 2, bbox: [-96, 31, -95.9, 31.1] }, { name: "B", n: 1, bbox: null }],
      [{ name: "A", n: 5, bbox: [-93.4, 32, -93.3, 32.2] }, { name: "C", n: 3, bbox: [-93.5, 32, -93.4, 32.1] }, { name: "B", n: 1, bbox: [-93, 32, -93, 32] }],
    );
    expect(out).toEqual([
      { name: "A", n: 7, bbox: [-96, 31, -93.3, 32.2] },
      { name: "B", n: 2, bbox: [-93, 32, -93, 32] },
      { name: "C", n: 3, bbox: [-93.5, 32, -93.4, 32.1] },
    ]);
  });
});

describe("Louisiana search", () => {
  it("reads identifier terms as digits (serial, LUW, dashed API) and nothing else", () => {
    expect(identifierDigits("253790")).toBe("253790");
    expect(identifierDigits("17-081-21794")).toBe("1708121794");
    expect(identifierDigits(" 618433 ")).toBe("618433");
    expect(identifierDigits("SUS FORESTS 4-9")).toBe("");
    expect(identifierDigits("T14N R9W")).toBe("");
  });
  it("matches name/operator/field by escaped pattern and identifiers exactly", () => {
    expect(LA_WELL_SQL.suggest).toContain("name ILIKE $1 ESCAPE");
    expect(LA_WELL_SQL.suggest).toContain("operator ILIKE $1 ESCAPE");
    expect(LA_WELL_SQL.suggest).toContain("field ILIKE $1 ESCAPE");
    expect(LA_WELL_SQL.suggest).toContain("serial::text = $3 OR luw = $3 OR api LIKE $3 || '%'");
  });
  it("labels a result with serial, API, unit, operator and parish", () => {
    expect(laSuggestLabel({ name: "HA RA SUV;SUS FORESTS 4-9 HC", wellNo: "003-ALT", serial: 253790, api: "17081217940000", luw: "618433", operator: "COMSTOCK", parish: "Red River" }))
      .toEqual({ label: "HA RA SUV;SUS FORESTS 4-9 HC #003-ALT", sub: "Serial 253790 · API 17081217940000 · LUW 618433 · COMSTOCK · Red River Parish, LA" });
    expect(laSuggestLabel({ name: "J T BIERDEN JR", wellNo: null, serial: 990503, api: null, luw: null, operator: null, parish: "Red River" }).sub)
      .toBe("Serial 990503 · Red River Parish, LA");
  });
});

const record: LaWellRecord = {
  fid: 2_000_253_790, serial: 253790, api: "17081217940000", name: "HA RA SUV;SUS FORESTS 4-9 HC", wellNo: "003-ALT",
  operator: "COMSTOCK OIL & GAS--LA, LLC", operatorId: "C332", field: "WOODARDVILLE", fieldId: "9803",
  statusCode: "10", statusText: "Active - Producing Gas", status: "Producing", type: "Gas", symbol: "Gas",
  product: "20", classType: null, spudDate: "2023-01-25", permitDate: "2022-10-10", completionDate: "2023-08-12", statusDate: "2023-08-12",
  md: 22820, tvd: 12698, luw: "618433", section: 4, township: "T14N R9W", parish: "Red River",
  locationQuality: "flag", locationNote: "more than 800 m from its recorded section", lon: -93.29, lat: 32.23,
};

describe("well panel payload", () => {
  it("carries the generic panel keys plus the Louisiana record and its unit", () => {
    const unit = { luw: "618433", mappedWells: 4, window: { from: 202110, to: 202609 }, series: [[202305, 0, 100]], totals: { oil: 0, gas: 100, condensate: 0 }, months: 1, firstMonth: 202305, lastMonth: 202305, wellsReported: 4, luwName: "HA RA SU79;", luwType: "UNIT", operator: "COMSTOCK", flaggedMonths: 0 } as LaUnitSummary;
    const d = shapeLaWellDetail(record, [{ fid: 2_002_291_219, type: "Horizontal", md: 22820, tvd: 12698, lengthFt: 10124.4 }], unit);
    expect(d).toMatchObject({
      state: "LA", fid: 2_000_253_790, api8: null, leaseName: record.name, county: "Red River", location: "Red River Parish, LA",
      abstract: "Sec 4", survey: "T14N R9W", status: "Producing", statusText: "Active - Producing Gas", productLabel: "Gas",
      locationQuality: "flag", unit: { luw: "618433", wellsReported: 4 },
    });
    expect(d.bores).toEqual([{ fid: 2_002_291_219, type: "Horizontal", md: 22820, tvd: 12698, lengthFt: 10124 }]);
    expect(shapeLaWellDetail({ ...record, luw: null, section: 0 }, [], null)).toMatchObject({ unit: null, abstract: null, luw: null });
  });
});

describe("Well Analysis record", () => {
  it("imports a Louisiana well as source sonris, labeled as unit production", () => {
    const d = laResearchWellData(record, "Horizontal");
    expect(d).toMatchObject({
      name: "HA RA SUV;SUS FORESTS 4-9 HC #003-ALT", state: "LA", county: "Red River", status: "PRODUCING", trajectory: "HORIZONTAL",
      wellType: "Gas", abstractId: "Sec 4", survey: "T14N R9W", trs: "Sec 4 T14N R9W", source: "sonris", sourceRef: "253790",
      leaseName: "Unit production · LUW 618433",
    });
    expect(laResearchWellData({ ...record, luw: null, status: "Canceled/Abandoned" }, null)).toMatchObject({ leaseName: "No production unit on record", status: "UNKNOWN", trajectory: "UNKNOWN" });
    expect(laResearchWellData({ ...record, status: "Dry Hole" }, null).status).toBe("PLUGGED");
  });
});
