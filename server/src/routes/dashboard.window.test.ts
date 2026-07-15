import { describe, it, expect } from "vitest";
import { dashboardWindow, windowBuckets } from "./dashboard.js";

const NOW = new Date("2026-07-15T18:00:00Z");

describe("dashboardWindow CUSTOM", () => {
  it("builds an inclusive custom range (end-exclusive internally)", () => {
    const w = dashboardWindow("CUSTOM", NOW, "2025-03-01", "2025-06-30");
    expect(w.label).toBe("Custom");
    expect(w.start.toISOString()).toBe("2025-03-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2025-07-01T00:00:00.000Z"); // June 30 fully included
  });

  it("falls back to YTD on a malformed or inverted range", () => {
    expect(dashboardWindow("CUSTOM", NOW, "garbage", "2025-06-30").label).toBe("YTD");
    expect(dashboardWindow("CUSTOM", NOW, "2025-06-30", "2025-03-01").label).toBe("YTD");
    expect(dashboardWindow("CUSTOM", NOW, undefined, undefined).label).toBe("YTD");
    // The research.ts lesson: absurd-but-parseable years must not pass.
    expect(dashboardWindow("CUSTOM", NOW, "0202-07-09", "2025-06-30").label).toBe("YTD");
  });
});

describe("windowBuckets", () => {
  it("spans YTD as the twelve current-year months with the current one flagged", () => {
    const b = windowBuckets(dashboardWindow("YTD", NOW), NOW);
    expect(b).toHaveLength(12);
    expect(b[0].label).toBe("Jan");
    expect(b.findIndex((x) => x.isCurrent)).toBe(6); // July
  });

  it("spans a quarter as three months and a single month as one", () => {
    expect(windowBuckets(dashboardWindow("THIS_QUARTER", NOW), NOW).map((b) => b.label)).toEqual(["Jul", "Aug", "Sep"]);
    expect(windowBuckets(dashboardWindow("LAST_MONTH", NOW), NOW).map((b) => b.label)).toEqual(["Jun"]);
  });

  it("year-qualifies labels outside the current calendar year", () => {
    const b = windowBuckets(dashboardWindow("CUSTOM", NOW, "2025-11-01", "2026-02-28"), NOW);
    expect(b.map((x) => x.label)).toEqual(["Nov '25", "Dec '25", "Jan", "Feb"]);
    expect(b.every((x) => !x.isCurrent)).toBe(true);
  });

  it("switches to yearly buckets past 24 months", () => {
    const b = windowBuckets(dashboardWindow("CUSTOM", NOW, "2020-01-01", "2026-12-31"), NOW);
    expect(b.map((x) => x.label)).toEqual(["2020", "2021", "2022", "2023", "2024", "2025", "2026"]);
    expect(b.filter((x) => x.isCurrent).map((x) => x.label)).toEqual(["2026"]);
  });
});
