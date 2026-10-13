import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { DateField } from "./DateField";
import { useMenuPosition } from "./dropdownCore";
import { fmtDate } from "../lib/format";
import { rangeDays, rangeIssue, type DayRange } from "../lib/period";

/**
 * Custom reporting-range picker: a popover anchored to a period selector, with
 * From / To DateFields and explicit Cancel / Apply.
 *
 *  - Floats over the page (body-portaled, positioned by the shared dropdown
 *    hook: viewport-clamped, flips above only when it can't fit below), so
 *    opening it never pushes the header or the widgets below it around.
 *  - Edits stay in a local draft. The caller hears about a range only on
 *    Apply, which needs a complete, ordered range — the page never reloads
 *    on a half-picked or mid-typed date. Cancel, Escape and outside clicks
 *    discard the draft; reopening starts from the applied range.
 *  - Enters with the shared menu motion (mselIn) and fades out the same way.
 */

const WIDTH = 320;
/** Matches the drpOut animation in styles/shared.css. */
const EXIT_MS = 120;

const reducedMotion = () => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

export function DateRangePopover({ anchorRef, open, value, onApply, onCancel, ariaLabel = "Custom date range" }: {
  /** The control the popover hangs from (right edges line up). */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  /** The applied range — the draft starts from it each time the popover opens. */
  value: DayRange;
  onApply: (r: DayRange) => void;
  /** Close without applying (Cancel, Escape, a click outside). */
  onCancel: () => void;
  ariaLabel?: string;
}) {
  // Stay mounted through the exit fade.
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  useEffect(() => {
    if (open || !present) return;
    const t = window.setTimeout(() => setPresent(false), reducedMotion() ? 0 : EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open, present]);
  const leaving = present && !open;

  const [draft, setDraft] = useState<DayRange>(value);
  // Each open starts from the applied range (before paint — no stale flash).
  useLayoutEffect(() => { if (open) setDraft(value); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const { menuRef, pos } = useMenuPosition(anchorRef, present, { fitContent: true, width: WIDTH, align: "end" });

  const latest = useRef(onCancel);
  latest.current = onCancel;
  useEffect(() => {
    if (!open) return;
    // The From/To calendars are portaled to <body> as well; picks inside them
    // (or on the anchor, which toggles the popover itself) are not "outside".
    const inside = (t: EventTarget | null) =>
      t instanceof Node && (!!menuRef.current?.contains(t) || !!anchorRef.current?.contains(t)
        || (t instanceof Element && !!t.closest(".msel-menu-portal")));
    const onDown = (e: MouseEvent) => { if (!inside(e.target)) latest.current(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An open calendar takes this Escape (DateField closes it); the next one
      // closes the popover.
      if (document.querySelector(".datef-pop")) return;
      e.stopPropagation();
      latest.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); };
  }, [open, anchorRef, menuRef]);

  // Keyboard focus moves into the popover when it opens (the container, not a
  // field — focusing a DateField would pop its calendar on top straight away)
  // and returns to the opener when it closes from inside.
  const openerRef = useRef<HTMLElement | null>(null);
  const placed = pos != null;
  useEffect(() => {
    const el = menuRef.current;
    if (!open || !placed || !el || el.contains(document.activeElement)) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.focus({ preventScroll: true });
  }, [open, placed, menuRef]);
  useEffect(() => {
    if (open) return;
    const opener = openerRef.current;
    openerRef.current = null;
    const a = document.activeElement;
    if (opener && opener !== document.body && opener.isConnected && (!a || a === document.body || menuRef.current?.contains(a))) {
      opener.focus({ preventScroll: true });
    }
  }, [open, menuRef]);

  if (!present || !pos) return null;

  const issue = rangeIssue(draft);
  const days = rangeDays(draft);
  return createPortal(
    <div ref={menuRef} className={`msel-menu msel-menu-portal drp-pop ${leaving ? "leaving" : ""}`} style={pos}
      role="dialog" aria-label={ariaLabel} tabIndex={-1}>
      <div className="drp-fields">
        <div className="drp-field">
          <span className="drp-label">From</span>
          <DateField value={draft.from} onChange={(from) => setDraft((d) => ({ ...d, from }))} ariaLabel="Range start" placeholder="Start date" />
        </div>
        <div className="drp-field">
          <span className="drp-label">To</span>
          <DateField value={draft.to} onChange={(to) => setDraft((d) => ({ ...d, to }))} ariaLabel="Range end" placeholder="End date" />
        </div>
      </div>
      {/* One fixed-height line (hint → summary → error) so the popover never
          changes size while picking. */}
      <div className={`drp-msg ${issue === "order" || issue === "invalid" ? "error" : ""}`} aria-live="polite">
        {issue === "order" ? "The end date is before the start date."
          : issue === "invalid" ? "Enter dates as mm/dd/yyyy."
          : issue === "incomplete" ? "Choose a start and an end date."
          : `${fmtDate(draft.from)} – ${fmtDate(draft.to)} · ${days} day${days === 1 ? "" : "s"}`}
      </div>
      <div className="drp-foot">
        <button type="button" className="small" onClick={onCancel}>Cancel</button>
        {/* aria-disabled, not disabled: a date typed but not yet committed
            lands on blur — i.e. on this button's mousedown — and a truly
            disabled button would swallow that first click. */}
        <button type="button" className="small primary" aria-disabled={issue != null}
          onClick={() => { if (!rangeIssue(draft)) onApply(draft); }}>Apply</button>
      </div>
    </div>,
    document.body,
  );
}
