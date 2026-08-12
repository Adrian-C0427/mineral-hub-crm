/**
 * Zoom-aware geometry for body-portaled popups.
 *
 * The app applies a global `zoom` on :root (interface scale). Under CSS zoom,
 * `getBoundingClientRect()` reports VISUAL viewport pixels, but a portaled
 * `position: fixed` element inside the zoomed root lays out in LAYOUT pixels —
 * the browser multiplies its `top/left` by the zoom again. Positioning a menu
 * straight from the rect therefore lands it short of the field (up and to the
 * left, worse the further from the origin) — the "detached dropdown" bug.
 *
 * `layoutRect` converts a rect into layout-space coordinates, which match both
 * the CSS values we set on fixed portals and `documentElement.clientWidth/
 * clientHeight`. With no zoom applied it is an exact pass-through.
 */

export function rootZoom(): number {
  try {
    const z = parseFloat(getComputedStyle(document.documentElement).zoom as unknown as string);
    return Number.isFinite(z) && z > 0 ? z : 1;
  } catch {
    return 1;
  }
}

export interface LayoutRect {
  left: number; top: number; right: number; bottom: number; width: number; height: number;
}

/**
 * Viewport size in LAYOUT pixels — the space actually available to a fixed
 * portal inside the zoomed root. `documentElement.clientWidth` and
 * `window.innerWidth` both report the UNzoomed viewport, which under
 * zoom < 1 is smaller than the layout viewport; clamping against them pushes
 * right/bottom-edge menus away from their anchor (the "off-center at the
 * right dock" bug).
 */
export function layoutViewport(): { vw: number; vh: number } {
  const z = rootZoom();
  return {
    vw: document.documentElement.clientWidth / z,
    vh: document.documentElement.clientHeight / z,
  };
}

export function layoutRect(el: Element): LayoutRect {
  const r = el.getBoundingClientRect();
  const z = rootZoom();
  return {
    left: r.left / z, top: r.top / z, right: r.right / z, bottom: r.bottom / z,
    width: r.width / z, height: r.height / z,
  };
}
