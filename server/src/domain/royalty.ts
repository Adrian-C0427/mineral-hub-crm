/**
 * Lease royalty rates — the ONE parser every royalty figure goes through.
 *
 * Deal.royaltyRate is stored as a string so the user's intended form survives:
 * a standard fraction ("1/8", "3/16"), a custom fraction ("3/20") or a custom
 * percentage ("18.75%"). Everything that does math with it (NMA ↔ NRA, the
 * AI fact sheet, …) reads it through royaltyValue(), so a custom 18.75% and the
 * preset 3/16 behave identically. Mirrored in client/src/lib/royalty.ts — keep
 * the two in step (parity is unit-tested in royalty.test.ts).
 */

/** The app's standard lease royalty rates, stored as fractions ("3/16"). */
export const ROYALTY_RATE_OPTIONS = ["1/16", "1/8", "3/16", "1/6", "1/5", "9/40", "1/4"] as const;

/** Decimal interests keep 8 places (0.00390625 = 1/256 survives exactly). */
const round8 = (n: number) => Math.round(n * 1e8) / 1e8;

const NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const FRACTION = new RegExp(`^${NUM}\\s*[/⁄]\\s*${NUM}$`);
const PERCENT = new RegExp(`^${NUM}\\s*%$`);
const PLAIN = new RegExp(`^${NUM}$`);

export type RoyaltyParse =
  | { ok: true; value: number; canonical: string }
  | { ok: false; error: string };

export const ROYALTY_RATE_ERROR =
  "Enter a royalty rate between 0 and 100% — e.g. 3/16, 18.75%, 0.1875 or 18.75.";

/**
 * Parse a royalty rate typed by a user or read from storage.
 *   "3/16" → 0.1875 (fraction)      "18.75%" → 0.1875 (percent)
 *   "0.1875" → 0.1875 (decimal)     "18.75" → 0.1875 (a bare number > 1 is a percent)
 * Valid rates are decimal interests in (0, 1]. `canonical` is what to store,
 * keeping the form the user chose: a fraction stays a fraction — the standard
 * one when it equals a preset ("2/16" → "1/8"), else as typed ("3/20") — and
 * a percent or decimal is stored as the percentage ("18.75%", "0.1875" →
 * "18.75%"), so the display always shows the intended percent.
 */
export function parseRoyaltyRate(input: string | null | undefined): RoyaltyParse {
  const t = (input ?? "").trim().replace(/\s+/g, " ");
  if (!t) return { ok: false, error: "Enter a royalty rate." };
  let value: number | null = null;
  let fraction: string | null = null;
  const f = t.match(FRACTION);
  const p = t.match(PERCENT);
  const n = t.match(PLAIN);
  if (f) {
    const num = Number(f[1]), den = Number(f[2]);
    if (den > 0) { value = num / den; fraction = `${f[1]}/${f[2]}`; }
  } else if (p) {
    value = Number(p[1]) / 100;
  } else if (n) {
    const v = Number(n[1]);
    value = v > 1 ? v / 100 : v;
  }
  if (value == null || !Number.isFinite(value) || !(value > 0) || value > 1) {
    return { ok: false, error: ROYALTY_RATE_ERROR };
  }
  value = round8(value);
  const preset = fraction ? ROYALTY_RATE_OPTIONS.find((o) => round8(fractionValue(o)) === value) : undefined;
  const canonical = preset ?? fraction ?? `${percentNumber(value)}%`;
  return { ok: true, value, canonical };
}

/** Decimal value of a stored royalty rate; null when blank, unreadable or out of (0, 1]. */
export function royaltyValue(r: string | null | undefined): number | null {
  const p = parseRoyaltyRate(r);
  return p.ok ? p.value : null;
}

/** Display: "3/16 · 18.75%", "18.75%" for a percentage, the raw text when unreadable. */
export function royaltyLabel(r: string | null | undefined): string {
  const t = (r ?? "").trim();
  if (!t) return "";
  const v = royaltyValue(t);
  if (v == null) return t;
  const pct = `${percentNumber(v)}%`;
  return t.match(FRACTION) ? `${t.replace(/\s+/g, "")} · ${pct}` : pct;
}

/** A decimal interest as a percentage number, without float noise (0.1875 → 18.75). */
function percentNumber(v: number): number {
  return Number((v * 100).toFixed(6));
}

function fractionValue(f: string): number {
  const [a, b] = f.split("/").map(Number);
  return a / b;
}

/**
 * NMA ↔ NRA at a lease royalty rate. NRA is normalized to a 1/8 royalty:
 * NRA = NMA × royalty ÷ 1/8 (10 NMA at 1/4 → 20 NRA; at 1/8 NRA = NMA).
 * Rounded to 4 decimals; null when either input is missing. Mirrors
 * nraFromNma/nmaFromNra in client/src/lib/perAcre.ts.
 */
export function nraFromNma(nma: number | null, royalty: number | null): number | null {
  if (nma == null || royalty == null || !(royalty > 0)) return null;
  return round4(nma * royalty * 8);
}
export function nmaFromNra(nra: number | null, royalty: number | null): number | null {
  if (nra == null || royalty == null || !(royalty > 0)) return null;
  return round4(nra / (royalty * 8));
}
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
