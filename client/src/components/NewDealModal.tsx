import { useEffect, useState } from "react";
import { Modal, Req } from "./ui";
import { api, ApiError } from "../api/client";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { GeoFields } from "./GeoFields";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS, basinsForCounties, formationsForCounties, suggestFirst } from "../lib/options";
import type { DealSummary } from "../types";
import { MoneyInput } from "./MoneyInput";
import { DateField } from "./DateField";
import { OperatorSelect } from "./OperatorSelect";
import { totalFromPerAcre, findBuyerByOffsetDays } from "../lib/perAcre";
import { money, fmtDate } from "../lib/format";

const DAYS_TO_CLOSE_PRESETS = [30, 40, 50, 60, 75] as const;

/** YYYY-MM-DD + n calendar days (UTC, matching the server's date math). */
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

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
  // Either acreage measurement satisfies the requirement — unleased acreage
  // has no lease royalty interest, so NRA may not apply and NMA stands in.
  if (a.nra.trim() === "" && a.acreageNma.trim() === "") m.push("NRA or NMA");
  if (a.ourPrice.trim() === "") m.push("Our Price");
  if (!a.sameTimeline && !a.dateUnderContract) m.push("Date Under Contract");
  return m;
}

/**
 * Create a deal — or, when `parentDealId` is passed, add an additional deal under
 * an existing seller. Either way the form is the full deal form with the same
 * required fields. During top-level creation the user can also add one or more
 * additional deals (each an identical full deal form) before saving, so a
 * multi-deal seller package is created in a single step.
 */
