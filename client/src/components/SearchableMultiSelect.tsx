import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Caret, scrollActiveIntoView, useDismiss, useMenuPosition } from "./dropdownCore";

interface Props {
  options: readonly string[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Optional display labels keyed by option value (e.g. TX → "Texas (TX)").
   *  Search matches BOTH the stored value and the label, so typing "Texas"
   *  finds TX and typing "royalty" finds RI. Stored values never change. */
  labels?: Record<string, string>;
}

/**
 * The application's standard MULTI-select control: searchable, with selected
 * items as removable chips. Shares the `.msel` design system and dropdownCore
 * internals with Select — same portaled menu (never clipped by tables or
 * modals), same chevron, same keyboard model: arrows move the active option,
 * Enter adds it, Backspace on an empty query removes the last chip, Escape
 * closes the menu only.
 */
export function SearchableMultiSelect({ options, value, onChange, placeholder = "Search…", labels }: Props) {
  const show = (v: string) => labels?.[v] ?? v;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { menuRef, pos } = useMenuPosition(ref, open);
  const close = () => { setOpen(false); setQuery(""); setActive(-1); };
  useDismiss([ref, menuRef], open, close);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) =>
      !value.includes(o) && (q === "" || o.toLowerCase().includes(q) || (labels?.[o]?.toLowerCase().includes(q) ?? false)));
  }, [options, value, query, labels]);

  const shown = filtered.slice(0, 50);

  useEffect(() => {
    if (!open) return;
    setActive(shown.length ? 0 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, value.length]);

  useEffect(() => { if (open) scrollActiveIntoView(menuRef.current, active); }, [open, active, menuRef]);

  function add(opt: string) {
    onChange([...value, opt]);
    setQuery("");
    inputRef.current?.focus();
  }
  function remove(opt: string) {
    onChange(value.filter((v) => v !== opt));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!open) setOpen(true); else if (shown.length) setActive((a) => (a + 1) % shown.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (shown.length) setActive((a) => (a - 1 + shown.length) % shown.length); }
    else if (e.key === "Enter") { e.preventDefault(); if (open && active >= 0 && shown[active]) add(shown[active]); }
    else if (e.key === "Backspace" && query === "" && value.length) { remove(value[value.length - 1]); }
    else if (e.key === "Tab") { close(); }
  }

  return (
    <div className="msel" ref={ref}>
      <div className={`msel-box ${open ? "open" : ""}`} onClick={() => { setOpen(true); inputRef.current?.focus(); }}>
        {value.map((v) => (
          <span className="msel-chip" key={v}>
            {show(v)}
            <button type="button" aria-label={`Remove ${show(v)}`} onClick={(e) => { e.stopPropagation(); remove(v); }}>×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="msel-input"
          role="combobox" aria-expanded={open} aria-haspopup="listbox"
          value={query}
          placeholder={value.length === 0 ? placeholder : ""}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <Caret open={open} />
      </div>
      {open && pos && createPortal(
        <div
          className="msel-menu msel-menu-portal" role="listbox" ref={menuRef}
          style={pos}
        >
          {/* Bulk row: select everything that matches the current search, or
              clear the whole selection in one click — no unchecking one by one. */}
          {(filtered.length > 1 || value.length > 1) && (
            <div className="msel-bulk">
              {filtered.length > 1 && (
                <button type="button" onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onChange([...value, ...filtered]); setQuery(""); inputRef.current?.focus(); }}>
                  Select all{query ? " matching" : ""} ({filtered.length})
                </button>
              )}
              {value.length > 1 && (
                <button type="button" onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onChange([]); inputRef.current?.focus(); }}>
                  Deselect all
                </button>
              )}
            </div>
          )}
          {shown.length === 0 ? (
            <div className="msel-empty">{query ? "No matches" : "All selected"}</div>
          ) : (
            shown.map((o, i) => (
              <div
                className={`msel-opt ${i === active ? "active" : ""}`}
                role="option" aria-selected={false}
                key={o}
                onMouseEnter={() => setActive(i)}
                onClick={() => add(o)}
              >
                {show(o)}
              </div>
            ))
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
