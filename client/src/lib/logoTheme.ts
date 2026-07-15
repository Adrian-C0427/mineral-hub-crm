/**
 * Theme-adaptive logos.
 *
 * Uploaded company logos are arbitrary artwork — commonly dark marks that
 * vanish on the dark theme or white marks that vanish on the light theme.
 * This module re-tones ONLY the neutral extremes so the mark stays readable:
 *
 *  - dark theme:  near-black pixels → white
 *  - light theme: near-white pixels → black
 *
 * Brand colors, gradients, transparency, and colored icons are untouched: a
 * pixel is only eligible when its chroma (max−min channel spread) is low, i.e.
 * it is genuinely a black/white/gray element rather than a saturated color.
 * Both the darkness/brightness test and the neutrality test are smoothstepped,
 * so antialiased edges and soft shading remap proportionally — no posterized
 * fringes or jagged outlines.
 *
 * Performance: each (logo, theme) result is cached as a PNG data URL, and the
 * first request for a logo warms BOTH themes, so flipping the theme swaps in a
 * precomputed image synchronously — no refetch, no reprocessing, no flicker.
 */

export type LogoTheme = "dark" | "light";

/** Resolved results, readable synchronously during render. */
const resolved = new Map<string, string>();
/** In-flight work, so concurrent callers share one computation. */
const pending = new Map<string, Promise<string>>();

const cacheKey = (src: string, theme: LogoTheme) => `${theme}|${src}`;

/** Cached variant if it has already been computed (synchronous, for first paint). */
export function cachedLogoVariant(src: string, theme: LogoTheme): string | null {
  return resolved.get(cacheKey(src, theme)) ?? null;
}

/**
 * The theme-adapted variant of a logo (data URL in, data URL out).
 * Falls back to the original source on any processing failure.
 * Also warms the opposite theme in the background so a later theme
 * switch is instant.
 */
export function adaptLogoToTheme(src: string, theme: LogoTheme): Promise<string> {
  const key = cacheKey(src, theme);
  const hit = resolved.get(key);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    p = computeVariant(src, theme)
      .then((out) => { resolved.set(key, out); return out; })
      .catch(() => { resolved.set(key, src); return src; })
      .finally(() => { pending.delete(key); });
    pending.set(key, p);
  }
  // Warm the other theme too (fire-and-forget) so toggling never waits.
  const other: LogoTheme = theme === "dark" ? "light" : "dark";
  const otherKey = cacheKey(src, other);
  if (!resolved.has(otherKey) && !pending.has(otherKey)) {
    const q = computeVariant(src, other)
      .then((out) => { resolved.set(otherKey, out); return out; })
      .catch(() => { resolved.set(otherKey, src); return src; })
      .finally(() => { pending.delete(otherKey); });
    pending.set(otherKey, q);
  }
  return p;
}

/** 0→1 ramp with smooth ends (Hermite), clamped. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Thresholds (0–255). A pixel remaps fully inside the first edge and not at
// all beyond the second; between them the remap fades smoothly so antialiased
// edges (which pass through mid grays) transition without artifacts.
const BLACK_FULL = 48;   // max(R,G,B) ≤ this  → fully "black"
const BLACK_NONE = 96;   // max(R,G,B) ≥ this  → not black at all
const WHITE_FULL = 208;  // min(R,G,B) ≥ this  → fully "white"
const WHITE_NONE = 160;  // min(R,G,B) ≤ this  → not white at all
const CHROMA_NEUTRAL = 24; // channel spread ≤ this → fully neutral (gray)
const CHROMA_COLORED = 60; // channel spread ≥ this → definitely a brand color

/** Largest processing dimension — bounds work while staying crisp in the UI. */
const MAX_SIDE = 1024;
/** SVGs rasterize at least this large so small intrinsic sizes stay sharp. */
const SVG_MIN_SIDE = 512;

async function computeVariant(src: string, theme: LogoTheme): Promise<string> {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  await img.decode();

  let w = img.naturalWidth || SVG_MIN_SIDE;
  let h = img.naturalHeight || SVG_MIN_SIDE;
  const isSvg = src.startsWith("data:image/svg");
  if (isSvg && Math.max(w, h) < SVG_MIN_SIDE) {
    const s = SVG_MIN_SIDE / Math.max(w, h);
    w = Math.round(w * s); h = Math.round(h * s);
  }
  if (Math.max(w, h) > MAX_SIDE) {
    const s = MAX_SIDE / Math.max(w, h);
    w = Math.round(w * s); h = Math.round(h * s);
  }

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.drawImage(img, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue; // fully transparent — nothing to retone
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
    // Neutrality: only gray-ish pixels are candidates; saturated brand colors
    // fade out of eligibility between the two chroma edges.
    const neutral = 1 - smoothstep(CHROMA_NEUTRAL, CHROMA_COLORED, maxC - minC);
    if (neutral === 0) continue;
    const weight = theme === "dark"
      ? (1 - smoothstep(BLACK_FULL, BLACK_NONE, maxC)) * neutral  // how "black" it is
      : smoothstep(WHITE_NONE, WHITE_FULL, minC) * neutral;       // how "white" it is
    if (weight === 0) continue;
    // Remap toward the tonal inverse (black↔white), proportionally — a 30%-black
    // antialiased edge pixel moves 30% of the way, keeping edges smooth.
    px[i] = Math.round(r + (255 - 2 * r) * weight);
    px[i + 1] = Math.round(g + (255 - 2 * g) * weight);
    px[i + 2] = Math.round(b + (255 - 2 * b) * weight);
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}
