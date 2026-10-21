import { useState } from "react";
import { Modal, Req } from "./ui";
import { api, ApiError } from "../api/client";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { GeoFields } from "./GeoFields";
import { SurveyMultiPicker } from "./AbstractPicker";
import { Select } from "./Select";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS, basinsForCounties, formationsForCounties, suggestFirst } from "../lib/options";
import { OWNERSHIP_STATUSES, PRODUCING_STATUSES, LEASE_STATUS_OPTIONS } from "../lib/assetOptions";
import type { DealSummary } from "../types";
import { MoneyInput } from "./MoneyInput";
import { DateField } from "./DateField";
import { OperatorSelect } from "./OperatorSelect";
import { money } from "../lib/format";
import { royaltyValue } from "../lib/royalty";
import { FormSection } from "./kit";
import { SectionRail, useSectionRail } from "./SectionRail";
import {
  applyAcreageEdit, AcreageNote, editPriceGroup, emptyPriceGroup, PriceNote, RoyaltyRateField, royaltyRateError, syncPriceGroup,
  type AcreSource, type PriceField, type PriceGroup,
} from "./DealEconomics";

const numOrNull = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// The form's sections, in order, as listed in the left rail (a step strip on
// phones) — the same shell as New Deal. A required section is complete once
// none of its fields appear in the form's `missing` list.
type SecKey = "basics" | "location" | "economics" | "cost" | "valuation" | "lease" | "notes";
const SECTIONS: { key: SecKey; label: string; fields?: string[] }[] = [
  { key: "basics", label: "Basics", fields: ["Asset Name", "Asset Type"] },
  { key: "location", label: "Location", fields: ["State", "County", "Abstract", "Survey"] },
  { key: "economics", label: "Interest & acreage", fields: ["NMA or NRA"] },
  { key: "cost", label: "Acquisition" },
  { key: "valuation", label: "Valuation" },
  { key: "lease", label: "Current lease" },
  { key: "notes", label: "Notes" },
];

/**
 * Create an owned mineral asset — the New Deal form's shell, components and
 * rules (geography chain, royalty-rate ↔ NMA/NRA conversion, a price typed as
 * a total or per acre) around the asset's own fields: ownership and producing
 * status, acquisition date and purchase price, current/book value and the
 * current lease. No seller-acquisition timeline or asking price: those belong
 * to a deal (and to the asset's Sell tab once it is marked for sale).
 */
