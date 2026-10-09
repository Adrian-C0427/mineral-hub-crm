import { describe, it, expect } from "vitest";
import {
  bucketFromWording, classifyLaBore, classifyLaWell, distanceFt, isLaFid, LA_FID_BASE, LA_FID_SPAN, LA_STATUS_BUCKET,
  laBoreFid, laSerialOfFid, laWellFid, sectionLabelOf, shapeUnitProduction, ymShift, type UnitProductionRow,
} from "./sonrisWells.js";

// Louisiana wells share the map's `wells`/`wellbores` tile layers (promoteId
// "fid") and its Texas status vocabulary, so the id namespace and the mapping
// table are pinned here.

describe("fid namespace", () => {
  it("puts Louisiana ids in their own block, clear of every RRC id and below int4", () => {
    expect(laWellFid(253790)).toBe(2_000_253_790);
    expect(laBoreFid(2_304_466)).toBe(2_002_304_466);
    // RRC SURFACE_ID / BOTTOM_ID are ~0.3M–1.5M today; the block starts at 2e9.
    expect(isLaFid(1_482_390)).toBe(false);
    expect(isLaFid(LA_FID_BASE - 1)).toBe(false);
    expect(isLaFid(laWellFid(1))).toBe(true);
    expect(LA_FID_BASE + LA_FID_SPAN - 1).toBeLessThan(2 ** 31 - 1);
    expect(isLaFid(LA_FID_BASE + LA_FID_SPAN)).toBe(false);
    expect(isLaFid(2_000_000_000.5)).toBe(false);
    expect(laSerialOfFid(2_000_253_790)).toBe(253790);
    expect(laSerialOfFid(1_482_390)).toBeNull();
  });
});

describe("status / type mapping (Texas vocabulary)", () => {
  const TX_STATUSES = ["Producing", "Shut-In", "Plugged", "Permitted", "Dry Hole", "Active", "Canceled/Abandoned", "Unknown"];
  const TX_TYPES = ["Oil", "Gas", "Oil/Gas", "Location", "Dry Hole", "Injection/Disposal", "Unknown"];

  it("maps every Red River Parish status code", () => {
    const cases: [string, string, string | null, string, string, string][] = [
      ["10", "Active - Producing Gas", "20", "Producing", "Gas", "Gas"],
      ["10", "Active - Producing Oil", "10", "Producing", "Oil", "Oil"],
      ["33", "Shut-In Productive -Future Utility Gas", "20", "Shut-In", "Gas", "Shut-In (Gas)"],
      ["34", "Shut-In Productive -No Future Utility Oil", "10", "Shut-In", "Oil", "Shut-In (Oil)"],
      ["37", "Shut-In Waiting On Market Gas", "20", "Shut-In", "Gas", "Shut-In (Gas)"],
      ["20", "Pa-35 Temporary Inactive Well To Be Omitted From Prod.Report Gas", "20", "Shut-In", "Gas", "Shut-In (Gas)"],
      ["30", "Plugged And Abandoned Oil", "10", "Plugged", "Oil", "Plugged Oil"],
      ["30", "Plugged And Abandoned Dry Gas", "25", "Plugged", "Gas", "Plugged Gas"],
      ["30", "Plugged And Abandoned No Product Specified", "00", "Plugged", "Unknown", "Well"],
      ["29", "Dry And Plugged No Product Specified", "00", "Dry Hole", "Dry Hole", "Dry Hole"],
      ["31", "Shut-In Dry Hole -Future Utility No Product Specified", "00", "Dry Hole", "Dry Hole", "Dry Hole"],
      ["01", "Permitted", "00", "Permitted", "Location", "Permitted Location"],
      ["03", "Permit Expired", null, "Canceled/Abandoned", "Location", "Canceled/Abandoned Location"],
      ["09", "Active- Injection Commercial Swd", "00", "Active", "Injection/Disposal", "Injection/Disposal"],
      ["09", "Active- Injection Aquifer Remediation", "00", "Active", "Injection/Disposal", "Injection/Disposal"],
      ["26", "Act 404 Orphan Well-Injection And Mining No Product Specified", "00", "Shut-In", "Injection/Disposal", "Injection/Disposal"],
      ["23", "Act 404 Orphan Well-Eng Oil", "10", "Shut-In", "Oil", "Shut-In (Oil)"],
      ["28", "Unable To Locate Well-No Plugged And Abandoned Gas", "20", "Shut-In", "Gas", "Shut-In (Gas)"],
      ["22", "Reverted To Single Completion No Product Specified", "00", "Plugged", "Unknown", "Well"],
      ["24", "Rvrtd L/O-Resident Consumption Gas", "20", "Shut-In", "Gas", "Shut-In (Gas)"],
      ["80", "* Unknown * No Product Specified", "00", "Unknown", "Unknown", "Well"],
    ];
    for (const [code, text, product, status, type, symbol] of cases) {
      expect(classifyLaWell(code, text, product), `${code} ${text}`).toEqual({ status, type, symbol });
    }
  });

  it("only ever emits the Texas status/type vocabulary the paint and filters use", () => {
    for (const code of [...Object.keys(LA_STATUS_BUCKET), "02", "45", "99"]) {
      for (const product of ["00", "10", "20", "25", null]) {
        const c = classifyLaWell(code, "Something", product);
        expect(TX_STATUSES).toContain(c.status);
        expect(TX_TYPES).toContain(c.type);
      }
    }
  });

  it("falls back to the wording for codes not in the table", () => {
    expect(bucketFromWording("Plugged And Abandoned Gas")).toBe("Plugged");
    expect(bucketFromWording("Unable To Locate Well-No Plugged And Abandoned Oil")).toBe("Shut-In");
    expect(bucketFromWording("Dry And Plugged Oil")).toBe("Dry Hole");
    expect(bucketFromWording("Active- Injection Produced Salt Water")).toBe("Active");
    expect(bucketFromWording("Shut-In Future Utility")).toBe("Shut-In");
    expect(bucketFromWording("Active - Producing Gas")).toBe("Producing");
    expect(bucketFromWording("Permit Revoked")).toBe("Canceled/Abandoned");
    expect(bucketFromWording("Permit To Drill")).toBe("Permitted");
    expect(bucketFromWording("Something new")).toBe("Unknown");
    expect(classifyLaWell("45", "Plugged And Abandoned Gas", "20")).toEqual({ status: "Plugged", type: "Gas", symbol: "Plugged Gas" });
  });
});

