import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Segmented } from "./kit";
import { Select } from "./Select";
import { PhoneInput } from "./PhoneInput";
import { StateSelect } from "./StateSelect";
import { formatPhone, normalizePhone } from "../lib/phone";
import type { ContactRow } from "../pages/Contacts";
import type { SellerType } from "../types";

/**
 * Seller Information — the one block both New deal and New opportunity (and
 * the seller editors) use to capture who the seller is. The seller IS a
 * Contact: pick an existing one (search by name, company, phone or email) or
 * describe a new one; the server links the contact to the record it creates,
 * reusing an existing contact with the same email / phone + name rather than
 * duplicating it. An individual shows first/middle/last name; an entity (trust, LLC,
 * estate…) shows the entity name and type, with an optional contact person.
 * The block's values go out as the API's `seller` object (sellerInfoBody).
 */

export type SellerKind = "INDIVIDUAL" | "ENTITY";
export const ENTITY_TYPES: { value: SellerType; label: string }[] = [
  { value: "TRUST", label: "Trust" }, { value: "LLC", label: "LLC" }, { value: "CORPORATION", label: "Corporation" },
  { value: "ESTATE", label: "Estate" }, { value: "PARTNERSHIP", label: "Partnership" }, { value: "OTHER", label: "Other entity" },
];

export interface SellerInfoForm {
  /** Existing Contact id ("" = none picked: a new contact unless one matches). */
  contactId: string;
  kind: SellerKind;
  /** Entity type when `kind` is ENTITY. */
  entityType: SellerType;
  firstName: string;
  /** Optional; shown between the first and last name. */
  middleName: string;
  lastName: string;
  companyName: string;
  /** Canonical digits (PhoneInput). */
  phone: string;
  email: string;
  mailingAddress: string;
  mailingCity: string;
  mailingState: string;
  mailingZip: string;
}

export const emptySellerInfo = (): SellerInfoForm => ({
  contactId: "", kind: "INDIVIDUAL", entityType: "TRUST", firstName: "", middleName: "", lastName: "", companyName: "", phone: "", email: "",
  mailingAddress: "", mailingCity: "", mailingState: "", mailingZip: "",
});

