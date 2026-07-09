import { useState } from "react";
import { Modal } from "./ui";
import { api, ApiError } from "../api/client";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { GeoFields } from "./GeoFields";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS, basinsForCounties, formationsForCounties, suggestFirst } from "../lib/options";
import type { DealSummary } from "../types";

// An additional asset behaves exactly like a standalone deal record — the same
// fields, dependencies, and required fields. Its contract timeline defaults to
// the deal's (one timeline); untick "Same timeline" to give it its own.
interface AssetRow {
  name: string; states: string[]; counties: string[]; abstractIds: string[];
  assetTypes: string[]; nra: string; ourPrice: string; askPrice: string;
  operator: string; rrc: string; acreageNma: string; basins: string[]; formations: string[];
  sameTimeline: boolean; dateUnderContract: string;
}
const emptyAsset = (): AssetRow => ({
  name: "", states: [], counties: [], abstractIds: [], assetTypes: [], nra: "", ourPrice: "", askPrice: "",
  operator: "", rrc: "", acreageNma: "", basins: [], formations: [], sameTimeline: true, dateUnderContract: "",
});
// Same required set as a standalone deal (Date Under Contract may be shared).
function assetMissing(a: AssetRow): string[] {
  const m: string[] = [];
  if (!a.name.trim()) m.push("Deal Name");
  if (!a.states.length) m.push("State");
  if (!a.counties.length) m.push("County");
  if (!a.abstractIds.length) m.push("Abstract");
  if (!a.assetTypes.length) m.push("Asset Type");
  if (a.nra.trim() === "") m.push("NRA");
  if (a.ourPrice.trim() === "") m.push("Our Price");
  if (!a.sameTimeline && !a.dateUnderContract) m.push("Date Under Contract");
  return m;
}

