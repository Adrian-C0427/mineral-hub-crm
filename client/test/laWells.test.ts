import { describe, it, expect } from "vitest";
import { countyStateShort, isLaWellFid, LA_FID_BASE, LA_FID_SPAN, sectionTownship, unitProductionTitle, ymLabel } from "../src/lib/laWells";

// Mirrors server/src/domain/sonrisWells.ts — the fid block decides whether a
// map well opens through /wells/import-sonris or /wells/import-rrc.
describe("Louisiana well ids", () => {
  it("recognizes the Louisiana block only", () => {
    expect(isLaWellFid(2_000_253_790)).toBe(true);
    expect(isLaWellFid("2000253790")).toBe(true);
    expect(isLaWellFid(1_482_390)).toBe(false);
    expect(isLaWellFid(LA_FID_BASE + LA_FID_SPAN)).toBe(false);
    expect(isLaWellFid(null)).toBe(false);
    expect(isLaWellFid("abc")).toBe(false);
  });
});

describe("unit production labels", () => {
  it("always names the unit, never the well", () => {
    expect(unitProductionTitle({ luw: "618433", luwName: "HA RA SU79;", wellsReported: 4 })).toBe("Unit production — LUW 618433 (HA RA SU79;), reported for 4 wells");
    expect(unitProductionTitle({ luw: "618433", luwName: null, wellsReported: 1 })).toBe("Unit production — LUW 618433, reported for 1 well");
    expect(unitProductionTitle({ luw: "616641", luwName: "  ", wellsReported: null })).toBe("Unit production — LUW 616641");
  });
  it("formats months, sections and county lines", () => {
    expect(ymLabel(202609)).toBe("2026-09");
    expect(ymLabel(null)).toBe("—");
    expect(sectionTownship("Sec 4", "T14N R9W")).toBe("Sec 4 · T14N R9W");
    expect(sectionTownship(null, null)).toBeNull();
    expect(countyStateShort("Red River", "LA")).toBe("Red River Parish, LA");
    expect(countyStateShort("Leon", "TX")).toBe("Leon Co, TX");
  });
});