/** True when nothing has been entered or picked. */
export function sellerInfoBlank(f: SellerInfoForm): boolean {
  return !f.contactId && !f.firstName.trim() && !f.middleName.trim() && !f.lastName.trim() && !f.companyName.trim() && !f.phone && !f.email.trim()
    && !f.mailingAddress.trim() && !f.mailingCity.trim() && !f.mailingState && !f.mailingZip.trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Required fields still missing (labels) — the seller needs a name or an entity name. */
export function sellerInfoMissing(f: SellerInfoForm): string[] {
  if (f.contactId) return [];
  const hasPerson = !!(f.firstName.trim() || f.lastName.trim());
  if (f.kind === "ENTITY") return f.companyName.trim() ? [] : ["Seller entity name"];
  return hasPerson ? [] : ["Seller name"];
}

/** Values the server would refuse, as messages. */
export function sellerInfoInvalid(f: SellerInfoForm): string[] {
  const out: string[] = [];
  if (f.email.trim() && !EMAIL_RE.test(f.email.trim())) out.push("Seller email is not a valid address");
  return out;
}

/** The API's `seller` object (POST /deals, POST|PATCH /opportunities). */
export function sellerInfoBody(f: SellerInfoForm): Record<string, string | null> {
  const t = (v: string) => (v.trim() === "" ? null : v.trim());
  const entity = f.kind === "ENTITY";
  return {
    contactId: f.contactId || null,
    sellerType: entity ? f.entityType : "INDIVIDUAL",
    firstName: t(f.firstName), middleName: t(f.middleName), lastName: t(f.lastName),
    companyName: entity ? t(f.companyName) : null,
    phone: f.phone || null, email: t(f.email),
    mailingAddress: t(f.mailingAddress), mailingCity: t(f.mailingCity), mailingState: f.mailingState || null, mailingZip: t(f.mailingZip),
  };
}

/** Form values seeded from a contact (edit flows); blanks where the contact has none. */
export function sellerInfoFromContact(c: Pick<ContactRow, "id" | "firstName" | "middleName" | "lastName" | "entityName" | "phone" | "email" | "mailingStreet" | "mailingCity" | "mailingState" | "mailingZip">, kind?: SellerKind): SellerInfoForm {
  const entityOnly = !!c.entityName && (!c.lastName || c.firstName === c.entityName);
  return {
    contactId: c.id, kind: kind ?? (entityOnly ? "ENTITY" : "INDIVIDUAL"), entityType: "TRUST",
    firstName: entityOnly && c.firstName === c.entityName ? "" : c.firstName ?? "", middleName: c.middleName ?? "", lastName: c.lastName ?? "", companyName: c.entityName ?? "",
    phone: normalizePhone(c.phone ?? ""), email: c.email ?? "",
    mailingAddress: c.mailingStreet ?? "", mailingCity: c.mailingCity ?? "", mailingState: c.mailingState ?? "", mailingZip: c.mailingZip ?? "",
  };
}

/** Display name for a contact row (person, else entity). */
export const contactDisplayName = (c: Pick<ContactRow, "name" | "entityName">) => c.name || c.entityName || "Contact";

/** The org's contacts for a picker (empty when the caller may not view contacts). */
export function useContactOptions(): { contacts: ContactRow[] | null; options: { value: string; label: string; hint?: string }[]; error: string | null; canSearch: boolean } {
  const { can } = useAuth();
  const canSearch = can("viewContacts");
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!canSearch) { setContacts([]); return; }
    api.get<ContactRow[]>("/contacts").then(setContacts).catch((e) => { setContacts([]); setError(e instanceof ApiError ? e.message : "Contacts could not be loaded"); });
  }, [canSearch]);
  // Search covers the name, the company, the phone and the email (the hint).
  const options = useMemo(() => (contacts ?? []).map((c) => ({
    value: c.id,
    label: contactDisplayName(c),
    hint: [c.entityName && c.entityName !== c.name ? c.entityName : null, c.phone ? formatPhone(c.phone) : null, c.email].filter(Boolean).join(" · ") || undefined,
  })), [contacts]);
  return { contacts, options, error, canSearch };
}

/** "Existing contact" search field — by name, company, phone or email. */
export function ContactPicker({ value, onPick, onClear, contacts, options, loading, note }: {
  value: string; onPick: (c: ContactRow) => void; onClear: () => void;
  contacts: ContactRow[] | null; options: { value: string; label: string; hint?: string }[]; loading: boolean; note?: React.ReactNode;
}) {
  const picked = value ? contacts?.find((c) => c.id === value) ?? null : null;
  return (
    <div className="field seller-info-pick">
      <label>Existing contact</label>
      <Select value={value} onChange={(id) => { const c = id ? contacts?.find((x) => x.id === id) : null; if (c) onPick(c); else onClear(); }} ariaLabel="Existing contact"
        clearable searchable placeholder={loading ? "Loading contacts…" : "Search contacts by name, company, phone or email…"}
        searchPlaceholder="Name, company, phone or email…" emptyText="No matching contact — the details below create one" options={options} />
      <div className="seller-info-note muted">
        {picked
          ? <>Linked to <Link to={`/contacts/${picked.id}`}>{contactDisplayName(picked)}</Link> — the details below update that contact.</>
          : value ? "Linked to an existing contact." : note}
      </div>
    </div>
  );
}

