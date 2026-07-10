import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Caret, scrollActiveIntoView, useDismiss, useMenuPosition } from "./dropdownCore";

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
 * The application's standard SINGLE-select control. Shares the `.msel` design
 * system and the dropdownCore internals with SearchableMultiSelect, so single-
 * and multi-select fields look and behave identically everywhere. Fully
 * keyboard-operable: Enter/Space/ArrowDown open; arrows + Home/End move the
 * active option; Enter picks; Escape closes (menu only — never a parent
 * dialog); printable characters type-ahead when the list isn't searchable.
 */
export function Select({
  options, value, onChange, placeholder = "Select…", disabled,
  searchable = false, clearable = false, width, ariaLabel, id,
}: Props) {
  const opts = useMemo(() => options.map(toOpt), [options]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typeahead = useRef({ buf: "", at: 0 });

  const { menuRef, pos } = useMenuPosition(ref, open);
  const close = () => { setOpen(false); setQuery(""); setActive(-1); };
  useDismiss([ref, menuRef], open, () => { close(); boxRef.current?.focus(); });

  const selected = opts.find((o) => o.value === value) ?? null;

  useEffect(() => { if (open && searchable) inputRef.current?.focus(); }, [open, searchable]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return opts;
    return opts.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [opts, query]);

  // Reset the active row whenever the visible list changes.
  useEffect(() => {
    if (!open) return;
    const idx = filtered.findIndex((o) => o.value === value);
    setActive(idx >= 0 ? idx : filtered.length ? 0 : -1);
  }, [open, filtered, value]);

  useEffect(() => { if (open) scrollActiveIntoView(menuRef.current, active); }, [open, active, menuRef]);

  function pick(v: string) { onChange(v); close(); boxRef.current?.focus(); }

  function move(delta: number) {
    if (!filtered.length) return;
    setActive((a) => (a + delta + filtered.length) % filtered.length);
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); }
      return;
    }
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(1); break;
      case "ArrowUp": e.preventDefault(); move(-1); break;
      case "Home": e.preventDefault(); setActive(filtered.length ? 0 : -1); break;
      case "End": e.preventDefault(); setActive(filtered.length - 1); break;
      case "Enter": e.preventDefault(); if (active >= 0 && filtered[active]) pick(filtered[active].value); break;
      case "Tab": close(); break;
      default: {
        // Type-ahead for plain lists (searchable lists get the real input).
        if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now();
          const t = typeahead.current;
          t.buf = now - t.at > 700 ? e.key : t.buf + e.key;
          t.at = now;
          const q = t.buf.toLowerCase();
          const idx = opts.findIndex((o) => o.label.toLowerCase().startsWith(q));
          if (idx >= 0) setActive(idx);
        }
      }
    }
  }

  return (
    <div className={`msel msel-single ${disabled ? "is-disabled" : ""}`} ref={ref} style={width != null ? { width } : undefined}>
      <div
        className={`msel-box ${open ? "open" : ""}`}
        ref={boxRef}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} tabIndex={disabled ? -1 : 0}
        aria-activedescendant={open && active >= 0 && filtered[active] ? `${id ?? "msel"}-opt-${filtered[active].value}` : undefined}
        id={id}
        onClick={() => !disabled && (open ? close() : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={`msel-single-value ${selected ? "" : "placeholder"}`}>
          {selected ? selected.label : placeholder}
        </span>
        {clearable && selected && !disabled && (
          <button type="button" className="msel-clear" aria-label="Clear" onClick={(e) => { e.stopPropagation(); pick(""); }}>×</button>
        )}
        <Caret open={open} />
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
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
                else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
                else if (e.key === "Enter") { e.preventDefault(); if (active >= 0 && filtered[active]) pick(filtered[active].value); }
              }}
            />
          )}
          {filtered.length === 0 ? (
            <div className="msel-empty">No matches</div>
          ) : (
            filtered.map((o, i) => (
              <div
                key={o.value}
                id={`${id ?? "msel"}-opt-${o.value}`}
                role="option" aria-selected={o.value === value}
                className={`msel-opt ${o.value === value ? "selected" : ""} ${i === active ? "active" : ""}`}
                onMouseEnter={() => setActive(i)}
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
