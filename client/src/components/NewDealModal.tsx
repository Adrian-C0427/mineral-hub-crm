import { useState } from "react";
import { Modal } from "./ui";
import { api, ApiError } from "../api/client";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { AbstractMultiPicker } from "./AbstractPicker";
import { TEXAS_COUNTY_OPTIONS, TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS } from "../lib/options";
import type { DealSummary } from "../types";

export function NewDealModal({ onClose, onCreated }: { onClose: () => void; onCreated: (d: DealSummary) => void }) {
  const [f, setF] = useState({
    name: "", state: "", operator: "", sellerNames: "",
    acreageNma: "", nra: "", askPrice: "", ourPrice: "", estimatedClosingCosts: "",
    dateUnderContract: "", originalClosingDate: "", notes: "",
  });
  const [counties, setCounties] = useState<string[]>([]);
  const [basins, setBasins] = useState<string[]>([]);
  const [formations, setFormations] = useState<string[]>([]);
  const [assetTypes, setAssetTypes] = useState<string[]>([]);
  const [abstractIds, setAbstractIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

  async function submit() {
    if (!f.name.trim()) { setError("Deal name is required"); return; }
    setBusy(true);
    setError(null);
    try {
      const deal = await api.post<DealSummary>("/deals", {
        name: f.name.trim(),
        state: f.state || null,
        counties, basins, formations, assetTypes, abstractIds,
        operator: f.operator || null,
        acreageNma: numOrNull(f.acreageNma),
        nra: numOrNull(f.nra),
        askPrice: numOrNull(f.askPrice),
        ourPrice: numOrNull(f.ourPrice),
        estimatedClosingCosts: numOrNull(f.estimatedClosingCosts),
        sellerNames: f.sellerNames ? f.sellerNames.split(",").map((s) => s.trim()).filter(Boolean) : [],
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
          <button className="primary" onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create deal"}</button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>New deals are created directly into <strong>Under Contract</strong>. Find Buyer By and Final Closing dates auto-calculate from the anchor dates.</p>
      <div className="field"><label>Deal name *</label><input value={f.name} onChange={set("name")} autoFocus /></div>
      <div className="dd-grid">
        <div className="field"><label>State</label><input value={f.state} onChange={set("state")} /></div>
        <div className="field"><label>County</label><SearchableMultiSelect options={TEXAS_COUNTY_OPTIONS} value={counties} onChange={setCounties} placeholder="Search counties…" /></div>
        <div className="field"><label>Asset Type</label><SearchableMultiSelect options={ASSET_TYPE_OPTIONS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
        <div className="field"><label>Basin</label><SearchableMultiSelect options={TEXAS_BASIN_OPTIONS} value={basins} onChange={setBasins} placeholder="Search basins…" /></div>
        <div className="field"><label>Formation</label><SearchableMultiSelect options={TEXAS_FORMATION_OPTIONS} value={formations} onChange={setFormations} placeholder="Search formations…" /></div>
        <div className="field"><label>Operator</label><input value={f.operator} onChange={set("operator")} /></div>
        <div className="field"><label>NMA</label><input type="number" value={f.acreageNma} onChange={set("acreageNma")} /></div>
        <div className="field"><label>NRA</label><input type="number" value={f.nra} onChange={set("nra")} /></div>
        <div className="field"><label>Our Price (acquisition cost)</label><input type="number" value={f.ourPrice} onChange={set("ourPrice")} /></div>
        <div className="field"><label>Ask Price (to buyers)</label><input type="number" value={f.askPrice} onChange={set("askPrice")} /></div>
        <div className="field"><label>Est. Closing Costs</label><input type="number" value={f.estimatedClosingCosts} onChange={set("estimatedClosingCosts")} /></div>
        <div className="field"><label>Date Under Contract</label><input type="date" value={f.dateUnderContract} onChange={set("dateUnderContract")} /></div>
        <div className="field"><label>Original Closing Date</label><input type="date" value={f.originalClosingDate} onChange={set("originalClosingDate")} /></div>
      </div>
      <div className="field"><label>Abstract</label><AbstractMultiPicker value={abstractIds} counties={counties} onChange={setAbstractIds} /></div>
      <div className="field"><label>Seller Names (comma-sep)</label><input value={f.sellerNames} onChange={set("sellerNames")} /></div>
      <div className="field"><label>Notes</label><textarea rows={3} value={f.notes} onChange={set("notes")} /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