export function NewAssetModal({ onClose, onCreated }: { onClose: () => void; onCreated: (d: DealSummary) => void }) {
  const [f, setF] = useState({
    name: "", operator: "", rrc: "",
    acreageNma: "", nra: "", royaltyRate: "",
    netRevenueInterest: "", workingInterest: "",
    acquisitionDate: "", currentValue: "", bookValue: "",
    leaseEffectiveDate: "", leaseExpirationDate: "", notes: "",
  });
  const [ownershipStatus, setOwnershipStatus] = useState("");
  const [producingStatus, setProducingStatus] = useState("");
  const [leaseStatuses, setLeaseStatuses] = useState<string[]>([]);
  // NMA ↔ NRA follow each other through the royalty rate; this is the one the
  // user typed (the other is calculated) — identical to New Deal.
  const [acreSource, setAcreSource] = useState<AcreSource>(null);
  const acre = { nma: f.acreageNma, nra: f.nra, royaltyRate: f.royaltyRate, source: acreSource };
  // Purchase price: total, per NMA and per NRA stay in step.
  const [cost, setCost] = useState<PriceGroup>(emptyPriceGroup);
  const editAcreage = (edit: { nma?: string; nra?: string; royaltyRate?: string }) => {
    const next = applyAcreageEdit(acre, edit);
    setAcreSource(next.source);
    setF((p) => ({ ...p, acreageNma: next.nma, nra: next.nra, royaltyRate: next.royaltyRate }));
    setCost((g) => syncPriceGroup(g, numOrNull(next.nma), numOrNull(next.nra), royaltyValue(next.royaltyRate)));
  };
  const [states, setStates] = useState<string[]>([]);
  const [counties, setCounties] = useState<string[]>([]);
  const [abstractIds, setAbstractIds] = useState<string[]>([]);
  const [surveys, setSurveys] = useState<string[]>([]);
  const [basins, setBasins] = useState<string[]>([]);
  const [formations, setFormations] = useState<string[]>([]);
  const [assetTypes, setAssetTypes] = useState<string[]>([]);
  const [wells, setWells] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const nma = numOrNull(f.acreageNma), nra = numOrNull(f.nra);
  const purchasePrice = numOrNull(cost.total);
  const currentValue = numOrNull(f.currentValue);
  const editCost = (field: PriceField) => (v: string) => setCost((g) => editPriceGroup(g, field, v, nma, nra, royaltyValue(f.royaltyRate)));

  // Required set: the deal's identity + geography + acreage bar, with the
  // survey (an asset is a specific tract) and without a contract timeline.
  const missing: string[] = [];
  if (!f.name.trim()) missing.push("Asset Name");
  if (!states.length) missing.push("State");
  if (!counties.length) missing.push("County");
  if (!abstractIds.length) missing.push("Abstract");
  if (!surveys.length) missing.push("Survey");
  if (!assetTypes.length) missing.push("Asset Type");
  if (f.nra.trim() === "" && f.acreageNma.trim() === "") missing.push("NMA or NRA");

  const sections = SECTIONS;
  const isDone = (k: SecKey) => {
    const fields = SECTIONS.find((x) => x.key === k)?.fields;
    return !!fields && !fields.some((m) => missing.includes(m));
  };
  const { sec, goSec, formRef, railRef, onFormScroll } = useSectionRail<SecKey>("basics");

  // Decimal interests are fractions 0–1 (0.1875 = 18.75%), as the server stores them.
  const interestError = (label: string, v: string): string | null => {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? null : `${label}: enter a decimal between 0 and 1 (0.1875 = 18.75%)`;
  };

  async function submit() {
    if (missing.length) { setError(`Required: ${missing.join(", ")}`); return; }
    const royaltyErr = royaltyRateError(f.royaltyRate);
    if (royaltyErr) { setError(`Royalty rate: ${royaltyErr}`); return; }
    const nriErr = interestError("Net revenue interest", f.netRevenueInterest) ?? interestError("Working interest", f.workingInterest);
    if (nriErr) { setError(nriErr); return; }
    setBusy(true);
    setError(null);
    try {
      const d = await api.post<DealSummary>("/deals", {
        name: f.name.trim(),
        recordType: "OWNED_ASSET",
        assetMode: "HOLD",
        states, state: states[0] ?? null,
        counties, basins, formations, assetTypes, abstractIds, surveys, wells,
        operator: f.operator || null,
        rrc: f.rrc || null,
        acreageNma: nma,
        nra,
        royaltyRate: f.royaltyRate || null,
        netRevenueInterest: numOrNull(f.netRevenueInterest),
        workingInterest: numOrNull(f.workingInterest),
        ownershipStatus: ownershipStatus || null,
        producingStatus: producingStatus || null,
        acquisitionDate: f.acquisitionDate || null,
        // Purchase price is the asset's cost basis (per-acre figures are a way
        // to enter it; the stored basis is the total, shown per acre on the page).
        purchasePrice,
        currentValue,
        bookValue: numOrNull(f.bookValue),
        leaseStatuses,
        leaseEffectiveDate: f.leaseEffectiveDate || null,
        leaseExpirationDate: f.leaseExpirationDate || null,
        notes: f.notes || null,
      });
      onCreated(d);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create the asset");
    } finally {
      setBusy(false);
    }
  }

  const req = <Req />;
  const dirty = Object.values(f).some((v) => v.trim() !== "") || cost.total !== "" || cost.perNma !== "" || cost.perNra !== ""
    || states.length > 0 || counties.length > 0 || assetTypes.length > 0 || leaseStatuses.length > 0;
  return (
    <Modal
      title="New mineral asset"
      subtitle={<>Added to your portfolio on <strong>Hold</strong> · mark it for sale any time from its page</>}
      onClose={onClose}
      wide
      dirty={dirty}
      footer={
        <>
          <div className="nd-sum">
            <div className="nd-sum-item"><span>Purchase price</span><b className={purchasePrice == null ? "empty" : undefined}>{money(purchasePrice)}</b></div>
            <div className="nd-sum-item"><span>Current value</span><b className={currentValue == null ? "empty" : undefined}>{money(currentValue)}</b></div>
          </div>
          <div className="nd-foot-actions">
            <span className="nd-left">
              <span className="modal-req-note"><Req /> Required</span>
              {missing.length > 0 && <span>{missing.length} required field{missing.length === 1 ? "" : "s"} left</span>}
            </span>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={submit} disabled={busy || missing.length > 0}
              title={missing.length ? "Enabled once required fields are filled" : undefined}>
              {busy ? "Saving…" : "Create asset"}
            </button>
          </div>
        </>
      }
    >
      <div className="nd-shell">
        <SectionRail sections={sections.map((x) => ({ key: x.key, label: x.label, required: !!x.fields }))}
          active={sec} isDone={isDone} onPick={goSec} railRef={railRef} />

        <div className="nd-form" ref={formRef} onScroll={onFormScroll}>
          <div data-sec="basics">
            <FormSection title="Basics">
              <div className="nd-basics">
                <div className="field" style={{ gridColumn: "1 / -1" }}><label>Asset name {req}</label><input value={f.name} onChange={set("name")} autoFocus placeholder="e.g. Smith Unit Royalty · Midland Co." /></div>
                <div className="field"><label>Asset type {req}</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
                <div className="field"><label>Ownership status</label><Select value={ownershipStatus} onChange={setOwnershipStatus} placeholder="Select…" clearable ariaLabel="Ownership status" options={OWNERSHIP_STATUSES.map((t) => ({ value: t, label: t }))} /></div>
                <div className="field"><label>Producing status</label><Select value={producingStatus} onChange={setProducingStatus} placeholder="Select…" clearable ariaLabel="Producing status" options={PRODUCING_STATUSES.map((t) => ({ value: t, label: t }))} /></div>
              </div>
            </FormSection>
          </div>

          <div data-sec="location">
            <FormSection title="Location" hint="State → County → Abstract → Survey, the same chain as a deal.">
              <div className="nd-grid3">
                <GeoFields
                  states={states} onStatesChange={setStates}
                  counties={counties} onCountiesChange={setCounties}
                  abstractIds={abstractIds} onAbstractsChange={setAbstractIds}
                  labels={{ state: <>State {req}</>, county: <>County {req}</>, abstract: <>Abstract {req}</> }}
                />
                <div className="field"><label>Survey {req}</label><SurveyMultiPicker value={surveys} onChange={setSurveys} abstractIds={abstractIds} /></div>
                <div className="field"><label>Basin</label><SearchableMultiSelect options={suggestFirst(TEXAS_BASIN_OPTIONS, basinsForCounties(counties))} value={basins} onChange={setBasins} placeholder={counties.length ? "Suggested for your counties first…" : "Search basins…"} /></div>
                <div className="field"><label>Formation</label><SearchableMultiSelect options={suggestFirst(TEXAS_FORMATION_OPTIONS, formationsForCounties(counties))} value={formations} onChange={setFormations} placeholder={counties.length ? "Suggested for your counties first…" : "Search formations…"} /></div>
                <div className="field"><label title="Operators active in the selected state and county">Operator</label>
                  <OperatorSelect states={states} counties={counties} value={f.operator} onChange={(v) => setF((p) => ({ ...p, operator: v }))} />
                </div>
                <div className="field"><label>Wells</label><SearchableMultiSelect options={[]} value={wells} onChange={setWells} placeholder="Type a well name or API, Enter" /></div>
                <div className="field"><label>RRC</label><input value={f.rrc} onChange={set("rrc")} placeholder="RRC number" /></div>
              </div>
            </FormSection>
          </div>

          <div data-sec="economics">
            <FormSection title="Interest & acreage" hint="NMA or NRA: at least one required (NMA alone for unleased acreage). With a royalty rate, either one calculates the other.">
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
                <div className="field"><label title="Decimal interest between 0 and 1 (0.1875 = 18.75%)">Net revenue interest</label><input type="number" step="any" min={0} max={1} value={f.netRevenueInterest} onChange={set("netRevenueInterest")} placeholder="e.g. 0.1875" /></div>
                <div className="field"><label title="Decimal interest between 0 and 1 (working-interest assets only)">Working interest</label><input type="number" step="any" min={0} max={1} value={f.workingInterest} onChange={set("workingInterest")} placeholder="e.g. 0.25" /></div>
              </div>
            </FormSection>
          </div>

          <div data-sec="cost">
            <FormSection title="Acquisition" hint="What you paid. Enter any one of the total, per NMA or per NRA; the others are calculated from the acreage above.">
              <div className="nd-grid3">
                <div className="field"><label>Price per NMA</label><MoneyInput decimals={2} value={cost.perNma} onChange={editCost("perNma")} ariaLabel="Purchase price per NMA" placeholder="0.00" /></div>
                <div className="field"><label>Price per NRA</label><MoneyInput decimals={2} value={cost.perNra} onChange={editCost("perNra")} ariaLabel="Purchase price per NRA" placeholder="0.00" /></div>
                <div className="field"><label title="Cost basis for ROI and unrealized gain">Purchase price</label>
                  <MoneyInput value={cost.total} onChange={editCost("total")} decimals={2} ariaLabel="Purchase price" placeholder="0" />
                  <PriceNote g={cost} />
                </div>
                <div className="field"><label>Acquisition date</label><DateField value={f.acquisitionDate} onChange={(v) => setF((p) => ({ ...p, acquisitionDate: v }))} /></div>
              </div>
            </FormSection>
          </div>

          <div data-sec="valuation">
            <FormSection title="Valuation" hint="Current value drives ROI and unrealized gain; book value, when set, is the gain's basis instead of the purchase price.">
              <div className="nd-grid3">
                <div className="field"><label>Current estimated value</label><MoneyInput value={f.currentValue} onChange={(v) => setF((p) => ({ ...p, currentValue: v }))} ariaLabel="Current estimated value" placeholder="0" /></div>
                <div className="field"><label>Book value</label><MoneyInput value={f.bookValue} onChange={(v) => setF((p) => ({ ...p, bookValue: v }))} ariaLabel="Book value" placeholder="0" /></div>
              </div>
            </FormSection>
          </div>

          <div data-sec="lease">
            <FormSection title="Current lease" hint="Optional now; the asset page tracks lease terms and expiration reminders.">
              <div className="nd-grid3">
                <div className="field"><label>Lease status</label><SearchableMultiSelect options={LEASE_STATUS_OPTIONS} value={leaseStatuses} onChange={setLeaseStatuses} placeholder="Select lease status…" /></div>
                <div className="field"><label>Lease effective date</label><DateField value={f.leaseEffectiveDate} onChange={(v) => setF((p) => ({ ...p, leaseEffectiveDate: v }))} /></div>
                <div className="field"><label>Lease expiration date</label><DateField value={f.leaseExpirationDate} onChange={(v) => setF((p) => ({ ...p, leaseExpirationDate: v }))} /></div>
              </div>
            </FormSection>
          </div>

          <div data-sec="notes">
            <FormSection title="Notes">
              <div className="field nd-notes"><label>Notes</label><textarea rows={3} value={f.notes} onChange={set("notes")} placeholder="Anything worth remembering about this asset…" /></div>
            </FormSection>
          </div>
        </div>
      </div>
      {error && <div className="error-text nd-error" role="alert">{error}</div>}
    </Modal>
  );
}
