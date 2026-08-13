import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { layoutRect, layoutViewport } from "../lib/viewport";

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

export function useMenuPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  opts?: {
    /**
     * The popup renders its FULL content with no internal scrolling (the
     * DateField calendar). Flip decisions use the content's real height and
     * no maxHeight clamp is applied — the popup must never be clipped.
     */
    fitContent?: boolean;
  },
) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const fitContent = opts?.fitContent ?? false;

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      // layoutRect converts to layout-space px so the fixed portal lands
      // exactly on the anchor even under the global interface zoom.
      const r = anchorRef.current ? layoutRect(anchorRef.current) : null;
      if (!r) return;
      // Viewport in layout px — same coordinate space as layoutRect and the
      // fixed portal, so edge clamping is exact under the interface zoom.
      const { vw, vh } = layoutViewport();
      const left = Math.max(EDGE, Math.min(r.left, vw - r.width - EDGE));
      const below = vh - r.bottom - 4 - EDGE;
      const above = r.top - 4 - EDGE;
      // Open downward whenever space permits: the full menu fits below, OR
      // there's enough room below for a usable (scrollable) menu. Only flip
      // above the anchor when the space below is genuinely cramped AND the
      // space above is meaningfully larger — this keeps every dropdown in the
      // app opening down by default (the direction users expect), including
      // controls that sit low inside modals.
      if (fitContent) {
        // Full-content popup (calendar): never clamp its height — flip above
        // only when the whole popup can't fit below but CAN fit above.
        const contentH = menuRef.current?.scrollHeight ?? MENU_MAX_H;
        if (below >= contentH || above < contentH || below >= above) {
          setPos({ position: "fixed", top: r.bottom + 4, left, width: r.width });
        } else {
          setPos({ position: "fixed", bottom: vh - r.top + 4, left, width: r.width });
        }
        return;
      }
      const MIN_USABLE = 160; // a menu this tall scrolls comfortably
      const fitsBelow = below >= Math.min(MENU_MAX_H, menuRef.current?.scrollHeight ?? MENU_MAX_H);
      if (fitsBelow || below >= MIN_USABLE || below >= above) {
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