describe("labels and bores", () => {
  it("labels sections like gis.abstracts (and treats 0 as unrecorded)", () => {
    expect(sectionLabelOf(4)).toBe("Sec 4");
    expect(sectionLabelOf(0)).toBeNull();
    expect(sectionLabelOf(null)).toBeNull();
  });
  it("classifies straight bore lines by MD − TVD, or by offset without depths", () => {
    const path: [number, number][] = [[-93.3775, 32.0905], [-93.37795, 32.1057]]; // ~5,500 ft north
    expect(classifyLaBore(17510, 12426, path)).toBe("Horizontal");
    expect(classifyLaBore(12900, 12426, path)).toBe("Directional");
    expect(classifyLaBore(17510, null, path)).toBe("Horizontal");
    expect(classifyLaBore(null, null, [[-93.3, 32.1], [-93.3, 32.1005]])).toBe("Directional");
    expect(Math.round(distanceFt([-93.3, 32.1], [-93.3, 32.2]) / 100) * 100).toBe(36500); // 0.1° of latitude ≈ 11.1 km
  });
});

describe("unit production shaping", () => {
  const row = (ym: number, gas: number, extra: Partial<UnitProductionRow> = {}): UnitProductionRow =>
    ({ ym, line: "1", oil: 0, condensate: 0, gas, wells: 2, luwName: "HA RA SU79;", luwType: "UNIT", operator: "COMSTOCK", stateFlag: null, ...extra });

  it("shifts months across years", () => {
    expect(ymShift(202609, -59)).toBe(202110);
    expect(ymShift(202601, -1)).toBe(202512);
    expect(ymShift(202512, 1)).toBe(202601);
  });

  it("sums report lines per month, keeps the window, and reports the latest month's well count", () => {
    const u = shapeUnitProduction([
      row(202108, 999),                                            // before the window
      row(202110, 100),
      row(202111, 50, { line: "2", operator: "OLD OP", wells: 0 }),  // operator change: two lines
      row(202111, 70, { operator: "NEW OP", wells: 3, oil: 12, condensate: 12 }),
      row(202112, 80, { stateFlag: "D-OGP Report is delinquent", luwName: null }),
    ], 202110, 202609);
    expect(u.series).toEqual([[202110, 0, 100], [202111, 12, 120], [202112, 0, 80]]);
    expect(u.totals).toEqual({ oil: 12, gas: 300, condensate: 12 });
    expect(u.months).toBe(3);
    expect([u.firstMonth, u.lastMonth]).toEqual([202110, 202112]);
    expect(u.wellsReported).toBe(2);
    expect(u.flaggedMonths).toBe(1);
    // Latest line carrying a name; operator from the most recent line.
    expect(u.luwName).toBe("HA RA SU79;");
    expect(u.operator).toBe("COMSTOCK");
  });

  it("reports an empty unit plainly", () => {
    const u = shapeUnitProduction([], 202110, 202609);
    expect(u).toMatchObject({ series: [], months: 0, firstMonth: null, lastMonth: null, wellsReported: null, luwName: null });
  });

  it("takes the max (not the sum) of well counts across a month's lines", () => {
    const u = shapeUnitProduction([row(202605, 47364, { wells: 3, operator: "A" }), row(202605, 0, { wells: 3, operator: "B" })], 202110, 202609);
    expect(u.wellsReported).toBe(3);
  });
});
