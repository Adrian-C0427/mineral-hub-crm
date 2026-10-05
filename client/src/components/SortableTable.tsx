import { fmtDate } from "../lib/format";
import { useAuth } from "../auth/AuthContext";
import { loadProfileTablePrefs, saveProfileTablePrefs } from "../lib/tablePrefs";
import { Select } from "./Select";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  /** Floor for the column's width when the user hasn't set one — protects
   *  identifying columns (names) from being crushed by wide tables. */
  minWidth?: number;
  /** When true, the column can't be hidden via Customize View (still reorderable). */
  required?: boolean;
  /** Hidden until the user enables it via Customize View. Keeps the default
   *  view scannable while every column stays one click away. */
  defaultHidden?: boolean;
  /** Added after users may already have saved a layout for this table: a
   *  browser layout saved before `known` was tracked never saw it. */
  newlyAdded?: boolean;
  /** Was hidden by default in an earlier version. A browser layout hiding
   *  exactly those columns held the old defaults — not a user choice — so it
   *  is treated as never customized (the current defaults apply). */
  legacyDefaultHidden?: boolean;
  /** This column's cell in the totals row (see `totalsLabel`), computed over
   *  every row the table holds — not just the visible page. */
  total?: (rows: T[]) => ReactNode;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  /** Adds a totals row under the last row: this label sits in the first
   *  visible column that has no `total`, and each column with one shows it. */
  totalsLabel?: (rows: T[]) => ReactNode;
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
  /** Filters/search rendered on the SAME row as Customize View — no more
   *  dedicated row with dead space for one right-aligned button. */
  toolbar?: ReactNode;
  /** Rendered between the toolbar row and the table — e.g. an expandable
   *  filter strip that must sit under the toolbar but above the columns. */
  subToolbar?: ReactNode;
  /** Enables client-side pagination with a compact rows-per-page selector.
   *  Pass the selectable page sizes (e.g. [20, 50, 100, 200]); rows are sorted
   *  across the full set FIRST, then the current page is sliced for display, so
   *  sorting is never limited to one page. Omit to render every row (no footer). */
  rowsPerPage?: number[];
  /** Default page size when pagination is on (defaults to 50, or the first
   *  option if 50 isn't offered). */
  defaultPageSize?: number;
  /** Sorting runs on the SERVER across the whole filtered dataset — `rows` is
   *  one already-sorted page. Header clicks report the next sort through
   *  `onSort` (the caller re-queries) instead of sorting the page locally,
   *  so ordering is never limited to the rows currently in the browser. */
  serverSort?: {
    sort: { key: string; dir: "asc" | "desc" } | null;
    onSort: (s: { key: string; dir: "asc" | "desc" }) => void;
  };
  /** Singular noun for the footer count ("deal" → "12 deals"). */
  paginationNoun?: string;
  /** Extra content appended to the footer count (e.g. "· $1.2M total value"). */
  footerExtra?: ReactNode;
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
// Customize View — per-table column layout (order + hidden + pinned columns).
// ---------------------------------------------------------------------------
//
// Until the user changes something, a table shows its DEFAULT layout, live —
// nothing is stored, so columns added to the app later simply appear. The
// first change marks the layout customized and saves it to the user's profile
// (server; mirrored in localStorage for an instant first paint). A customized
// layout is kept exactly as chosen: columns added afterwards are listed in the
// customizer but start hidden. "Restore default" clears the saved layout.
//
// Column WIDTHS are deliberately absent: columns auto-size to their data on
// every load, and manual header-drag resizes live only for the session.
// `known` = every column key the saved layout has seen.
interface ColPrefs { order: string[]; hidden: string[]; pinned: string[]; known?: string[]; customized?: boolean }
const legacyKey = (id: string) => `mh-cols:v1:${id}`;
const localKey = (userId: string, id: string) => `mh-cols:v2:${userId}:${id}`;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.includes(k));

function readLocal(key: string): ColPrefs | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<ColPrefs>;
    return { order: p.order ?? [], hidden: p.hidden ?? [], pinned: p.pinned ?? [], known: p.known, customized: p.customized };
  } catch { return null; }
}

/** A pre-profile browser layout, or null when it only held the old defaults. */
function legacyCustomized<T>(id: string, columns: Column<T>[]): ColPrefs | null {
  const p = readLocal(legacyKey(id));
  if (!p) return null;
  const known = new Set(p.known ?? columns.filter((c) => !c.newlyAdded).map((c) => c.key));
  const oldDefaults = columns.filter((c) => (c.defaultHidden || c.legacyDefaultHidden) && !c.required && known.has(c.key)).map((c) => c.key);
  const untouched = p.order.length === 0 && p.pinned.length === 0 && sameSet(p.hidden, oldDefaults);
  return untouched ? null : { ...p, known: p.known ?? [...known], customized: true };
}

