import { describe, it, expect } from "vitest";
import { planExtentQuery, parseExtent } from "./gis.js";

// GET /api/gis/extent powers the map's "zoom to filtered results" behavior:
// the client sends the active filters as repeated query params and fits the
// returned bbox. These tests pin the query planner's precedence rules and its
// handling of Express's string-vs-array query values.

describe("planExtentQuery precedence", () => {
  it("returns null when no filter is set", () => {
    expect(planExtentQuery({})).toBeNull();
    expect(planExtentQuery({ counties: "" })).toBeNull();
  });

  it("frames counties from gis.counties when only counties are selected (bare names = Texas)", () => {
    const plan = planExtentQuery({ counties: ["Leon", "Freestone"] })!;
    expect(plan.sql).toContain("FROM gis.counties");
    expect(plan.sql).toContain("(state = ANY($1::text[]) AND name = ANY($2::text[]))");
    expect(plan.params).toEqual([["TX"], ["Leon", "Freestone"]]);
  });

  it("keeps Sabine TX and Sabine LA apart (state-qualified county keys)", () => {
    expect(planExtentQuery({ counties: "Sabine" })!.params).toEqual([["TX"], ["Sabine"]]);
    expect(planExtentQuery({ counties: "LA|Sabine" })!.params).toEqual([["LA"], ["Sabine"]]);
    const both = planExtentQuery({ counties: ["Sabine", "LA|Sabine"] })!;
    expect(both.sql).toContain("((state = ANY($1::text[]) AND name = ANY($2::text[])) OR (state = ANY($3::text[]) AND name = ANY($4::text[])))");
    expect(both.params).toEqual([["TX"], ["Sabine"], ["LA"], ["Sabine"]]);
  });

  it("frames the selected states' coverage when only a State filter is set", () => {
    const plan = planExtentQuery({ states: "TX" })!;
    expect(plan.sql).toContain("FROM gis.counties WHERE state = ANY($1::text[])");
    expect(plan.params).toEqual([["TX"]]);
    expect(planExtentQuery({ states: ["la", "OK"] })!.params).toEqual([["LA"]]);
  });

  it("returns null for a State-only selection outside GIS coverage", () => {
    expect(planExtentQuery({ states: ["OK", "NM"] })).toBeNull();
  });

  it("frames matching abstracts when abstract/survey filters are set", () => {
    const plan = planExtentQuery({ counties: "Leon", abstracts: ["101", "202"] })!;
    expect(plan.sql).toContain("FROM gis.abstracts");
    expect(plan.sql).toContain("(state = ANY($1::text[]) AND county = ANY($2::text[]))");
    // Abstract values are compared against the display form ('?' stripped),
    // matching what /gis/options and the vector tiles serve.
    expect(plan.sql).toContain("replace(abstract, '?', '') = ANY($3::text[])");
    expect(plan.params).toEqual([["TX"], ["Leon"], ["101", "202"]]);
  });

  it("frames a parish's sections by state-qualified key", () => {
    const plan = planExtentQuery({ counties: "LA|Caddo", abstracts: "Sec 12" })!;
    expect(plan.sql).toContain("FROM gis.abstracts");
    expect(plan.params).toEqual([["LA"], ["Caddo"], ["Sec 12"]]);
  });

  it("scopes well filters to Texas counties only (rrc.wells is RRC/Texas data)", () => {
    const plan = planExtentQuery({ counties: ["Leon", "LA|Caddo"], wellTypes: "Gas" })!;
    expect(plan.sql).toContain("FROM rrc.wells");
    expect(plan.params).toEqual([["Leon"], ["Gas"]]);
    expect(planExtentQuery({ counties: "LA|Caddo", wellTypes: "Gas" })!.params).toEqual([[], ["Gas"]]);
  });

  it("frames matching wells when any well-level filter is set, keeping all scoping predicates", () => {
    const plan = planExtentQuery({ counties: "Leon", surveys: "SMITH J", wellStatuses: ["Producing", "Shut-In"], wellTypes: "Oil" })!;
    expect(plan.sql).toContain("FROM rrc.wells");
    expect(plan.sql).toContain("county = ANY($1::text[])");
    expect(plan.sql).toContain("survey = ANY($2::text[])");
    expect(plan.sql).toContain("type = ANY($3::text[])");
    expect(plan.sql).toContain("status = ANY($4::text[])");
    expect(plan.params).toEqual([["Leon"], ["SMITH J"], ["Oil"], [["Producing", "Shut-In"]].flat()]);
  });

  it("keeps operator names with commas intact (repeated params, no splitting)", () => {
    const plan = planExtentQuery({ operators: ["SMITH OIL, INC.", "JONES & CO"] })!;
    expect(plan.sql).toContain("FROM rrc.wells");
    expect(plan.params).toEqual([["SMITH OIL, INC.", "JONES & CO"]]);
  });

  it("normalizes single-string params and drops blank values", () => {
    const plan = planExtentQuery({ wellTypes: "Gas", counties: ["  ", ""] })!;
    expect(plan.sql).toContain("FROM rrc.wells");
    expect(plan.sql).not.toContain("county");
    expect(plan.params).toEqual([["Gas"]]);
  });
});

describe("parseExtent", () => {
  it("parses a PostGIS BOX() into [minx, miny, maxx, maxy]", () => {
    expect(parseExtent("BOX(-96.2 31.1,-95.7 31.6)")).toEqual([-96.2, 31.1, -95.7, 31.6]);
  });
  it("returns null for null/empty/garbage", () => {
    expect(parseExtent(null)).toBeNull();
    expect(parseExtent("")).toBeNull();
    expect(parseExtent("not a box")).toBeNull();
  });
});
