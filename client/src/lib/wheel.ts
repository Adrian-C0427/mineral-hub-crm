/** Wheel helpers shared by the app's scroll routing (lib/boardWheel.ts, and
 *  SortableTable's list-page handoff in lib/fillScroll.ts). */

/** A wheel gesture ends after this long without an event: trackpad momentum
 *  keeps one alive, separate mouse-wheel flicks start new ones. */
export const WHEEL_GESTURE_GAP_MS = 300;

/** Pixels per line for DOM_DELTA_LINE wheels (Firefox mouse wheels). */
const LINE_PX = 40;

/** A wheel delta in pixels; `pagePx` is one DOM_DELTA_PAGE. Read the deltas
 *  before deltaMode: Firefox reports pixels only when they are read first. */
export function wheelPx(delta: number, deltaMode: number, pagePx: number): number {
  return delta * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? pagePx : 1);
}
