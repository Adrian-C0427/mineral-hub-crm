import { useState } from "react";
import { Modal } from "./ui";
import { api, ApiError } from "../api/client";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { GeoFields } from "./GeoFields";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS, basinsForCounties, formationsForCounties, suggestFirst } from "../lib/options";
import type { DealSummary } from "../types";

// A lightweight asset row captured during New Deal creation. Only the name is
// required; each becomes a full child-asset deal that can be refined later.
interface AssetRow { name: string; nra: string; ourPrice: string; askPrice: string; operator: string; assetTypes: string[] }
const emptyAsset = (): AssetRow => ({ name: "", nra: "", ourPrice: "", askPrice: "", operator: "", assetTypes: [] });

/**
 * Create a deal — or, when `parentDealId` is passed, add a child asset under an
 * existing seller transaction (only the name is required in that mode). During
 * top-level creation the user can also add one or more assets before saving, so
 * a multi-asset seller package is created in a single step.
 */
export function NewDealModal({ onClose, onCreated, parentDealId }: {
  onClose: () => void;
  onCreated: (d: DealSummary) => void;
  parentDealId?: string;
}) {
  const asset = !!parentDealId;
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
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

  // Required before save. A child asset needs only a name; a top-level deal
  // mirrors the server-side required-field check.
  const missing: string[] = [];
  if (!f.name.trim()) missing.push(asset ? "Asset name" : "Deal name");
  if (!asset) {
    if (!states.length) missing.push("State");
    if (!counties.length) missing.push("County");
    if (!abstractIds.length) missing.push("Abstract");
    if (f.nra.trim() === "") missing.push("NRA");
    if (!assetTypes.length) missing.push("Asset Type");
    if (f.ourPrice.trim() === "") missing.push("Our Price");
    if (!f.dateUnderContract) missing.push("Date Under Contract");
  }
  const badAssetRows = assets.length > 0 && assets.some((a) => !a.name.trim());

  const setAsset = (i: number, k: keyof AssetRow, v: string | string[]) =>
    setAssets((rows) => rows.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));

  async function submit() {
    if (missing.length) { setError(`Required: ${missing.join(", ")}`); return; }
    if (badAssetRows) { setError("Every asset needs a name (or remove the empty row)."); return; }
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
        // Add-asset mode: attach to the parent package.
        ...(asset ? { parentDealId } : {}),
        // New-deal mode: additional child assets created alongside this deal.
        ...(!asset && assets.length
          ? {
              assets: assets.map((a) => ({
                name: a.name.trim(),
                nra: numOrNull(a.nra),
                ourPrice: numOrNull(a.ourPrice),
                askPrice: numOrNull(a.askPrice),
                operator: a.operator || null,
                assetTypes: a.assetTypes,
              })),
            }
          : {}),
      });
      onCreated(deal);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create deal");
    } finally {
      setBusy(false);
    }
  }

  const req = <span style={{ color: "var(--red)" }}>*</span>;
  return (
    <Modal
      title={asset ? "Add asset" : "New Deal"}
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy || missing.length > 0}>
            {busy ? "Saving…" : asset ? "Add asset" : assets.length ? `Create deal + ${assets.length} asset${assets.length > 1 ? "s" : ""}` : "Create deal"}
          </button>
        </>
      }
    >
      {asset ? (
        <p className="muted" style={{ marginTop: 0 }}>
          This asset is added under the seller transaction. Only the <strong>name</strong> is required — fill in the
          rest here or later on the asset's own page. It's independently marketable.
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          New deals start in <strong>Under Contract</strong>. Fields marked {req} are required.
          Add sellers afterward in the deal's <strong>Seller Details</strong> section.
        </p>
      )}
      <div className="field"><label>{asset ? "Asset" : "Deal"} name {req}</label><input value={f.name} onChange={set("name")} autoFocus /></div>
      <div className="dd-grid">
        <GeoFields
          states={states} onStatesChange={setStates}
          counties={counties} onCountiesChange={setCounties}
          abstractIds={abstractIds} onAbstractsChange={setAbstractIds}
          labels={asset ? { state: "State", county: "County", abstract: "Abstract" } : { state: "State *", county: "County *", abstract: "Abstract *" }}
        />
        <div className="field"><label>Asset Type {asset ? null : req}</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
        <div className="field"><label>NRA {asset ? null : req}</label><input type="number" value={f.nra} onChange={set("nra")} /></div>
        <div className="field"><label>Our Price (acquisition cost) {asset ? null : req}</label><input type="number" value={f.ourPrice} onChange={set("ourPrice")} /></div>
        <div className="field"><label>Date Under Contract {asset ? null : req}</label><input type="date" value={f.dateUnderContract} onChange={set("dateUnderContract")} /></div>
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

      {/* Multi-asset seller: add more interests acquired from the same seller.
          Each becomes an independently-marketable child asset. */}
      {!asset && (
        <div className="nd-assets">
          <div className="nd-assets-head">
            <div>
              <strong>Additional assets under this seller</strong>
              <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>optional — one or more interests marketed separately</span>
            </div>
            <button type="button" className="small" onClick={() => setAssets((r) => [...r, emptyAsset()])}>+ Add asset</button>
          </div>
          {assets.map((a, i) => (
            <div key={i} className="nd-asset-row">
              <div className="field" style={{ flex: "2 1 160px" }}><label>Asset name {req}</label><input value={a.name} onChange={(e) => setAsset(i, "name", e.target.value)} placeholder={`Asset ${i + 1}`} /></div>
              <div className="field" style={{ flex: "1 1 90px" }}><label>NRA</label><input type="number" value={a.nra} onChange={(e) => setAsset(i, "nra", e.target.value)} /></div>
              <div className="field" style={{ flex: "1 1 100px" }}><label>Our Price</label><input type="number" value={a.ourPrice} onChange={(e) => setAsset(i, "ourPrice", e.target.value)} /></div>
              <div className="field" style={{ flex: "1 1 100px" }}><label>Ask Price</label><input type="number" value={a.askPrice} onChange={(e) => setAsset(i, "askPrice", e.target.value)} /></div>
              <div className="field" style={{ flex: "2 1 150px" }}><label>Asset Type</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={a.assetTypes} onChange={(v) => setAsset(i, "assetTypes", v)} placeholder="Any" /></div>
              <button type="button" className="nd-asset-del" title="Remove asset" onClick={() => setAssets((r) => r.filter((_, idx) => idx !== i))}>×</button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