/**
 * Create a deal — or, when `parentDealId` is passed, add a child asset under an
 * existing seller transaction. Either way the form is the full deal form with
 * the same required fields. During top-level creation the user can also add one
 * or more additional assets (each an identical full deal form) before saving, so
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

  // The primary form uses the full standalone-deal required set (identical in
  // add-asset mode).
  const missing: string[] = [];
  if (!f.name.trim()) missing.push("Deal Name");
  if (!states.length) missing.push("State");
  if (!counties.length) missing.push("County");
  if (!abstractIds.length) missing.push("Abstract");
  if (!assetTypes.length) missing.push("Asset Type");
  if (f.nra.trim() === "") missing.push("NRA");
  if (f.ourPrice.trim() === "") missing.push("Our Price");
  if (!f.dateUnderContract) missing.push("Date Under Contract");

  const assetErrors = assets.map(assetMissing);
  const anyAssetIncomplete = assetErrors.some((e) => e.length > 0);

  const patchAsset = (i: number, patch: Partial<AssetRow>) =>
    setAssets((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  async function submit() {
    if (missing.length) { setError(`Required: ${missing.join(", ")}`); return; }
    if (anyAssetIncomplete) {
      const i = assetErrors.findIndex((e) => e.length > 0);
      setError(`Asset ${i + 1} is missing: ${assetErrors[i].join(", ")}`);
      return;
    }
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
        // New-deal mode: additional child assets created alongside this deal —
        // each a full deal record; timeline defaults to the deal's.
        ...(!asset && assets.length
          ? {
              assets: assets.map((a) => ({
                name: a.name.trim(),
                states: a.states, state: a.states[0] ?? null,
                counties: a.counties, abstractIds: a.abstractIds,
                assetTypes: a.assetTypes, basins: a.basins, formations: a.formations,
                nra: numOrNull(a.nra), ourPrice: numOrNull(a.ourPrice), askPrice: numOrNull(a.askPrice),
                operator: a.operator || null, rrc: a.rrc || null, acreageNma: numOrNull(a.acreageNma),
                dateUnderContract: a.sameTimeline ? (f.dateUnderContract || null) : (a.dateUnderContract || null),
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
          <button className="primary" onClick={submit} disabled={busy || missing.length > 0 || anyAssetIncomplete}>
            {busy ? "Saving…" : asset ? "Add asset" : assets.length ? `Create deal + ${assets.length} asset${assets.length > 1 ? "s" : ""}` : "Create deal"}
          </button>
        </>
      }
    >
      {asset ? (
        <p className="muted" style={{ marginTop: 0 }}>
          This asset is added under the seller transaction — the same full deal form. Fields marked {req} are required.
          It's independently marketable.
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          New deals start in <strong>Under Contract</strong>. Fields marked {req} are required.
          Add sellers afterward in the deal's <strong>Seller Details</strong> section.
        </p>
      )}
      <div className="field"><label>{asset ? "Asset" : "Deal"} Name {req}</label><input value={f.name} onChange={set("name")} autoFocus /></div>
      <div className="dd-grid">
        <GeoFields
          states={states} onStatesChange={setStates}
          counties={counties} onCountiesChange={setCounties}
          abstractIds={abstractIds} onAbstractsChange={setAbstractIds}
          labels={{ state: "State *", county: "County *", abstract: "Abstract *" }}
        />
        <div className="field"><label>Asset Type {req}</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
        <div className="field"><label>NRA {req}</label><input type="number" value={f.nra} onChange={set("nra")} /></div>
        <div className="field"><label>Our Price (acquisition cost) {req}</label><input type="number" value={f.ourPrice} onChange={set("ourPrice")} /></div>
        <div className="field"><label>Date Under Contract {req}</label><input type="date" value={f.dateUnderContract} onChange={set("dateUnderContract")} /></div>
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

      {/* Multi-asset seller: additional interests acquired from the same seller.
          Each is an identical full deal form and becomes an independently-
          marketable child asset grouped under this seller transaction. */}
      {!asset && (
        <div className="nd-assets">
          <div className="nd-assets-head">
            <div>
              <strong>Additional assets under this seller</strong>
              <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>optional — each is a full deal, marketable separately</span>
            </div>
            <button type="button" className="small" onClick={() => setAssets((r) => [...r, emptyAsset()])}>+ Add asset</button>
          </div>
          {assets.map((a, i) => (
            <AssetCard
              key={i}
              index={i}
              a={a}
              req={req}
              onPatch={(patch) => patchAsset(i, patch)}
              onRemove={() => setAssets((r) => r.filter((_, idx) => idx !== i))}
            />
          ))}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

/** One additional asset — the identical full deal form as a compact card. */
function AssetCard({ index, a, req, onPatch, onRemove }: {
  index: number; a: AssetRow; req: React.ReactNode; onPatch: (patch: Partial<AssetRow>) => void; onRemove: () => void;
}) {
  return (
    <div className="nd-asset-card">
      <div className="nd-asset-card-head">
        <strong>Asset {index + 1}</strong>
        <button type="button" className="nd-asset-del" title="Remove asset" onClick={onRemove}>×</button>
      </div>
      <div className="field"><label>Deal Name {req}</label><input value={a.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder={`Asset ${index + 1}`} /></div>
      <div className="dd-grid">
        <GeoFields
          states={a.states} onStatesChange={(v) => onPatch({ states: v })}
          counties={a.counties} onCountiesChange={(v) => onPatch({ counties: v })}
          abstractIds={a.abstractIds} onAbstractsChange={(v) => onPatch({ abstractIds: v })}
          labels={{ state: "State *", county: "County *", abstract: "Abstract *" }}
        />
        <div className="field"><label>Asset Type {req}</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={a.assetTypes} onChange={(v) => onPatch({ assetTypes: v })} placeholder="Search asset types…" /></div>
        <div className="field"><label>NRA {req}</label><input type="number" value={a.nra} onChange={(e) => onPatch({ nra: e.target.value })} /></div>
        <div className="field"><label>Our Price {req}</label><input type="number" value={a.ourPrice} onChange={(e) => onPatch({ ourPrice: e.target.value })} /></div>
        <div className="field"><label>Basin</label><SearchableMultiSelect options={suggestFirst(TEXAS_BASIN_OPTIONS, basinsForCounties(a.counties))} value={a.basins} onChange={(v) => onPatch({ basins: v })} placeholder="Search basins…" /></div>
        <div className="field"><label>Formation</label><SearchableMultiSelect options={suggestFirst(TEXAS_FORMATION_OPTIONS, formationsForCounties(a.counties))} value={a.formations} onChange={(v) => onPatch({ formations: v })} placeholder="Search formations…" /></div>
        <div className="field"><label>Operator</label><input value={a.operator} onChange={(e) => onPatch({ operator: e.target.value })} /></div>
        <div className="field"><label>RRC</label><input value={a.rrc} onChange={(e) => onPatch({ rrc: e.target.value })} placeholder="RRC lease / district / operator no." /></div>
        <div className="field"><label>NMA</label><input type="number" value={a.acreageNma} onChange={(e) => onPatch({ acreageNma: e.target.value })} /></div>
        <div className="field"><label>Ask Price (to buyers)</label><input type="number" value={a.askPrice} onChange={(e) => onPatch({ askPrice: e.target.value })} /></div>
      </div>
      {/* Contract timeline: shared with the deal by default; untick for its own. */}
      <div className="nd-asset-timeline">
        <label className="nd-asset-same">
          <input type="checkbox" checked={a.sameTimeline} onChange={(e) => onPatch({ sameTimeline: e.target.checked })} />
          <span>Same contract timeline as the deal</span>
        </label>
        {!a.sameTimeline && (
          <div className="field" style={{ marginBottom: 0 }}><label>Date Under Contract {req}</label><input type="date" value={a.dateUnderContract} onChange={(e) => onPatch({ dateUnderContract: e.target.value })} /></div>
        )}
      </div>
    </div>
  );
}
