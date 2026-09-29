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

/** Explains an auto-calculated total, or that a typed total overrides it. */
export function PerAcreNote({ auto, manual, acres, rate }: {
  auto: { total: number; basis: "NMA" | "NRA" } | null; manual: boolean; acres: number | null; rate: number | null;
}) {
  if (!auto) return null;
  if (manual) return <div className="nd-calc">Manual total · overrides the per-acre {money(auto.total)}</div>;
  return (
    <div className="nd-calc auto">
      Auto: {acres?.toLocaleString("en-US")} {auto.basis} × {money(rate, { cents: true })} = <strong>{money(auto.total)}</strong>
    </div>
  );
}
