/**
 * Client mirror of the implied-margin formula (client/src/lib/metrics.ts) —
 * parity with server/src/domain/metrics.ts is tested on the server.
 */
import { describe, it, expect } from "vitest";
import { impliedMargin } from "../src/lib/metrics";

describe("impliedMargin (deal page header)", () => {
  it("is (ask − our price) ÷ our price", () => {
    expect(impliedMargin(150_000, 100_000)).toBeCloseTo(0.5);
    expect(impliedMargin(80_000, 100_000)).toBeCloseTo(-0.2);
    expect(Math.round(impliedMargin(40_000, 30_000)! * 100)).toBe(33); // shown as +33%
  });

  it("is null (shown as —) without both prices or a positive Our Price", () => {
    expect(impliedMargin(null, 100_000)).toBeNull();
    expect(impliedMargin(150_000, null)).toBeNull();
    expect(impliedMargin(150_000, 0)).toBeNull();
    expect(impliedMargin(150_000, -1)).toBeNull();
  });
});
