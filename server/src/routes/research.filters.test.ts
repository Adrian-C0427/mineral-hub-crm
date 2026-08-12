/**
 * Regression tests for the 2026-08-12 audit finding: unbounded research filter
 * lists.
 *
 * Every list `parseFilters` returns becomes a Prisma `IN (…)` — or, on the RRC
 * path, an `ANY($n::text[])`. Repeated query params (`?survey=a&survey=b…`) are
 * caller-controlled and were uncapped, so one request could build a predicate
 * carrying tens of thousands of bound values: planning cost on every table the
 * query touches, and eventually Postgres's 65,535-parameter ceiling, which
 * surfaces as a 500 from a read endpoint. gis.ts already slices its equivalent
 * lists at the same bound.
 */
import { describe, it, expect } from "vitest";
import { parseFilters, MAX_FILTER_VALUES } from "./research.js";

const many = (n: number, prefix = "v") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("research filter value caps", () => {
  it("caps every repeated-param filter at MAX_FILTER_VALUES", () => {
    const over = many(MAX_FILTER_VALUES + 250);
    const f = parseFilters({
      state: over, county: over, docType: over, buyer: over, seller: over,
      operator: over, survey: over, permitStatus: over, trajectory: over,
    });
    for (const [name, values] of Object.entries({
      states: f.states, counties: f.counties, docTypes: f.docTypes,
      buyers: f.buyers, sellers: f.sellers, operators: f.operators,
      surveys: f.surveys, statuses: f.statuses, trajectories: f.trajectories,
    })) {
      expect(values.length, name).toBe(MAX_FILTER_VALUES);
    }
  });

  it("caps abstractIds AFTER merging both accepted spellings", () => {
    // ?abstractId= and ?abstract= are concatenated, so capping each input alone
    // would still admit twice the ceiling.
    const f = parseFilters({
      abstractId: many(MAX_FILTER_VALUES, "a"),
      abstract: many(MAX_FILTER_VALUES, "b"),
    });
    expect(f.abstractIds.length).toBe(MAX_FILTER_VALUES);
  });

  it("leaves a realistic selection untouched", () => {
    // 254 = every county in Texas, comfortably inside the cap.
    const counties = many(254, "county");
    const f = parseFilters({ county: counties, survey: ["ABSTRACT 1", "H&TC RR CO"] });
    expect(f.counties).toEqual(counties);
    expect(f.surveys).toEqual(["ABSTRACT 1", "H&TC RR CO"]);
  });

  it("still handles a single value, an absent value, and blanks", () => {
    const f = parseFilters({ county: "Freestone", survey: "", state: undefined });
    expect(f.counties).toEqual(["Freestone"]);
    expect(f.surveys).toEqual([]);
    expect(f.states).toEqual([]);
  });
});
