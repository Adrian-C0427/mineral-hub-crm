import { useState } from "react";
import { Modal } from "./ui";
import { api, ApiError } from "../api/client";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { Select } from "./Select";
import { PhoneInput } from "./PhoneInput";
import { GeoFields } from "./GeoFields";
import { StateSelect } from "./StateSelect";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS } from "../lib/options";

/**
 * Standardized New Buyer template — the buyer counterpart of NewDealModal.
 * Same layout, validation, and save behavior; every new buyer is created
 * through this form so records start consistent.
 */
export function NewBuyerModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({
    companyName: "", contactName: "", email: "", phone: "",
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

  // Required before a buyer can be created (Company Name, Contact Name, Phone).
  const missing: string[] = [];
  if (!f.companyName.trim()) missing.push("Company name");
  if (!f.contactName.trim()) missing.push("Contact name");
  if (!f.phone.trim()) missing.push("Phone number");

  async function submit() {
    if (missing.length) { setError(`Required: ${missing.join(", ")}`); return; }
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.post<{ id: string }>("/buyers", {
        companyName: f.companyName.trim(),
        name: f.companyName.trim(),
        contactName: f.contactName.trim() || null,
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

  return (
    <Modal
      title="New Buyer"
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy || missing.length > 0}>{busy ? "Creating…" : "Create buyer"}</button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>New buyers start as <strong>Warm</strong> unless set otherwise. Fields marked <span style={{ color: "var(--red)" }}>*</span> are required; the buy box drives deal matching — fill in what you know and add the rest later.</p>
      <div className="field"><label>Company name <span style={{ color: "var(--red)" }}>*</span></label><input value={f.companyName} onChange={set("companyName")} autoFocus /></div>
      <div className="dd-grid">
        <div className="field"><label>Contact name <span style={{ color: "var(--red)" }}>*</span></label><input value={f.contactName} onChange={set("contactName")} /></div>
        <div className="field"><label>Phone <span style={{ color: "var(--red)" }}>*</span></label><PhoneInput value={f.phone} onChange={(v) => setF((p) => ({ ...p, phone: v }))} /></div>
        <div className="field"><label>Email</label><input type="email" value={f.email} onChange={set("email")} /></div>
        <div className="field"><label>Website</label><input value={f.website} onChange={set("website")} /></div>
        <div className="field"><label>Relationship</label>
          <Select value={relationshipStatus} onChange={(v) => setRelationshipStatus(v as "HOT" | "WARM" | "COLD")} ariaLabel="Relationship status"
            options={[{ value: "HOT", label: "Hot" }, { value: "WARM", label: "Warm" }, { value: "COLD", label: "Cold" }]} />
        </div>
        <div className="field"><label>Next follow-up</label><input type="date" value={f.nextFollowUpDate} onChange={set("nextFollowUpDate")} /></div>
      </div>
      {/* Structured mailing address — same fields used across the CRM. */}
      <div className="dd-grid">
        <div className="field"><label>Mailing address</label><input value={f.mailingAddress} onChange={set("mailingAddress")} /></div>
        <div className="field"><label>Mailing city</label><input value={f.mailingCity} onChange={set("mailingCity")} /></div>
        <div className="field"><label>Mailing state</label><StateSelect value={f.mailingState} onChange={(v) => setF((p) => ({ ...p, mailingState: v }))} /></div>
        <div className="field"><label>Mailing ZIP code</label><input value={f.mailingZip} onChange={set("mailingZip")} /></div>
      </div>

      <div className="section-head" style={{ marginTop: 6 }}><h3 style={{ margin: 0 }}>Buy box</h3></div>
      <div className="dd-grid">
        <GeoFields
          states={states} onStatesChange={setStates}
          counties={counties} onCountiesChange={setCounties}
          labels={{ state: "States", county: "Counties" }}
        />
        <div className="field"><label>Basins</label><SearchableMultiSelect options={[...TEXAS_BASIN_OPTIONS]} value={basins} onChange={setBasins} placeholder="Search basins…" /></div>
        <div className="field"><label>Formations</label><SearchableMultiSelect options={[...TEXAS_FORMATION_OPTIONS]} value={formations} onChange={setFormations} placeholder="Search formations…" /></div>
        <div className="field"><label>Asset types</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
        <div className="field"><label>Min acreage</label><input type="number" value={f.minAcreage} onChange={set("minAcreage")} /></div>
        <div className="field"><label>Max acreage</label><input type="number" value={f.maxAcreage} onChange={set("maxAcreage")} /></div>
        <div className="field"><label>Min price</label><input type="number" value={f.minPrice} onChange={set("minPrice")} /></div>
        <div className="field"><label>Max price</label><input type="number" value={f.maxPrice} onChange={set("maxPrice")} /></div>
      </div>
      <div className="field"><label>Notes</label><textarea rows={3} value={f.notes} onChange={set("notes")} /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
