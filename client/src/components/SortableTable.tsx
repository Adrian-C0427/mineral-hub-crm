import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

export type SortType = "text" | "number" | "date";

export interface Column<T> {
  key: string;
  header: string;
  /** Primitive used for sorting. Return null for "empty" (sorted last). */
  value: (row: T) => string | number | Date | null | undefined;
  /** Custom cell renderer. Defaults to the stringified value. */
  render?: (row: T) => ReactNode;
  type?: SortType;
  align?: "left" | "right" | "center";
  width?: string;
  /** When true, the column can't be hidden via Customize View (still reorderable). */
  required?: boolean;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Route for the row's destination. Renders the first column as a real <Link>
   *  so cmd/middle-click "open in new tab" works (row click still navigates). */
  rowHref?: (row: T) => string;
  /** Optional default sort (overridden by user clicks). */
  defaultSort?: { key: string; dir: "asc" | "desc" };
  /** Optional grouping comparator applied before user picks a column. */
  defaultCompare?: (a: T, b: T) => number;
  rowClassName?: (row: T) => string | undefined;
  empty?: ReactNode;
  /** Enables a leading checkbox column with select-all for bulk actions. */
  selection?: {
    selected: Set<string>;
    onToggle: (id: string) => void;
    onToggleAll: (ids: string[]) => void;
  };
  /** Turn on the "Customize View" control: a stable id namespaces the saved
   *  column layout (visibility + order) in localStorage, per user + table. */
  customizeId?: string;
}

function compareValues(a: unknown, b: unknown, type: SortType): number {
  const aNull = a == null || a === "";
  const bNull = b == null || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1; // nulls always last
  if (bNull) return -1;
  if (type === "number") return Number(a) - Number(b);
  if (type === "date") return new Date(a as string).getTime() - new Date(b as string).getTime();
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
}

// ---------------------------------------------------------------------------
// Customize View — persisted per-table column layout (order + hidden columns).
// ---------------------------------------------------------------------------

interface ColPrefs { order: string[]; hidden: string[]; widths: Record<string, number> }
const colKey = (id: string) => `mh-cols:v1:${id}`;
function loadColPrefs(id: string): ColPrefs {
  try { const raw = localStorage.getItem(colKey(id)); if (raw) { const p = JSON.parse(raw) as Partial<ColPrefs>; return { order: p.order ?? [], hidden: p.hidden ?? [], widths: p.widths ?? {} }; } } catch { /* ignore */ }
  return { order: [], hidden: [], widths: {} };
}
const MIN_COL_W = 64;

function useColumnPrefs<T>(customizeId: string | undefined, columns: Column<T>[]) {
  const [prefs, setPrefs] = useState<ColPrefs>(() => (customizeId ? loadColPrefs(customizeId) : { order: [], hidden: [], widths: {} }));
  // Reload when the table identity changes (e.g. remounted for another list).
  useEffect(() => { if (customizeId) setPrefs(loadColPrefs(customizeId)); }, [customizeId]);
  useEffect(() => { if (customizeId) { try { localStorage.setItem(colKey(customizeId), JSON.stringify(prefs)); } catch { /* ignore */ } } }, [customizeId, prefs]);

  // Apply the saved order (unknown/new columns keep their natural position at the end).
  const ordered = useMemo(() => {
    if (!customizeId || prefs.order.length === 0) return columns;
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const seen = new Set<string>();
    const out: Column<T>[] = [];
    for (const k of prefs.order) { const c = byKey.get(k); if (c) { out.push(c); seen.add(k); } }
    for (const c of columns) if (!seen.has(c.key)) out.push(c);
    return out;
  }, [columns, prefs.order, customizeId]);

  const hidden = new Set(prefs.hidden);
  const visible = customizeId ? ordered.filter((c) => !hidden.has(c.key)) : columns;

  const toggle = (key: string) => setPrefs((p) => ({ ...p, hidden: p.hidden.includes(key) ? p.hidden.filter((k) => k !== key) : [...p.hidden, key] }));
  const move = (key: string, dir: -1 | 1) => setPrefs((p) => {
    const keys = ordered.map((c) => c.key);
    const i = keys.indexOf(key); const j = i + dir;
    if (i < 0 || j < 0 || j >= keys.length) return p;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    return { ...p, order: keys };
  });
  const setWidth = (key: string, w: number) => setPrefs((p) => ({ ...p, widths: { ...p.widths, [key]: Math.max(MIN_COL_W, Math.round(w)) } }));
  const reset = () => setPrefs({ order: [], hidden: [], widths: {} });
  const isDefault = prefs.order.length === 0 && prefs.hidden.length === 0 && Object.keys(prefs.widths).length === 0;

  return { ordered, visible, hidden, widths: prefs.widths, toggle, move, setWidth, reset, isDefault };
}

