import { fmtDate } from "../lib/format";
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

interface ColPrefs { order: string[]; hidden: string[]; widths: Record<string, number>; pinned: string[] }
const colKey = (id: string) => `mh-cols:v1:${id}`;
function loadColPrefs(id: string): ColPrefs {
  try { const raw = localStorage.getItem(colKey(id)); if (raw) { const p = JSON.parse(raw) as Partial<ColPrefs>; return { order: p.order ?? [], hidden: p.hidden ?? [], widths: p.widths ?? {}, pinned: p.pinned ?? [] }; } } catch { /* ignore */ }
  return { order: [], hidden: [], widths: {}, pinned: [] };
}
const MIN_COL_W = 64;
// Pinned columns get a fixed width so their sticky left-offsets are exact.
const PIN_DEFAULT_W = 160;

function useColumnPrefs<T>(customizeId: string | undefined, columns: Column<T>[]) {
  const [prefs, setPrefs] = useState<ColPrefs>(() => (customizeId ? loadColPrefs(customizeId) : { order: [], hidden: [], widths: {}, pinned: [] }));
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
  const orderedVisible = customizeId ? ordered.filter((c) => !hidden.has(c.key)) : columns;
  // Pinned (visible) columns render first, in pin order; the rest follow.
  const pinnedKeys = customizeId ? prefs.pinned.filter((k) => orderedVisible.some((c) => c.key === k)) : [];
  const pinnedSet = new Set(pinnedKeys);
  const visible = pinnedKeys.length
    ? [...pinnedKeys.map((k) => orderedVisible.find((c) => c.key === k)!).filter(Boolean), ...orderedVisible.filter((c) => !pinnedSet.has(c.key))]
    : orderedVisible;

  const toggle = (key: string) => setPrefs((p) => ({ ...p, hidden: p.hidden.includes(key) ? p.hidden.filter((k) => k !== key) : [...p.hidden, key] }));
  // Drag-and-drop reorder: move `fromKey` to `toKey`'s position within the full
  // column order (hidden columns keep their relative slots).
  const reorder = (fromKey: string, toKey: string) => setPrefs((p) => {
    const keys = ordered.map((c) => c.key);
    const fi = keys.indexOf(fromKey), ti = keys.indexOf(toKey);
    if (fi < 0 || ti < 0 || fi === ti) return p;
    keys.splice(fi, 1);
    keys.splice(ti, 0, fromKey);
    return { ...p, order: keys };
  });
  const setWidth = (key: string, w: number) => setPrefs((p) => ({ ...p, widths: { ...p.widths, [key]: Math.max(MIN_COL_W, Math.round(w)) } }));
  const togglePin = (key: string) => setPrefs((p) => {
    if (p.pinned.includes(key)) return { ...p, pinned: p.pinned.filter((k) => k !== key) };
    // Pin: give the column a fixed width (if none yet) so sticky offsets are exact.
    return { ...p, pinned: [...p.pinned, key], widths: p.widths[key] != null ? p.widths : { ...p.widths, [key]: PIN_DEFAULT_W } };
  });
  const reset = () => setPrefs({ order: [], hidden: [], widths: {}, pinned: [] });
  const isDefault = prefs.order.length === 0 && prefs.hidden.length === 0 && Object.keys(prefs.widths).length === 0 && prefs.pinned.length === 0;

  return { ordered, visible, hidden, widths: prefs.widths, pinnedKeys, pinnedSet, toggle, reorder, setWidth, togglePin, reset, isDefault };
}

