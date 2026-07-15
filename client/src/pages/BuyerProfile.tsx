import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, RelationshipDot, StageBadge, StatusBadge, OverflowMenu, ConfirmDelete } from "../components/ui";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { Select } from "../components/Select";
import { AssigneePicker } from "../components/AssigneePicker";
import { GeoFields } from "../components/GeoFields";
import { StateSelect } from "../components/StateSelect";
import { BuyerRelationships } from "../components/BuyerRelationships";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS } from "../lib/options";
import { money, pct, fmtDate, toInputDate } from "../lib/format";
import { formatPhone } from "../lib/phone";
import { PhoneInput } from "../components/PhoneInput";
import type { BuyBox, Relationship, UserLite } from "../types";
import { MoneyInput } from "../components/MoneyInput";
import { useUnsavedSection, guarded } from "../lib/unsaved";
import { DateField } from "../components/DateField";

interface BuyerProfileData {
  id: string;
  name: string;
  companyName: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  mailingAddress: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  relationshipStatus: Relationship;
  lastContactDate: string | null;
  nextFollowUpDate: string | null;
  notes: string | null;
  owners: { id: string; name: string }[];
  buyBox: BuyBox;
  closeRate: number;
  closedDeals: number;
  dealHistory: { dealId: string; dealName: string; stage: string; status: string; amount: number | null; isSelectedBuyer: boolean; date: string }[];
}

const ARRAY_KEYS: (keyof BuyBox)[] = ["states", "counties", "basins", "formations", "assetTypes"];

/** Human range: both bounds → "a – b", one bound → "500+ " / "up to 500", none → "Any". */
function fmtRange(min: number | null, max: number | null, fmt: (n: number) => string): string {
  if (min != null && max != null) return `${fmt(min)} – ${fmt(max)}`;
  if (min != null) return `${fmt(min)}+`;
  if (max != null) return `up to ${fmt(max)}`;
  return "Any";
}

// Section-based editing: each panel edits independently, so changing a phone
// number can never accidentally disturb the buy box, and vice versa.
type Section = "contact" | "buybox" | "tracking";

