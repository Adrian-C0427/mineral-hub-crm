import { useMemo, useState, type ReactNode } from "react";

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
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
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

export function SortableTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  defaultSort,
  defaultCompare,
  rowClassName,
  empty,
  selection,
}: Props<T>) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(defaultSort ?? null);

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

  return (
    <div className="table-scroll">
      <table className="data-table">
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
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  onClick={() => onHeaderClick(c.key)}
                  className={`sortable ${c.align ?? "left"} ${active ? "active" : ""}`}
                  style={c.width ? { width: c.width } : undefined}
                >
                  <span className="th-inner">
                    {c.header}
                    <span className="sort-ind">{active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length + (selection ? 1 : 0)} className="empty-cell">
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
                {columns.map((c) => (
                  <td key={c.key} className={c.align ?? "left"}>
                    {c.render ? c.render(row) : displayDefault(c.value(row))}
                  </td>
                ))}
              </tr>
            );})
          )}
        </tbody>
      </table>
    </div>
  );
}

function displayDefault(v: string | number | Date | null | undefined): ReactNode {
  if (v == null || v === "") return "—";
  if (v instanceof Date) return v.toLocaleDateString();
  return String(v);
}
