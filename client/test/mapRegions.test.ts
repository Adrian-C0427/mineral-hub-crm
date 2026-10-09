/**
 * Louisiana on the map (client side): parish county keys that never collide
 * with the same-named Texas counties, and parish/section wording in labels
 * (client/src/lib/counties.ts, client/src/lib/abstracts.ts — the latter mirrors
 * server/src/domain/abstractLabel.ts).
 *
 * Kept outside src/ so the client build's typecheck never needs vitest.
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import {
  COUNTIES, MAP_COUNTY_LABELS, PARISHES, mapCountyKey, mapCountyKeyLabel, mapCountyOptions, parseMapCountyKey,
} from "../src/lib/counties";
import { abstractShortLabel, countyStateLabel, formatAbstract, rankAbstracts, surveyLabel } from "../src/lib/abstracts";

describe("map county keys", () => {
  it("keeps Texas keys bare and qualifies Louisiana parishes", () => {
    expect(mapCountyKey("Sabine")).toBe("Sabine");
    expect(mapCountyKey("Sabine", "LA")).toBe("LA|Sabine");
    expect(parseMapCountyKey("LA|Red River")).toEqual({ state: "LA", name: "Red River" });
    expect(parseMapCountyKey("Red River")).toEqual({ state: "TX", name: "Red River" });
  });
  it("offers both Sabines as distinct options, labelled apart", () => {
    const all = mapCountyOptions();
    expect(all.filter((k) => parseMapCountyKey(k).name === "Sabine")).toEqual(["Sabine", "LA|Sabine"]);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(COUNTIES.length + PARISHES.length);
    expect(MAP_COUNTY_LABELS["LA|Sabine"]).toBe("Sabine Parish, LA");
    expect(MAP_COUNTY_LABELS["Sabine"]).toBeUndefined();
    expect(mapCountyKeyLabel("Leon")).toBe("Leon");
  });
  it("follows the State filter", () => {
    expect(mapCountyOptions(["LA"])).toEqual(PARISHES.map((p) => `LA|${p.name}`));
    expect(mapCountyOptions(["TX"])).not.toContain("LA|Caddo");
    expect(mapCountyOptions(["TX"])).toContain("Sabine");
    expect(mapCountyOptions(["OK"])).toEqual([]);
  });
});

describe("parish and section labels", () => {
  it("reads a Louisiana section as section · township/range in its parish", () => {
    expect(formatAbstract({ abstract: "Sec 32", survey: "T23N R16W", county: "Caddo", state: "LA" })).toBe("Sec 32 · T23N R16W · Caddo Parish, Louisiana");
    expect(abstractShortLabel({ abstract: "Sec 7", survey: "T17N R13W" })).toBe("Sec 7 · T17N R13W");
    expect(countyStateLabel("Sabine", "LA")).toBe("Sabine Parish, Louisiana");
    expect(surveyLabel("T17N R13W")).toBe("T17N R13W");
  });
  it("leaves Texas wording unchanged", () => {
    expect(countyStateLabel("Sabine", "TX")).toBe("Sabine County, Texas");
    expect(formatAbstract({ abstract: "A-15", survey: "SMITH, J", county: "Leon", state: "TX" })).toBe("Abstract 15 · J. Smith Survey · Leon County, Texas");
  });
  it("ranks sections numerically in pickers", () => {
    expect(rankAbstracts(["Sec 12", "Sec 2", "Sec 1"], "", (a) => ({ abstract: a, text: a }))).toEqual(["Sec 1", "Sec 2", "Sec 12"]);
  });
});
