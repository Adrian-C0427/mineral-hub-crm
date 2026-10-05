import { useState } from "react";
import { api } from "../api/client";
import { Plus } from "lucide-react";
import { Modal, Banner, ConfirmDelete, UserChip } from "./ui";
import { Avatar, Tag } from "./kit";
import { PhoneInput } from "./PhoneInput";
import { Select } from "./Select";
import { StateSelect } from "./StateSelect";
import { formatPhone } from "../lib/phone";
import { fmtDateLocal } from "../lib/format";
import type { Seller, SellerType, UserLite } from "../types";

/**
 * Seller Details — structured owner/seller records on a deal, kept separate from
 * deal characteristics. Supports multiple owners (heirs, trusts, entities); each
 * carries personal, contact, physical and mailing info.
 */

const SELLER_TYPES: SellerType[] = ["INDIVIDUAL", "TRUST", "LLC", "CORPORATION", "ESTATE", "PARTNERSHIP", "OTHER"];
const CONTACT_METHODS = ["Phone", "Email", "Mail", "Text"];
const prettyType = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();

function sellerDisplayName(s: Seller): string {
  const person = [s.firstName, s.middleName, s.lastName].filter(Boolean).join(" ");
  return s.companyName || s.trustName || person || "Unnamed seller";
}

