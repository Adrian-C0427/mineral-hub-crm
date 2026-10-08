import { describe, it, expect } from "vitest";
import { allTimeSpan, isAllPeriod } from "./period.js";

const NOW = new Date("2026-10-07T15:30:00Z");
const day = (d: Date) => d.toISOString().slice(0, 10);

describe("isAllPeriod", () => {
  it("matches only the explicit ALL flag", () => {
    expect(isAllPeriod("ALL")).toBe(true);
    expect(isAllPeriod("all")).toBe(false);
    expect(isAllPeriod(undefined)).toBe(false);
    expect(isAllPeriod(["ALL"])).toBe(false);
  });
});

describe("allTimeSpan", () => {
  it("spans the earliest record through today", () => {
    const s = allTimeSpan([new Date("2019-03-14T12:00:00Z"), null, new Date("2024-01-01")], NOW);
    expect(day(s.from)).toBe("2019-03-14");
    expect(day(s.to)).toBe("2026-10-07");
  });

  it("extends past today for future-dated records (projected closings)", () => {
    const s = allTimeSpan([new Date("2027-02-01")], NOW);
    expect(day(s.from)).toBe("2026-10-07");
    expect(day(s.to)).toBe("2027-02-01");
  });

  it("collapses to today with no (valid) dates", () => {
    const s = allTimeSpan([undefined, new Date("garbage")], NOW);
    expect(day(s.from)).toBe("2026-10-07");
    expect(day(s.to)).toBe("2026-10-07");
  });
});