export function BuyerProfile() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = useAuth();
  const [b, setB] = useState<BuyerProfileData | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [editing, setEditing] = useState<Section | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState<BuyerProfileData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() { api.get<BuyerProfileData>(`/buyers/${id}`).then(setB); }
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers); }, [id]);

  // Registered while a section is dirty: navigation anywhere raises the
  // standard Save / Discard / Cancel dialog. Section switches go through
  // guarded() below, so they get the same treatment.
  useUnsavedSection(editing != null, draft, b, () => saveSection(), () => cancel());

  if (!b) return <Spinner />;
  const view = editing ? draft! : b;

  function startEdit(section: Section) {
    // Editing a different section while another has unsaved changes runs
    // through the same unsaved-changes dialog as navigation.
    guarded(() => {
      setDraft(JSON.parse(JSON.stringify(b)));
      setEditing(section);
      setErr(null);
    });
  }
  function cancel() { setEditing(null); setDraft(null); setErr(null); }

  /** PATCH only the fields belonging to the section being edited. */
  async function saveSection() {
    if (!draft || !editing) return;
    const payload: Record<string, unknown> =
      editing === "contact" ? {
        companyName: draft.companyName, contactName: draft.contactName,
        email: draft.email || null, phone: draft.phone, website: draft.website,
        mailingAddress: draft.mailingAddress, mailingCity: draft.mailingCity, mailingState: draft.mailingState, mailingZip: draft.mailingZip,
        ownerIds: draft.owners.map((o) => o.id),
      }
      : editing === "buybox" ? { buyBox: draft.buyBox }
      : {
        relationshipStatus: draft.relationshipStatus, lastContactDate: draft.lastContactDate,
        nextFollowUpDate: draft.nextFollowUpDate, notes: draft.notes,
      };
    setBusy(true); setErr(null);
    try {
      await api.patch(`/buyers/${id}`, payload);
      setEditing(null); setDraft(null); load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Save failed");
      throw e; // let the unsaved-changes dialog know the save failed
    } finally { setBusy(false); }
  }

  const setD = (patch: Partial<BuyerProfileData>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setBox = (k: keyof BuyBox, v: unknown) => setDraft((d) => (d ? { ...d, buyBox: { ...d.buyBox, [k]: v } } : d));

  // Return to the Buyers list. Prefer browser back so its filters/sort/scroll
  // survive (the list keeps that state in memory); fall back to /buyers on a
  // deep link with no in-app history.
  const backToBuyers = () => { if (window.history.length > 1) nav(-1); else nav("/buyers"); };

  /** Per-panel header: title + its own Edit (or Save/Cancel while editing). */
  function SectionHead({ title, section }: { title: string; section: Section }) {
    const active = editing === section;
    return (
      <div className="section-head">
        <h3 style={{ margin: 0 }}>{title}</h3>
        {can("editBuyers") && (active ? (
          <div className="row" style={{ gap: 6 }}>
            <button className="small" onClick={cancel} disabled={busy}>Cancel</button>
            <button className="small primary" onClick={() => void saveSection().catch(() => {})} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        ) : (
          <button className="small" onClick={() => startEdit(section)}>Edit</button>
        ))}
      </div>
    );
  }

  const editContact = editing === "contact";
  const editBox = editing === "buybox";
  const editTracking = editing === "tracking";

  return (
    <div className="page">
      <button className="link-btn" onClick={backToBuyers} style={{ marginBottom: 10 }}>← Back to Buyers</button>
      <div className="page-header">
        <div className="row">
          <h1 style={{ marginBottom: 0 }}>{view.companyName}</h1>
          {view.contactName && <span className="muted">{view.contactName}</span>}
          <RelationshipDot status={view.relationshipStatus} />
        </div>
        <div className="row">
          {can("deleteBuyers") && !editing && <OverflowMenu items={[{ label: "Delete buyer…", danger: true, onClick: () => setConfirmDelete(true) }]} />}
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDelete
          itemLabel="buyer"
          name={view.companyName}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => { await api.del(`/buyers/${id}`); nav("/buyers"); }}
        />
      )}
      {err && <div className="error-text">{err}</div>}

      <div className="grid-2">
        {/* Contact Info */}
        <div className="panel">
          <SectionHead title="Contact Info" section="contact" />
          {editContact ? (
            <>
              <Row><Fld l="Company"><input value={view.companyName} onChange={(e) => setD({ companyName: e.target.value })} /></Fld><Fld l="Contact name"><input value={view.contactName ?? ""} onChange={(e) => setD({ contactName: e.target.value })} /></Fld></Row>
              <Row><Fld l="Email"><input value={view.email ?? ""} onChange={(e) => setD({ email: e.target.value })} /></Fld><Fld l="Phone"><PhoneInput value={view.phone ?? ""} onChange={(v) => setD({ phone: v })} /></Fld></Row>
              <Fld l="Website"><input value={view.website ?? ""} onChange={(e) => setD({ website: e.target.value })} /></Fld>
              <Fld l="Mailing address"><input value={view.mailingAddress ?? ""} onChange={(e) => setD({ mailingAddress: e.target.value })} /></Fld>
              <Row>
                <Fld l="Mailing city"><input value={view.mailingCity ?? ""} onChange={(e) => setD({ mailingCity: e.target.value })} /></Fld>
                <Fld l="Mailing state"><StateSelect value={view.mailingState ?? ""} onChange={(v) => setD({ mailingState: v })} /></Fld>
                <Fld l="Mailing ZIP code"><input value={view.mailingZip ?? ""} onChange={(e) => setD({ mailingZip: e.target.value })} /></Fld>
              </Row>
              <Fld l="Relationship owner(s)">
                {/* Shared user-assignment component — identical to Deals/Assets. */}
                <AssigneePicker
                  users={users}
                  value={view.owners.map((o) => o.id)}
                  onChange={(ids) => setD({ owners: users.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, name: u.name })) })}
                  placeholder="Assign relationship owner(s)…"
                />
              </Fld>
            </>
          ) : (
            <div className="dd-grid">
              <KV k="Contact" v={view.contactName} /><KV k="Email" v={view.email} /><KV k="Phone" v={view.phone ? formatPhone(view.phone) : null} />
              <KV k="Website" v={view.website} />
              <KV k="Address" v={view.mailingAddress} />
              <KV k="City / State / ZIP" v={[view.mailingCity, view.mailingState, view.mailingZip].filter(Boolean).join(", ")} />
              <KV k="Owner(s)" v={view.owners.map((o) => o.name).join(", ")} />
            </div>
          )}
        </div>

        {/* Buy Box */}
        <div className="panel">
          <SectionHead title="Buy Box & Criteria" section="buybox" />
          {editBox ? (
            <>
              <GeoFields
                states={view.buyBox.states} onStatesChange={(v) => setBox("states", v)}
                counties={view.buyBox.counties} onCountiesChange={(v) => setBox("counties", v)}
                labels={{ state: "states", county: "counties" }}
              />
              <Fld l="basins">
                <SearchableMultiSelect options={[...TEXAS_BASIN_OPTIONS]} value={view.buyBox.basins} onChange={(v) => setBox("basins", v)} placeholder="Search basins…" />
              </Fld>
              <Fld l="formations">
                <SearchableMultiSelect options={[...TEXAS_FORMATION_OPTIONS]} value={view.buyBox.formations} onChange={(v) => setBox("formations", v)} placeholder="Search formations…" />
              </Fld>
              <Fld l="asset types">
                <SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={view.buyBox.assetTypes} onChange={(v) => setBox("assetTypes", v)} placeholder="Search asset types…" />
              </Fld>
              <Row><Fld l="Min acreage"><input type="number" value={view.buyBox.minAcreage ?? ""} onChange={(e) => setBox("minAcreage", e.target.value === "" ? null : Number(e.target.value))} /></Fld><Fld l="Max acreage"><input type="number" value={view.buyBox.maxAcreage ?? ""} onChange={(e) => setBox("maxAcreage", e.target.value === "" ? null : Number(e.target.value))} /></Fld></Row>
              <Row><Fld l="Min price"><MoneyInput value={view.buyBox.minPrice != null ? String(view.buyBox.minPrice) : ""} onChange={(v) => setBox("minPrice", v === "" ? null : Number(v))} ariaLabel="Minimum price" /></Fld><Fld l="Max price"><MoneyInput value={view.buyBox.maxPrice != null ? String(view.buyBox.maxPrice) : ""} onChange={(v) => setBox("maxPrice", v === "" ? null : Number(v))} ariaLabel="Maximum price" /></Fld></Row>
            </>
          ) : (
            <div className="dd-grid">
              {/* Friendly display names — the raw key rendered "ASSETTYPES". */}
              {ARRAY_KEYS.map((k) => <KV key={k} k={k === "assetTypes" ? "Asset types" : k} v={(view.buyBox[k] as string[]).join(", ")} />)}
              <KV k="Acreage" v={fmtRange(view.buyBox.minAcreage, view.buyBox.maxAcreage, (n) => n.toLocaleString("en-US"))} />
              <KV k="Price" v={fmtRange(view.buyBox.minPrice, view.buyBox.maxPrice, (n) => money(n))} />
            </div>
          )}
        </div>
      </div>

      {/* Relationship & Tracking */}
      <div className="panel">
        <SectionHead title="Relationship & Tracking" section="tracking" />
        <div className="dd-grid">
          <KV k="Close rate (computed)" v={view.closedDeals > 0 ? `${pct(view.closeRate)} · ${view.closedDeals} closed` : "No closed deals yet"} />
          {editTracking ? (
            <>
              <Fld l="Status"><Select value={view.relationshipStatus} onChange={(v) => setD({ relationshipStatus: v as Relationship })} ariaLabel="Relationship status" options={[{ value: "HOT", label: "Hot" }, { value: "WARM", label: "Warm" }, { value: "COLD", label: "Cold" }]} /></Fld>
              <Fld l="Last contact"><DateField value={toInputDate(view.lastContactDate)} onChange={(v) => setD({ lastContactDate: v || null })} /></Fld>
              <Fld l="Next follow-up"><DateField value={toInputDate(view.nextFollowUpDate)} onChange={(v) => setD({ nextFollowUpDate: v || null })} /></Fld>
            </>
          ) : (
            <>
              <KV k="Last contact" v={fmtDate(view.lastContactDate)} />
              <KV k="Next follow-up" v={fmtDate(view.nextFollowUpDate)} />
            </>
          )}
        </div>
        <Fld l="Notes">
          {editTracking ? <textarea rows={3} value={view.notes ?? ""} onChange={(e) => setD({ notes: e.target.value })} /> : <div className="wrap">{view.notes || "—"}</div>}
        </Fld>
      </div>

      {/* Relationships — transaction-network intelligence from research data */}
      {!editing && <BuyerRelationships buyerId={b.id} />}

      {/* Deal History — every row clickable */}
      <div className="panel">
        <h3>Deal History</h3>
        {view.dealHistory.length === 0 ? <p className="muted">No deal activity yet.</p> : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Deal</th><th>Stage</th><th>Status</th><th className="right">Amount</th><th>Date</th></tr></thead>
              <tbody>
                {view.dealHistory.map((h) => (
                  <tr key={h.dealId} className="clickable" onClick={() => nav(`/deals/${h.dealId}`)}>
                    <td><strong>{h.dealName}</strong>{h.isSelectedBuyer && <span className="badge resp-offer" style={{ marginLeft: 6 }}>Selected</span>}</td>
                    <td><StageBadge stage={h.stage} /></td>
                    <td><StatusBadge status={h.status} /></td>
                    <td className="right">{money(h.amount)}</td>
                    <td>{fmtDate(h.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v || "—"}</span></div>;
}
function Fld({ l, children }: { l: string; children: React.ReactNode }) {
  return <div className="field" style={{ flex: 1 }}><label>{l}</label>{children}</div>;
}
function Row({ children }: { children: React.ReactNode }) {
  return <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>{children}</div>;
}