export function SellerDetails({ dealId, sellers, users, canEdit, onChanged }: {
  dealId: string;
  sellers: Seller[];
  users: UserLite[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<Seller | "new" | null>(null);
  const [removing, setRemoving] = useState<Seller | null>(null);

  async function remove() {
    if (!removing) return;
    await api.del(`/deals/${dealId}/sellers/${removing.id}`);
    setRemoving(null);
    onChanged();
  }

  return (
    <div className="panel dd-card seller-panel">
      <div className="dd-card-head">
        <div>
          <h3 className="dd-card-title">Sellers</h3>
          <div className="dd-card-sub">Owner and contact details, kept separate from the deal characteristics</div>
        </div>
        {canEdit && <button className="small primary dd-add-btn" onClick={() => setEditing("new")}><Plus size={13} strokeWidth={2.2} aria-hidden="true" />Add seller</button>}
      </div>

      {sellers.length === 0 ? (
        <p className="seller-empty">No seller information yet.{canEdit && " Add a seller to record their contact and mailing details."}</p>
      ) : (
        <div className="seller-list">
          {sellers.map((s) => (
            <SellerCard key={s.id} s={s} canEdit={canEdit} onEdit={() => setEditing(s)} onRemove={() => setRemoving(s)} />
          ))}
        </div>
      )}

      {editing && (
        <SellerFormModal
          dealId={dealId}
          seller={editing === "new" ? null : editing}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}
      {removing && (
        <ConfirmDelete itemLabel="seller" name={sellerDisplayName(removing)} onCancel={() => setRemoving(null)} onConfirm={remove} />
      )}
    </div>
  );
}

function SellerCard({ s, canEdit, onEdit, onRemove }: { s: Seller; canEdit: boolean; onEdit: () => void; onRemove: () => void }) {
  const physical = [s.physicalAddress, s.physicalCity, [s.physicalState, s.physicalZip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const mailing = [s.mailingAddress, s.mailingCity, [s.mailingState, s.mailingZip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const sameAddr = physical && mailing && physical === mailing;
  const name = sellerDisplayName(s);
  const added = s.dateAdded ? fmtDateLocal(s.dateAdded) : null;
  return (
    <div className="seller-card">
      <div className="seller-card-head">
        <div className="seller-id">
          <Avatar name={name} size={34} />
          <div className="seller-id-text">
            <span className="seller-name">{name}</span>
            <span className="seller-meta">{[prettyType(s.sellerType), added && `Added ${added}`].filter(Boolean).join(" · ")}</span>
          </div>
          {s.preferredContactMethod && <Tag tone="success" dot>Prefers {s.preferredContactMethod.toLowerCase()}</Tag>}
        </div>
        <div className="seller-actions">
          {s.primaryPhone && (
            <a className="seller-act" href={`tel:${s.primaryPhone}`} title={`Call ${formatPhone(s.primaryPhone)}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
              Call
            </a>
          )}
          {s.email && (
            <a className="seller-act" href={`mailto:${s.email}`} title={`Email ${s.email}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
              Email
            </a>
          )}
          {canEdit && (
            <>
              <button type="button" className="small seller-edit" onClick={onEdit}>Edit</button>
              <button type="button" className="small seller-remove" onClick={onRemove}>Remove</button>
            </>
          )}
        </div>
      </div>
      <div className="seller-grid">
        <KV k="Phone" v={s.primaryPhone ? formatPhone(s.primaryPhone) : null} />
        <KV k="Email" v={s.email} />
        <KV k="Preferred contact" v={s.preferredContactMethod} />
        <KV k="Assigned to" v={s.assignedTeamMember ? <UserChip user={s.assignedTeamMember} size={16} /> : null} />
        <KV k="Physical address" v={physical} />
        <KV k="Mailing address" v={sameAddr ? "Same as physical" : mailing} />
        {s.internalNotes && <KV k="Notes" v={s.internalNotes} wide />}
      </div>
    </div>
  );
}

function KV({ k, v, wide }: { k: string; v: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`seller-kv ${wide ? "wide" : ""}`}>
      <span className="seller-k">{k}</span>
      <span className={`seller-v ${v ? "" : "dim"}`}>{v || "—"}</span>
    </div>
  );
}

interface FormState {
  sellerType: SellerType;
  firstName: string; middleName: string; lastName: string; companyName: string; trustName: string;
  primaryPhone: string; email: string; preferredContactMethod: string;
  physicalAddress: string; physicalCity: string; physicalState: string; physicalZip: string;
  mailingAddress: string; mailingCity: string; mailingState: string; mailingZip: string;
  internalNotes: string; assignedTeamMemberId: string;
}
type TextKey = Exclude<keyof FormState, "sellerType">;

function addrEqual(f: FormState): boolean {
  return f.mailingAddress === f.physicalAddress && f.mailingCity === f.physicalCity
    && f.mailingState === f.physicalState && f.mailingZip === f.physicalZip;
}

function SellerFormModal({ dealId, seller, users, onClose, onSaved }: {
  dealId: string;
  seller: Seller | null;
  users: UserLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<FormState>(() => ({
    sellerType: seller?.sellerType ?? "INDIVIDUAL",
    firstName: seller?.firstName ?? "",
    middleName: seller?.middleName ?? "",
    lastName: seller?.lastName ?? "",
    companyName: seller?.companyName ?? "",
    trustName: seller?.trustName ?? "",
    primaryPhone: seller?.primaryPhone ?? "",
    email: seller?.email ?? "",
    preferredContactMethod: seller?.preferredContactMethod ?? "",
    physicalAddress: seller?.physicalAddress ?? "",
    physicalCity: seller?.physicalCity ?? "",
    physicalState: seller?.physicalState ?? "",
    physicalZip: seller?.physicalZip ?? "",
    mailingAddress: seller?.mailingAddress ?? "",
    mailingCity: seller?.mailingCity ?? "",
    mailingState: seller?.mailingState ?? "",
    mailingZip: seller?.mailingZip ?? "",
    internalNotes: seller?.internalNotes ?? "",
    assignedTeamMemberId: seller?.assignedTeamMember?.id ?? "",
  }));
  // Mailing == physical (default true for a brand-new seller so the common case
  // needs no extra typing; for an existing seller, reflect what's stored —
  // treating an empty mailing address as "same as physical").
  const [sameAsPhysical, setSameAsPhysical] = useState<boolean>(() => {
    if (!seller) return true;
    const noMailing = !seller.mailingAddress && !seller.mailingCity && !seller.mailingState && !seller.mailingZip;
    return noMailing || addrEqual({
      physicalAddress: seller.physicalAddress ?? "", physicalCity: seller.physicalCity ?? "", physicalState: seller.physicalState ?? "", physicalZip: seller.physicalZip ?? "",
      mailingAddress: seller.mailingAddress ?? "", mailingCity: seller.mailingCity ?? "", mailingState: seller.mailingState ?? "", mailingZip: seller.mailingZip ?? "",
    } as FormState);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setV = (k: TextKey | "sellerType") => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const set = (k: TextKey | "sellerType") => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV(k)(e.target.value);
  // Physical-address edits mirror into mailing while "same as physical" is on.
  const setPhysicalV = (k: "physicalAddress" | "physicalCity" | "physicalState" | "physicalZip") => (v: string) =>
    setF((p) => {
      const next = { ...p, [k]: v };
      if (sameAsPhysical) {
        next.mailingAddress = next.physicalAddress; next.mailingCity = next.physicalCity;
        next.mailingState = next.physicalState; next.mailingZip = next.physicalZip;
      }
      return next;
    });
  const setPhysical = (k: "physicalAddress" | "physicalCity" | "physicalState" | "physicalZip") => (e: React.ChangeEvent<HTMLInputElement>) =>
    setPhysicalV(k)(e.target.value);
  function toggleSame(checked: boolean) {
    setSameAsPhysical(checked);
    if (checked) setF((p) => ({ ...p, mailingAddress: p.physicalAddress, mailingCity: p.physicalCity, mailingState: p.physicalState, mailingZip: p.physicalZip }));
  }

  async function save() {
    setBusy(true); setError(null);
    const s = (v: string) => (v.trim() === "" ? null : v.trim());
    const mail = sameAsPhysical
      ? { mailingAddress: s(f.physicalAddress), mailingCity: s(f.physicalCity), mailingState: s(f.physicalState), mailingZip: s(f.physicalZip) }
      : { mailingAddress: s(f.mailingAddress), mailingCity: s(f.mailingCity), mailingState: s(f.mailingState), mailingZip: s(f.mailingZip) };
    const body: Record<string, unknown> = {
      sellerType: f.sellerType,
      firstName: s(f.firstName), middleName: s(f.middleName), lastName: s(f.lastName),
      companyName: s(f.companyName), trustName: s(f.trustName),
      primaryPhone: s(f.primaryPhone), email: s(f.email), preferredContactMethod: s(f.preferredContactMethod),
      physicalAddress: s(f.physicalAddress), physicalCity: s(f.physicalCity), physicalState: s(f.physicalState), physicalZip: s(f.physicalZip),
      ...mail,
      internalNotes: s(f.internalNotes),
      assignedTeamMemberId: f.assignedTeamMemberId || null,
    };
    try {
      if (seller) await api.patch(`/deals/${dealId}/sellers/${seller.id}`, body);
      else await api.post(`/deals/${dealId}/sellers`, body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={seller ? "Edit seller" : "Add seller"}
      onClose={onClose}
      wide
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : seller ? "Save seller" : "Add seller"}</button>
      </>}
    >
      <FormGroup title="Personal information">
        <div className="grid-3">
          <Fld l="First name"><input value={f.firstName} onChange={set("firstName")} /></Fld>
          <Fld l="Middle name"><input value={f.middleName} onChange={set("middleName")} /></Fld>
          <Fld l="Last name"><input value={f.lastName} onChange={set("lastName")} /></Fld>
          <Fld l="Company / entity name"><input value={f.companyName} onChange={set("companyName")} /></Fld>
          <Fld l="Trust name"><input value={f.trustName} onChange={set("trustName")} /></Fld>
          <Fld l="Seller type">
            <Select value={f.sellerType} onChange={(v) => setF((p) => ({ ...p, sellerType: v as SellerType }))}
              options={SELLER_TYPES.map((t) => ({ value: t, label: prettyType(t) }))} ariaLabel="Seller type" />
          </Fld>
        </div>
      </FormGroup>

      <FormGroup title="Contact information">
        <div className="grid-3">
          <Fld l="Primary phone"><PhoneInput value={f.primaryPhone} onChange={(v) => setF((p) => ({ ...p, primaryPhone: v }))} /></Fld>
          <Fld l="Email address"><input type="email" value={f.email} onChange={set("email")} /></Fld>
          <Fld l="Preferred contact method">
            <Select value={f.preferredContactMethod}
              onChange={(v) => setF((p) => ({ ...p, preferredContactMethod: v }))}
              placeholder="—" clearable ariaLabel="Preferred contact method"
              options={CONTACT_METHODS.map((m) => ({ value: m, label: m }))} />
          </Fld>
        </div>
      </FormGroup>

      <FormGroup title="Physical address">
        <div className="grid-2">
          <Fld l="Street address" wide><input value={f.physicalAddress} onChange={setPhysical("physicalAddress")} /></Fld>
          <Fld l="City"><input value={f.physicalCity} onChange={setPhysical("physicalCity")} /></Fld>
          <div className="grid-2">
            <Fld l="State"><StateSelect value={f.physicalState} onChange={setPhysicalV("physicalState")} /></Fld>
            <Fld l="ZIP"><input value={f.physicalZip} onChange={setPhysical("physicalZip")} /></Fld>
          </div>
        </div>
      </FormGroup>

      <FormGroup title="Mailing address">
        <label className="row seller-same" style={{ marginBottom: sameAsPhysical ? 0 : 10 }}>
          <input type="checkbox" checked={sameAsPhysical} onChange={(e) => toggleSame(e.target.checked)} /> Mailing address is the same as physical address
        </label>
        {!sameAsPhysical && (
          <div className="grid-2">
            <Fld l="Street address" wide><input value={f.mailingAddress} onChange={set("mailingAddress")} /></Fld>
            <Fld l="City"><input value={f.mailingCity} onChange={set("mailingCity")} /></Fld>
            <div className="grid-2">
              <Fld l="State"><StateSelect value={f.mailingState} onChange={setV("mailingState")} /></Fld>
              <Fld l="ZIP"><input value={f.mailingZip} onChange={set("mailingZip")} /></Fld>
            </div>
          </div>
        )}
      </FormGroup>

      <FormGroup title="Additional information">
        <div className="grid-2">
          <Fld l="Assigned team member">
            <Select value={f.assignedTeamMemberId}
              onChange={(v) => setF((p) => ({ ...p, assignedTeamMemberId: v }))}
              placeholder="Unassigned" clearable searchable ariaLabel="Assigned team member"
              options={users.map((u) => ({ value: u.id, label: u.name }))} />
          </Fld>
          <Fld l="Internal notes" wide><textarea rows={3} value={f.internalNotes} onChange={set("internalNotes")} /></Fld>
        </div>
      </FormGroup>

      {error && <Banner kind="error">{error}</Banner>}
    </Modal>
  );
}

/** Labeled form section — renders the app's standard `.modal-sec` header so the
 *  seller form matches the New Deal / New Buyer creation layout exactly. */
function FormGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="modal-sec">{title}</div>
      {children}
    </>
  );
}

function Fld({ l, children, wide }: { l: string; children: React.ReactNode; wide?: boolean }) {
  return <div className="field" style={wide ? { gridColumn: "1 / -1", marginBottom: 0 } : { marginBottom: 0 }}><label>{l}</label>{children}</div>;
}
