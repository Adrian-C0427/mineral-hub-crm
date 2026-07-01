/** Server-side money formatting for pre-rendered strings (e.g. activity log). */
export function money(n: number | null | undefined): string {
  if (n == null) return "$0";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
