import { useState } from "react";
import { Modal } from "./ui";
import { api, ApiError } from "../api/client";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { GeoFields } from "./GeoFields";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS, basinsForCounties, formationsForCounties, suggestFirst } from "../lib/options";
import type { DealSummary } from "../types";

export function NewDealModal({ onClose, onCreated }: { onClose: () => void; onCreated: (d: DealSummary) => void }) {
  const [f, setF] = useState({
    name: "", operator: "", rrc: "",
    acreageNma: "", nra: "", askPrice: "", ourPrice: "", estimatedClosingCosts: "",
    dateUnderContract: "", originalClosingDate: "", notes: "",
  });
  const [states, setStates] = useState<string[]>([]);
  const [counties, setCounties] = useState<string[]>([]);
  const [basins, setBasins] = useState<string[]>([]);
  const [formations, setFormations] = useState<string[]>([]);
  const [assetTypes, setAssetTypes] = useState<string[]>([]);
  const [abstractIds, setAbstractIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

  // Required before a deal can be created (matches the server-side check).
  const missing: string[] = [];
  if (!f.name.trim()) missing.push("Deal name");
  if (!states.length) missing.push("State");
  if (!counties.length) missing.push("County");
  if (!abstractIds.length) missing.push("Abstract");
  if (f.nra.trim() === "") missing.push("NRA");
  if (!assetTypes.length) missing.push("Asset Type");
  if (f.ourPrice.trim() === "") missing.push("Our Price");
  if (!f.dateUnderContract) missing.push("Date Under Contract");

  async function submit() {
    if (missing.length) { setError(`Required: ${missing.join(", ")}`); return; }
    setBusy(true);
    setError(null);
    try {
      const deal = await api.post<DealSummary>("/deals", {
        name: f.name.trim(),
        states, state: states[0] ?? null,
        counties, basins, formations, assetTypes, abstractIds,
        operator: f.operator || null,
        rrc: f.rrc || null,
        acreageNma: numOrNull(f.acreageNma),
        nra: numOrNull(f.nra),
        askPrice: numOrNull(f.askPrice),
        ourPrice: numOrNull(f.ourPrice),
        estimatedClosingCosts: numOrNull(f.estimatedClosingCosts),
        // Seller info is captured in the structured Seller Details section on the
        // deal page (the single source of truth) — not here.
        sellerNames: [],
        dateUnderContract: f.dateUnderContract || null,
        originalClosingDate: f.originalClosingDate || null,
        notes: f.notes || null,
      });
      onCreated(deal);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create deal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New Deal"
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy || missing.length > 0}>{busy ? "Creating…" : "Create deal"}</button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        New deals start in <strong>Under Contract</strong>. Fields marked <span style={{ color: "var(--red)" }}>*</span> are required.
        Add sellers afterward in the deal's <strong>Seller Details</strong> section.
      </p>
      <div className="field"><label>Deal name <span style={{ color: "var(--red)" }}>*</span></label><input value={f.name} onChange={set("name")} autoFocus /></div>
      <div className="dd-grid">
        <GeoFields
          states={states} onStatesChange={setStates}
          counties={counties} onCountiesChange={setCounties}
          abstractIds={abstractIds} onAbstractsChange={setAbstractIds}
          labels={{ state: "State *", county: "County *", abstract: "Abstract *" }}
        />
        <div className="field"><label>Asset Type <span style={{ color: "var(--red)" }}>*</span></label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
        <div className="field"><label>NRA <span style={{ color: "var(--red)" }}>*</span></label><input type="number" value={f.nra} onChange={set("nra")} /></div>
        <div className="field"><label>Our Price (acquisition cost) <span style={{ color: "var(--red)" }}>*</span></label><input type="number" value={f.ourPrice} onChange={set("ourPrice")} /></div>
        <div className="field"><label>Date Under Contract <span style={{ color: "var(--red)" }}>*</span></label><input type="date" value={f.dateUnderContract} onChange={set("dateUnderContract")} /></div>
        <div className="field"><label>Basin</label><SearchableMultiSelect options={suggestFirst(TEXAS_BASIN_OPTIONS, basinsForCounties(counties))} value={basins} onChange={setBasins} placeholder={counties.length ? "Suggested for your counties first…" : "Search basins…"} /></div>
        <div className="field"><label>Formation</label><SearchableMultiSelect options={suggestFirst(TEXAS_FORMATION_OPTIONS, formationsForCounties(counties))} value={formations} onChange={setFormations} placeholder={counties.length ? "Suggested for your counties first…" : "Search formations…"} /></div>
        <div className="field"><label>Operator</label><input value={f.operator} onChange={set("operator")} /></div>
        <div className="field"><label>RRC</label><input value={f.rrc} onChange={set("rrc")} placeholder="RRC lease / district / operator no." /></div>
        <div className="field"><label>NMA</label><input type="number" value={f.acreageNma} onChange={set("acreageNma")} /></div>
        <div className="field"><label>Ask Price (to buyers)</label><input type="number" value={f.askPrice} onChange={set("askPrice")} /></div>
        <div className="field"><label>Est. Closing Costs</label><input type="number" value={f.estimatedClosingCosts} onChange={set("estimatedClosingCosts")} /></div>
        <div className="field"><label>Original Closing Date</label><input type="date" value={f.originalClosingDate} onChange={set("originalClosingDate")} /></div>
      </div>
      <div className="field"><label>Notes</label><textarea rows={3} value={f.notes} onChange={set("notes")} /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
