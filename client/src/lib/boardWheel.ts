import { useCallback, useRef } from "react";
import { WHEEL_GESTURE_GAP_MS, wheelPx } from "./wheel";

/**
 * Wheel / trackpad routing for the Pipeline boards (deals and opportunities).
 *
 * The board (.kanban) is the only horizontal scroller; each column's card list
 * (.kanban-col-body) scrolls vertically on its own and keeps its vertical
 * overscroll to itself. Browsers latch a whole wheel gesture to the first
 * scroller under the pointer that can take any of it, so a sideways trackpad
 * swipe with the slightest vertical drift that starts over a card list stays
 * stuck in that list, and a plain mouse wheel (vertical only) can't move the
 * board. Once per gesture this decides who takes it:
 *
 *  - over a card list, a vertical wheel stays native (the column scrolls; the
 *    board never fights it, even at the column's end);
 *  - a sideways gesture over a card list moves the board;
 *  - Shift+wheel anywhere, and a plain vertical wheel over the column headers,
 *    the gaps or the empty board, move the board sideways;
 *  - everything else (pinch / ctrl-zoom, a board with nothing off-screen, a
 *    sideways swipe over the headers or gaps, which the browser already hands
 *    to the board) stays native.
 */

/** native = leave it to the browser; x = board scrolls by deltaX; y = board scrolls by the wheel's dominant delta. */
export type BoardWheelMode = "native" | "x" | "y";

export interface BoardWheelStart {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  /** The pointer is over a column's card list. */
  overColumnBody: boolean;
  /** The board has columns off to the side (scrollWidth > clientWidth). */
  boardScrolls: boolean;
}

/** How a gesture that starts with this wheel event is routed. */
export function boardWheelMode(g: BoardWheelStart): BoardWheelMode {
  if (g.ctrlKey || !g.boardScrolls) return "native";
  const ax = Math.abs(g.deltaX), ay = Math.abs(g.deltaY);
  if (ax === 0 && ay === 0) return "native";
  // Sideways: the browser hands it to the board unless a card list would
  // grab it first (any vertical drift latches it there).
  if (ax > ay) return g.overColumnBody ? "x" : "native";
  if (g.shiftKey) return "y";
  return g.overColumnBody ? "native" : "y";
}

/** Horizontal pixels the board scrolls for one wheel event of a gesture in `mode`. */
export function boardWheelDelta(mode: BoardWheelMode, e: { deltaX: number; deltaY: number; deltaMode: number }, pagePx: number): number {
  if (mode === "native") return 0;
  const d = mode === "x" || Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  return wheelPx(d, e.deltaMode, pagePx);
}

/**
 * Ref callback for a board's .kanban element: routes wheel gestures as
 * described above. Non-passive (it must be able to cancel), bound to the
 * board only — never the document — so scrolling elsewhere stays on the
 * browser's fast path.
 */
export function useBoardWheel(): (board: HTMLElement | null) => void {
  const detach = useRef<(() => void) | null>(null);
  return useCallback((board: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (!board) return;
    let mode: BoardWheelMode = "native";
    let lastAt = -Infinity;
    const onWheel = (e: WheelEvent) => {
      const deltaX = e.deltaX, deltaY = e.deltaY; // before deltaMode (see wheelPx)
      if (e.ctrlKey) return; // pinch / ctrl+wheel zoom
      // Only a cancelable event can start a gesture: once the browser runs one
      // natively, the rest of it arrives non-cancelable and stays native. A
      // sideways event that is still cancelable inside a native gesture (the
      // board slid a card list under the pointer) is looked at again, so the
      // list can't swallow the rest of the swipe.
      const sideways = Math.abs(deltaX) > Math.abs(deltaY);
      if (e.timeStamp - lastAt > WHEEL_GESTURE_GAP_MS || (mode === "native" && sideways && e.cancelable)) {
        const body = (e.target as Element | null)?.closest?.(".kanban-col-body");
        mode = e.cancelable ? boardWheelMode({
          deltaX, deltaY, shiftKey: e.shiftKey, ctrlKey: false,
          overColumnBody: !!body && board.contains(body),
          boardScrolls: board.scrollWidth > board.clientWidth + 1,
        }) : "native";
      }
      lastAt = e.timeStamp;
      if (mode === "native" || !e.cancelable) return;
      // The board owns the whole gesture, edges included: nothing leaks into a
      // column or turns into a back/forward swipe.
      e.preventDefault();
      board.scrollLeft += boardWheelDelta(mode, { deltaX, deltaY, deltaMode: e.deltaMode }, board.clientWidth);
    };
    board.addEventListener("wheel", onWheel, { passive: false });
    detach.current = () => board.removeEventListener("wheel", onWheel);
  }, []);
}
