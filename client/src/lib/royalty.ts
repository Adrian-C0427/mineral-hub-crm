/** The app's standard lease royalty rates, stored as fractions ("3/16"). */
export const ROYALTY_RATE_OPTIONS = ["1/16", "1/8", "3/16", "1/6", "1/5", "9/40", "1/4"] as const;

/** Decimal value of a royalty rate ("3/16" → 0.1875, "25%" → 0.25, "0.1875"); null if unreadable. */
export function royaltyValue(r: string | null | undefined): number | null {
  const t = (r ?? "").trim();
  if (!t) return null;
  const frac = t.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) return Number(frac[2]) ? Number(frac[1]) / Number(frac[2]) : null;
  const pct = t.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) return Number(pct[1]) / 100;
  const n = Number(t);
  return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : null;
}

/** "3/16 · 18.75%" (the fraction alone when it can't be read as a number). */
export function royaltyLabel(r: string | null | undefined): string {
  const t = (r ?? "").trim();
  if (!t) return "";
  const v = royaltyValue(t);
  if (v == null) return t;
  const pct = `${Number((v * 100).toFixed(2))}%`;
  return t.endsWith("%") ? pct : `${t} · ${pct}`;
}

/** Select options for a royalty-rate dropdown; keeps a stored non-standard value selectable. */
export function royaltyOptions(current?: string | null): { value: string; label: string }[] {
  const opts: string[] = [...ROYALTY_RATE_OPTIONS];
  if (current && !opts.includes(current)) opts.push(current);
  return opts.map((o) => ({ value: o, label: royaltyLabel(o) }));
}
