/**
 * Viewport-height list pages (client/src/lib/fillScroll.ts): the page floor
 * that keeps a few rows on a cramped screen, and the wheel routing between the
 * rows and the page once that floor makes the page scroll too.
 *
 * Kept outside src/ so the client build's typecheck never needs vitest.
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import { FILL_MIN_TABLE_PX, fillPageFloor, nestedWheelTarget, steerNestedWheel, type NestedWheel } from "../src/lib/fillScroll";
import { wheelPx } from "../src/lib/wheel";

const w = (over: Partial<NestedWheel>): NestedWheel => ({ deltaY: 100, innerTop: 0, outerTop: 0, outerMax: 180, cardCutOff: true, ...over });

describe("fillPageFloor", () => {
  it("never stretches a short table", () => {
    expect(fillPageFloor(400, 150)).toBe(550);
  });
  it("keeps a long table at a few rows", () => {
    expect(fillPageFloor(400, 3000)).toBe(400 + FILL_MIN_TABLE_PX);
  });
  it("rounds up so sub-pixel layouts never squeeze the last pixel", () => {
    expect(fillPageFloor(400.25, 3000)).toBe(400 + FILL_MIN_TABLE_PX + 1);
  });
});

describe("steerNestedWheel — which gestures over the rows are steered", () => {
  it("down, while the card's bottom (last rows, pager) is below the window and the page can move", () => {
    expect(steerNestedWheel(w({}))).toBe(true);
  });
  it("not down once the whole card is on screen or the page is at its end — the rows scroll natively", () => {
    expect(steerNestedWheel(w({ cardCutOff: false }))).toBe(false);
    expect(steerNestedWheel(w({ outerTop: 180 }))).toBe(false);
  });
  it("up, while the page is scrolled (the header is hidden)", () => {
    expect(steerNestedWheel(w({ deltaY: -100, outerTop: 40, innerTop: 500 }))).toBe(true);
    expect(steerNestedWheel(w({ deltaY: -100, outerTop: 0, innerTop: 500 }))).toBe(false);
  });
  it("never for an empty delta", () => {
    expect(steerNestedWheel(w({ deltaY: 0 }))).toBe(false);
  });
});

describe("nestedWheelTarget — inside a steered gesture", () => {
  it("down: the page first, then the rows", () => {
    expect(nestedWheelTarget(w({ outerTop: 60 }))).toBe("page");
    expect(nestedWheelTarget(w({ outerTop: 180 }))).toBe("rows");
    expect(nestedWheelTarget(w({ outerTop: 120, cardCutOff: false }))).toBe("rows");
  });
  it("up: the rows back to their top first, then the page", () => {
    expect(nestedWheelTarget(w({ deltaY: -100, innerTop: 300, outerTop: 180 }))).toBe("rows");
    expect(nestedWheelTarget(w({ deltaY: -100, innerTop: 0, outerTop: 180 }))).toBe("page");
  });
});

describe("wheelPx", () => {
  it("passes pixels through and converts line / page wheels", () => {
    expect(wheelPx(-53, 0, 700)).toBe(-53);
    expect(wheelPx(3, 1, 700)).toBe(120);
    expect(wheelPx(1, 2, 700)).toBe(700);
  });
});
