/**
 * Pipeline board wheel routing (client/src/lib/boardWheel.ts): which wheel /
 * trackpad gestures move the board sideways and which stay with the browser
 * (column scrolling, zoom).
 *
 * Kept outside src/ so the client build's typecheck never needs vitest.
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import { boardWheelDelta, boardWheelMode, type BoardWheelStart } from "../src/lib/boardWheel";

const start = (over: Partial<BoardWheelStart>): BoardWheelStart => ({
  deltaX: 0, deltaY: 0, shiftKey: false, ctrlKey: false,
  overColumnBody: false, boardScrolls: true,
  ...over,
});

describe("boardWheelMode — vertical wheel", () => {
  it("stays native over a column's card list (the column scrolls)", () => {
    expect(boardWheelMode(start({ deltaY: 100, overColumnBody: true }))).toBe("native");
    expect(boardWheelMode(start({ deltaY: -40, deltaX: 3, overColumnBody: true }))).toBe("native");
  });
  it("moves the board over column headers, gaps and empty board space", () => {
    expect(boardWheelMode(start({ deltaY: 100 }))).toBe("y");
    expect(boardWheelMode(start({ deltaY: -100 }))).toBe("y");
  });
  it("Shift+wheel moves the board anywhere, columns included", () => {
    expect(boardWheelMode(start({ deltaY: 100, shiftKey: true, overColumnBody: true }))).toBe("y");
  });
});

describe("boardWheelMode — sideways gestures", () => {
  it("are taken over a card list, which would otherwise latch the gesture", () => {
    // A trackpad swipe with a little vertical drift, and a tilt wheel.
    expect(boardWheelMode(start({ deltaX: 12, deltaY: 2, overColumnBody: true }))).toBe("x");
    expect(boardWheelMode(start({ deltaX: -120, overColumnBody: true }))).toBe("x");
  });
  it("stay native over headers, gaps and empty board, where the browser hands them to the board", () => {
    expect(boardWheelMode(start({ deltaX: 12, deltaY: 2 }))).toBe("native");
  });
});

describe("boardWheelMode — left alone", () => {
  it("pinch / ctrl+wheel zoom", () => {
    expect(boardWheelMode(start({ deltaY: 5, ctrlKey: true }))).toBe("native");
  });
  it("a board with nothing off to the side", () => {
    expect(boardWheelMode(start({ deltaY: 100, boardScrolls: false }))).toBe("native");
    expect(boardWheelMode(start({ deltaX: 30, overColumnBody: true, boardScrolls: false }))).toBe("native");
  });
  it("an empty event", () => {
    expect(boardWheelMode(start({}))).toBe("native");
  });
});

describe("boardWheelDelta", () => {
  const px = (deltaX: number, deltaY: number, deltaMode = 0) => ({ deltaX, deltaY, deltaMode });
  it("native gestures never scroll the board", () => {
    expect(boardWheelDelta("native", px(10, 100), 800)).toBe(0);
  });
  it("y: wheel down scrolls right, wheel up scrolls left", () => {
    expect(boardWheelDelta("y", px(0, 100), 800)).toBe(100);
    expect(boardWheelDelta("y", px(0, -53), 800)).toBe(-53);
  });
  it("y: a sideways event later in the gesture still moves the board its own way", () => {
    expect(boardWheelDelta("y", px(-30, 4), 800)).toBe(-30);
  });
  it("x: only the sideways part moves the board (vertical drift is dropped)", () => {
    expect(boardWheelDelta("x", px(14, 3), 800)).toBe(14);
    expect(boardWheelDelta("x", px(1, 9), 800)).toBe(1);
  });
  it("line and page wheels are converted to pixels", () => {
    expect(boardWheelDelta("y", px(0, 3, 1), 800)).toBe(120);
    expect(boardWheelDelta("y", px(0, -1, 2), 800)).toBe(-800);
  });
});