function ColumnCustomizer<T>({ ordered, hidden, pinnedSet, onToggle, onReorder, onPin, onReset, isDefault }: {
  ordered: Column<T>[];
  hidden: Set<string>;
  pinnedSet: Set<string>;
  onToggle: (key: string) => void;
  onReorder: (fromKey: string, toKey: string) => void;
  onPin: (key: string) => void;
  onReset: () => void;
  isDefault: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Drag-and-drop reorder state: the column being dragged and the current target.
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
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
          <div className="cv-head"><strong>Columns</strong><span className="muted" style={{ fontSize: 12 }}>Show, hide, pin &amp; reorder</span></div>
          <div className="cv-list">
            {listed.map((c) => {
              const on = !hidden.has(c.key);
              const pinned = pinnedSet.has(c.key);
              return (
                <div key={c.key}
                  className={`cv-row ${dragKey === c.key ? "dragging" : ""} ${overKey === c.key && dragKey && dragKey !== c.key ? "drop-over" : ""}`}
                  onDragOver={(e) => { if (!dragKey) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overKey !== c.key) setOverKey(c.key); }}
                  onDrop={(e) => { e.preventDefault(); if (dragKey) onReorder(dragKey, c.key); setDragKey(null); setOverKey(null); }}
                >
                  {/* Only the handle is draggable, so the checkbox stays clickable. */}
                  <span className="cv-drag" title="Drag to reorder" aria-label="Drag to reorder" draggable
                    onDragStart={(e) => { setDragKey(c.key); e.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => { setDragKey(null); setOverKey(null); }}>⠿</span>
                  <label className="cv-check">
                    <input type="checkbox" checked={on} disabled={c.required} onChange={() => onToggle(c.key)} />
                    <span>{c.header}{c.required ? " *" : ""}</span>
                  </label>
                  <span className="cv-move">
                    <button type="button" className={`icon-btn ${pinned ? "on" : ""}`} title={pinned ? "Unpin column" : "Pin column to the left"} aria-pressed={pinned} onClick={() => onPin(c.key)}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><path d="M12 17v5" /><path d="M9 10.76V4a1 1 0 011-1h4a1 1 0 011 1v6.76a2 2 0 00.55 1.38l1.9 1.9A1 1 0 0117.65 17H6.35a1 1 0 01-.7-1.96l1.9-1.9A2 2 0 009 10.76z" /></svg>
                    </button>
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
  const { ordered, visible, hidden, widths, pinnedKeys, pinnedSet, toggle, reorder, setWidth, togglePin, reset, isDefault } = useColumnPrefs(customizeId, columns);
  const cols = visible;

  // Cumulative left offsets for user-pinned columns (they render first). Their
  // widths are fixed on pin, so the offsets are exact. When any column is pinned
  // we drive stickiness explicitly instead of the default lead-sticky CSS.
  const hasPins = pinnedKeys.length > 0;
  const selW = selection ? 44 : 0;
  const pinLeft: Record<string, number> = {};
  {
    let acc = selW;
    for (const key of pinnedKeys) { pinLeft[key] = acc; acc += widths[key] ?? PIN_DEFAULT_W; }
  }
  const pinStyle = (key: string, head: boolean): React.CSSProperties | undefined =>
    pinnedSet.has(key) ? { position: "sticky", left: pinLeft[key], zIndex: head ? 4 : 3, background: head ? "var(--panel-2)" : "var(--panel)" } : undefined;

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
      {/* lead-sticky pins the identifying column while wide tables scroll; when
          the user pins columns explicitly, we drive stickiness inline instead. */}
      <table className={`data-table${hasPins ? "" : " lead-sticky"}${selection ? " has-sel" : ""}`}>
        <thead>
          <tr>
            {selection && (() => {
              const ids = sorted.map(rowKey);
              const allSelected = ids.length > 0 && ids.every((id) => selection.selected.has(id));
              return (
                <th className="center" style={{ width: 36, ...(hasPins ? { position: "sticky", left: 0, zIndex: 4, background: "var(--panel-2)" } : {}) }}>
                  <input type="checkbox" checked={allSelected} onChange={() => selection.onToggleAll(ids)} aria-label="Select all" />
                </th>
              );
            })()}
            {cols.map((c) => {
              const active = sort?.key === c.key;
              const w = widths[c.key];
              const wStyle = w != null ? { width: w, minWidth: w, maxWidth: w } : (c.width ? { width: c.width } : undefined);
              const pinned = pinnedSet.has(c.key);
              return (
                <th
                  key={c.key}
                  onClick={() => onHeaderClick(c.key)}
                  className={`sortable ${c.align ?? "left"} ${active ? "active" : ""} ${pinned ? "cv-pin" : ""} ${pinned && c.key === pinnedKeys[pinnedKeys.length - 1] ? "cv-pin-last" : ""}`}
                  style={{ ...wStyle, ...pinStyle(c.key, true) }}
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
                  <td className="center" onClick={(e) => e.stopPropagation()} style={hasPins ? { position: "sticky", left: 0, zIndex: 3, background: "var(--panel)" } : undefined}>
                    <input type="checkbox" checked={selection.selected.has(id)} onChange={() => selection.onToggle(id)} aria-label="Select row" />
                  </td>
                )}
                {cols.map((c, ci) => {
                  const cell = c.render ? c.render(row) : displayDefault(c.value(row));
                  const w = widths[c.key];
                  const wStyle = w != null ? { width: w, minWidth: w, maxWidth: w } : undefined;
                  const pinned = pinnedSet.has(c.key);
                  return (
                    <td key={c.key} className={`${c.align ?? "left"} ${pinned ? "cv-pin" : ""} ${pinned && c.key === pinnedKeys[pinnedKeys.length - 1] ? "cv-pin-last" : ""}`} style={{ ...wStyle, ...pinStyle(c.key, false) }}>
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
        <ColumnCustomizer ordered={ordered} hidden={hidden} pinnedSet={pinnedSet} onToggle={toggle} onReorder={reorder} onPin={togglePin} onReset={reset} isDefault={isDefault} />
      </div>
      {table}
    </div>
  );
}

function displayDefault(v: string | number | Date | null | undefined): ReactNode {
  if (v == null || v === "") return "—";
  if (v instanceof Date) return fmtDate(v);
  return String(v);
}
