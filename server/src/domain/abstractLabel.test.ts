import { describe, it, expect } from "vitest";
import { abstractNumber, formatAbstract, rankAbstracts, surveyLabel } from "./abstractLabel.js";

describe("formatAbstract", () => {
  it("identifies an abstract by number, survey, county and state", () => {
    expect(formatAbstract({ abstract: "A-15", survey: "SMITH, J", county: "Leon", state: "TX" }))
      .toBe("Abstract 15 — J Smith Survey — Leon County, Texas");
  });
  it("omits unknown parts but never shows a bare number", () => {
    expect(formatAbstract({ abstract: "15", county: "Freestone", state: "TX" })).toBe("Abstract 15 — Freestone County, Texas");
    expect(formatAbstract({ abstract: "15" })).toBe("Abstract 15");
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
    expect(surveyLabel("WOODS, R")).toBe("R Woods Survey");
    expect(surveyLabel("S SANCHEZ SUR")).toBe("S Sanchez Survey");
    expect(surveyLabel("SANCHEZ, S LEAGUE")).toBe("S Sanchez League");
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
