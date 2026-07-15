import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useDismiss, useMenuPosition } from "./dropdownCore";

/**
 * The application's standard DATE control, replacing raw <input type="date">
 * everywhere. Same contract as the native input — `value` is "YYYY-MM-DD" or
 * "" — but the popup calendar supports fast long-range navigation: click the
 * title to zoom out to a month grid, click again for a year grid, so any date
 * is reachable in a few clicks instead of arrowing month by month.
 *
 * All date math is plain string/UTC arithmetic — no local-time Date parsing —
 * so the selected day never shifts across timezones (see the fmtDate lesson).
 */

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** "YYYY-MM-DD" → [y, monthIndex, d] or null. */
function parseIso(v: string): [number, number, number] | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  return [y, mo, d];
}

/** Lenient typed-text parse: MM/DD/YYYY, M-D-YY, or YYYY-MM-DD. */
function parseTyped(text: string): string | null {
  const t = text.trim();
  if (t === "") return "";
  if (parseIso(t)) return t;
  const m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  const mo = Number(m[1]) - 1, d = Number(m[2]);
  if (mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo)) return null;
  return iso(y, mo, d);
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const firstDow = (y: number, m: number) => new Date(Date.UTC(y, m, 1)).getUTCDay();

function fmtDisplay(v: string): string {
  const p = parseIso(v);
  return p ? `${pad(p[1] + 1)}/${pad(p[2])}/${p[0]}` : "";
}

function todayIso(): string {
  const n = new Date();
  return iso(n.getFullYear(), n.getMonth(), n.getDate());
}

interface Props {
  /** "YYYY-MM-DD" or "" — identical to the native input contract. */
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  placeholder?: string;
}

type View = "days" | "months" | "years";

export function DateField({ value, onChange, ariaLabel, disabled, placeholder = "mm/dd/yyyy" }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("days");
  const [text, setText] = useState(fmtDisplay(value));
  const parsed = parseIso(value);
  const now = new Date();
  const [vy, setVy] = useState(parsed ? parsed[0] : now.getFullYear());
  const [vm, setVm] = useState(parsed ? parsed[1] : now.getMonth());
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { menuRef, pos } = useMenuPosition(ref, open);

  // Keep the typed text and the visible month in sync with outside changes.
  useEffect(() => { setText(fmtDisplay(value)); }, [value]);
  useEffect(() => {
    if (!open) return;
    const p = parseIso(value);
    setVy(p ? p[0] : now.getFullYear());
    setVm(p ? p[1] : now.getMonth());
    setView("days");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => setOpen(false);
  useDismiss([ref, menuRef], open, close);

  function commitText() {
    const p = parseTyped(text);
    if (p === null) { setText(fmtDisplay(value)); return; } // invalid → revert
    if (p !== value) onChange(p);
    else setText(fmtDisplay(value));
  }
  function pick(y: number, m: number, d: number) {
    onChange(iso(y, m, d));
    close();
  }
  function shiftMonth(delta: number) {
    const t = vy * 12 + vm + delta;
    setVy(Math.floor(t / 12)); setVm(((t % 12) + 12) % 12);
  }

  // Calendar cells: leading blanks + days of the visible month.
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow(vy, vm) }, () => null),
    ...Array.from({ length: daysInMonth(vy, vm) }, (_, i) => i + 1),
  ];
  const today = todayIso();
  const yearsBase = Math.floor(vy / 12) * 12;

  const popupStyle = pos
    ? { ...pos, width: 268, left: Math.max(8, Math.min(Number(pos.left ?? 8), document.documentElement.clientWidth - 276)), maxHeight: undefined }
    : undefined;

  return (
    <div className={`msel msel-single datef ${disabled ? "is-disabled" : ""}`} ref={ref}>
      <div className={`msel-box ${open ? "open" : ""}`} onClick={() => { if (!disabled) { setOpen(true); inputRef.current?.focus(); } }}>
        <input
          ref={inputRef}
          className="datef-input"
          value={text}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => !disabled && setOpen(true)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitText(); close(); }
            else if (e.key === "Tab") close();
            else if (e.key === "ArrowDown" && !open) setOpen(true);
          }}
        />
        {value && !disabled && (
          <button type="button" className="msel-clear" aria-label="Clear date" tabIndex={-1}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onChange(""); setText(""); }}>×</button>
        )}
        <CalendarDays size={15} className="datef-icon" aria-hidden strokeWidth={2} />
      </div>
      {open && !disabled && pos && createPortal(
        <div className="msel-menu msel-menu-portal datef-pop" ref={menuRef} style={popupStyle} role="dialog" aria-label="Choose date"
          onMouseDown={(e) => e.preventDefault() /* keep focus in the text input */}>
          <div className="datef-head">
            <button type="button" className="datef-nav" aria-label={view === "years" ? "Previous years" : view === "months" ? "Previous year" : "Previous month"}
              onClick={() => (view === "days" ? shiftMonth(-1) : view === "months" ? setVy((y) => y - 1) : setVy((y) => y - 12))}>
              <ChevronLeft size={15} />
            </button>
            <button type="button" className="datef-title"
              title={view === "days" ? "Choose month" : view === "months" ? "Choose year" : undefined}
              onClick={() => setView(view === "days" ? "months" : "years")}>
              {view === "days" ? `${MONTHS[vm]} ${vy}` : view === "months" ? String(vy) : `${yearsBase}–${yearsBase + 11}`}
            </button>
            <button type="button" className="datef-nav" aria-label={view === "years" ? "Next years" : view === "months" ? "Next year" : "Next month"}
              onClick={() => (view === "days" ? shiftMonth(1) : view === "months" ? setVy((y) => y + 1) : setVy((y) => y + 12))}>
              <ChevronRight size={15} />
            </button>
          </div>

          {view === "days" && (
            <>
              <div className="datef-grid datef-dow">{DOW.map((d) => <span key={d}>{d}</span>)}</div>
              <div className="datef-grid">
                {cells.map((d, i) => d === null
                  ? <span key={`b${i}`} />
                  : (
                    <button type="button" key={d}
                      className={`datef-day ${iso(vy, vm, d) === value ? "selected" : ""} ${iso(vy, vm, d) === today ? "today" : ""}`}
                      onClick={() => pick(vy, vm, d)}>{d}</button>
                  ))}
              </div>
            </>
          )}
          {view === "months" && (
            <div className="datef-grid datef-grid-4">
              {MONTHS_SHORT.map((m, i) => (
                <button type="button" key={m} className={`datef-cell ${parsed && parsed[0] === vy && parsed[1] === i ? "selected" : ""}`}
                  onClick={() => { setVm(i); setView("days"); }}>{m}</button>
              ))}
            </div>
          )}
          {view === "years" && (
            <div className="datef-grid datef-grid-4">
              {Array.from({ length: 12 }, (_, i) => yearsBase + i).map((y) => (
                <button type="button" key={y} className={`datef-cell ${parsed && parsed[0] === y ? "selected" : ""}`}
                  onClick={() => { setVy(y); setView("months"); }}>{y}</button>
              ))}
            </div>
          )}

          <div className="datef-foot">
            <button type="button" className="datef-link" onClick={() => { const t = todayIso(); const p = parseIso(t)!; setVy(p[0]); setVm(p[1]); onChange(t); close(); }}>Today</button>
            {value && <button type="button" className="datef-link" onClick={() => { onChange(""); close(); }}>Clear</button>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
