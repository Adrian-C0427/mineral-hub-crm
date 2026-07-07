import { useEffect, useMemo, useRef, useState } from "react";

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

/** A searchable, multi-select dropdown with selected items shown as removable chips. */
export function SearchableMultiSelect({ options, value, onChange, placeholder = "Search…", labels }: Props) {
  const show = (v: string) => labels?.[v] ?? v;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) =>
      !value.includes(o) && (q === "" || o.toLowerCase().includes(q) || (labels?.[o]?.toLowerCase().includes(q) ?? false)));
  }, [options, value, query, labels]);

  function add(opt: string) {
    onChange([...value, opt]);
    setQuery("");
  }
  function remove(opt: string) {
    onChange(value.filter((v) => v !== opt));
  }

  return (
    <div className="msel" ref={ref}>
      <div className="msel-box" onClick={() => setOpen(true)}>
        {value.map((v) => (
          <span className="msel-chip" key={v}>
            {show(v)}
            <button type="button" onClick={(e) => { e.stopPropagation(); remove(v); }}>×</button>
          </span>
        ))}
        <input
          className="msel-input"
          value={query}
          placeholder={value.length === 0 ? placeholder : ""}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
      </div>
      {open && (
        <div className="msel-menu">
          {filtered.length === 0 ? (
            <div className="msel-empty">{query ? "No matches" : "All selected"}</div>
          ) : (
            filtered.slice(0, 50).map((o) => (
              <div className="msel-opt" key={o} onClick={() => add(o)}>{show(o)}</div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
