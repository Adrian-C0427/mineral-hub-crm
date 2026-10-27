import { useEffect, useState } from "react";
import { Modal, Req } from "./ui";
import { api, ApiError } from "../api/client";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { GeoFields } from "./GeoFields";
import { ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS } from "../lib/options";
import { GeoTagFields } from "./GeoTagFields";
import type { DealSummary } from "../types";
import { MoneyInput } from "./MoneyInput";
import { DateField } from "./DateField";
import { OperatorSelect } from "./OperatorSelect";
import { findBuyerByOffsetDays } from "../lib/perAcre";
import { fmtDate, money } from "../lib/format";
import { royaltyValue } from "../lib/royalty";
import { FormSection } from "./kit";
import { SectionRail, useSectionRail } from "./SectionRail";
import { SellerInformation, emptySellerInfo, sellerInfoBody, sellerInfoBlank, sellerInfoInvalid, sellerInfoMissing } from "./SellerInformation";
import {
  addDaysIso, applyAcreageEdit, AcreageNote, DaysToCloseField, editPriceGroup, emptyPriceGroup, PriceNote, RoyaltyRateField, royaltyRateError, syncPriceGroup,
  type AcreSource, type PriceField, type PriceGroup,
} from "./DealEconomics";

const numOrNull = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// The form's sections, in order, as listed in the left rail (a step strip on
// phones). A required section is complete once none of its fields appear in
// the form's existing `missing` list.
type SecKey = "basics" | "seller" | "location" | "economics" | "cost" | "asking" | "timeline";
const SECTIONS: { key: SecKey; label: string; fields?: string[] }[] = [
  { key: "basics", label: "Basics", fields: ["Deal Name", "Asset Type", "Date Under Contract"] },
  { key: "seller", label: "Seller", fields: ["Seller name", "Seller entity name"] },
  { key: "location", label: "Location", fields: ["State", "County", "Abstract"] },
  { key: "economics", label: "Economics", fields: ["NMA or NRA"] },
  { key: "cost", label: "Acquisition cost", fields: ["Acquisition Cost"] },
  { key: "asking", label: "Asking price" },
  { key: "timeline", label: "Timeline & notes" },
];

/**
 * Create a deal: the full deal form, with the seller captured up front through
 * the shared Seller Information block (an existing contact, or the details of
 * a new one — the server links the contact to the deal as its primary seller).
 */
