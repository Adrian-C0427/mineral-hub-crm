/**
 * Viewport-height list pages (.page-fill > .ct-card, styles/shared.css): the
 * page is exactly the screen under the top bar and only the table's rows
 * scroll. On a cramped screen (a tall header / stat strip over a short window)
 * that would squeeze the table to a sliver, so the page keeps a floor — and
 * once the floor applies, the page itself (.app-main) scrolls too. The wheel
 * rules below keep that second scroller from ever trapping a gesture.
 */

/** The table's scroll area stops shrinking at this height (about four rows). */
export const FILL_MIN_TABLE_PX = 220;

/** min-height for the page: everything but the table's scroll area, plus that
 *  area at min(its full height, FILL_MIN_TABLE_PX) — a short table is never
 *  stretched, a long one never drops below a few rows. */
export function fillPageFloor(chromePx: number, tablePx: number): number {
  return Math.ceil(chromePx + Math.min(tablePx, FILL_MIN_TABLE_PX));
}

export interface NestedWheel {
  deltaY: number;
  /** The rows' scroll position (0 = top). */
  innerTop: number;
  /** The page's scroll position and how far it can scroll. */
  outerTop: number;
  outerMax: number;
  /** Part of the table card (last rows, totals, pager) is below the window. */
  cardCutOff: boolean;
}

const pageCanMoveDown = (w: NestedWheel) => w.cardCutOff && w.outerTop < w.outerMax - 1;

/**
 * Whether a vertical wheel gesture that starts over the rows is steered by
 * hand (otherwise the browser runs it). Only when the page has somewhere to
 * go: down while part of the card is below the window, up while the page is
 * scrolled. The rest — including every gesture on a page that fits — is native.
 */
export function steerNestedWheel(w: NestedWheel): boolean {
  if (w.deltaY > 0) return pageCanMoveDown(w);
  if (w.deltaY < 0) return w.outerTop > 0;
  return false;
}

/**
 * Inside a steered gesture, which scroller one wheel event moves. Going down,
 * the page first until the whole card is on screen (the last rows and the
 * pager stay visible while the rows scroll), then the rows. Going up, the rows
 * back to their top first, then the page brings the header back.
 */
export function nestedWheelTarget(w: NestedWheel): "page" | "rows" {
  if (w.deltaY > 0) return pageCanMoveDown(w) ? "page" : "rows";
  return w.innerTop > 0 ? "rows" : "page";
}