export function SellerInformation({ value: f, onChange, req, autoFocus, compact }: {
  value: SellerInfoForm;
  onChange: (next: SellerInfoForm) => void;
  /** The required marker element (the form's <Req />). */
  req?: React.ReactNode;
  autoFocus?: boolean;
  /** Fewer columns (inside a card instead of the wide creation modal). */
  compact?: boolean;
}) {
  const { contacts, options, error: loadErr, canSearch } = useContactOptions();
  const set = <K extends keyof SellerInfoForm>(k: K) => (v: SellerInfoForm[K]) => onChange({ ...f, [k]: v });
  const setText = (k: keyof SellerInfoForm) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...f, [k]: e.target.value });

  /** Linking a contact fills in what it knows; anything already typed stays. */
  function pickContact(c: ContactRow) {
    const seed = sellerInfoFromContact(c, f.kind === "ENTITY" || (!c.lastName && !!c.entityName) ? "ENTITY" : "INDIVIDUAL");
    onChange({
      ...f, contactId: c.id, kind: seed.kind,
      firstName: f.firstName || seed.firstName, middleName: f.middleName || seed.middleName, lastName: f.lastName || seed.lastName, companyName: f.companyName || seed.companyName,
      phone: f.phone || seed.phone, email: f.email || seed.email,
      mailingAddress: f.mailingAddress || seed.mailingAddress, mailingCity: f.mailingCity || seed.mailingCity,
      mailingState: f.mailingState || seed.mailingState, mailingZip: f.mailingZip || seed.mailingZip,
    });
  }

  const entity = f.kind === "ENTITY";
  const grid = compact ? "nd-grid2" : "nd-grid3";
  return (
    <div className="seller-info">
      {canSearch && (
        <ContactPicker value={f.contactId} onPick={pickContact} onClear={() => onChange({ ...f, contactId: "" })} contacts={contacts} options={options} loading={!contacts}
          note={loadErr ?? "No contact picked: a new contact is created from the details below (an existing one with the same email, or phone and name, is reused)."} />
      )}

      <div className="seller-info-kind">
        <Segmented ariaLabel="Seller kind" value={f.kind} onChange={(k) => onChange({ ...f, kind: k })}
          options={[{ value: "INDIVIDUAL" as const, label: "Individual" }, { value: "ENTITY" as const, label: "Entity" }]} />
      </div>

      <div className={grid}>
        {entity ? (
          <>
            <div className="field" style={{ gridColumn: compact ? "1 / -1" : "span 2" }}>
              <label>Entity name {req}</label>
              <input value={f.companyName} onChange={setText("companyName")} autoFocus={autoFocus} placeholder="Hernandez Family Trust, Lone Star Minerals LLC…" aria-label="Seller entity name" />
            </div>
            <div className="field"><label>Entity type</label>
              <Select value={f.entityType} onChange={(v) => onChange({ ...f, entityType: v as SellerType })} ariaLabel="Entity type" options={ENTITY_TYPES} />
            </div>
            <div className="field"><label>Contact first name</label><input value={f.firstName} onChange={setText("firstName")} placeholder="Trustee, manager… (optional)" aria-label="Contact first name" /></div>
            <div className="field"><label>Contact middle name</label><input value={f.middleName} onChange={setText("middleName")} placeholder="Optional" aria-label="Contact middle name" /></div>
            <div className="field"><label>Contact last name</label><input value={f.lastName} onChange={setText("lastName")} aria-label="Contact last name" /></div>
          </>
        ) : (
          <>
            <div className="field"><label>First name {req}</label><input value={f.firstName} onChange={setText("firstName")} autoFocus={autoFocus} aria-label="Seller first name" /></div>
            <div className="field"><label>Middle name</label><input value={f.middleName} onChange={setText("middleName")} placeholder="Optional" aria-label="Seller middle name" /></div>
            <div className="field"><label>Last name {req}</label><input value={f.lastName} onChange={setText("lastName")} aria-label="Seller last name" /></div>
          </>
        )}
        <div className="field"><label>Phone</label><PhoneInput value={f.phone} onChange={set("phone")} placeholder="(555) 000-0000" /></div>
        <div className="field"><label>Email</label><input type="email" inputMode="email" autoComplete="off" value={f.email} onChange={setText("email")} placeholder="name@example.com" aria-label="Seller email" /></div>
      </div>

      <div className={`${grid} seller-info-mailing`}>
        <div className="field" style={{ gridColumn: "1 / -1" }}><label>Mailing address</label><input value={f.mailingAddress} onChange={setText("mailingAddress")} placeholder="Street address" aria-label="Mailing address" /></div>
        <div className="field"><label>City</label><input value={f.mailingCity} onChange={setText("mailingCity")} aria-label="Mailing city" /></div>
        <div className="field"><label>State</label><StateSelect value={f.mailingState} onChange={set("mailingState")} /></div>
        <div className="field"><label>ZIP</label><input value={f.mailingZip} onChange={setText("mailingZip")} inputMode="numeric" aria-label="Mailing ZIP" /></div>
      </div>
    </div>
  );
}