export function NewDealModal({ onClose, onCreated, pipelineId }: {
  onClose: () => void;
  onCreated: (d: DealSummary) => void;
  /** Pipeline the new deal enters (defaults to the org's default pipeline). */
  pipelineId?: string;
}) {
  const [seller, setSeller] = useState(emptySellerInfo);
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
    const m = numOrNull(next.nma), r = numOrNull(next.nra), roy = royaltyValue(next.royaltyRate);
    setCost((g) => syncPriceGroup(g, m, r, roy));
    setAsk((g) => syncPriceGroup(g, m, r, roy));
  };
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

  const nma = numOrNull(f.acreageNma), nra = numOrNull(f.nra);
  const ourPrice = numOrNull(cost.total);
  const askPrice = numOrNull(ask.total);
  const editCost = (field: PriceField) => (v: string) => setCost((g) => editPriceGroup(g, field, v, nma, nra, royaltyValue(f.royaltyRate)));
  const editAsk = (field: PriceField) => (v: string) => setAsk((g) => editPriceGroup(g, field, v, nma, nra, royaltyValue(f.royaltyRate)));

  const daysToClose = f.daysToClose.trim() !== "" && Number(f.daysToClose) > 0 ? Math.round(Number(f.daysToClose)) : null;
  const findBuyerBy = f.dateUnderContract ? addDaysIso(f.dateUnderContract, findBuyerByOffsetDays(daysToClose)) : null;
  useEffect(() => {
    if (closingManual) return;
    const auto = f.dateUnderContract && daysToClose ? addDaysIso(f.dateUnderContract, daysToClose) : "";
    setF((p) => (p.originalClosingDate === auto ? p : { ...p, originalClosingDate: auto }));
  }, [f.dateUnderContract, daysToClose, closingManual]);

  const missing: string[] = [];
  if (!f.name.trim()) missing.push("Deal Name");
  missing.push(...sellerInfoMissing(seller));
  if (!states.length) missing.push("State");
  if (!counties.length) missing.push("County");
  if (!abstractIds.length) missing.push("Abstract");
  if (!assetTypes.length) missing.push("Asset Type");
  if (f.nra.trim() === "" && f.acreageNma.trim() === "") missing.push("NMA or NRA");
  if (ourPrice == null) missing.push("Acquisition Cost");
  if (!f.dateUnderContract) missing.push("Date Under Contract");

  // Section rail: progress from the required checks above, click-to-jump, and
  // a scroll-spy that follows the form as it scrolls.
  const sections = SECTIONS;
  const isDone = (k: SecKey) => {
    const fields = SECTIONS.find((x) => x.key === k)?.fields;
    return !!fields && !fields.some((m) => missing.includes(m));
  };
  const fieldsLeft = missing.length;
  const { sec, goSec, formRef, railRef, onFormScroll } = useSectionRail<SecKey>("basics");

  async function submit() {
    if (missing.length) { setError(`Required: ${missing.join(", ")}`); return; }
    const royaltyErr = royaltyRateError(f.royaltyRate);
    if (royaltyErr) { setError(`Royalty rate: ${royaltyErr}`); return; }
    const sellerErr = sellerInfoInvalid(seller);
    if (sellerErr.length) { setError(sellerErr.join(" · ")); return; }
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
        // The seller: an existing contact or a new one, linked by the server as
        // the deal's primary seller (Seller Details on the deal page).
        seller: sellerInfoBody(seller),
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

  const req = <Req />;
  return (
    <Modal
      title="New deal"
      subtitle={<>Starts in <strong>Under Contract</strong> · the seller becomes a linked contact</>}
      onClose={onClose}
      wide
      dirty={Object.values(f).some((v) => v.trim() !== "") || !sellerInfoBlank(seller) || [cost.perNma, cost.perNra, cost.total, ask.perNma, ask.perNra, ask.total].some((v) => v !== "") || states.length > 0 || counties.length > 0 || assetTypes.length > 0}
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
            <button className="primary" onClick={submit} disabled={busy || missing.length > 0}
              title={missing.length ? "Enabled once required fields are filled" : undefined}>
              {busy ? "Saving…" : "Create deal"}
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
                <div className="field" style={{ gridColumn: "1 / -1" }}><label>Deal name {req}</label><input value={f.name} onChange={set("name")} autoFocus placeholder="e.g. Terry Casey · Reeves Co." /></div>
                <div className="field"><label>Asset type {req}</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
                <div className="field"><label>Date under contract {req}</label><DateField value={f.dateUnderContract} onChange={(v) => setF((p) => ({ ...p, dateUnderContract: v }))} /></div>
              </div>
            </FormSection>
          </div>

          <div data-sec="seller">
            <FormSection title="Seller" hint="Who we are buying from. Pick an existing contact, or enter the seller and a contact is created and linked — one contact per seller, however many deals.">
              <SellerInformation value={seller} onChange={setSeller} req={req} />
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
                {/* Basin / Formation: suggested (and filled in while untouched) from the
                    abstracts' footprint or the county — see components/GeoTagFields. */}
                <GeoTagFields autoFill basins={basins} onBasinsChange={setBasins} formations={formations} onFormationsChange={setFormations} abstractIds={abstractIds} counties={counties} states={states} />
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
                  <MoneyInput value={cost.total} onChange={editCost("total")} decimals={2} ariaLabel="Acquisition cost" placeholder="0" />
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
                  <MoneyInput value={ask.total} onChange={editAsk("total")} decimals={2} ariaLabel="Asking price" placeholder="0" />
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

        </div>
      </div>
      {error && <div className="error-text nd-error" role="alert">{error}</div>}
    </Modal>
  );
}
