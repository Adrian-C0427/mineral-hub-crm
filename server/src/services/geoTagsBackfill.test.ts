import { describe, it, expect } from "vitest";
import { geoTagCandidate, geoTagUpdate } from "./geoTagsBackfill.js";
import type { GeoContext } from "../domain/geoRegions.js";

// The backfill writes into live deals unattended, so what it may touch is pinned here.

const ctx = (over: Partial<GeoContext> = {}): GeoContext => ({
  basins: [{ id: "basin:east-texas-basin", name: "East Texas Basin", kind: "basin", parent: null, basis: "county", share: 0.999, confidence: "medium", edge: false, sources: ["epa-aapg"] }],
  subBasins: [], plays: [],
  formations: [{ name: "Cotton Valley", basis: "wells", confidence: "high", count: 3 }, { name: "Woodbine", basis: "fields", confidence: "low", count: 22 }],
  coverage: { abstractsRequested: 0, abstractsResolved: 0, abstractsPending: 0, countiesUnknown: [], basis: "county" },
  notes: [],
  ...over,
});
const rec = (over = {}) => ({ basins: [] as string[], formations: [] as string[], states: ["TX"], state: "TX", counties: ["Leon"], abstractIds: [] as string[], ...over });

describe("geoTagCandidate", () => {
  it("wants Texas (or stateless) records with a county or abstract and a blank tag list", () => {
    expect(geoTagCandidate(rec())).toBe(true);
    expect(geoTagCandidate(rec({ states: [], state: null }))).toBe(true);
    expect(geoTagCandidate(rec({ counties: [], abstractIds: ["TX-289653"] }))).toBe(true);
    expect(geoTagCandidate(rec({ basins: ["Permian Basin"] }))).toBe(true); // formations still blank
    expect(geoTagCandidate(rec({ basins: ["Permian Basin"], formations: ["Wolfcamp"] }))).toBe(false);
    expect(geoTagCandidate(rec({ states: ["LA"], state: "LA" }))).toBe(false);
    expect(geoTagCandidate(rec({ counties: [], abstractIds: [] }))).toBe(false);
  });
});

describe("geoTagUpdate", () => {
  it("fills only the blank lists, from well evidence and ≥ medium basins; county field lists never apply", () => {
    expect(geoTagUpdate({ basins: [], formations: [] }, ctx())).toEqual({ basins: ["East Texas Basin"], formations: ["Cotton Valley"] });
    expect(geoTagUpdate({ basins: ["Hand-picked"], formations: [] }, ctx())).toEqual({ formations: ["Cotton Valley"] });
    expect(geoTagUpdate({ basins: [], formations: ["Hand-picked"] }, ctx())).toEqual({ basins: ["East Texas Basin"] });
    const fieldsOnly = ctx({ formations: [{ name: "Woodbine", basis: "fields", confidence: "low", count: 22 }] });
    expect(geoTagUpdate({ basins: ["X"], formations: [] }, fieldsOnly)).toBeNull();
  });
  it("leaves a split county alone", () => {
    const split = ctx({ basins: [
      { id: "a", name: "East Texas Basin", kind: "basin", parent: null, basis: "county", share: 0.6, confidence: "low", edge: true, sources: [] },
      { id: "b", name: "Gulf Coast Basin", kind: "basin", parent: null, basis: "county", share: 0.4, confidence: "low", edge: true, sources: [] },
    ], formations: [] });
    expect(geoTagUpdate({ basins: [], formations: [] }, split)).toBeNull();
  });
});
