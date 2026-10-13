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
 * Re-toning is only applied when it makes the mark MORE visible (planRetone).
 * Blindly flipping black→white erased whole logos: a wordmark on its own white
 * plate became a blank white box, a black badge with white lettering a blank
 * disc — and because the original paints first and the processed variant swaps
 * in a moment later, the logo appeared, then "disappeared". Artwork that brings
 * its own background, or whose dark parts mostly outline light parts, is shown
 * exactly as uploaded.
 *
 * Performance: each (logo, theme) result is cached (keyed by the source string
 * itself), and the first request for a logo warms BOTH themes, so flipping the
 * theme swaps in a precomputed image synchronously — no reprocessing, no
 * flicker. A logo that needs no change resolves to its own source.
 */

export type LogoTheme = "dark" | "light";

/** Resolved results per source, readable synchronously during render. */
const resolved = new Map<string, Partial<Record<LogoTheme, string>>>();
/** In-flight work, so concurrent callers share one computation. */
const pending = new Map<string, Partial<Record<LogoTheme, Promise<string>>>>();
/** Bumped by clearLogoCache so work started before a clear can't refill it. */
let generation = 0;

/** Cached variant if it has already been computed (synchronous, for first paint). */
export function cachedLogoVariant(src: string, theme: LogoTheme): string | null {
  return resolved.get(src)?.[theme] ?? null;
}

/** Drop every processed variant (session boundary: a signed-out tab keeps no org's artwork). */
export function clearLogoCache(): void {
  generation++;
  resolved.clear();
  pending.clear();
}

/**
 * The theme-adapted variant of a logo (data URL in, data URL out).
 * Resolves to the original source when no change is warranted or on any
 * processing failure — never rejects. Also warms the opposite theme in the
 * background so a later theme switch is instant.
 */
export function adaptLogoToTheme(src: string, theme: LogoTheme): Promise<string> {
  const p = variantFor(src, theme);
  void variantFor(src, theme === "dark" ? "light" : "dark");
  return p;
}

function variantFor(src: string, theme: LogoTheme): Promise<string> {
  const hit = cachedLogoVariant(src, theme);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(src)?.[theme];
  if (inflight) return inflight;
  const gen = generation;
  const p: Promise<string> = computeVariant(src, theme)
    .catch(() => src) // undecodable, canvas unavailable — the original is the safe answer
    .then((out) => {
      if (gen === generation) {
        entry(resolved, src)[theme] = out;
        const slot = pending.get(src);
        if (slot?.[theme] === p) {
          delete slot[theme];
          if (!slot.dark && !slot.light) pending.delete(src);
        }
      }
      return out;
    });
  entry(pending, src)[theme] = p;
  return p;
}

function entry<V>(map: Map<string, Partial<Record<LogoTheme, V>>>, src: string): Partial<Record<LogoTheme, V>> {
  let e = map.get(src);
  if (!e) { e = {}; map.set(src, e); }
  return e;
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

/** Neutrality: 1 for grays, fading to 0 for saturated brand colors. */
function neutrality(r: number, g: number, b: number): number {
  return 1 - smoothstep(CHROMA_NEUTRAL, CHROMA_COLORED, Math.max(r, g, b) - Math.min(r, g, b));
}

/** How strongly a pixel is a neutral extreme: "black" (dark theme re-tones it) or "white" (light theme does), 0→1. */
function toneWeight(r: number, g: number, b: number, tone: "black" | "white"): number {
  const neutral = neutrality(r, g, b);
  if (neutral === 0) return 0;
  return tone === "black"
    ? (1 - smoothstep(BLACK_FULL, BLACK_NONE, Math.max(r, g, b))) * neutral
    : smoothstep(WHITE_NONE, WHITE_FULL, Math.min(r, g, b)) * neutral;
}

/** The extreme a theme re-tones (and the one it re-tones INTO). */
const SOURCE_TONE = { dark: "black", light: "white" } as const;
const TARGET_TONE = { dark: "white", light: "black" } as const;

/**
 * Re-tone pixels in place: the theme's invisible extreme moves toward its
 * tonal inverse (black↔white), proportionally — a 30%-black antialiased edge
 * pixel moves 30% of the way, keeping edges smooth.
 */
export function retonePixels(px: Uint8ClampedArray, theme: LogoTheme): void {
  const tone = SOURCE_TONE[theme];
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue; // fully transparent — nothing to retone
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const weight = toneWeight(r, g, b, tone);
    if (weight === 0) continue;
    px[i] = Math.round(r + (255 - 2 * r) * weight);
    px[i + 1] = Math.round(g + (255 - 2 * g) * weight);
    px[i + 2] = Math.round(b + (255 - 2 * b) * weight);
  }
}

