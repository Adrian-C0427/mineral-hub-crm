import { useEffect, useRef, useState } from "react";
import type { UserLite } from "../types";

/**
 * Multi-select for assigning team members to a record (deals, assets, and bulk
 * actions). Selected users show as removable chips; a searchable dropdown adds
 * more. Works on user ids so duplicate display names never collide.
 */
export function AssigneePicker({ users, value, onChange, placeholder = "Assign team members…" }: {
  users: UserLite[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const byId = new Map(users.map((u) => [u.id, u]));
  const q = query.trim().toLowerCase();
  const options = users.filter((u) => !value.includes(u.id) && (q === "" || u.name.toLowerCase().includes(q)));

  return (
    <div className="msel" ref={ref}>
      <div className="msel-box" onClick={() => setOpen(true)}>
        {value.map((id) => (
          <span className="msel-chip" key={id}>
            {byId.get(id)?.name ?? "Unknown"}
            <button type="button" onClick={(e) => { e.stopPropagation(); onChange(value.filter((v) => v !== id)); }}>×</button>
          </span>
        ))}
        <input
          className="msel-input"
          value={query}
          placeholder={value.length === 0 ? placeholder : ""}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocusCapture={() => setOpen(true)}
          onFocus={() => setOpen(true)}
        />
      </div>
      {open && (
        <div className="msel-menu">
          {options.length === 0 ? (
            <div className="msel-empty">{q ? "No matches" : "Everyone assigned"}</div>
          ) : (
            options.slice(0, 50).map((u) => (
              <div className="msel-opt" key={u.id} onClick={() => { onChange([...value, u.id]); setQuery(""); }}>{u.name}</div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
