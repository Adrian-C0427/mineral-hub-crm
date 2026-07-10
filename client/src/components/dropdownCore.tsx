import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Shared internals for the app's ONE dropdown family (Select +
 * SearchableMultiSelect). Both controls get identical behavior from here:
 *
 *  - a body-portaled, fixed-position menu that escapes overflow containers
 *    (tables, modals) and repositions on scroll/resize instead of closing;
 *    scrolling INSIDE the menu never moves it
 *  - outside-click closes
 *  - Escape closes the MENU ONLY: handled in the capture phase and stopped,
 *    so an enclosing Modal (which also listens for Escape) stays open
 *  - the same chevron affordance, rotating while open
 */

export function useMenuPosition(anchorRef: RefObject<HTMLElement | null>, open: boolean) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width });
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
