import { describe, it, expect } from "vitest";
import { abstractNumbers, countySt, recordAbstracts, recordSurveys, surveyName } from "./researchGeo";

describe("Research location fields (client mirror of server/src/domain/researchGeo.ts)", () => {
  it("Abstract is the number only", () => {
    expect(abstractNumbers("A-923")).toEqual(["923"]);
    expect(abstractNumbers("A-58, 61 / 102")).toEqual(["58", "61", "102"]);
    expect(abstractNumbers("N/A")).toEqual([]);
    expect(recordAbstracts({ abstractId: "A-923", abstractIds: [] })).toEqual(["923"]);
    expect(recordAbstracts({ abstractId: "A-15, A-47", abstractIds: ["A-15", "A-47"] })).toEqual(["15", "47"]); // before the backfill
  });

  it("Survey Name is standardized; the record's own wins, else each abstract's by county + number", () => {
    expect(surveyName("WARNICK, J")).toBe("J. Warnick Survey");
    expect(surveyName("923")).toBe("");
    const gis: Record<string, string> = { "leon|923": "WARNICK, J", "leon|47": "SMITH, A" };
    const find = (a: string, county: string) => (gis[`${county.toLowerCase()}|${a}`] ? { survey: gis[`${county.toLowerCase()}|${a}`] } : undefined);
    expect(recordSurveys({ abstractId: "923", survey: "J HALLMARK", county: "Leon", state: "TX" }, find)).toEqual(["J. Hallmark Survey"]);
    expect(recordSurveys({ abstractId: "923, 47", survey: null, county: "Leon", state: "TX" }, find)).toEqual(["J. Warnick Survey", "A. Smith Survey"]);
    expect(recordSurveys({ abstractId: "923", survey: null, county: "Freestone", state: "TX" }, find)).toEqual([]); // never by number alone
  });

  it("County reads County, ST", () => {
    expect(countySt("Leon", "TX")).toBe("Leon, TX");
    expect(countySt("Leon", "tx")).toBe("Leon, TX");
    expect(countySt("Leon", null)).toBe("Leon");
  });
});
