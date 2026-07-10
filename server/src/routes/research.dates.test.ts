import { describe, it, expect } from "vitest";
import { parseDay, parseWindow, parseCompare } from "./research.js";

// Regression coverage for MINERAL-HUB-API-5:
// GET /api/research/summary?from=0202-07-09 crashed with
// PrismaClientUnknownRequestError because the malformed year (0202) parsed to a
// valid Date, and parseCompare then extrapolated a same-length prior window
// yielding a BCE year (-001622-07-07) that Prisma can't serialize.

const yearOf = (d: Date) => d.getUTCFullYear();

describe("parseDay year guard", () => {
  it("parses a plausible YYYY-MM-DD as UTC midnight", () => {
    const d = parseDay("2026-07-09");
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe("2026-07-09T00:00:00.000Z");
  });

  it("rejects a malformed early year as if unset (the reported crash input)", () => {
    expect(parseDay("0202-07-09")).toBeNull();
  });

  it("rejects years outside the plausible research range", () => {
    expect(parseDay("0001-01-01")).toBeNull();
    expect(parseDay("1899-12-31")).toBeNull();
    expect(parseDay("2101-01-01")).toBeNull();
  });

  it("accepts the plausible-range boundaries", () => {
    expect(parseDay("1900-01-01")).not.toBeNull();
    expect(parseDay("2100-12-31")).not.toBeNull();
  });

  it("returns null for empty and unparseable input", () => {
    expect(parseDay(undefined)).toBeNull();
    expect(parseDay("not-a-date")).toBeNull();
  });
});

describe("window extrapolation stays in a serializable (positive) year", () => {
  it("falls back to the default window for a malformed ?from and never yields a BCE compare year", () => {
    const win = parseWindow({ from: "0202-07-09" });
    // Malformed from is ignored → default 90-day window ending today.
    expect(yearOf(win.from)).toBeGreaterThanOrEqual(1900);
    expect(yearOf(win.to)).toBeGreaterThanOrEqual(1900);

    const cmp = parseCompare({}, win);
    // The prior-period window must never contain a negative/BCE year.
    for (const d of [win.from, win.to, cmp.from, cmp.to]) {
      expect(yearOf(d)).toBeGreaterThanOrEqual(1);
    }
  });

  it("preserves a valid explicit window and its extrapolated compare period", () => {
    const win = parseWindow({ from: "2026-01-01", to: "2026-03-31" });
    expect(win.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(win.to.toISOString()).toBe("2026-03-31T00:00:00.000Z");

    const cmp = parseCompare({}, win);
    // Same-length period immediately before the current window.
    expect(cmp.to.toISOString()).toBe("2025-12-31T00:00:00.000Z");
    expect(yearOf(cmp.from)).toBe(2025);
  });
});
