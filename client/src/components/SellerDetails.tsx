import { useState } from "react";
import { api } from "../api/client";
import { Modal, Banner } from "./ui";
import { fmtDate } from "../lib/format";
import type { Seller, SellerType, UserLite } from "../types";

/**
 * Seller Details — structured owner/seller records on a deal, kept separate from
 * deal characteristics. Supports multiple owners (heirs, trusts, entities); each
 * carries personal, contact, mailing, physical and additional info. The Tax /
 * Entity ID is sensitive: it's only shown/editable to callers with the
 * viewSellerTaxId permission (the API mirrors this gate).
 */

const SELLER_TYPES: SellerType[] = ["INDIVIDUAL", "TRUST", "LLC", "CORPORATION", "ESTATE", "PARTNERSHIP", "OTHER"];
const CONTACT_METHODS = ["Phone", "Email", "Mail", "Text"];
const prettyType = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();

function sellerDisplayName(s: Seller): string {
  const person = [s.firstName, s.middleName, s.lastName].filter(Boolean).join(" ");
  return s.companyName || s.trustName || person || "Unnamed seller";
}

export function SellerDetails({ dealId, sellers, users, canEdit, canViewTaxId, onChanged }: {
  dealId: string;
  sellers: Seller[];
  users: UserLite[];
  canEdit: boolean;
  canViewTaxId: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<Seller | "new" | null>(null);

  async function remove(s: Seller) {
    if (!window.confirm(`Remove ${sellerDisplayName(s)} from this deal?`)) return;
    await api.del(`/deals/${dealId}/sellers/${s.id}`);
    onChanged();
  }

  return (
    <div className="panel">
      <div className="section-head">
        <h3 style={{ margin: 0 }}>Seller Details</h3>
        {canEdit && <button className="small primary" onClick={() => setEditing("new")}>+ Add seller</button>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Owner and contact information for this deal, kept separate from the deal characteristics.</p>

      {sellers.length === 0 ? (
        <p className="muted">No seller information yet.{canEdit && " Add a seller to record their contact and mailing details."}</p>
      ) : (
        <div className="seller-list">
          {sellers.map((s) => (
            <SellerCard key={s.id} s={s} canEdit={canEdit} canViewTaxId={canViewTaxId} onEdit={() => setEditing(s)} onRemove={() => remove(s)} />
          ))}
        </div>
      )}

      {editing && (
        <SellerFormModal
          dealId={dealId}
          seller={editing === "new" ? null : editing}
          users={users}
          canViewTaxId={canViewTaxId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}
    </div>
  );
}

function SellerCard({ s, canEdit, canViewTaxId, onEdit, onRemove }: { s: Seller; canEdit: boolean; canViewTaxId: boolean; onEdit: () => void; onRemove: () => void }) {
  const mailing = [s.mailingAddress, s.mailingCity, [s.mailingState, s.mailingZip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const physical = [s.physicalAddress, s.physicalCity, [s.physicalState, s.physicalZip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return (
    <div className="seller-card">
      <div className="seller-card-head">
        <div className="row" style={{ gap: 8 }}>
          <strong>{sellerDisplayName(s)}</strong>
          {s.isPrimary && <span className="badge resp-offer">Primary</span>}
          <span className="badge resp-pending">{prettyType(s.sellerType)}</span>
          {s.ownershipPercent != null && <span className="muted">{s.ownershipPercent}%</span>}
        </div>
        {canEdit && (
          <div className="row" style={{ gap: 6 }}>
            <button className="link-btn" onClick={onEdit}>Edit</button>
            <button className="link-btn" style={{ color: "var(--red)" }} onClick={onRemove}>Remove</button>
          </div>
        )}
      </div>
      <div className="seller-grid">
        <KV k="Primary phone" v={s.primaryPhone} />
        <KV k="Secondary phone" v={s.secondaryPhone} />
        <KV k="Email" v={s.email} />
        <KV k="Preferred contact" v={s.preferredContactMethod} />
        <KV k="Mailing address" v={mailing} />
        <KV k="Physical address" v={physical} />
        <KV k="Assigned to" v={s.assignedTeamMember?.name} />
        <KV k="Date added" v={fmtDate(s.dateAdded)} />
        {(canViewTaxId || s.hasTaxId) && (
          <KV k="Tax / Entity ID" v={canViewTaxId ? (s.taxId || "—") : (s.hasTaxId ? "•••••• (restricted)" : "—")} />
        )}
        {s.preferredCommunicationNotes && <KV k="Communication notes" v={s.preferredCommunicationNotes} wide />}
        {s.internalNotes && <KV k="Internal notes" v={s.internalNotes} wide />}
      </div>
    </div>
  );
}

function KV({ k, v, wide }: { k: string; v: React.ReactNode; wide?: boolean }) {
  return (
    <div className="kv" style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <span className="k">{k}</span>
      <span className="v" style={{ whiteSpace: wide ? "normal" : undefined }}>{v || "—"}</span>
    </div>
  );
}

interface FormState {
  isPrimary: boolean;
  sellerType: SellerType;
  ownershipPercent: string;
  firstName: string; middleName: string; lastName: string; companyName: string; trustName: string;
  primaryPhone: string; secondaryPhone: string; email: string; preferredContactMethod: string;
  mailingAddress: string; mailingCity: string; mailingState: string; mailingZip: string;
  physicalAddress: string; physicalCity: string; physicalState: string; physicalZip: string;
  internalNotes: string; taxId: string; preferredCommunicationNotes: string; assignedTeamMemberId: string;
}
type StringFieldKey = Exclude<keyof FormState, "isPrimary" | "sellerType">;

function SellerFormModal({ dealId, seller, users, canViewTaxId, onClose, onSaved }: {
  dealId: string;
  seller: Seller | null;
  users: UserLite[];
  canViewTaxId: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<FormState>(() => ({
    isPrimary: seller?.isPrimary ?? false,
    sellerType: seller?.sellerType ?? "INDIVIDUAL",
    ownershipPercent: seller?.ownershipPercent != null ? String(seller.ownershipPercent) : "",
    firstName: seller?.firstName ?? "",
    middleName: seller?.middleName ?? "",
    lastName: seller?.lastName ?? "",
    companyName: seller?.companyName ?? "",
    trustName: seller?.trustName ?? "",
    primaryPhone: seller?.primaryPhone ?? "",
    secondaryPhone: seller?.secondaryPhone ?? "",
    email: seller?.email ?? "",
    preferredContactMethod: seller?.preferredContactMethod ?? "",
    mailingAddress: seller?.mailingAddress ?? "",
    mailingCity: seller?.mailingCity ?? "",
    mailingState: seller?.mailingState ?? "",
    mailingZip: seller?.mailingZip ?? "",
    physicalAddress: seller?.physicalAddress ?? "",
    physicalCity: seller?.physicalCity ?? "",
    physicalState: seller?.physicalState ?? "",
    physicalZip: seller?.physicalZip ?? "",
    internalNotes: seller?.internalNotes ?? "",
    taxId: seller?.taxId ?? "",
    preferredCommunicationNotes: seller?.preferredCommunicationNotes ?? "",
    assignedTeamMemberId: seller?.assignedTeamMember?.id ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: StringFieldKey | "sellerType") => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save() {
    setBusy(true); setError(null);
    const s = (v: string) => (v.trim() === "" ? null : v.trim());
    const body: Record<string, unknown> = {
      isPrimary: f.isPrimary,
      sellerType: f.sellerType,
      ownershipPercent: f.ownershipPercent.trim() === "" ? null : Number(f.ownershipPercent),
      firstName: s(f.firstName), middleName: s(f.middleName), lastName: s(f.lastName),
      companyName: s(f.companyName), trustName: s(f.trustName),
      primaryPhone: s(f.primaryPhone), secondaryPhone: s(f.secondaryPhone), email: s(f.email),
      preferredContactMethod: s(f.preferredContactMethod),
      mailingAddress: s(f.mailingAddress), mailingCity: s(f.mailingCity), mailingState: s(f.mailingState), mailingZip: s(f.mailingZip),
      physicalAddress: s(f.physicalAddress), physicalCity: s(f.physicalCity), physicalState: s(f.physicalState), physicalZip: s(f.physicalZip),
      internalNotes: s(f.internalNotes), preferredCommunicationNotes: s(f.preferredCommunicationNotes),
      assignedTeamMemberId: f.assignedTeamMemberId || null,
    };
    if (canViewTaxId) body.taxId = s(f.taxId);
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
      title={seller ? "Edit Seller" : "Add Seller"}
      onClose={onClose}
      wide
      footer={<>
        <button className="small" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : seller ? "Save" : "Add seller"}</button>
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
            <select value={f.sellerType} onChange={set("sellerType")}>{SELLER_TYPES.map((t) => <option key={t} value={t}>{prettyType(t)}</option>)}</select>
          </Fld>
        </div>
      </FormGroup>

      <FormGroup title="Contact information">
        <div className="grid-2">
          <Fld l="Primary phone"><input value={f.primaryPhone} onChange={set("primaryPhone")} /></Fld>
          <Fld l="Secondary phone"><input value={f.secondaryPhone} onChange={set("secondaryPhone")} /></Fld>
          <Fld l="Email address"><input type="email" value={f.email} onChange={set("email")} /></Fld>
          <Fld l="Preferred contact method">
            <select value={f.preferredContactMethod} onChange={set("preferredContactMethod")}>
              <option value="">—</option>{CONTACT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Fld>
        </div>
      </FormGroup>

      <FormGroup title="Mailing address">
        <div className="grid-2">
          <Fld l="Mailing address" wide><input value={f.mailingAddress} onChange={set("mailingAddress")} /></Fld>
          <Fld l="City"><input value={f.mailingCity} onChange={set("mailingCity")} /></Fld>
          <div className="grid-2">
            <Fld l="State"><input value={f.mailingState} onChange={set("mailingState")} /></Fld>
            <Fld l="ZIP"><input value={f.mailingZip} onChange={set("mailingZip")} /></Fld>
          </div>
        </div>
      </FormGroup>

      <FormGroup title="Physical address">
        <div className="grid-2">
          <Fld l="Street address" wide><input value={f.physicalAddress} onChange={set("physicalAddress")} /></Fld>
          <Fld l="City"><input value={f.physicalCity} onChange={set("physicalCity")} /></Fld>
          <div className="grid-2">
            <Fld l="State"><input value={f.physicalState} onChange={set("physicalState")} /></Fld>
            <Fld l="ZIP"><input value={f.physicalZip} onChange={set("physicalZip")} /></Fld>
          </div>
        </div>
      </FormGroup>

      <FormGroup title="Additional information">
        <div className="grid-2">
          <Fld l="Ownership %"><input type="number" value={f.ownershipPercent} onChange={set("ownershipPercent")} placeholder="e.g. 50" /></Fld>
          <Fld l="Assigned team member">
            <select value={f.assignedTeamMemberId} onChange={set("assignedTeamMemberId")}>
              <option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Fld>
          {canViewTaxId && <Fld l="Tax ID / Entity ID"><input value={f.taxId} onChange={set("taxId")} placeholder="Sensitive — permission-restricted" /></Fld>}
          <Fld l="Primary owner">
            <label className="row" style={{ textTransform: "none", gap: 6 }}>
              <input type="checkbox" checked={f.isPrimary} onChange={(e) => setF((p) => ({ ...p, isPrimary: e.target.checked }))} /> Mark as the primary seller
            </label>
          </Fld>
          <Fld l="Preferred communication notes" wide><textarea rows={2} value={f.preferredCommunicationNotes} onChange={set("preferredCommunicationNotes")} /></Fld>
          <Fld l="Internal notes" wide><textarea rows={3} value={f.internalNotes} onChange={set("internalNotes")} /></Fld>
        </div>
      </FormGroup>

      {error && <Banner kind="error">{error}</Banner>}
    </Modal>
  );
}

function FormGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="seller-form-group">
      <div className="assumption-group-title">{title}</div>
      {children}
    </div>
  );
}

function Fld({ l, children, wide }: { l: string; children: React.ReactNode; wide?: boolean }) {
  return <div className="field" style={wide ? { gridColumn: "1 / -1", marginBottom: 0 } : { marginBottom: 0 }}><label>{l}</label>{children}</div>;
}
