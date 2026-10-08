import { useEffect, useRef, useState } from "react";
import { Modal, Req } from "./ui";
import { api, ApiError } from "../api/client";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { GeoFields } from "./GeoFields";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS, basinsForCounties, formationsForCounties, suggestFirst } from "../lib/options";
import type { DealSummary } from "../types";
import { MoneyInput } from "./MoneyInput";
import { DateField } from "./DateField";
import { OperatorSelect } from "./OperatorSelect";
import { findBuyerByOffsetDays } from "../lib/perAcre";
import { fmtDate, money } from "../lib/format";
import { FormSection } from "./kit";
import {
  addDaysIso, applyAcreageEdit, AcreageNote, DaysToCloseField, editPriceGroup, emptyPriceGroup, PriceNote, RoyaltyRateField, royaltyRateError, syncPriceGroup,
  type AcreSource, type PriceField, type PriceGroup,
} from "./DealEconomics";

const numOrNull = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

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
  if (a.nra.trim() === "" && a.acreageNma.trim() === "") m.push("NMA or NRA");
  if (a.ourPrice.trim() === "") m.push("Our Price");
  if (!a.sameTimeline && !a.dateUnderContract) m.push("Date Under Contract");
  return m;
}

// The form's sections, in order, as listed in the left rail (a step strip on
// phones). A required section is complete once none of its fields appear in
// the form's existing `missing` list.
type SecKey = "basics" | "location" | "economics" | "cost" | "asking" | "timeline" | "extras";
const SECTIONS: { key: SecKey; label: string; fields?: string[] }[] = [
  { key: "basics", label: "Basics", fields: ["Deal Name", "Asset Type", "Date Under Contract"] },
  { key: "location", label: "Location", fields: ["State", "County", "Abstract"] },
  { key: "economics", label: "Economics", fields: ["NMA or NRA"] },
  { key: "cost", label: "Acquisition cost", fields: ["Acquisition Cost"] },
  { key: "asking", label: "Asking price" },
  { key: "timeline", label: "Timeline & notes" },
  { key: "extras", label: "Additional deals" },
];

