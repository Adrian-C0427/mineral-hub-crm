/**
 * Theme-adaptive logos (client/src/lib/logoTheme.ts): when re-toning a logo
 * helps, when it would erase the logo (the "logo appears, then disappears"
 * bug), the pixel remap itself, and the variant cache.
 *
 * Images are synthetic RGBA buffers; the canvas path isn't available in node,
 * which conveniently exercises the "processing failed → original" fallback.
 *
 * Kept outside src/ so the client build's typecheck never needs vitest.
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import { adaptLogoToTheme, cachedLogoVariant, clearLogoCache, planRetone, retonePixels } from "../src/lib/logoTheme";

type RGBA = [number, number, number, number];
const CLEAR: RGBA = [0, 0, 0, 0];
const BLACK: RGBA = [0, 0, 0, 255];
const WHITE: RGBA = [255, 255, 255, 255];
const GRAY: RGBA = [128, 128, 128, 255];
const RED: RGBA = [220, 30, 30, 255];

const W = 40, H = 20;
/** Paint a W×H image from a per-pixel function. */
function paint(fn: (x: number, y: number) => RGBA, w = W, h = H): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(fn(x, y), (y * w + x) * 4);
  return px;
}
const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

/** Black wordmark on a transparent background. */
const wordmark = paint((x, y) => (inRect(x, y, 5, 5, 35, 15) ? BLACK : CLEAR));
/** Five white strokes inside a black badge, on transparent. */
const badge = paint((x, y) => {
  if (!inRect(x, y, 2, 2, 38, 18)) return CLEAR;
  const stroke = inRect(x, y, 0, 4, W, 16) && [6, 12, 18, 24, 30].some((s) => x === s || x === s + 1);
  return stroke ? WHITE : BLACK;
});

describe("planRetone — dark ground (the sidebar)", () => {
  it("re-tones a dark mark on transparency (it would be invisible on black)", () => {
    expect(planRetone(wordmark, W, H, "dark")).toBe("retone");
  });

  it("still re-tones with antialiased (semi-transparent) edges", () => {
    const aa = paint((x, y) => (inRect(x, y, 5, 5, 35, 15) ? BLACK : inRect(x, y, 4, 4, 36, 16) ? [0, 0, 0, 90] : CLEAR));
    expect(planRetone(aa, W, H, "dark")).toBe("retone");
  });

  it("leaves artwork with its own opaque background alone (white plate → was a blank white box)", () => {
    const plate = paint((x, y) => (inRect(x, y, 8, 6, 32, 14) ? BLACK : WHITE));
    expect(planRetone(plate, W, H, "dark")).toBe("opaque");
    const jpegLike = paint((x, y) => (inRect(x, y, 8, 6, 32, 14) ? RED : BLACK));
    expect(planRetone(jpegLike, W, H, "dark")).toBe("opaque");
  });

  it("leaves a dark wordmark on a white plate with transparent margins alone", () => {
    const plate = paint((x, y) => (!inRect(x, y, 2, 2, 38, 18) ? CLEAR : inRect(x, y, 8, 7, 32, 13) ? BLACK : WHITE));
    expect(planRetone(plate, W, H, "dark")).toBe("erases");
  });

  it("leaves a black badge with white lettering alone (was a blank white shape)", () => {
    expect(planRetone(badge, W, H, "dark")).toBe("erases");
  });

  it("sees through an antialiased gray band between black and white", () => {
    // The badge again, each white stroke flanked by a 1px gray antialiasing column.
    const soft = paint((x, y) => {
      if (!inRect(x, y, 2, 2, 38, 18)) return CLEAR;
      const band = inRect(x, y, 0, 4, W, 16);
      if (band && [6, 12, 18, 24, 30].some((s) => x === s || x === s + 1)) return WHITE;
      if (band && [6, 12, 18, 24, 30].some((s) => x === s - 1 || x === s + 2)) return GRAY;
      return BLACK;
    });
    expect(planRetone(soft, W, H, "dark")).toBe("erases");
  });

  it("re-tones when black mostly borders color (outline inside a brand shape)", () => {
    const inShape = paint((x, y) => (inRect(x, y, 10, 6, 30, 14) ? BLACK : inRect(x, y, 2, 2, 38, 18) ? RED : CLEAR));
    expect(planRetone(inShape, W, H, "dark")).toBe("retone");
  });

  it("does nothing for color-only artwork, and never swaps in a blank render", () => {
    expect(planRetone(paint((x, y) => (inRect(x, y, 5, 5, 35, 15) ? RED : CLEAR)), W, H, "dark")).toBe("nothing");
    expect(planRetone(paint(() => CLEAR), W, H, "dark")).toBe("blank");
  });
});

describe("planRetone — light ground (Settings previews in Light)", () => {
  it("re-tones a white mark on transparency", () => {
    const white = paint((x, y) => (inRect(x, y, 5, 5, 35, 15) ? WHITE : CLEAR));
    expect(planRetone(white, W, H, "light")).toBe("retone");
  });

  it("leaves white lettering on a black badge alone", () => {
    expect(planRetone(badge, W, H, "light")).toBe("erases");
  });

  it("has nothing to do for a dark mark", () => {
    expect(planRetone(wordmark, W, H, "light")).toBe("nothing");
  });
});

describe("retonePixels", () => {
  it("dark: black → white; colors and transparency untouched", () => {
    const px = new Uint8ClampedArray([...BLACK, ...RED, ...CLEAR, ...WHITE]);
    retonePixels(px, "dark");
    expect([...px]).toEqual([...WHITE, ...RED, ...CLEAR, ...WHITE]);
  });

  it("light: white → black", () => {
    const px = new Uint8ClampedArray([...WHITE, ...RED]);
    retonePixels(px, "light");
    expect([...px]).toEqual([...BLACK, ...RED]);
  });

  it("antialiased grays move proportionally (no hard fringe)", () => {
    const px = new Uint8ClampedArray([70, 70, 70, 255]);
    retonePixels(px, "dark");
    expect(px[0]).toBeGreaterThan(70);
    expect(px[0]).toBeLessThan(255);
  });
});

describe("variant cache", () => {
  const A = "data:image/png;base64,AAAA";
  const B = "data:image/png;base64,BBBB";

  it("falls back to the original when processing is unavailable, and caches it", async () => {
    clearLogoCache();
    expect(cachedLogoVariant(A, "dark")).toBeNull();
    await expect(adaptLogoToTheme(A, "dark")).resolves.toBe(A);
    expect(cachedLogoVariant(A, "dark")).toBe(A);
    await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
    expect(cachedLogoVariant(A, "light")).toBe(A); // opposite theme pre-warmed
  });

  it("shares one computation between concurrent callers, per source", () => {
    clearLogoCache();
    const p = adaptLogoToTheme(B, "dark");
    expect(adaptLogoToTheme(B, "dark")).toBe(p);
    expect(adaptLogoToTheme(A, "dark")).not.toBe(p);
  });

  it("clear drops everything — including work that was in flight", async () => {
    clearLogoCache();
    await adaptLogoToTheme(A, "dark");
    const inflight = adaptLogoToTheme(B, "dark");
    clearLogoCache();
    await inflight;
    expect(cachedLogoVariant(A, "dark")).toBeNull();
    expect(cachedLogoVariant(B, "dark")).toBeNull();
  });
});
