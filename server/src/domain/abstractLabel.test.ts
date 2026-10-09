import { describe, it, expect } from "vitest";
import {
  abstractNumber, abstractShortLabel, abstractSortKey, countyLabel, countyStateLabel, formatAbstract, isSectionLabel,
  rankAbstracts, sectionLabel, sectionNumber, surveyLabel,
} from "./abstractLabel.js";

describe("formatAbstract", () => {
  it("identifies an abstract by number, survey, county and state", () => {
    expect(formatAbstract({ abstract: "A-15", survey: "SMITH, J", county: "Leon", state: "TX" }))
      .toBe("Abstract 15 · J. Smith Survey · Leon County, Texas");
  });
  it("omits unknown parts but never shows a bare number", () => {
    expect(formatAbstract({ abstract: "15", county: "Freestone", state: "TX" })).toBe("Abstract 15 · Freestone County, Texas");
    expect(formatAbstract({ abstract: "15" })).toBe("Abstract 15");
  });
});

describe("abstractShortLabel", () => {
  it("reads A-number · survey, without the county", () => {
    expect(abstractShortLabel({ abstract: "3", survey: "DWIGHT, W" })).toBe("A-3 · W. Dwight Survey");
    expect(abstractShortLabel({ abstract: "A-015" })).toBe("A-15");
  });
});

describe("abstractNumber", () => {
  it("normalizes the shapes abstracts arrive in", () => {
    for (const [raw, n] of [["A-15", "15"], ["a15", "15"], ["ABST 015", "15"], ["15", "15"], ["A-15B", "15B"]]) {
      expect(abstractNumber(raw)).toBe(n);
    }
  });
});

describe("surveyLabel", () => {
  it("flips Last, First names and reads as a survey", () => {
    expect(surveyLabel("WOODS, R")).toBe("R. Woods Survey");
    expect(surveyLabel("S SANCHEZ SUR")).toBe("S. Sanchez Survey");
    expect(surveyLabel("SANCHEZ, S LEAGUE")).toBe("S. Sanchez League");
    expect(surveyLabel("SA&MG RR CO")).toBe("SA&MG RR CO Survey");
  });
});

describe("rankAbstracts", () => {
  const items = ["A-150", "A-15", "A-1500", "A-115", "A-5", "A-51", "A-215"];
  const rank = (q: string) => rankAbstracts(items, q, (a) => ({ abstract: a, text: a }));
  it("puts the exact number first, then prefixes, then contains — ascending within each", () => {
    expect(rank("15")).toEqual(["A-15", "A-150", "A-1500", "A-115", "A-215"]);
  });
  it("orders numerically (not alphabetically) with no query", () => {
    expect(rank("")).toEqual(["A-5", "A-15", "A-51", "A-115", "A-150", "A-215", "A-1500"]);
  });
  it("accepts an 'abstract'/'A-' prefix in the query", () => {
    expect(rank("abstract 15")[0]).toBe("A-15");
    expect(rank("A-5")[0]).toBe("A-5");
  });
});

// Louisiana: parishes (not counties) and PLSS sections (stored where a Texas
// abstract lives: label "Sec 12", survey = township/range "T17N R13W").
describe("parish and section wording", () => {
  it("calls a Louisiana county-level division a parish", () => {
    expect(countyLabel("Caddo", "LA")).toBe("Caddo Parish");
    expect(countyLabel("Sabine", "TX")).toBe("Sabine County");
    expect(countyLabel("Sabine", null)).toBe("Sabine County");
    expect(countyStateLabel("Caddo", "LA")).toBe("Caddo Parish, Louisiana");
    expect(countyStateLabel("Leon", "TX")).toBe("Leon County, Texas");
    expect(countyStateLabel("Caddo Parish", "LA")).toBe("Caddo Parish, Louisiana");
  });
  it("recognises section labels and their numbers", () => {
    expect(isSectionLabel("Sec 12")).toBe(true);
    expect(isSectionLabel("Section 7")).toBe(true);
    expect(isSectionLabel("A-12")).toBe(false);
    expect(isSectionLabel("SECTION 12 BLK 4")).toBe(true);
    expect(sectionNumber("Sec 07")).toBe("7");
    expect(sectionNumber("A-7")).toBeNull();
    expect(abstractSortKey("Sec 12")).toBe(12);
  });
  it("labels a section with its township/range, never as an abstract or survey", () => {
    expect(sectionLabel({ abstract: "Sec 32", survey: "T23N R16W" })).toBe("Sec 32 · T23N R16W");
    expect(abstractShortLabel({ abstract: "Sec 32", survey: "T23N R16W" })).toBe("Sec 32 · T23N R16W");
    expect(formatAbstract({ abstract: "Sec 32", survey: "T23N R16W", county: "Caddo", state: "LA" }))
      .toBe("Sec 32 · T23N R16W · Caddo Parish, Louisiana");
    // The state is implied by the section label when a caller doesn't have it.
    expect(formatAbstract({ abstract: "Sec 5", survey: "T5N R12W", county: "Sabine" })).toBe("Sec 5 · T5N R12W · Sabine Parish, Louisiana");
    expect(surveyLabel("T17N R13W")).toBe("T17N R13W");
    expect(surveyLabel("t5½n r5w")).toBe("T5½N R5W");
  });
  it("leaves Texas abstracts exactly as before", () => {
    expect(formatAbstract({ abstract: "A-5", survey: "SMITH, J", county: "Sabine", state: "TX" })).toBe("Abstract 5 · J. Smith Survey · Sabine County, Texas");
    expect(abstractShortLabel({ abstract: "A-5", survey: "SMITH, J" })).toBe("A-5 · J. Smith Survey");
  });
  it("ranks sections by section number", () => {
    const secs = ["Sec 21", "Sec 1", "Sec 12", "Sec 2", "Sec 11"];
    const rank = (q: string) => rankAbstracts(secs, q, (a) => ({ abstract: a, text: `${a} T17N R13W` }));
    expect(rank("")).toEqual(["Sec 1", "Sec 2", "Sec 11", "Sec 12", "Sec 21"]);
    expect(rank("sec 1")[0]).toBe("Sec 1");
    expect(rank("12")[0]).toBe("Sec 12");
  });
});
