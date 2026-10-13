/**
 * Custom reporting ranges (client/src/lib/period.ts) and popup placement
 * (client/src/lib/viewport.ts popupX) behind the Dashboard's Custom period
 * picker: a range is applied — and fetched — only when complete and in order,
 * and the picker always lands fully inside the viewport.
 *
 * Kept outside src/ so the client build's typecheck never needs vitest.
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import { EMPTY_RANGE, isIsoDay, rangeDays, rangeIssue, sameRange, withAllPeriod } from "../src/lib/period";
import { popupX } from "../src/lib/viewport";

describe("isIsoDay", () => {
  it("accepts real calendar days only", () => {
    expect(isIsoDay("2026-01-31")).toBe(true);
    expect(isIsoDay("2024-02-29")).toBe(true); // leap day
    expect(isIsoDay("2026-02-29")).toBe(false);
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("2026-13-01")).toBe(false);
    expect(isIsoDay("2026-00-10")).toBe(false);
    expect(isIsoDay("2026-1-5")).toBe(false);
    expect(isIsoDay("01/05/2026")).toBe(false);
    expect(isIsoDay("")).toBe(false);
  });
});

describe("rangeIssue", () => {
  it("is incomplete until both ends are chosen", () => {
    expect(rangeIssue(EMPTY_RANGE)).toBe("incomplete");
    expect(rangeIssue({ from: "2026-01-01", to: "" })).toBe("incomplete");
    expect(rangeIssue({ from: "", to: "2026-03-31" })).toBe("incomplete");
  });
  it("rejects malformed days", () => {
    expect(rangeIssue({ from: "2026-02-30", to: "2026-03-31" })).toBe("invalid");
    expect(rangeIssue({ from: "2026-01-01", to: "03/31/2026" })).toBe("invalid");
  });
  it("rejects an end before the start", () => {
    expect(rangeIssue({ from: "2026-03-31", to: "2026-01-01" })).toBe("order");
    expect(rangeIssue({ from: "2026-01-01", to: "2025-12-31" })).toBe("order");
  });
  it("accepts ordered ranges, including a single day", () => {
    expect(rangeIssue({ from: "2026-01-01", to: "2026-03-31" })).toBeNull();
    expect(rangeIssue({ from: "2026-04-15", to: "2026-04-15" })).toBeNull();
    expect(rangeIssue({ from: "2019-06-01", to: "2026-05-31" })).toBeNull();
  });
});

describe("rangeDays", () => {
  it("counts both ends", () => {
    expect(rangeDays({ from: "2026-04-15", to: "2026-04-15" })).toBe(1);
    expect(rangeDays({ from: "2026-01-01", to: "2026-03-31" })).toBe(90);
    expect(rangeDays({ from: "2024-01-01", to: "2024-12-31" })).toBe(366);
  });
  it("is null for a range that can't be applied", () => {
    expect(rangeDays(EMPTY_RANGE)).toBeNull();
    expect(rangeDays({ from: "2026-03-31", to: "2026-01-01" })).toBeNull();
  });
});

describe("sameRange", () => {
  it("compares both ends", () => {
    expect(sameRange({ from: "2026-01-01", to: "2026-02-01" }, { from: "2026-01-01", to: "2026-02-01" })).toBe(true);
    expect(sameRange({ from: "2026-01-01", to: "2026-02-01" }, { from: "2026-01-01", to: "2026-02-02" })).toBe(false);
  });
});

describe("withAllPeriod", () => {
  it("puts All just before Custom, so Custom stays last", () => {
    const out = withAllPeriod([["YTD", "YTD"], ["CUSTOM", "Custom"]] as const);
    expect(out.map(([v]) => v)).toEqual(["YTD", "ALL", "CUSTOM"]);
  });
});

describe("popupX", () => {
  const anchor = (left: number, width: number) => ({ left, right: left + width, width });

  it("defaults to the anchor's width and left edge (unchanged dropdown behavior)", () => {
    expect(popupX(anchor(100, 200), 1200)).toEqual({ left: 100, width: 200 });
    // Near the right edge the field-width menu is pulled back inside.
    expect(popupX(anchor(1100, 200), 1200)).toEqual({ left: 992, width: 200 });
  });

  it("lines up right edges for align end", () => {
    // Tray 600–1000; a 340px popover hangs from its right edge.
    expect(popupX(anchor(600, 400), 1440, { width: 340, align: "end" })).toEqual({ left: 660, width: 340 });
  });

  it("clamps an end-aligned popover that would overhang the left edge", () => {
    // Short tray at the far left: the popover can't start before the 8px edge.
    expect(popupX(anchor(10, 120), 1200, { width: 340, align: "end" })).toEqual({ left: 8, width: 340 });
  });

  it("shrinks to fit narrow viewports and stays fully on screen", () => {
    const { left, width } = popupX(anchor(16, 343), 320, { width: 340, align: "end" });
    expect(width).toBe(304);
    expect(left).toBe(8);
    expect(left + width).toBeLessThanOrEqual(320 - 8);
  });

  it("never overhangs the right edge", () => {
    // Anchor partly scrolled past the right edge (a sideways-scrolling tray).
    const { left, width } = popupX(anchor(900, 400), 1024, { width: 340, align: "end" });
    expect(left + width).toBe(1024 - 8);
  });
});
