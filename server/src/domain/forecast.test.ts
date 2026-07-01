import { describe, it, expect } from "vitest";
import { linearFit, linearForecast, addMonths } from "./forecast.js";

describe("linearFit", () => {
  it("fits a perfect line with r2=1", () => {
    const f = linearFit([2, 4, 6, 8]);
    expect(f.slope).toBeCloseTo(2);
    expect(f.intercept).toBeCloseTo(2);
    expect(f.r2).toBeCloseTo(1);
  });
  it("handles a single point", () => {
    expect(linearFit([5])).toEqual({ slope: 0, intercept: 5, r2: 0 });
  });
});

describe("linearForecast", () => {
  it("projects the next periods of a linear trend", () => {
    expect(linearForecast([2, 4, 6, 8], 2)).toEqual([10, 12]);
  });
  it("floors negative projections at 0", () => {
    const out = linearForecast([10, 6, 2], 2); // slope -4 → would go negative
    expect(out.every((v) => v >= 0)).toBe(true);
    expect(out[1]).toBe(0);
  });
});

describe("addMonths", () => {
  it("advances across year boundaries", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-01", 1)).toBe("2026-02");
  });
});
