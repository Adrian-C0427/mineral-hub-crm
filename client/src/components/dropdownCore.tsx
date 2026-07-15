import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Shared internals for the app's ONE dropdown family (Select +
 * SearchableMultiSelect). Both controls get identical behavior from here:
 *
 *  - a body-portaled, fixed-position menu that escapes overflow containers
 *    (tables, modals) and repositions on scroll/resize instead of closing;
 *    scrolling INSIDE the menu never moves it
 *  - the menu always opens fully inside the viewport: it flips upward when
 *    the anchor sits near the bottom, hugs the anchor when flipped (anchored
 *    by `bottom`), clamps its height to the available space, and never
 *    overhangs the right edge
 *  - outside-click closes
 *  - Escape closes the MENU ONLY: handled in the capture phase and stopped,
 *    so an enclosing Modal (which also listens for Escape) stays open
 *  - the same chevron affordance, rotating while open
 */

/** Matches .msel-menu's max-height so flip decisions agree with rendering. */
const MENU_MAX_H = 240;
const EDGE = 8; // minimum breathing room from viewport edges

export function useMenuPosition(anchorRef: RefObject<HTMLElement | null>, open: boolean) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      // documentElement.clientWidth/Height = the CSS viewport, which stays
      // correct inside embedded/zoomed contexts where window.inner* can lie.
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      const left = Math.max(EDGE, Math.min(r.left, vw - r.width - EDGE));
      const below = vh - r.bottom - 4 - EDGE;
      const above = r.top - 4 - EDGE;
      // Open downward whenever the full menu fits (or there's simply more room
      // below); otherwise flip above the anchor, anchored by `bottom` so a
      // short menu still hugs the control instead of floating mid-screen.
      if (below >= Math.min(MENU_MAX_H, menuRef.current?.scrollHeight ?? MENU_MAX_H) || below >= above) {
        setPos({ position: "fixed", top: r.bottom + 4, left, width: r.width, maxHeight: Math.max(80, Math.min(MENU_MAX_H, below)) });
      } else {
        setPos({ position: "fixed", bottom: vh - r.top + 4, left, width: r.width, maxHeight: Math.max(80, Math.min(MENU_MAX_H, above)) });
      }
    };
    place();
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", onScroll, true); };
  }, [open, anchorRef]);

  return { menuRef, pos };
}

export function useDismiss(
  refs: RefObject<HTMLElement | null>[],
  open: boolean,
  close: () => void,
) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      latest.current();
    };
    // Capture phase + stopPropagation: Escape closes just this menu, never a
    // parent dialog in the same keypress.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      latest.current();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

export function Caret({ open }: { open: boolean }) {
  return <ChevronDown size={15} className={`msel-caret ${open ? "open" : ""}`} aria-hidden strokeWidth={2.2} />;
}

/** Keep the active option visible while arrowing through a long menu. */
export function scrollActiveIntoView(menu: HTMLElement | null, index: number) {
  if (!menu) return;
  const el = menu.querySelectorAll<HTMLElement>('[role="option"]')[index];
  el?.scrollIntoView({ block: "nearest" });
}