function ColumnCustomizer<T>({ ordered, hidden, onToggle, onMove, onReset, isDefault }: {
  ordered: Column<T>[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onMove: (key: string, dir: -1 | 1) => void;
  onReset: () => void;
  isDefault: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Only columns with a header are meaningful to list; empty-header columns
  // (e.g. row actions) always show and aren't listed.
  const listed = ordered.filter((c) => c.header.trim() !== "");

  return (
    <div className="cv-wrap" ref={ref}>
      <button type="button" className={`small cv-btn ${open ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title="Customize columns">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>
        Customize View
      </button>
      {open && (
        <div className="cv-menu" role="dialog" aria-label="Customize columns">
          <div className="cv-head"><strong>Columns</strong><span className="muted" style={{ fontSize: 12 }}>Show, hide &amp; reorder</span></div>
          <div className="cv-list">
            {listed.map((c, i) => {
              const on = !hidden.has(c.key);
              return (
                <div key={c.key} className="cv-row">
                  <label className="cv-check">
                    <input type="checkbox" checked={on} disabled={c.required} onChange={() => onToggle(c.key)} />
                    <span>{c.header}{c.required ? " *" : ""}</span>
                  </label>
                  <span className="cv-move">
                    <button type="button" className="icon-btn" disabled={i === 0} title="Move up" onClick={() => onMove(c.key, -1)}>↑</button>
                    <button type="button" className="icon-btn" disabled={i === listed.length - 1} title="Move down" onClick={() => onMove(c.key, 1)}>↓</button>
                  </span>
                </div>
              );
            })}
          </div>
          <div className="cv-foot">
            <span className="cv-hint">Drag a header edge to resize</span>
            <button type="button" className="small" disabled={isDefault} onClick={onReset}>Restore default</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SortableTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowHref,
  defaultSort,
  defaultCompare,
  rowClassName,
  empty,
  selection,
  customizeId,
}: Props<T>) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(defaultSort ?? null);
  const { ordered, visible, hidden, widths, toggle, move, setWidth, reset, isDefault } = useColumnPrefs(customizeId, columns);
  const cols = visible;

  // Drag a header's right edge to resize the column (Customize View only).
  function startResize(e: React.PointerEvent, key: string) {
    e.preventDefault(); e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest("th");
    const startX = e.clientX;
    const startW = th ? th.getBoundingClientRect().width : 120;
    const onMove = (ev: PointerEvent) => setWidth(key, startW + (ev.clientX - startX));
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const sorted = useMemo(() => {
    const copy = [...rows];
    if (!sort) {
      if (defaultCompare) copy.sort(defaultCompare);
      return copy;
    }
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return copy;
    const type = col.type ?? "text";
    copy.sort((a, b) => {
      const cmp = compareValues(col.value(a), col.value(b), type);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort, columns, defaultCompare]);

  function onHeaderClick(key: string) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return { key, dir: "asc" }; // toggle back to asc on third click
    });
  }

  const table = (
    <div className="table-scroll">
      {/* lead-sticky pins the identifying column(s) while wide tables scroll. */}
      <table className={`data-table lead-sticky${selection ? " has-sel" : ""}`}>
        <thead>
          <tr>
            {selection && (() => {
              const ids = sorted.map(rowKey);
              const allSelected = ids.length > 0 && ids.every((id) => selection.selected.has(id));
              return (
                <th className="center" style={{ width: 36 }}>
                  <input type="checkbox" checked={allSelected} onChange={() => selection.onToggleAll(ids)} aria-label="Select all" />
                </th>
              );
            })()}
            {cols.map((c) => {
              const active = sort?.key === c.key;
              const w = widths[c.key];
              const style = w != null ? { width: w, minWidth: w, maxWidth: w } : (c.width ? { width: c.width } : undefined);
              return (
                <th
                  key={c.key}
                  onClick={() => onHeaderClick(c.key)}
                  className={`sortable ${c.align ?? "left"} ${active ? "active" : ""}`}
                  style={style}
                >
                  <span className="th-inner">
                    {c.header}
                    <span className="sort-ind">{active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </span>
                  {customizeId && (
                    <span
                      className="col-resize"
                      title="Drag to resize"
                      onPointerDown={(e) => startResize(e, c.key)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={cols.length + (selection ? 1 : 0)} className="empty-cell">
                {empty ?? "No records."}
              </td>
            </tr>
          ) : (
            sorted.map((row) => {
              const id = rowKey(row);
              return (
              <tr
                key={id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`${onRowClick ? "clickable" : ""} ${rowClassName?.(row) ?? ""} ${selection?.selected.has(id) ? "row-selected" : ""}`}
              >
                {selection && (
                  <td className="center" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selection.selected.has(id)} onChange={() => selection.onToggle(id)} aria-label="Select row" />
                  </td>
                )}
                {cols.map((c, ci) => {
                  const cell = c.render ? c.render(row) : displayDefault(c.value(row));
                  const w = widths[c.key];
                  return (
                    <td key={c.key} className={c.align ?? "left"} style={w != null ? { width: w, minWidth: w, maxWidth: w } : undefined}>
                      {rowHref && ci === 0
                        ? <Link to={rowHref(row)} className="row-link" onClick={(e) => e.stopPropagation()}>{cell}</Link>
                        : cell}
                    </td>
                  );
                })}
              </tr>
            );})
          )}
        </tbody>
      </table>
    </div>
  );

  if (!customizeId) return table;
  return (
    <div className="cv-table">
      <div className="cv-toolbar">
        <ColumnCustomizer ordered={ordered} hidden={hidden} onToggle={toggle} onMove={move} onReset={reset} isDefault={isDefault} />
      </div>
      {table}
    </div>
  );
}

function displayDefault(v: string | number | Date | null | undefined): ReactNode {
  if (v == null || v === "") return "—";
  if (v instanceof Date) return v.toLocaleDateString();
  return String(v);
}
