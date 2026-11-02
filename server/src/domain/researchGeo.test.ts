import { describe, it, expect } from "vitest";
import { abstractNumbers, countyCell, isCombinedLocation, joinSurveys, locationFields, parseLegalGeography, splitSurveys, surveyName, titleCounty } from "./researchGeo.js";

/**
 * Research location: Abstract, Survey Name and County are three separate
 * fields — the abstract number only, the standardized survey name, and the
 * county with its state ("Leon, TX").
 */
describe("Abstract — the number only", () => {
  it("drops prefixes and leading zeros, one entry per abstract", () => {
    expect(abstractNumbers("A-923")).toEqual(["923"]);
    expect(abstractNumbers("ABST 0923")).toEqual(["923"]);
    expect(abstractNumbers("Abstract 923")).toEqual(["923"]);
    expect(abstractNumbers("A-58, 61 / 102")).toEqual(["58", "61", "102"]);
    expect(abstractNumbers("15, 47, 15")).toEqual(["15", "47"]);
    expect(abstractNumbers("A-15B")).toEqual(["15B"]);
  });
  it("keeps nothing that isn't an abstract; Louisiana sections stay as written", () => {
    expect(abstractNumbers("N/A")).toEqual([]);
    expect(abstractNumbers("")).toEqual([]);
    expect(abstractNumbers(null)).toEqual([]);
    expect(abstractNumbers("Sec 12")).toEqual(["Sec 12"]);
  });
});

describe("Survey Name — standardized", () => {
  it("reads recorded survey spellings as one name", () => {
    expect(surveyName("WARNICK, J")).toBe("J. Warnick Survey");
    expect(surveyName("J WARNICK SUR")).toBe("J. Warnick Survey");
    expect(surveyName("J. Warnick Survey")).toBe("J. Warnick Survey");
    expect(surveyName("A-923 J. WARNICK SURVEY")).toBe("J. Warnick Survey"); // a leading abstract is not part of the name
  });
  it("a record over several surveys lists each once, '; '-separated", () => {
    expect(joinSurveys(["J. Warnick Survey", null, "T. Ragsdale Survey", "J. Warnick Survey"])).toBe("J. Warnick Survey; T. Ragsdale Survey");
    expect(joinSurveys([])).toBeNull();
    expect(splitSurveys("J. Warnick Survey; T. Ragsdale Survey")).toEqual(["J. Warnick Survey", "T. Ragsdale Survey"]);
    expect(splitSurveys(null)).toEqual([]);
  });
  it("is blank for a blank or number-only cell", () => {
    expect(surveyName("")).toBeNull();
    expect(surveyName("923")).toBeNull();
    expect(surveyName(undefined)).toBeNull();
  });
});

describe("County — county + state", () => {
  it("splits a state written after the county", () => {
    expect(countyCell("Leon County, Texas")).toEqual({ county: "Leon", state: "TX" });
    expect(countyCell("LEON COUNTY TX")).toEqual({ county: "Leon", state: "TX" });
    expect(countyCell("Leon, New Mexico")).toEqual({ county: "Leon", state: "NM" });
    expect(countyCell("LEON COUNTY STATE OF TEXAS")).toEqual({ county: "Leon", state: "TX" });
    expect(countyCell("Red River Parish, LA")).toEqual({ county: "Red River", state: "LA" });
  });
  it("takes no state that isn't written; 'Co.' is the county word, not Colorado", () => {
    expect(countyCell("LEON")).toEqual({ county: "Leon", state: null });
    expect(countyCell("De Witt")).toEqual({ county: "De Witt", state: null });
    expect(countyCell("McMullen Co.")).toEqual({ county: "McMullen", state: null });
    expect(titleCounty("McMullen Co.")).toBe("McMullen");
  });
});

describe("combined location text", () => {
  it("reads each part only where the text names it outright", () => {
    expect(parseLegalGeography("Abstract 923 · J. Warnick Survey · Leon County, Texas"))
      .toEqual({ abstracts: ["923"], survey: "J. Warnick Survey", county: "Leon", state: "TX" });
    expect(parseLegalGeography("50 AC OUT OF THE J. WARNICK SURVEY, A-923, LEON COUNTY, TX"))
      .toEqual({ abstracts: ["923"], survey: "J. Warnick Survey", county: "Leon", state: "TX" });
    expect(parseLegalGeography("WARNICK, J SURVEY, ABST 923"))
      .toEqual({ abstracts: ["923"], survey: "J. Warnick Survey", county: null, state: null });
  });
  it("doesn't guess: two surveys, an unmarked county or no markers at all give nothing", () => {
    expect(parseLegalGeography("10 AC IN THE A. SMITH SURVEY AND THE B. JONES SURVEY, A-12, A-15, Leon County Texas").survey).toBeNull();
    expect(parseLegalGeography("J WARNICK SURVEY LEON COUNTY").county).toBeNull();
    expect(parseLegalGeography("Lot 4 Block 2 Town of Centerville")).toEqual({ abstracts: [], survey: null, county: null, state: null });
  });
  it("one combined column mapped to all three fields gives each its own part; plain cells read as themselves", () => {
    const comb = "Abstract 923 · J. Warnick Survey · Leon County, Texas";
    expect(isCombinedLocation(comb)).toBe(true);
    expect(isCombinedLocation("Leon County, Texas")).toBe(false);
    expect(isCombinedLocation("A-923")).toBe(false);
    expect(locationFields({ abstract: comb, survey: comb, county: comb })).toEqual({
      abstracts: ["923"], abstractCell: "923", survey: "J. Warnick Survey", county: "Leon", state: "TX", combined: comb,
    });
    expect(locationFields({ abstract: "A-923", survey: "WARNICK, J", county: "Leon County, Texas" })).toEqual({
      abstracts: ["923"], abstractCell: "A-923", survey: "J. Warnick Survey", county: "Leon", state: "TX", combined: null,
    });
    expect(locationFields({ abstract: "", survey: "", county: "" })).toEqual({
      abstracts: [], abstractCell: null, survey: null, county: null, state: null, combined: null,
    });
  });
});
