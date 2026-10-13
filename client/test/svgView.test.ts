/**
 * Pan / zoom math for the Research → Geography choropleth
 * (client/src/lib/svgView.ts).
 *
 * Kept outside src/ so the client build's typecheck never needs vitest.
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import { clampView, clientToView, fitView, panView, sameView, unitsPerPixel, zoomOf, zoomView, type ViewBox, type ViewLimits } from "../src/lib/svgView";

const W = 720, H = 680;
const LIM: ViewLimits = { width: W, height: H, maxZoom: 128 };
const FULL: ViewBox = [0, 0, W, H];
const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe("zoomView", () => {
  it("keeps the anchor point fixed on screen", () => {
    const at: [number, number] = [200, 300];
    const z = zoomView(FULL, 2, at, LIM);
    expect(zoomOf(z, LIM)).toBeCloseTo(2);
    // The anchor sits at the same fraction of the view before and after.
    expect((at[0] - z[0]) / z[2]).toBeCloseTo((at[0] - FULL[0]) / FULL[2]);
    expect((at[1] - z[1]) / z[3]).toBeCloseTo((at[1] - FULL[1]) / FULL[3]);
  });

  it("keeps the content aspect ratio", () => {
    const z = zoomView(FULL, 3.7, [100, 100], LIM);
    expect(z[2] / z[3]).toBeCloseTo(W / H);
  });

  it("clamps between the full extent and maxZoom", () => {
    expect(zoomView(FULL, 0.5, [360, 340], LIM)).toEqual(FULL);
    const deep = zoomView(FULL, 10_000, [360, 340], LIM);
    expect(zoomOf(deep, LIM)).toBeCloseTo(LIM.maxZoom);
  });

  it("zooming out to the full extent recenters the map", () => {
    const z = zoomView(FULL, 4, [50, 50], LIM);
    close(zoomView(z, 1 / 8, [50, 50], LIM), FULL);
  });

  it("round-trips: in then out about the same point", () => {
    const start = zoomView(FULL, 6, [400, 300], LIM);
    const back = zoomView(zoomView(start, 2, [410, 310], LIM), 1 / 2, [410, 310], LIM);
    close(back, start);
  });
});

describe("panView / clampView", () => {
  it("drag semantics: content moves with the pointer, view moves opposite", () => {
    const z = zoomView(FULL, 4, [360, 340], LIM);
    const p = panView(z, 10, -5, LIM);
    close(p, [z[0] - 10, z[1] + 5, z[2], z[3]]);
  });

  it("is locked at the full extent", () => {
    expect(panView(FULL, 200, 200, LIM)).toEqual(FULL);
  });

  it("lets the view drift at most half a view past an edge when zoomed in", () => {
    const z = zoomView(FULL, 8, [360, 340], LIM);
    const far = panView(z, 10_000, 10_000, LIM); // drag content far right/down
    const cx = far[0] + far[2] / 2, cy = far[1] + far[3] / 2;
    expect(cx).toBeGreaterThanOrEqual(-far[2] / 2 - 1e-9);
    expect(cy).toBeGreaterThanOrEqual(-far[3] / 2 - 1e-9);
    expect(cx).toBeLessThan(far[2]); // still near the west/north edge
  });

  it("leaves drill-down framings of edge counties untouched", () => {
    // A small county hugging the top-left padding of the projection.
    const fit = fitView([9, 9, 30, 25], 0.16, LIM);
    close(clampView(fit, LIM), fit);
  });
});

describe("clientToView / unitsPerPixel", () => {
  it("maps element pixels to view units, accounting for the meet letterbox", () => {
    // 1440×680 element: the 720×680 view scales ×1 by height, centered with 360px bars.
    const rect = { left: 100, top: 50, width: 1440, height: 680 };
    close(clientToView(FULL, rect, 100 + 360, 50), [0, 0]);
    close(clientToView(FULL, rect, 100 + 360 + 720, 50 + 680), [W, H]);
    expect(unitsPerPixel(FULL, rect)).toBeCloseTo(1);
  });

  it("scales with zoom", () => {
    const rect = { left: 0, top: 0, width: 720, height: 680 };
    const z = zoomView(FULL, 4, [360, 340], LIM);
    expect(unitsPerPixel(z, rect)).toBeCloseTo(0.25);
    close(clientToView(z, rect, 360, 340), [360, 340]);
  });
});

describe("fitView / sameView", () => {
  it("pads the box and widens it to the content aspect", () => {
    const v = fitView([100, 100, 40, 10], 0.25, LIM);
    expect(v[2] / v[3]).toBeCloseTo(W / H);
    expect(v[2]).toBeCloseTo(60); // 40 × (1 + 2·0.25), the wider dimension
    close([v[0] + v[2] / 2, v[1] + v[3] / 2], [120, 105]); // centered on the box
  });

  it("compares views relative to their size", () => {
    expect(sameView(FULL, [0.3, 0.3, W, H])).toBe(true);
    expect(sameView(FULL, [2, 0, W, H])).toBe(false);
    const tiny: ViewBox = [100, 100, 6, 5.67];
    expect(sameView(tiny, [100.001, 100, 6, 5.67])).toBe(true);
    expect(sameView(tiny, [100.3, 100, 6, 5.67])).toBe(false);
  });
});
