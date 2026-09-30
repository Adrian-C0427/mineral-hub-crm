import { royaltyValue } from "../lib/royalty";
import { nmaFromNra, nraFromNma } from "../lib/perAcre";
import { money } from "../lib/format";

/**
 * Shared pieces of the deal economics form, used by New Deal and the Deal
 * Characteristics editor so both edit the same fields the same way.
 */

export const DAYS_TO_CLOSE_PRESETS = [30, 40, 50, 60, 75] as const;

/** YYYY-MM-DD + n calendar days (UTC, matching the server's date math). */
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Which acreage figure the user typed last; the other one is calculated from it. */
export type AcreSource = "nma" | "nra" | null;
export interface AcreageState { nma: string; nra: string; royaltyRate: string; source: AcreSource }

/**
 * Apply one edit to the Royalty Rate / NMA / NRA trio. The figure the user
 * typed drives the other through the royalty rate (NRA = NMA × royalty ÷ 1/8),
 * so a typed value is only ever replaced when one of ITS inputs changes.
 * Clearing a figure stops it driving (nothing is recalculated from a blank).
 */
export function applyAcreageEdit(s: AcreageState, edit: { nma?: string; nra?: string; royaltyRate?: string }): AcreageState {
  const next = { ...s };
  if (edit.nma !== undefined) { next.nma = edit.nma; next.source = edit.nma.trim() ? "nma" : null; }
  if (edit.nra !== undefined) { next.nra = edit.nra; next.source = edit.nra.trim() ? "nra" : null; }
  if (edit.royaltyRate !== undefined) {
    next.royaltyRate = edit.royaltyRate;
    // A new royalty rate with nothing typed yet: NMA is the primary measure.
    if (!next.source) next.source = next.nma.trim() ? "nma" : next.nra.trim() ? "nra" : null;
  }
  const r = royaltyValue(next.royaltyRate);
  const n = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  if (r != null && next.source === "nma") {
    const v = nraFromNma(n(next.nma), r);
    if (v != null) next.nra = String(v);
  } else if (r != null && next.source === "nra") {
    const v = nmaFromNra(n(next.nra), r);
    if (v != null) next.nma = String(v);
  }
  return next;
}

/** "Calculated from NMA at 1/4" — shown under the acreage field that was derived. */
export function AcreageNote({ s, field }: { s: AcreageState; field: "nma" | "nra" }) {
  const driver = field === "nra" ? "nma" : "nra";
  if (s.source !== driver || royaltyValue(s.royaltyRate) == null || !s[field].trim()) return null;
  return <div className="nd-calc auto">Calculated from {driver.toUpperCase()} at {s.royaltyRate} royalty</div>;
}

/** Days to Close: preset chips plus any typed number (string, "" = unset). */
export function DaysToCloseField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const days = value.trim() !== "" && Number(value) > 0 ? Math.round(Number(value)) : null;
  return (
    <div className="nd-dtc">
      <div className="seg-control" role="group" aria-label="Days to close presets">
        {DAYS_TO_CLOSE_PRESETS.map((d) => (
          <button type="button" key={d} className={`seg ${days === d ? "active" : ""}`} aria-pressed={days === d}
            onClick={() => onChange(days === d ? "" : String(d))}>{d}</button>
        ))}
      </div>
      <input type="number" min={1} max={3650} step={1} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Other" aria-label="Days to close" />
    </div>
  );
}

// --- Per-acre pricing (Our Cost / Asking Price) ------------------------------

/** Which figure of a price group the user typed; the other two are calculated. */
export type PriceField = "perNma" | "perNra" | "total";
/** One price (Our Cost or Asking Price): its total and both per-acre rates, as
 *  strings while editing. They describe the SAME price:
 *  total = per NMA × NMA = per NRA × NRA. */
export interface PriceGroup { perNma: string; perNra: string; total: string; source: PriceField | null }
export const emptyPriceGroup = (): PriceGroup => ({ perNma: "", perNra: "", total: "", source: null });

const toNum = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const cents = (n: number | null) => (n == null || !Number.isFinite(n) ? "" : String(Math.round(n * 100) / 100));

/**
 * Recalculate a price group from the figure the user typed, for the current
 * acreage (NMA/NRA already reflect the royalty-rate conversion). The typed
 * figure is never changed; a calculated one blanks when its acreage is missing.
 */
export function syncPriceGroup(g: PriceGroup, nma: number | null, nra: number | null): PriceGroup {
  const acres = (a: number | null) => (a != null && a > 0 ? a : null);
  const m = acres(nma), r = acres(nra);
  switch (g.source) {
    case "perNma": {
      const rate = toNum(g.perNma);
      const total = rate != null && m != null ? rate * m : null;
      return { ...g, total: cents(total), perNra: total != null && r != null ? cents(total / r) : "" };
    }
    case "perNra": {
      const rate = toNum(g.perNra);
      const total = rate != null && r != null ? rate * r : null;
      return { ...g, total: cents(total), perNma: total != null && m != null ? cents(total / m) : "" };
    }
    case "total": {
      const total = toNum(g.total);
      return { ...g, perNma: total != null && m != null ? cents(total / m) : "", perNra: total != null && r != null ? cents(total / r) : "" };
    }
    default:
      return g;
  }
}

/** The user typed into one figure: it becomes the driver. Clearing the driver
 *  clears what was calculated from it. */
export function editPriceGroup(g: PriceGroup, field: PriceField, value: string, nma: number | null, nra: number | null): PriceGroup {
  if (value.trim() === "") return g.source === field ? emptyPriceGroup() : { ...g, [field]: "" };
  return syncPriceGroup({ ...g, [field]: value, source: field }, nma, nra);
}

/** Editing state for a stored price: the driver is whichever stored rate
 *  reproduces the stored total, else the total itself (typed by hand). */
export function priceGroupFromStored(
  perNma: number | null | undefined, perNra: number | null | undefined, total: number | null | undefined,
  nma: number | null, nra: number | null,
): PriceGroup {
  const matches = (rate: number | null | undefined, a: number | null) =>
    rate != null && a != null && total != null && Math.abs(rate * a - total) < 0.01;
  const source: PriceField | null =
    matches(perNma, nma) ? "perNma" : matches(perNra, nra) ? "perNra"
    : total != null ? "total" : perNma != null ? "perNma" : perNra != null ? "perNra" : null;
  const g = { perNma: cents(perNma ?? null), perNra: cents(perNra ?? null), total: cents(total ?? null), source };
  return syncPriceGroup(g, nma, nra);
}

/** How a price group's total was reached. */
export function PriceNote({ g }: { g: PriceGroup }) {
  if (g.source === "total") return g.total ? <div className="nd-calc">Per-acre prices calculated from this total</div> : null;
  if (!g.source || !g.total) return null;
  const rate = toNum(g.source === "perNma" ? g.perNma : g.perNra);
  return (
    <div className="nd-calc auto">
      Calculated: {money(rate, { cents: true })} per {g.source === "perNma" ? "NMA" : "NRA"} = <strong>{money(toNum(g.total))}</strong>
    </div>
  );
}