/** A customized layout keeps its choices; columns it has never seen start hidden. */
function reconcileColPrefs<T>(p: ColPrefs, columns: Column<T>[]): ColPrefs {
  const known = new Set(p.known ?? columns.filter((c) => !c.newlyAdded).map((c) => c.key));
  const unseen = columns.filter((c) => !c.required && !known.has(c.key) && !p.hidden.includes(c.key)).map((c) => c.key);
  return { ...p, customized: true, hidden: [...p.hidden, ...unseen], known: [...new Set([...known, ...columns.map((c) => c.key)])] };
}
const MIN_COL_W = 64;
// A column whose longest value exceeds this many characters wraps (within a
// width band) instead of stretching the table; everything else stays on one
// line and the column widens to fit its data.
const LONG_TEXT_CHARS = 64;
// Long-text columns wrap within [LONG_COL_MIN_W, 420px] (max in CSS), so they
// stay ~2 lines instead of collapsing to a narrow multi-line sliver.
const LONG_COL_MIN_W = 320;
// Pinned columns get a fixed width so their sticky left-offsets are exact.
const PIN_DEFAULT_W = 160;

function useColumnPrefs<T>(customizeId: string | undefined, columns: Column<T>[]) {
  const { user } = useAuth();
  const userId = user?.id ?? "anon";
  const defaults = (): ColPrefs => ({ order: [], hidden: columns.filter((c) => c.defaultHidden && !c.required).map((c) => c.key), pinned: [], known: columns.map((c) => c.key), customized: false });
  // First paint: this user's local mirror, else a customized legacy browser layout, else defaults.
  const initial = (id: string): ColPrefs => {
    const local = readLocal(localKey(userId, id));
    if (local?.customized) return reconcileColPrefs(local, columns);
    const legacy = legacyCustomized(id, columns);
    return legacy ? reconcileColPrefs(legacy, columns) : defaults();
  };
  const [prefs, setPrefs] = useState<ColPrefs>(() => (customizeId ? initial(customizeId) : { order: [], hidden: [], pinned: [] }));
  // Set by user actions; the persist effect below saves only then.
  const dirty = useRef(false);
  // Session-only manual widths: dropped on reload/remount so every fresh view
  // starts from automatic content-based sizing.
  const [widths, setWidths] = useState<Record<string, number>>({});

  // The profile is the source of truth: adopt its layout, or upload a
  // customized layout that only existed in this browser (one-time migration).
  useEffect(() => {
    if (!customizeId) return;
    dirty.current = false;
    const start = initial(customizeId);
    setPrefs(start);
    let live = true;
    void loadProfileTablePrefs(userId).then((saved) => {
      if (!live || dirty.current) return; // the user already changed something
      const s = saved[customizeId];
      if (s) {
        const next = reconcileColPrefs({ ...s, customized: true }, columns);
        setPrefs(next);
        try { localStorage.setItem(localKey(userId, customizeId), JSON.stringify(next)); } catch { /* ignore */ }
      } else if (start.customized && user) {
        saveProfileTablePrefs(userId, customizeId, { order: start.order, hidden: start.hidden, pinned: start.pinned, known: start.known });
      }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customizeId, userId]);

  useEffect(() => {
    if (!customizeId || !dirty.current) return;
    dirty.current = false;
    try {
      if (prefs.customized) localStorage.setItem(localKey(userId, customizeId), JSON.stringify(prefs));
      else localStorage.removeItem(localKey(userId, customizeId));
      localStorage.removeItem(legacyKey(customizeId)); // superseded by the profile copy
    } catch { /* ignore */ }
    if (user) saveProfileTablePrefs(userId, customizeId, prefs.customized ? { order: prefs.order, hidden: prefs.hidden, pinned: prefs.pinned, known: prefs.known } : null);
  }, [customizeId, prefs, userId, user]);

  // Every user change marks the layout customized and persists it.
  const change = (fn: (p: ColPrefs) => ColPrefs) => {
    dirty.current = true;
    setPrefs((p) => ({ ...fn(p), customized: true, known: [...new Set([...(p.known ?? []), ...columns.map((c) => c.key)])] }));
  };

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

  const toggle = (key: string) => change((p) => ({ ...p, hidden: p.hidden.includes(key) ? p.hidden.filter((k) => k !== key) : [...p.hidden, key] }));
  // Drag-and-drop reorder: move `fromKey` to `toKey`'s position within the full
  // column order (hidden columns keep their relative slots).
  const reorder = (fromKey: string, toKey: string) => {
    const keys = ordered.map((c) => c.key);
    const fi = keys.indexOf(fromKey), ti = keys.indexOf(toKey);
    if (fi < 0 || ti < 0 || fi === ti) return;
    keys.splice(fi, 1);
    keys.splice(ti, 0, fromKey);
    change((p) => ({ ...p, order: keys }));
  };
  const setWidth = (key: string, w: number) => setWidths((ws) => ({ ...ws, [key]: Math.max(MIN_COL_W, Math.round(w)) }));
  const togglePin = (key: string) => {
    // Pin: give the column a session width (if none yet) so sticky offsets are
    // exact; unpinning releases it back to automatic sizing.
    setWidths((ws) => prefs.pinned.includes(key)
      ? (() => { const { [key]: _drop, ...rest } = ws; return rest; })()
      : ws[key] != null ? ws : { ...ws, [key]: PIN_DEFAULT_W });
    change((p) => p.pinned.includes(key)
      ? { ...p, pinned: p.pinned.filter((k) => k !== key) }
      : { ...p, pinned: [...p.pinned, key] });
  };
  const reset = () => { dirty.current = true; setPrefs(defaults()); setWidths({}); };
  const isDefault = !prefs.customized && Object.keys(widths).length === 0;

  return { ordered, visible, hidden, widths, pinnedKeys, pinnedSet, toggle, reorder, setWidth, togglePin, reset, isDefault };
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
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" /></svg>
        Customize view
      </button>
      {open && (
        <div className="cv-menu cv-columns" role="dialog" aria-label="Customize columns">
          <div className="cv-head"><strong>Columns</strong><span className="cv-sub">Show, hide, pin and reorder</span></div>
          <div className="cv-list">
            {listed.map((c) => {
              const on = !hidden.has(c.key);
              const pinned = pinnedSet.has(c.key);
              return (
                <div key={c.key}
                  className={`cv-row ${on ? "" : "off"} ${dragKey === c.key ? "dragging" : ""} ${overKey === c.key && dragKey && dragKey !== c.key ? "drop-over" : ""}`}
                  onDragOver={(e) => { if (!dragKey) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overKey !== c.key) setOverKey(c.key); }}
                  onDrop={(e) => { e.preventDefault(); if (dragKey) onReorder(dragKey, c.key); setDragKey(null); setOverKey(null); }}
                >
                  {/* Only the handle is draggable, so the checkbox stays clickable. */}
                  <span className="cv-drag" title="Drag to reorder" aria-label="Drag to reorder" draggable
                    onDragStart={(e) => { setDragKey(c.key); e.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => { setDragKey(null); setOverKey(null); }}>
                    <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="3" r="1.4" /><circle cx="8.5" cy="3" r="1.4" /><circle cx="3.5" cy="8" r="1.4" /><circle cx="8.5" cy="8" r="1.4" /><circle cx="3.5" cy="13" r="1.4" /><circle cx="8.5" cy="13" r="1.4" /></svg>
                  </span>
                  <label className="cv-check">
                    <input type="checkbox" checked={on} disabled={c.required} onChange={() => onToggle(c.key)} />
                    <span>{c.header}</span>
                  </label>
                  {c.required && <span className="cv-req">Always shown</span>}
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
            <span className="cv-hint">Drag a header edge to resize. Widths reset on reload.</span>
            <button type="button" className="small" disabled={isDefault} onClick={onReset}>Restore defaults</button>
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
  toolbar,
  subToolbar,
  rowsPerPage,
  defaultPageSize,
  serverSort,
  paginationNoun,
  footerExtra,
  totalsLabel,
}: Props<T>) {
  const [localSort, setLocalSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(defaultSort ?? null);
  // Server-sort mode: the caller owns the sort state and re-queries on change.
  const sort = serverSort ? serverSort.sort : localSort;
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
    pinnedSet.has(key) ? { position: "sticky", left: pinLeft[key], zIndex: head ? 7 : 3, background: head ? "var(--surface)" : "var(--row-bg, var(--surface))" } : undefined;

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
    // Server-sorted pages arrive in their final order — sorting the visible
    // page locally would only ever reorder ONE page, so it is skipped.
    if (serverSort) return rows;
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
  }, [rows, sort, columns, defaultCompare, serverSort]);

  function onHeaderClick(key: string) {
    const next = (prev: { key: string; dir: "asc" | "desc" } | null): { key: string; dir: "asc" | "desc" } => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return { key, dir: "asc" }; // toggle back to asc on third click
    };
    if (serverSort) serverSort.onSort(next(serverSort.sort));
    else setLocalSort(next);
  }

  // Pagination (opt-in via rowsPerPage). Rows are sorted across the FULL set
  // above, then the current page is sliced here — so sorting/select-all reflect
  // the whole list, not just the visible page.
  const paginated = !!rowsPerPage && rowsPerPage.length > 0;
  const initialPageSize = defaultPageSize ?? (rowsPerPage?.includes(50) ? 50 : rowsPerPage?.[0] ?? 50);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [page, setPage] = useState(1);
  const totalPages = paginated ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const curPage = Math.min(page, totalPages);
  // Snap back to a valid page when the row set shrinks or the page size changes.
  useEffect(() => { setPage(1); }, [pageSize, sorted.length]);
  const paged = paginated ? sorted.slice((curPage - 1) * pageSize, curPage * pageSize) : sorted;

  // Right-edge fade: a visible cue that more columns exist off-screen. (The
  // pinned lead column already anchors the left edge, so no left fade.)
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, [sorted.length, cols.length]);

  // Dynamic column sizing: after every render (data, filters, edits, paging),
  // re-check which columns hold long text. Those wrap inside a width band;
  // the rest never wrap, so their width follows the current data.
  const tableRef = useRef<HTMLTableElement>(null);
  const [longCols, setLongCols] = useState<Set<string>>(() => new Set());
  useLayoutEffect(() => {
    const t = tableRef.current;
    if (!t) return;
    const off = selection ? 1 : 0;
    const bodyRows = Array.from(t.tBodies[0]?.rows ?? []);
    const next = new Set<string>();
    cols.forEach((c, i) => {
      let max = 0;
      for (const r of bodyRows) { const cell = r.cells[i + off]; if (cell) max = Math.max(max, (cell.textContent ?? "").length); }
      if (max > LONG_TEXT_CHARS) next.add(c.key);
    });
    if (next.size !== longCols.size || [...next].some((k) => !longCols.has(k))) setLongCols(next);
  });

  const table = (
    <div className="table-edge-wrap">
      {moreRight && <div className="table-fade-r" aria-hidden="true" />}
    <div className="table-scroll" ref={scrollRef}>
      {/* lead-sticky pins the identifying column while wide tables scroll; when
          the user pins columns explicitly, we drive stickiness inline instead. */}
      <table ref={tableRef} className={`data-table auto-cols${hasPins ? "" : " lead-sticky"}${selection ? " has-sel" : ""}`}>
        <thead>
          <tr>
            {selection && (() => {
              const ids = paged.map(rowKey);
              const allSelected = ids.length > 0 && ids.every((id) => selection.selected.has(id));
              // Some (not all) rows on the page selected: the header box shows a dash.
              const someSelected = !allSelected && ids.some((id) => selection.selected.has(id));
              return (
                <th className="center" style={{ width: 36, ...(hasPins ? { position: "sticky", left: 0, zIndex: 7, background: "var(--surface)" } : {}) }}>
                  <input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = someSelected; }} onChange={() => selection.onToggleAll(ids)} aria-label="Select all" />
                </th>
              );
            })()}
            {cols.map((c) => {
              const active = sort?.key === c.key;
              const pinned = pinnedSet.has(c.key);
              // Pinned columns need a fixed width even after a reload (sticky
              // offsets assume one); everything else auto-sizes to its data
              // unless the user dragged a session width.
              const w = widths[c.key] ?? (pinned ? PIN_DEFAULT_W : undefined);
              const wStyle = w != null
                ? { width: w, minWidth: Math.max(w, c.minWidth ?? 0), maxWidth: Math.max(w, c.minWidth ?? 0) }
                : { ...(c.width ? { width: c.width } : {}), ...(c.minWidth ? { minWidth: c.minWidth } : {}) };
              return (
                <th
                  key={c.key}
                  onClick={() => onHeaderClick(c.key)}
                  className={`sortable ${c.align ?? "left"} ${active ? "active" : ""} ${pinned ? "cv-pin" : ""} ${pinned && c.key === pinnedKeys[pinnedKeys.length - 1] ? "cv-pin-last" : ""}`}
                  style={{ ...wStyle, ...pinStyle(c.key, true) }}
                >
                  <span className="th-inner">
                    {c.header}
                    <svg className={`sort-ind ${active && sort!.dir === "asc" ? "asc" : ""}`} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
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
            paged.map((row) => {
              const id = rowKey(row);
              return (
              <tr
                key={id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`${onRowClick ? "clickable" : ""} ${rowClassName?.(row) ?? ""} ${selection?.selected.has(id) ? "row-selected" : ""}`}
              >
                {selection && (
                  <td className="center" onClick={(e) => e.stopPropagation()} style={hasPins ? { position: "sticky", left: 0, zIndex: 3, background: "var(--row-bg, var(--surface))" } : undefined}>
                    <input type="checkbox" checked={selection.selected.has(id)} onChange={() => selection.onToggle(id)} aria-label="Select row" />
                  </td>
                )}
                {cols.map((c, ci) => {
                  const cell = c.render ? c.render(row) : displayDefault(c.value(row));
                  const pinned = pinnedSet.has(c.key);
                  const w = widths[c.key] ?? (pinned ? PIN_DEFAULT_W : undefined);
                  // A width the user dragged is honored: content wraps inside it.
                  const wStyle = w != null
                    ? { width: w, minWidth: Math.max(w, c.minWidth ?? 0), maxWidth: Math.max(w, c.minWidth ?? 0), whiteSpace: "normal" as const, overflowWrap: "anywhere" as const }
                    : longCols.has(c.key)
                      ? { minWidth: Math.max(c.minWidth ?? 0, LONG_COL_MIN_W) }
                      : (c.minWidth ? { minWidth: c.minWidth } : undefined);
                  return (
                    <td key={c.key} className={`${c.align ?? "left"} ${longCols.has(c.key) ? "col-long" : ""} ${pinned ? "cv-pin" : ""} ${pinned && c.key === pinnedKeys[pinnedKeys.length - 1] ? "cv-pin-last" : ""}`} style={{ ...wStyle, ...pinStyle(c.key, false) }}>
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
        {totalsLabel && sorted.length > 0 && (() => {
          const labelKey = cols.find((c) => !c.total)?.key;
          return (
            <tfoot className="dt-totals">
              <tr>
                {selection && <td style={hasPins ? { position: "sticky", left: 0, zIndex: 3 } : undefined} />}
                {cols.map((c) => {
                  const pinned = pinnedSet.has(c.key);
                  const pin = pinStyle(c.key, false);
                  return (
                    <td key={c.key} className={`${c.align ?? "left"} ${pinned ? "cv-pin" : ""} ${pinned && c.key === pinnedKeys[pinnedKeys.length - 1] ? "cv-pin-last" : ""}`}
                      style={pin ? { ...pin, background: undefined } : undefined}>
                      {c.key === labelKey ? <span className="dt-totals-label">{totalsLabel(sorted)}</span> : c.total?.(sorted)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          );
        })()}
      </table>
    </div>
    </div>
  );

  // Footer (design layout): the count on the left; rows-per-page, the page
  // position and prev/next on the right.
  const footer = paginated ? (
    <div className="ct-foot">
      <span>
        {sorted.length}
        {paginationNoun ? ` ${paginationNoun}${sorted.length === 1 ? "" : "s"}` : ""}
        {footerExtra}
      </span>
      <span className="ct-foot-controls">
        <span className="ct-rpp-wrap">
          <span className="ct-rpp-lbl">Rows per page</span>
          <span className="ct-rpp" title="Records per page">
            <Select
              value={String(pageSize)}
              onChange={(v) => setPageSize(Number(v))}
              options={rowsPerPage!.map((n) => String(n))}
              width={68}
              ariaLabel="Records per page"
            />
          </span>
        </span>
        <span className="ct-pgof">Page {curPage} of {totalPages}</span>
        <span className="ct-pages">
          <button className="ct-pgbtn" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)} aria-label="Previous page">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
          </button>
          <button className="ct-pgbtn" disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)} aria-label="Next page">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        </span>
      </span>
    </div>
  ) : null;

  if (!customizeId) {
    return (
      <>
        {table}
        {footer}
      </>
    );
  }
  return (
    <div className="cv-table">
      <div className="cv-toolbar">
        <div className="cv-toolbar-left">{toolbar}</div>
        <ColumnCustomizer ordered={ordered} hidden={hidden} pinnedSet={pinnedSet} onToggle={toggle} onReorder={reorder} onPin={togglePin} onReset={reset} isDefault={isDefault} />
      </div>
      {subToolbar}
      {table}
      {footer}
    </div>
  );
}

function displayDefault(v: string | number | Date | null | undefined): ReactNode {
  if (v == null || v === "") return "—";
  if (v instanceof Date) return fmtDate(v);
  return String(v);
}
