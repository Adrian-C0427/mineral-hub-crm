import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional muted sub-label shown to the right of the option. */
  hint?: string;
}

interface Props {
  options: readonly SelectOption[] | readonly string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Show a type-to-filter input in the dropdown (for long option lists). */
  searchable?: boolean;
  /** Allow clearing back to "" via an inline ✕ (adds a "— none —" affordance). */
  clearable?: boolean;
  /** Constrain the control width (defaults to filling its container). */
  width?: number | string;
  ariaLabel?: string;
  id?: string;
}

const toOpt = (o: SelectOption | string): SelectOption => (typeof o === "string" ? { value: o, label: o } : o);

/**
 * The application's standard SINGLE-select control. Shares the exact `.msel`
 * styling, sizing, dropdown, hover/focus/disabled states, and open/close
 * animation with SearchableMultiSelect, so single- and multi-select fields
 * look and behave identically everywhere. Replaces native <select> usage.
 */
export function Select({
  options, value, onChange, placeholder = "Select…", disabled,
  searchable = false, clearable = false, width, ariaLabel, id,
}: Props) {
  const opts = useMemo(() => options.map(toOpt), [options]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The menu is portaled to <body> with fixed coords so it escapes any
  // overflow/scroll container (e.g. a table) that would otherwise clip it.
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const selected = opts.find((o) => o.value === value) ?? null;

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false); setQuery("");
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") { setOpen(false); setQuery(""); } }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, []);

  // Position the portaled menu under the control, and keep it attached as the
  // page (or an ancestor) scrolls by repositioning rather than closing.
  // Crucially, scrolling *inside* the menu — spinning the wheel/trackpad through
  // a long option list — must NOT move or close it, so scroll events originating
  // within the menu are ignored. The menu closes only on selection or an outside
  // click (handled above), matching every other dropdown in the app.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
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
  }, [open]);

  useEffect(() => { if (open && searchable) inputRef.current?.focus(); }, [open, searchable]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return opts;
    return opts.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [opts, query]);

  function pick(v: string) { onChange(v); setOpen(false); setQuery(""); }

  return (
    <div className={`msel msel-single ${disabled ? "is-disabled" : ""}`} ref={ref} style={width != null ? { width } : undefined}>
      <div
        className="msel-box"
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} tabIndex={disabled ? -1 : 0}
        id={id}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={(e) => { if (!disabled && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) { e.preventDefault(); setOpen(true); } }}
      >
        <span className={`msel-single-value ${selected ? "" : "placeholder"}`}>
          {selected ? selected.label : placeholder}
        </span>
        {clearable && selected && !disabled && (
          <button type="button" className="msel-clear" aria-label="Clear" onClick={(e) => { e.stopPropagation(); pick(""); }}>×</button>
        )}
        <span className="msel-caret" aria-hidden>▾</span>
      </div>
      {open && !disabled && pos && createPortal(
        <div
          className="msel-menu msel-menu-portal" role="listbox" ref={menuRef}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
        >
          {searchable && (
            <input
              ref={inputRef}
              className="msel-search"
              value={query}
              placeholder="Search…"
              onChange={(e) => setQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          {filtered.length === 0 ? (
            <div className="msel-empty">No matches</div>
          ) : (
            filtered.map((o) => (
              <div
                key={o.value}
                role="option" aria-selected={o.value === value}
                className={`msel-opt ${o.value === value ? "selected" : ""}`}
                onClick={() => pick(o.value)}
              >
                <span>{o.label}</span>
                {o.hint && <span className="msel-opt-hint">{o.hint}</span>}
                {o.value === value && (
                  <svg className="msel-opt-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                )}
              </div>
            ))
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
