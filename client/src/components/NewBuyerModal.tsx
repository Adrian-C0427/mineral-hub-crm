import { useState } from "react";
import { Modal, Req } from "./ui";
import { api, ApiError } from "../api/client";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { Select } from "./Select";
import { PhoneInput } from "./PhoneInput";
import { GeoFields } from "./GeoFields";
import { StateSelect } from "./StateSelect";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS } from "../lib/options";
import { MoneyInput } from "./MoneyInput";
import { DateField } from "./DateField";

/**
 * Standardized New Buyer template — the buyer counterpart of NewDealModal.
 * Same layout, validation, and save behavior; every new buyer is created
 * through this form so records start consistent.
 */
export function NewBuyerModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({
    companyName: "", contactFirstName: "", contactLastName: "", email: "", phone: "",
    website: "", mailingAddress: "", mailingCity: "", mailingState: "", mailingZip: "",
    minAcreage: "", maxAcreage: "", minPrice: "", maxPrice: "",
    nextFollowUpDate: "", notes: "",
  });
  const [relationshipStatus, setRelationshipStatus] = useState<"HOT" | "WARM" | "COLD">("WARM");
  const [states, setStates] = useState<string[]>([]);
  const [counties, setCounties] = useState<string[]>([]);
  const [basins, setBasins] = useState<string[]>([]);
  const [formations, setFormations] = useState<string[]>([]);
  const [assetTypes, setAssetTypes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

  // Required before a buyer can be created (Company, First/Last name, Phone).
  const missing: string[] = [];
  if (!f.companyName.trim()) missing.push("Company name");
  if (!f.contactFirstName.trim()) missing.push("First name");
  if (!f.contactLastName.trim()) missing.push("Last name");
  if (!f.phone.trim()) missing.push("Phone number");

  async function submit() {
    if (missing.length) { setError(`Required: ${missing.join(", ")}`); return; }
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.post<{ id: string }>("/buyers", {
        companyName: f.companyName.trim(),
        name: f.companyName.trim(),
        contactFirstName: f.contactFirstName.trim(),
        contactLastName: f.contactLastName.trim(),
        email: f.email.trim() || null,
        phone: f.phone.trim() || null,
        website: f.website.trim() || null,
        mailingAddress: f.mailingAddress.trim() || null,
        mailingCity: f.mailingCity.trim() || null,
        mailingState: f.mailingState || null,
        mailingZip: f.mailingZip.trim() || null,
        relationshipStatus,
        nextFollowUpDate: f.nextFollowUpDate || null,
        notes: f.notes || null,
        buyBox: {
          states,
          counties, basins, formations, assetTypes,
          minAcreage: numOrNull(f.minAcreage),
          maxAcreage: numOrNull(f.maxAcreage),
          minPrice: numOrNull(f.minPrice),
          maxPrice: numOrNull(f.maxPrice),
        },
      });
      onCreated(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create buyer");
    } finally {
      setBusy(false);
    }
  }

  const req = <Req />;
  return (
    <Modal
      title="New Buyer"
      subtitle={<>Starts as <strong style={{ color: "var(--amber)" }}>Warm</strong> unless set otherwise · the buy box drives deal matching — add the rest later</>}
      onClose={onClose}
      wide
      dirty={Object.values(f).some((v) => v.trim() !== "") || states.length > 0 || counties.length > 0 || assetTypes.length > 0}
      footer={
        <>
          <span className="modal-req-note"><Req /> Required</span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy || missing.length > 0}
            title={missing.length ? "Enabled once required fields are filled" : undefined}>
            {busy ? "Creating…" : "Create buyer"}
          </button>
        </>
      }
    >
      <div className="modal-sec">Company &amp; contact</div>
      <div className="nd-grid3">
        <div className="field" style={{ gridColumn: "1 / -1" }}><label>Company name {req}</label><input value={f.companyName} onChange={set("companyName")} autoFocus placeholder="e.g. Bluebonnet Minerals LLC" /></div>
        <div className="field"><label>First name {req}</label><input value={f.contactFirstName} onChange={set("contactFirstName")} placeholder="First" /></div>
        <div className="field"><label>Last name {req}</label><input value={f.contactLastName} onChange={set("contactLastName")} placeholder="Last" /></div>
        <div className="field"><label>Phone {req}</label><PhoneInput value={f.phone} onChange={(v) => setF((p) => ({ ...p, phone: v }))} /></div>
        <div className="field"><label>Email</label><input type="email" value={f.email} onChange={set("email")} placeholder="name@company.com" /></div>
        <div className="field"><label>Website</label><input value={f.website} onChange={set("website")} placeholder="company.com" /></div>
        <div className="field"><label>Relationship</label>
          <Select value={relationshipStatus} onChange={(v) => setRelationshipStatus(v as "HOT" | "WARM" | "COLD")} ariaLabel="Relationship status"
            options={[{ value: "HOT", label: "Hot" }, { value: "WARM", label: "Warm" }, { value: "COLD", label: "Cold" }]} />
        </div>
      </div>

      <div className="modal-sec">Follow-up &amp; mailing address</div>
      <div className="nd-grid3">
        <div className="field"><label>Next follow-up</label><DateField value={f.nextFollowUpDate} onChange={(v) => setF((p) => ({ ...p, nextFollowUpDate: v }))} /></div>
        <div className="field" style={{ gridColumn: "2 / -1" }}><label>Mailing address</label><input value={f.mailingAddress} onChange={set("mailingAddress")} placeholder="Street address" /></div>
        <div className="field"><label>City</label><input value={f.mailingCity} onChange={set("mailingCity")} placeholder="City" /></div>
        <div className="field"><label>State</label><StateSelect value={f.mailingState} onChange={(v) => setF((p) => ({ ...p, mailingState: v }))} /></div>
        <div className="field"><label>ZIP code</label><input value={f.mailingZip} onChange={set("mailingZip")} placeholder="75201" /></div>
      </div>

      <div className="modal-sec">Buy box <span className="modal-sec-hint">— what this buyer wants; drives deal matching</span></div>
      <div className="nd-grid3">
        <GeoFields
          states={states} onStatesChange={setStates}
          counties={counties} onCountiesChange={setCounties}
          labels={{ state: "States", county: "Counties" }}
        />
        <div className="field"><label>Basins</label><SearchableMultiSelect options={[...TEXAS_BASIN_OPTIONS]} value={basins} onChange={setBasins} placeholder="Search basins…" /></div>
        <div className="field"><label>Formations</label><SearchableMultiSelect options={[...TEXAS_FORMATION_OPTIONS]} value={formations} onChange={setFormations} placeholder="Search formations…" /></div>
        <div className="field"><label>Asset types</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
        <div className="field"><label>Min acreage</label><input type="number" value={f.minAcreage} onChange={set("minAcreage")} placeholder="0" /></div>
        <div className="field"><label>Max acreage</label><input type="number" value={f.maxAcreage} onChange={set("maxAcreage")} placeholder="No max" /></div>
        <div className="field"><label>Min price</label><MoneyInput value={f.minPrice} onChange={(v) => setF((p) => ({ ...p, minPrice: v }))} ariaLabel="Minimum price" /></div>
        <div className="field"><label>Max price</label><MoneyInput value={f.maxPrice} onChange={(v) => setF((p) => ({ ...p, maxPrice: v }))} ariaLabel="Maximum price" /></div>
        <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><textarea rows={3} value={f.notes} onChange={set("notes")} placeholder="Anything worth remembering about this buyer…" /></div>
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