const CheckIcon = ({ size = 9 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

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
    acreageNma: "", nra: "", estimatedClosingCosts: "",
    daysToClose: "", royaltyRate: "",
    dateUnderContract: "", originalClosingDate: "", notes: "",
  });
  // Closing follows Date Under Contract + Days to Close until the user
  // picks a closing date themselves.
  const [closingManual, setClosingManual] = useState(false);
  // NMA ↔ NRA follow each other through the royalty rate; this is the one the
  // user typed (the other is calculated).
  const [acreSource, setAcreSource] = useState<AcreSource>(null);
  const acre = { nma: f.acreageNma, nra: f.nra, royaltyRate: f.royaltyRate, source: acreSource };
  // Our Cost / Asking Price: total, per NMA and per NRA stay in step — the
  // figure the user typed drives the other two (see DealEconomics).
  const [cost, setCost] = useState<PriceGroup>(emptyPriceGroup);
  const [ask, setAsk] = useState<PriceGroup>(emptyPriceGroup);
  const editAcreage = (edit: { nma?: string; nra?: string; royaltyRate?: string }) => {
    const next = applyAcreageEdit(acre, edit);
    setAcreSource(next.source);
    setF((p) => ({ ...p, acreageNma: next.nma, nra: next.nra, royaltyRate: next.royaltyRate }));
    const m = numOrNull(next.nma), r = numOrNull(next.nra);
    setCost((g) => syncPriceGroup(g, m, r));
    setAsk((g) => syncPriceGroup(g, m, r));
  };
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

  const nma = numOrNull(f.acreageNma), nra = numOrNull(f.nra);
  const ourPrice = numOrNull(cost.total);
  const askPrice = numOrNull(ask.total);
  const editCost = (field: PriceField) => (v: string) => setCost((g) => editPriceGroup(g, field, v, nma, nra));
  const editAsk = (field: PriceField) => (v: string) => setAsk((g) => editPriceGroup(g, field, v, nma, nra));

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
  if (f.nra.trim() === "" && f.acreageNma.trim() === "") missing.push("NMA or NRA");
  if (ourPrice == null) missing.push("Acquisition Cost");
  if (!f.dateUnderContract) missing.push("Date Under Contract");

  const assetErrors = assets.map(assetMissing);
  const anyAssetIncomplete = assetErrors.some((e) => e.length > 0);

  const patchAsset = (i: number, patch: Partial<AssetRow>) =>
    setAssets((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Section rail: progress from the required checks above, click-to-jump, and
  // a scroll-spy that follows the form as it scrolls.
  const sections = SECTIONS.filter((x) => !(asset && x.key === "extras"));
  const isDone = (k: SecKey) => {
    const fields = SECTIONS.find((x) => x.key === k)?.fields;
    return !!fields && !fields.some((m) => missing.includes(m));
  };
  const requiredSecs = sections.filter((x) => x.fields);
  const reqDone = requiredSecs.filter((x) => isDone(x.key)).length;
  const fieldsLeft = missing.length + assetErrors.reduce((n, e) => n + e.length, 0);
  const [sec, setSec] = useState<SecKey>("basics");
  const formRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const spyLock = useRef(0);
  const goSec = (k: SecKey) => {
    const pane = formRef.current;
    const el = pane?.querySelector<HTMLElement>(`[data-sec="${k}"]`);
    spyLock.current = Date.now() + 700;
    if (pane && el) pane.scrollTo({ top: Math.max(0, el.offsetTop - 4), behavior: "smooth" });
    setSec(k);
  };
  const onFormScroll = () => {
    const pane = formRef.current;
    if (!pane || Date.now() < spyLock.current) return;
    const els = [...pane.querySelectorAll<HTMLElement>("[data-sec]")];
    let cur = els[0]?.dataset.sec;
    for (const el of els) if (el.offsetTop - 80 <= pane.scrollTop) cur = el.dataset.sec;
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4) cur = els[els.length - 1]?.dataset.sec;
    if (cur && cur !== sec) setSec(cur as SecKey);
  };
  // On phones the rail is a sideways strip: keep the active step in view.
  useEffect(() => {
    const list = railRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-rail="${sec}"]`);
    if (!list || !item || list.scrollWidth <= list.clientWidth) return;
    list.scrollTo({ left: item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2, behavior: "smooth" });
  }, [sec]);

  async function submit() {
    if (missing.length) { setError(`Required: ${missing.join(", ")}`); return; }
    const royaltyErr = royaltyRateError(f.royaltyRate);
    if (royaltyErr) { setError(`Royalty rate: ${royaltyErr}`); return; }
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
        ourCostPerNma: numOrNull(cost.perNma),
        ourCostPerNra: numOrNull(cost.perNra),
        askPricePerNma: numOrNull(ask.perNma),
        askPricePerNra: numOrNull(ask.perNra),
        daysToClose,
        royaltyRate: f.royaltyRate || null,
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
      title={asset ? "Add deal" : "New deal"}
      subtitle={asset
        ? <>Added under the same seller — the full deal form, independently marketable</>
        : <>Starts in <strong>Under Contract</strong> · add sellers later in Seller Details</>}
      onClose={onClose}
      wide
      dirty={Object.values(f).some((v) => v.trim() !== "") || [cost.perNma, cost.perNra, cost.total, ask.perNma, ask.perNra, ask.total].some((v) => v !== "") || states.length > 0 || counties.length > 0 || assetTypes.length > 0}
      footer={
        <>
          <div className="nd-sum">
            <div className="nd-sum-item"><span>Acquisition cost</span><b className={ourPrice == null ? "empty" : undefined}>{money(ourPrice)}</b></div>
            <div className="nd-sum-item"><span>Asking price</span><b className={askPrice == null ? "empty" : undefined}>{money(askPrice)}</b></div>
          </div>
          <div className="nd-foot-actions">
            <span className="nd-left">
              <span className="modal-req-note"><Req /> Required</span>
              {fieldsLeft > 0 && <span>{fieldsLeft} required field{fieldsLeft === 1 ? "" : "s"} left</span>}
            </span>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={submit} disabled={busy || missing.length > 0 || anyAssetIncomplete}
              title={missing.length ? "Enabled once required fields are filled" : undefined}>
              {busy ? "Saving…" : asset ? "Add deal" : assets.length ? `Create deal + ${assets.length} more` : "Create deal"}
            </button>
          </div>
        </>
      }
    >
      <div className="nd-shell">
        <nav className="nd-rail" aria-label="Form sections">
          <div className="nd-rail-list" ref={railRef}>
            {sections.map((x) => {
              const done = isDone(x.key);
              const active = sec === x.key;
              return (
                <button type="button" key={x.key} data-rail={x.key} onClick={() => goSec(x.key)}
                  className={`nd-rail-item${active ? " active" : ""}`} aria-current={active ? "step" : undefined}>
                  <span className={`nd-ring ${done ? "done" : x.fields ? "req" : "opt"}`} aria-hidden="true">{done && <CheckIcon />}</span>
                  <span className="nd-rail-label">{x.label}</span>
                  {!x.fields && <span className="nd-rail-opt">Optional</span>}
                </button>
              );
            })}
          </div>
          <div className="nd-progress">
            <div className="nd-progress-bar" aria-hidden="true">
              {requiredSecs.map((x, i) => <span key={x.key} className={i < reqDone ? "done" : undefined} />)}
            </div>
            <span>{reqDone} of {requiredSecs.length} required sections</span>
          </div>
        </nav>

        <div className="nd-form" ref={formRef} onScroll={onFormScroll}>
          <div data-sec="basics">
            <FormSection title="Basics">
              <div className="nd-basics">
                <div className="field" style={{ gridColumn: "1 / -1" }}><label>Deal name {req}</label><input value={f.name} onChange={set("name")} autoFocus placeholder="e.g. Terry Casey · Reeves Co." /></div>
                <div className="field"><label>Asset type {req}</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
                <div className="field"><label>Date under contract {req}</label><DateField value={f.dateUnderContract} onChange={(v) => setF((p) => ({ ...p, dateUnderContract: v }))} /></div>
              </div>
            </FormSection>
          </div>

          <div data-sec="location">
            <FormSection title="Location">
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
            </FormSection>
          </div>

          <div data-sec="economics">
            <FormSection title="Economics" hint="NMA or NRA: at least one required (NMA alone for unleased acreage). With a royalty rate, either one calculates the other.">
              <div className="nd-grid3">
                <div className="field"><label title="Converts between NMA and NRA (NRA = NMA × royalty ÷ 1/8)">Royalty rate</label>
                  <RoyaltyRateField value={f.royaltyRate} onChange={(v) => editAcreage({ royaltyRate: v })} />
                </div>
                <div className="field"><label title="Net Mineral Acres · required unless NRA is provided">NMA {req}</label>
                  <input type="number" value={f.acreageNma} onChange={(e) => editAcreage({ nma: e.target.value })} placeholder="0.00" aria-label="NMA" />
                  <AcreageNote s={acre} field="nma" />
                </div>
                <div className="field"><label title="Net Royalty Acres · required unless NMA is provided">NRA {req}</label>
                  <input type="number" value={f.nra} onChange={(e) => editAcreage({ nra: e.target.value })} placeholder="0.00" aria-label="NRA" />
                  <AcreageNote s={acre} field="nra" />
                </div>
                <div className="field"><label>RRC</label><input value={f.rrc} onChange={set("rrc")} placeholder="RRC number" /></div>
              </div>
            </FormSection>
          </div>

          <div data-sec="cost">
            <FormSection title="Acquisition cost" hint="Enter any one: the total, per NMA or per NRA. The others are calculated from the acreage above.">
              <div className="nd-grid3">
                <div className="field"><label>Our cost per NMA</label><MoneyInput decimals={2} value={cost.perNma} onChange={editCost("perNma")} ariaLabel="Our cost per NMA" placeholder="0.00" /></div>
                <div className="field"><label>Our cost per NRA</label><MoneyInput decimals={2} value={cost.perNra} onChange={editCost("perNra")} ariaLabel="Our cost per NRA" placeholder="0.00" /></div>
                <div className="field"><label title="Our price — what the property is under contract for">Acquisition cost {req}</label>
                  <MoneyInput value={cost.total} onChange={editCost("total")} ariaLabel="Acquisition cost" placeholder="0" />
                  <PriceNote g={cost} />
                </div>
              </div>
            </FormSection>
          </div>

          <div data-sec="asking">
            <FormSection title="Asking price" hint="To buyers. Enter any one of the total, per NMA or per NRA.">
              <div className="nd-grid3">
                <div className="field"><label>Asking price per NMA</label><MoneyInput decimals={2} value={ask.perNma} onChange={editAsk("perNma")} ariaLabel="Asking price per NMA" placeholder="0.00" /></div>
                <div className="field"><label>Asking price per NRA</label><MoneyInput decimals={2} value={ask.perNra} onChange={editAsk("perNra")} ariaLabel="Asking price per NRA" placeholder="0.00" /></div>
                <div className="field"><label>Asking price</label>
                  <MoneyInput value={ask.total} onChange={editAsk("total")} ariaLabel="Asking price" placeholder="0" />
                  <PriceNote g={ask} />
                </div>
                <div className="field"><label>Est. closing costs</label><MoneyInput value={f.estimatedClosingCosts} onChange={(v) => setF((p) => ({ ...p, estimatedClosingCosts: v }))} ariaLabel="Estimated closing costs" placeholder="0" /></div>
              </div>
            </FormSection>
          </div>

          <div data-sec="timeline">
            <FormSection title="Timeline & notes">
              <div className="nd-grid3">
                <div className="field"><label title="Days from Date Under Contract to closing · pick a preset or type any number">Days to close</label>
                  <DaysToCloseField value={f.daysToClose} onChange={(v) => setF((p) => ({ ...p, daysToClose: v }))} />
                </div>
                <div className="field"><label title="Deadline to secure a buyer: Date Under Contract + every day to close beyond 30 (30 → 0 days, 60 → 30 days, 75 → 45 days)">Find buyer by</label>
                  <div className="nd-derived" aria-live="polite">
                    {findBuyerBy
                      ? <><strong>{fmtDate(findBuyerBy)}</strong><span className="muted"> · contract + {findBuyerByOffsetDays(daysToClose)} days</span></>
                      : <span className="muted">{daysToClose ? "Set Date Under Contract to calculate" : "Set Date Under Contract and Days to Close"}</span>}
                  </div>
                </div>
                <div className="field"><label title={closingManual ? undefined : "Follows Date Under Contract + Days to Close until you pick a date"}>Closing date</label>
                  <DateField value={f.originalClosingDate} onChange={(v) => { setClosingManual(v !== ""); setF((p) => ({ ...p, originalClosingDate: v })); }} />
                </div>
              </div>
              <div className="field nd-notes"><label>Notes</label><textarea rows={3} value={f.notes} onChange={set("notes")} placeholder="Anything worth remembering about this deal…" /></div>
            </FormSection>
          </div>

          {/* Additional deals under the same seller. Each is an identical full deal
              form and becomes an independently-marketable deal grouped under this
              seller. */}
          {!asset && (
            <div data-sec="extras" className="nd-assets">
              <FormSection title="Additional deals under this seller" hint="Optional. Each is a full deal, marketable separately.">
                <button type="button" className="nd-add-deal" onClick={() => setAssets((r) => [...r, emptyAsset()])}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  Add deal
                </button>
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
              </FormSection>
            </div>
          )}
        </div>
      </div>
      {error && <div className="error-text nd-error" role="alert">{error}</div>}
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
        <button type="button" className="nd-asset-del" title="Remove deal" aria-label="Remove deal" onClick={onRemove}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></svg>
        </button>
      </div>
      <div className="field"><label>Deal name {req}</label><input value={a.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder={`Deal ${index + 1}`} /></div>
      <div className="dd-grid">
        <GeoFields
          states={a.states} onStatesChange={(v) => onPatch({ states: v })}
          counties={a.counties} onCountiesChange={(v) => onPatch({ counties: v })}
          abstractIds={a.abstractIds} onAbstractsChange={(v) => onPatch({ abstractIds: v })}
          labels={{ state: <>State {req}</>, county: <>County {req}</>, abstract: <>Abstract {req}</> }}
        />
        <div className="field"><label>Asset type {req}</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={a.assetTypes} onChange={(v) => onPatch({ assetTypes: v })} placeholder="Search asset types…" /></div>
        <div className="field"><label title="Net Mineral Acres · required unless NRA is provided">NMA {req}</label><input type="number" value={a.acreageNma} onChange={(e) => onPatch({ acreageNma: e.target.value })} /></div>
        <div className="field"><label title="Net Royalty Acres · required unless NMA is provided">NRA {req}</label><input type="number" value={a.nra} onChange={(e) => onPatch({ nra: e.target.value })} /></div>
        <div className="field"><label>Our price {req}</label><input type="number" value={a.ourPrice} onChange={(e) => onPatch({ ourPrice: e.target.value })} /></div>
        <div className="field"><label>Basin</label><SearchableMultiSelect options={suggestFirst(TEXAS_BASIN_OPTIONS, basinsForCounties(a.counties))} value={a.basins} onChange={(v) => onPatch({ basins: v })} placeholder="Search basins…" /></div>
        <div className="field"><label>Formation</label><SearchableMultiSelect options={suggestFirst(TEXAS_FORMATION_OPTIONS, formationsForCounties(a.counties))} value={a.formations} onChange={(v) => onPatch({ formations: v })} placeholder="Search formations…" /></div>
        {/* Assets inherit the deal's geography when they don't set their own. */}
        <div className="field"><label>Operator</label>
          <OperatorSelect states={a.states.length ? a.states : parentStates} counties={a.counties.length ? a.counties : parentCounties} value={a.operator} onChange={(v) => onPatch({ operator: v })} ariaLabel={`Deal ${index + 1} operator`} />
        </div>
        <div className="field"><label>RRC</label><input value={a.rrc} onChange={(e) => onPatch({ rrc: e.target.value })} placeholder="RRC number" /></div>
        <div className="field"><label>Ask price (to buyers)</label><input type="number" value={a.askPrice} onChange={(e) => onPatch({ askPrice: e.target.value })} /></div>
      </div>
      {/* Contract timeline: shared with the deal by default; untick for its own. */}
      <div className="nd-asset-timeline">
        <label className="nd-asset-same">
          <input type="checkbox" checked={a.sameTimeline} onChange={(e) => onPatch({ sameTimeline: e.target.checked })} />
          <span>Same contract timeline as the deal</span>
        </label>
        {!a.sameTimeline && (
          <div className="field" style={{ marginBottom: 0 }}><label>Date under contract {req}</label><DateField value={a.dateUnderContract} onChange={(v) => onPatch({ dateUnderContract: v })} /></div>
        )}
      </div>
    </div>
  );
}