export function NewDealModal({ onClose, onCreated, parentDealId, pipelineId }: {
  onClose: () => void;
  onCreated: (d: DealSummary) => void;
  parentDealId?: string;
  /** Pipeline the new deal enters (defaults to the org's default pipeline). */
  pipelineId?: string;
}) {
  const asset = !!parentDealId;
  const [f, setF] = useState({
    name: "", operator: "", rrc: "",
    acreageNma: "", nra: "", askPrice: "", ourPrice: "", estimatedClosingCosts: "",
    ourCostPerNma: "", ourCostPerNra: "", askPricePerNma: "", askPricePerNra: "",
    daysToClose: "",
    dateUnderContract: "", originalClosingDate: "", notes: "",
  });
  // Original closing follows Date Under Contract + Days to Close until the user
  // picks a closing date themselves.
  const [closingManual, setClosingManual] = useState(false);
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

  // A manually entered total wins; otherwise per-acre rate × the deal's acreage.
  const nma = numOrNull(f.acreageNma), nra = numOrNull(f.nra);
  const autoCost = totalFromPerAcre(numOrNull(f.ourCostPerNma), nma, numOrNull(f.ourCostPerNra), nra);
  const autoAsk = totalFromPerAcre(numOrNull(f.askPricePerNma), nma, numOrNull(f.askPricePerNra), nra);
  const ourPrice = f.ourPrice.trim() !== "" ? numOrNull(f.ourPrice) : autoCost?.total ?? null;
  const askPrice = f.askPrice.trim() !== "" ? numOrNull(f.askPrice) : autoAsk?.total ?? null;

  const daysToClose = f.daysToClose.trim() !== "" && Number(f.daysToClose) > 0 ? Math.round(Number(f.daysToClose)) : null;
  const findBuyerBy = f.dateUnderContract ? addDaysIso(f.dateUnderContract, findBuyerByOffsetDays(daysToClose)) : null;
  useEffect(() => {
    if (closingManual) return;
    const auto = f.dateUnderContract && daysToClose ? addDaysIso(f.dateUnderContract, daysToClose) : "";
    setF((p) => (p.originalClosingDate === auto ? p : { ...p, originalClosingDate: auto }));
  }, [f.dateUnderContract, daysToClose, closingManual]);

  // The primary form uses the full standalone-deal required set (identical in
  // add-asset mode).
  const missing: string[] = [];
  if (!f.name.trim()) missing.push("Deal Name");
  if (!states.length) missing.push("State");
  if (!counties.length) missing.push("County");
  if (!abstractIds.length) missing.push("Abstract");
  if (!assetTypes.length) missing.push("Asset Type");
  if (f.nra.trim() === "" && f.acreageNma.trim() === "") missing.push("NRA or NMA");
  if (ourPrice == null) missing.push("Acquisition Cost");
  if (!f.dateUnderContract) missing.push("Date Under Contract");

  const assetErrors = assets.map(assetMissing);
  const anyAssetIncomplete = assetErrors.some((e) => e.length > 0);

  const patchAsset = (i: number, patch: Partial<AssetRow>) =>
    setAssets((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  async function submit() {
    if (missing.length) { setError(`Required: ${missing.join(", ")}`); return; }
    if (anyAssetIncomplete) {
      const i = assetErrors.findIndex((e) => e.length > 0);
      setError(`Additional deal ${i + 1} is missing: ${assetErrors[i].join(", ")}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const deal = await api.post<DealSummary>("/deals", {
        name: f.name.trim(),
        pipelineId: pipelineId ?? null,
        states, state: states[0] ?? null,
        counties, basins, formations, assetTypes, abstractIds,
        operator: f.operator || null,
        rrc: f.rrc || null,
        acreageNma: numOrNull(f.acreageNma),
        nra: numOrNull(f.nra),
        askPrice,
        ourPrice,
        ourCostPerNma: numOrNull(f.ourCostPerNma),
        ourCostPerNra: numOrNull(f.ourCostPerNra),
        askPricePerNma: numOrNull(f.askPricePerNma),
        askPricePerNra: numOrNull(f.askPricePerNra),
        daysToClose,
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

  const req = <Req />;
  return (
    <Modal
      title={asset ? "Add Deal" : "New Deal"}
      subtitle={asset
        ? <>Added under the same seller — the full deal form, independently marketable</>
        : <>Starts in <strong>Under Contract</strong> · add sellers later in Seller Details</>}
      onClose={onClose}
      wide
      dirty={Object.values(f).some((v) => v.trim() !== "") || states.length > 0 || counties.length > 0 || assetTypes.length > 0}
      footer={
        <>
          <span className="modal-req-note"><Req /> Required</span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy || missing.length > 0 || anyAssetIncomplete}
            title={missing.length ? "Enabled once required fields are filled" : undefined}>
            {busy ? "Saving…" : asset ? "Add Deal" : assets.length ? `Create deal + ${assets.length} more` : "Create deal"}
          </button>
        </>
      }
    >
      <div className="modal-sec">Basics</div>
      <div className="nd-basics">
        <div className="field" style={{ gridColumn: "1 / -1" }}><label>Deal name {req}</label><input value={f.name} onChange={set("name")} autoFocus placeholder="e.g. Terry Casey — Reeves Co." /></div>
        <div className="field"><label>Asset type {req}</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
        <div className="field"><label>Date under contract {req}</label><DateField value={f.dateUnderContract} onChange={(v) => setF((p) => ({ ...p, dateUnderContract: v }))} /></div>
      </div>

      <div className="modal-sec">Location</div>
      <div className="nd-grid3">
        <GeoFields
          states={states} onStatesChange={setStates}
          counties={counties} onCountiesChange={setCounties}
          abstractIds={abstractIds} onAbstractsChange={setAbstractIds}
          labels={{ state: <>State {req}</>, county: <>County {req}</>, abstract: <>Abstract {req}</> }}
        />
        <div className="field"><label>Basin</label><SearchableMultiSelect options={suggestFirst(TEXAS_BASIN_OPTIONS, basinsForCounties(counties))} value={basins} onChange={setBasins} placeholder={counties.length ? "Suggested for your counties first…" : "Search basins…"} /></div>
        <div className="field"><label>Formation</label><SearchableMultiSelect options={suggestFirst(TEXAS_FORMATION_OPTIONS, formationsForCounties(counties))} value={formations} onChange={setFormations} placeholder={counties.length ? "Suggested for your counties first…" : "Search formations…"} /></div>
        <div className="field"><label title="Operators active in the selected state and county">Operator</label>
          <OperatorSelect states={states} counties={counties} value={f.operator} onChange={(v) => setF((p) => ({ ...p, operator: v }))} />
        </div>
      </div>

      <div className="modal-sec">Economics <span className="modal-sec-hint">— NRA or NMA: at least one required (NMA alone for unleased acreage)</span></div>
      <div className="nd-grid3">
        <div className="field"><label title="Net Royalty Acres — required unless NMA is provided">NRA {req}</label><input type="number" value={f.nra} onChange={set("nra")} placeholder="0.00" /></div>
        <div className="field"><label title="Net Mineral Acres — required unless NRA is provided">NMA {req}</label><input type="number" value={f.acreageNma} onChange={set("acreageNma")} placeholder="0.00" /></div>
        <div className="field"><label>RRC</label><input value={f.rrc} onChange={set("rrc")} placeholder="RRC Number" /></div>
      </div>

      <div className="modal-sec">Acquisition cost <span className="modal-sec-hint">— enter the total, or a per-acre cost and it's calculated from the acreage above</span></div>
      <div className="nd-grid3">
        <div className="field"><label>Our cost per NMA</label><MoneyInput decimals={2} value={f.ourCostPerNma} onChange={(v) => setF((p) => ({ ...p, ourCostPerNma: v }))} ariaLabel="Our cost per NMA" placeholder="0.00" /></div>
        <div className="field"><label>Our cost per NRA</label><MoneyInput decimals={2} value={f.ourCostPerNra} onChange={(v) => setF((p) => ({ ...p, ourCostPerNra: v }))} ariaLabel="Our cost per NRA" placeholder="0.00" /></div>
        <div className="field"><label title="Our price — what the property is under contract for">Acquisition cost {req}</label>
          <MoneyInput value={f.ourPrice} onChange={(v) => setF((p) => ({ ...p, ourPrice: v }))} ariaLabel="Acquisition cost" placeholder={autoCost ? autoCost.total.toLocaleString("en-US") : "0"} />
          <PerAcreNote auto={autoCost} manual={f.ourPrice.trim() !== ""} acres={autoCost?.basis === "NRA" ? nra : nma} rate={autoCost?.basis === "NRA" ? numOrNull(f.ourCostPerNra) : numOrNull(f.ourCostPerNma)} />
        </div>
      </div>

      <div className="modal-sec">Asking price <span className="modal-sec-hint">— to buyers; enter the total, or a per-acre price</span></div>
      <div className="nd-grid3">
        <div className="field"><label>Asking price per NMA</label><MoneyInput decimals={2} value={f.askPricePerNma} onChange={(v) => setF((p) => ({ ...p, askPricePerNma: v }))} ariaLabel="Asking price per NMA" placeholder="0.00" /></div>
        <div className="field"><label>Asking price per NRA</label><MoneyInput decimals={2} value={f.askPricePerNra} onChange={(v) => setF((p) => ({ ...p, askPricePerNra: v }))} ariaLabel="Asking price per NRA" placeholder="0.00" /></div>
        <div className="field"><label>Asking price</label>
          <MoneyInput value={f.askPrice} onChange={(v) => setF((p) => ({ ...p, askPrice: v }))} ariaLabel="Asking price" placeholder={autoAsk ? autoAsk.total.toLocaleString("en-US") : "0"} />
          <PerAcreNote auto={autoAsk} manual={f.askPrice.trim() !== ""} acres={autoAsk?.basis === "NRA" ? nra : nma} rate={autoAsk?.basis === "NRA" ? numOrNull(f.askPricePerNra) : numOrNull(f.askPricePerNma)} />
        </div>
        <div className="field"><label>Est. closing costs</label><MoneyInput value={f.estimatedClosingCosts} onChange={(v) => setF((p) => ({ ...p, estimatedClosingCosts: v }))} ariaLabel="Estimated closing costs" /></div>
      </div>

      <div className="modal-sec">Timeline &amp; notes</div>
      <div className="nd-grid3">
        <div className="field"><label title="Days from Date Under Contract to closing — pick a preset or type any number">Days to close</label>
          <div className="nd-dtc">
            <div className="seg-control" role="group" aria-label="Days to close presets">
              {DAYS_TO_CLOSE_PRESETS.map((d) => (
                <button type="button" key={d} className={`seg ${daysToClose === d ? "active" : ""}`} aria-pressed={daysToClose === d}
                  onClick={() => setF((p) => ({ ...p, daysToClose: daysToClose === d ? "" : String(d) }))}>{d}</button>
              ))}
            </div>
            <input type="number" min={1} max={3650} step={1} value={f.daysToClose} onChange={set("daysToClose")} placeholder="Other" aria-label="Days to close" />
          </div>
        </div>
        <div className="field"><label title="Deadline to secure a buyer: Date Under Contract + 15 days, plus every day to close beyond 30">Find buyer by</label>
          <div className="nd-derived" aria-live="polite">
            {findBuyerBy
              ? <><strong>{fmtDate(findBuyerBy)}</strong><span className="muted"> · contract + {findBuyerByOffsetDays(daysToClose)} days</span></>
              : <span className="muted">Set Date Under Contract to calculate</span>}
          </div>
        </div>
        <div className="field"><label title={closingManual ? undefined : "Follows Date Under Contract + Days to Close until you pick a date"}>Original closing date</label>
          <DateField value={f.originalClosingDate} onChange={(v) => { setClosingManual(v !== ""); setF((p) => ({ ...p, originalClosingDate: v })); }} />
        </div>
      </div>
      <div className="field" style={{ marginTop: 14 }}><label>Notes</label><textarea rows={2} value={f.notes} onChange={set("notes")} placeholder="Anything worth remembering about this deal…" /></div>

      {/* Additional deals under the same seller. Each is an identical full deal
          form and becomes an independently-marketable deal grouped under this
          seller. */}
      {!asset && (
        <div className="nd-assets">
          <div className="nd-assets-head">
            <div>
              <strong>Additional deals under this seller</strong>
              <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>optional — each is a full deal, marketable separately</span>
            </div>
            <button type="button" className="small" onClick={() => setAssets((r) => [...r, emptyAsset()])}>+ Add Deal</button>
          </div>
          {assets.map((a, i) => (
            <AssetCard
              key={i}
              index={i}
              a={a}
              req={req}
              parentStates={states}
              parentCounties={counties}
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

/** One additional deal — the identical full deal form as a compact card. */
function AssetCard({ index, a, req, parentStates, parentCounties, onPatch, onRemove }: {
  index: number; a: AssetRow; req: React.ReactNode; parentStates: string[]; parentCounties: string[];
  onPatch: (patch: Partial<AssetRow>) => void; onRemove: () => void;
}) {
  return (
    <div className="nd-asset-card">
      <div className="nd-asset-card-head">
        <strong>Deal {index + 1}</strong>
        <button type="button" className="nd-asset-del" title="Remove deal" onClick={onRemove}>×</button>
      </div>
      <div className="field"><label>Deal Name {req}</label><input value={a.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder={`Deal ${index + 1}`} /></div>
      <div className="dd-grid">
        <GeoFields
          states={a.states} onStatesChange={(v) => onPatch({ states: v })}
          counties={a.counties} onCountiesChange={(v) => onPatch({ counties: v })}
          abstractIds={a.abstractIds} onAbstractsChange={(v) => onPatch({ abstractIds: v })}
          labels={{ state: <>State {req}</>, county: <>County {req}</>, abstract: <>Abstract {req}</> }}
        />
        <div className="field"><label>Asset Type {req}</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={a.assetTypes} onChange={(v) => onPatch({ assetTypes: v })} placeholder="Search asset types…" /></div>
        <div className="field"><label title="Net Royalty Acres — required unless NMA is provided">NRA {req}</label><input type="number" value={a.nra} onChange={(e) => onPatch({ nra: e.target.value })} /></div>
        <div className="field"><label>Our Price {req}</label><input type="number" value={a.ourPrice} onChange={(e) => onPatch({ ourPrice: e.target.value })} /></div>
        <div className="field"><label>Basin</label><SearchableMultiSelect options={suggestFirst(TEXAS_BASIN_OPTIONS, basinsForCounties(a.counties))} value={a.basins} onChange={(v) => onPatch({ basins: v })} placeholder="Search basins…" /></div>
        <div className="field"><label>Formation</label><SearchableMultiSelect options={suggestFirst(TEXAS_FORMATION_OPTIONS, formationsForCounties(a.counties))} value={a.formations} onChange={(v) => onPatch({ formations: v })} placeholder="Search formations…" /></div>
        {/* Assets inherit the deal's geography when they don't set their own. */}
        <div className="field"><label>Operator</label>
          <OperatorSelect states={a.states.length ? a.states : parentStates} counties={a.counties.length ? a.counties : parentCounties} value={a.operator} onChange={(v) => onPatch({ operator: v })} ariaLabel={`Deal ${index + 1} operator`} />
        </div>
        <div className="field"><label>RRC</label><input value={a.rrc} onChange={(e) => onPatch({ rrc: e.target.value })} placeholder="RRC Number" /></div>
        <div className="field"><label title="Net Mineral Acres — required unless NRA is provided">NMA {req}</label><input type="number" value={a.acreageNma} onChange={(e) => onPatch({ acreageNma: e.target.value })} /></div>
        <div className="field"><label>Ask Price (to buyers)</label><input type="number" value={a.askPrice} onChange={(e) => onPatch({ askPrice: e.target.value })} /></div>
      </div>
      {/* Contract timeline: shared with the deal by default; untick for its own. */}
      <div className="nd-asset-timeline">
        <label className="nd-asset-same">
          <input type="checkbox" checked={a.sameTimeline} onChange={(e) => onPatch({ sameTimeline: e.target.checked })} />
          <span>Same contract timeline as the deal</span>
        </label>
        {!a.sameTimeline && (
          <div className="field" style={{ marginBottom: 0 }}><label>Date Under Contract {req}</label><DateField value={a.dateUnderContract} onChange={(v) => onPatch({ dateUnderContract: v })} /></div>
        )}
      </div>
    </div>
  );
}

/** Explains an auto-calculated total, or that a typed total overrides it. */
function PerAcreNote({ auto, manual, acres, rate }: {
  auto: { total: number; basis: "NMA" | "NRA" } | null; manual: boolean; acres: number | null; rate: number | null;
}) {
  if (!auto) return null;
  if (manual) return <div className="nd-calc">Manual total — overrides the per-acre {money(auto.total)}</div>;
  return (
    <div className="nd-calc auto">
      Auto: {acres?.toLocaleString("en-US")} {auto.basis} × {money(rate, { cents: true })} = <strong>{money(auto.total)}</strong>
    </div>
  );
}