/**
 * Whether re-toning helps, and if not, why:
 *  - "retone":  do it.
 *  - "blank":   nothing visible was drawn (e.g. an SVG the canvas couldn't
 *               rasterize) — never swap the logo for an empty image.
 *  - "opaque":  the artwork carries its own background (JPEG, flattened PNG);
 *               it already has its contrast, re-toning only erases it.
 *  - "nothing": no neutral extreme to re-tone.
 *  - "erases":  the extreme mostly borders the OTHER extreme (white letters on
 *               a black badge, a dark wordmark on a white plate) — re-toning
 *               would merge them into one blank shape.
 *
 * The last test weighs every edge of the re-toned region: an edge against the
 * page background (transparency, or the artwork's border) is REVEALED by
 * re-toning, an edge against the opposite extreme is ERASED, and an edge
 * against a color reads the same either way. Re-tone only when it reveals at
 * least as much outline as it erases.
 */
export type RetonePlan = "retone" | "blank" | "opaque" | "nothing" | "erases";

/** Share of solid pixels at/above which artwork counts as bringing its own background. */
const OPAQUE_SHARE = 0.95;
/** A pixel at least this opaque reads as artwork; below it, as background. */
const SOLID_ALPHA = 128;
/** Pixels scanned across an edge, so antialiased gray between two tones doesn't hide what lies beyond. */
const EDGE_REACH = 3;

const CLEAR = 0, SOURCE = 1, TARGET = 2, GRAY = 3, COLOR = 4;

export function planRetone(px: ArrayLike<number>, w: number, h: number, theme: LogoTheme): RetonePlan {
  const n = w * h;
  const src = SOURCE_TONE[theme], dst = TARGET_TONE[theme];
  const cls = new Uint8Array(n); // CLEAR by default
  let visible = 0, solid = 0, touched = 0, sources = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = px[o + 3];
    if (a === 0) continue;
    visible++;
    const r = px[o], g = px[o + 1], b = px[o + 2];
    const ws = toneWeight(r, g, b, src);
    if (ws > 0) touched++;
    if (a < SOLID_ALPHA) continue;
    solid++;
    if (ws >= 0.5) { cls[i] = SOURCE; sources++; }
    else if (toneWeight(r, g, b, dst) >= 0.5) cls[i] = TARGET;
    else cls[i] = neutrality(r, g, b) >= 0.5 ? GRAY : COLOR;
  }
  if (visible === 0) return "blank";
  if (solid / n >= OPAQUE_SHARE) return "opaque";
  if (touched === 0) return "nothing";
  if (sources === 0) return "retone"; // only faint shading — nothing it could merge

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  let reveal = 0, erase = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cls[y * w + x] !== SOURCE) continue;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && cls[ny * w + nx] === SOURCE) continue; // interior
        // A boundary edge: look across it (bridging an antialiased gray band).
        for (let k = 1; k <= EDGE_REACH; k++) {
          const qx = x + dx * k, qy = y + dy * k;
          if (qx < 0 || qx >= w || qy < 0 || qy >= h) { reveal++; break; } // the artwork's border → page background
          const c = cls[qy * w + qx];
          if (c === CLEAR) { reveal++; break; }
          if (c === TARGET) { erase++; break; }
          if (c !== GRAY) break; // a color (or the same tone again): reads the same either way
        }
      }
    }
  }
  return erase > reveal ? "erases" : "retone";
}

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
  if (planRetone(data.data, w, h, theme) !== "retone") return src;
  retonePixels(data.data, theme);
  ctx.putImageData(data, 0, 0);
  const out = canvas.toDataURL("image/png");
  // A degenerate canvas serializes as "data:," — keep the original instead.
  return out.startsWith("data:image/") ? out : src;
}
