import { describe, it, expect } from "vitest";
import {
  countyKey, countyNoun, countyScopePredicate, countySearchTerm, groupCountyKeys, parseCountyKey, parsePlssQuery, texasCountyNames,
} from "./gisRegion.js";

// Sabine and Red River are both a Texas county and a Louisiana parish, so the
// map's county keys are state-qualified for every state but Texas (whose bare
// names keep existing saved filters and URLs working).

describe("county keys", () => {
  it("reads bare names as Texas and ST|Name as that state", () => {
    expect(parseCountyKey("Sabine")).toEqual({ state: "TX", name: "Sabine" });
    expect(parseCountyKey("LA|Sabine")).toEqual({ state: "LA", name: "Sabine" });
    expect(parseCountyKey("tx | Red River")).toEqual({ state: "TX", name: "Red River" });
  });
  it("reads parish/county spellings", () => {
    expect(parseCountyKey("Caddo Parish")).toEqual({ state: "LA", name: "Caddo" });
    expect(parseCountyKey("Sabine Parish, LA")).toEqual({ state: "LA", name: "Sabine" });
    expect(parseCountyKey("Sabine County")).toEqual({ state: "TX", name: "Sabine" });
  });
  it("writes the canonical key (bare for Texas)", () => {
    expect(countyKey("Leon", "TX")).toBe("Leon");
    expect(countyKey("Leon", null)).toBe("Leon");
    expect(countyKey("Sabine", "la")).toBe("LA|Sabine");
    for (const k of ["Sabine", "LA|Sabine", "LA|Red River"]) {
      const { state, name } = parseCountyKey(k);
      expect(countyKey(name, state)).toBe(k);
    }
  });
  it("groups keys by state, de-duplicated", () => {
    expect([...groupCountyKeys(["Sabine", "LA|Sabine", "Leon", "Sabine", " ", "LA|Caddo"])]).toEqual([
      ["TX", ["Sabine", "Leon"]], ["LA", ["Sabine", "Caddo"]],
    ]);
    expect(texasCountyNames(["LA|Sabine", "Sabine"])).toEqual(["Sabine"]);
    expect(texasCountyNames(["LA|Caddo"])).toEqual([]);
  });
  it("builds a parameterized, state-scoped predicate", () => {
    const params: unknown[] = ["x"];
    const sql = countyScopePredicate(["Sabine", "LA|Sabine"], params);
    expect(sql).toBe("((state = ANY($2::text[]) AND county = ANY($3::text[])) OR (state = ANY($4::text[]) AND county = ANY($5::text[])))");
    expect(params).toEqual(["x", ["TX"], ["Sabine"], ["LA"], ["Sabine"]]);
    // Values never reach the SQL text.
    expect(countyScopePredicate(["LA|O'Brien"], [])).not.toContain("O'Brien");
    expect(countyScopePredicate([], [])).toBe("FALSE");
  });
  it("names the division per state", () => {
    expect(countyNoun("LA")).toBe("Parish");
    expect(countyNoun("TX")).toBe("County");
    expect(countyNoun(null)).toBe("County");
  });
});

describe("countySearchTerm", () => {
  it("strips the division noun / state and keeps what they imply", () => {
    expect(countySearchTerm("Caddo")).toEqual({ name: "Caddo", state: null });
    expect(countySearchTerm("Caddo Parish")).toEqual({ name: "Caddo", state: "LA" });
    expect(countySearchTerm("sabine county, tx")).toEqual({ name: "sabine", state: "TX" });
    expect(countySearchTerm("Sabine, Louisiana")).toEqual({ name: "Sabine", state: "LA" });
    expect(countySearchTerm("Red River LA")).toEqual({ name: "Red River", state: "LA" });
  });
  it("does not mistake name endings for a state", () => {
    expect(countySearchTerm("Dallas")).toEqual({ name: "Dallas", state: null });
    expect(countySearchTerm("La Salle")).toEqual({ name: "La Salle", state: null });
    expect(countySearchTerm("Atascosa")).toEqual({ name: "Atascosa", state: null });
  });
});

describe("parsePlssQuery", () => {
  it("reads section + township/range in the usual spellings", () => {
    for (const q of ["Sec 12 T17N R13W", "Section 12, T17N, R13W", "S12 T17N R13W", "sec 12 t17n r13w", "12-17N-13W", "S12-T17N-R13W", "Sec 12 T017N R013W"]) {
      expect(parsePlssQuery(q), q).toEqual({ section: 12, township: "T17N R13W" });
    }
  });
  it("reads a township alone or a section alone", () => {
    expect(parsePlssQuery("T17N R13W")).toEqual({ section: null, township: "T17N R13W" });
    expect(parsePlssQuery("Sec 1")).toEqual({ section: 1, township: null });
  });
  it("keeps fractional townships", () => {
    expect(parsePlssQuery("T5½N R5W")).toEqual({ section: null, township: "T5½N R5W" });
    expect(parsePlssQuery("T5 1/2N R5W")).toEqual({ section: null, township: "T5½N R5W" });
  });
  it("is null for anything that isn't a PLSS reference", () => {
    for (const q of ["Caddo", "Smith Survey 12", "A-12", "42-289-31234", "T17N", "Sabine", "Shelby 12", "12"]) {
      expect(parsePlssQuery(q), q).toBeNull();
    }
  });
});
