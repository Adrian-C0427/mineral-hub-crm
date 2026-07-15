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

  it("frames counties from gis.counties when only counties are selected", () => {
    const plan = planExtentQuery({ counties: ["Leon", "Freestone"] })!;
    expect(plan.sql).toContain("FROM gis.counties");
    expect(plan.sql).toContain("name = ANY($1::text[])");
    expect(plan.params).toEqual([["Leon", "Freestone"]]);
  });

  it("frames matching abstracts when abstract/survey filters are set", () => {
    const plan = planExtentQuery({ counties: "Leon", abstracts: ["101", "202"] })!;
    expect(plan.sql).toContain("FROM gis.abstracts");
    expect(plan.sql).toContain("county = ANY($1::text[])");
    // Abstract values are compared against the display form ('?' stripped),
    // matching what /gis/options and the vector tiles serve.
    expect(plan.sql).toContain("replace(abstract, '?', '') = ANY($2::text[])");
    expect(plan.params).toEqual([["Leon"], ["101", "202"]]);
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
