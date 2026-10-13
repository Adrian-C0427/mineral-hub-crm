/**
 * Pan / zoom math for SVG maps driven by an animated `viewBox`
 * (ResearchChoropleth). Pure functions — the component owns the events.
 *
 * Views are `[x, y, width, height]` in the SVG's own units and always keep the
 * content's aspect ratio, so one zoom factor describes both axes. The SVG
 * renders with the default `preserveAspectRatio="xMidYMid meet"`.
 */

export type ViewBox = [number, number, number, number];

export interface ViewLimits {
  /** Full-extent size of the content (zoom 1 = the whole map). */
  width: number;
  height: number;
  /** Deepest zoom allowed, relative to the full extent. */
  maxZoom: number;
}

/** Zoom factor of `vb` relative to the full extent (1 = whole map). */
export function zoomOf(vb: ViewBox, lim: ViewLimits): number {
  return lim.width / vb[2];
}

/**
 * Keep a view sensible: zoom stays within [1, maxZoom] and the view's center
 * stays near the content. At full extent the map is locked centered; the
 * deeper the zoom, the further past an edge the view may drift (up to half a
 * view), so drill-down framings of edge counties are never yanked back.
 */
export function clampView(vb: ViewBox, lim: ViewLimits): ViewBox {
  const { width: W, height: H } = lim;
  const w = Math.min(W, Math.max(W / lim.maxZoom, vb[2]));
  const h = w * (H / W);
  const k = w / W; // 1 at full extent → 0 when fully zoomed in
  const spanX = (W - w) / 2 + (w / 2) * (1 - k);
  const spanY = (H - h) / 2 + (h / 2) * (1 - k);
  const cx = Math.min(W / 2 + spanX, Math.max(W / 2 - spanX, vb[0] + vb[2] / 2));
  const cy = Math.min(H / 2 + spanY, Math.max(H / 2 - spanY, vb[1] + vb[3] / 2));
  return [cx - w / 2, cy - h / 2, w, h];
}

/**
 * Zoom by `factor` (>1 = in) about `at` (a point in view units), keeping that
 * point fixed on screen — the cursor / pinch midpoint stays under the finger.
 */
export function zoomView(vb: ViewBox, factor: number, at: [number, number], lim: ViewLimits): ViewBox {
  const w = Math.min(lim.width, Math.max(lim.width / lim.maxZoom, vb[2] / factor));
  const r = w / vb[2];
  const h = vb[3] * r;
  return clampView([at[0] - (at[0] - vb[0]) * r, at[1] - (at[1] - vb[1]) * r, w, h], lim);
}

/** Move the CONTENT by (dx, dy) view units — drag semantics. */
export function panView(vb: ViewBox, dx: number, dy: number, lim: ViewLimits): ViewBox {
  return clampView([vb[0] - dx, vb[1] - dy, vb[2], vb[3]], lim);
}

interface Rect { left: number; top: number; width: number; height: number }

/** Screen pixels per view unit for an element rect (meet scaling). */
function scaleOf(vb: ViewBox, rect: Rect): number {
  return Math.min(rect.width / vb[2], rect.height / vb[3]) || 1;
}

/** View units per screen pixel — converts a pointer delta into a pan. */
export function unitsPerPixel(vb: ViewBox, rect: Rect): number {
  return 1 / scaleOf(vb, rect);
}

/**
 * Client (pointer) coordinates → view units. Uses the element's bounding rect
 * rather than getScreenCTM so it stays consistent with clientX/Y under the
 * app-wide CSS `zoom` (both are visual pixels). Accounts for the letterbox
 * that "meet" adds when the element's aspect differs from the view's.
 */
export function clientToView(vb: ViewBox, rect: Rect, clientX: number, clientY: number): [number, number] {
  const s = scaleOf(vb, rect);
  const ox = rect.left + (rect.width - vb[2] * s) / 2;
  const oy = rect.top + (rect.height - vb[3] * s) / 2;
  return [vb[0] + (clientX - ox) / s, vb[1] + (clientY - oy) / s];
}

/**
 * Frame a bounding box: padded by `pad` (fraction of its size per side) and
 * widened to the content aspect so it fills the viewport.
 */
export function fitView(bbox: ViewBox, pad: number, lim: Pick<ViewLimits, "width" | "height">): ViewBox {
  const [x, y, w, h] = bbox;
  let bw = w * (1 + pad * 2), bh = h * (1 + pad * 2);
  const cx = x + w / 2, cy = y + h / 2;
  if (bw / bh > lim.width / lim.height) bh = bw * (lim.height / lim.width); else bw = bh * (lim.width / lim.height);
  return [cx - bw / 2, cy - bh / 2, bw, bh];
}

/** Two views are visually the same (within 0.1% of the view's size, so the test holds at any zoom). */
export function sameView(a: ViewBox, b: ViewBox): boolean {
  const eps = Math.max(a[2], b[2]) * 1e-3;
  return a.every((v, i) => Math.abs(v - b[i]) < eps);
}
