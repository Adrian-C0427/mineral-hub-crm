/**
 * Generic idempotent merge helpers — the heart of the storage-efficient,
 * incremental import. Dimension data (wells, operators, permits, fields) is
 * UPSERTed on its natural key; production is APPENDed month-over-month on its
 * natural key, updating volumes only when the RRC restates a prior month.
 *
 * These are pure SQL builders (unit-tested) — the caller supplies the flattened
 * values array and runs the returned statement through prisma.$executeRawUnsafe.
 * Re-running any month is therefore a no-op (or a volume correction), never a
 * duplicate.
 */
export interface MergeSpec {
  schema: string;
  table: string;
  columns: string[];       // insert columns, in value order
  conflict: string[];      // natural-key columns
  update?: string[];       // columns to overwrite on conflict; empty ⇒ DO NOTHING
  /** SQL type casts per column (e.g. { permit_date: "date" }). Text params
   *  into typed columns (date, int arrays, …) need an explicit ::cast or
   *  Postgres rejects the prepared statement. */
  casts?: Record<string, string>;
}

/** "($1,$2),($3,$4)" for rowCount rows of `width` columns each; a cast per
 *  column position (e.g. "::date") is appended when provided. */
export function valuesPlaceholders(rowCount: number, width: number, castByIndex?: (string | null)[]): string {
  if (rowCount <= 0 || width <= 0) return "";
  const rows: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const cells: string[] = [];
    for (let c = 0; c < width; c++) {
      const cast = castByIndex?.[c];
      cells.push(`$${r * width + c + 1}${cast ? `::${cast}` : ""}`);
    }
    rows.push(`(${cells.join(",")})`);
  }
  return rows.join(",");
}

/** Full parameterized INSERT … ON CONFLICT statement for `rowCount` rows. */
export function mergeSql(spec: MergeSpec, rowCount: number): string {
  const cols = spec.columns.join(", ");
  const casts = spec.casts ? spec.columns.map((c) => spec.casts![c] ?? null) : undefined;
  const vals = valuesPlaceholders(rowCount, spec.columns.length, casts);
  const conflictAction =
    spec.update && spec.update.length > 0
      ? `DO UPDATE SET ${spec.update.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`
      : "DO NOTHING";
  return (
    `INSERT INTO ${spec.schema}.${spec.table} (${cols}) VALUES ${vals} ` +
    `ON CONFLICT (${spec.conflict.join(", ")}) ${conflictAction}`
  );
}

/**
 * Watermark query: the newest production month already stored for a county.
 * A monthly run only needs to append cycles strictly greater than this, so we
 * never re-scan or re-store the full history.
 */
export function watermarkSql(schema = "rrc", table = "production"): string {
  return `SELECT COALESCE(MAX(cycle_ym), 0)::int AS watermark FROM ${schema}.${table} WHERE county = $1`;
}
