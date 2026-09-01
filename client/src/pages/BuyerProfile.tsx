import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, RelationshipDot, StageBadge, StatusBadge, OverflowMenu, ConfirmDelete, CtPill, Modal, ChipList } from "../components/ui";
import { SendDealEmailModal } from "../components/SendDealEmailModal";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { Select } from "../components/Select";
import { AssigneePicker } from "../components/AssigneePicker";
import { GeoFields } from "../components/GeoFields";
import { StateSelect } from "../components/StateSelect";
import { BuyerRelationships, type BuyerNetwork } from "../components/BuyerRelationships";
import { BuyerAliasManager } from "../components/BuyerAliasManager";
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
  contactFirstName: string | null;
  contactLastName: string | null;
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
  aliases: string[];
  createdAt: string;
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

/** What each behavior class means in plain terms (profile intelligence strip). */
const BEHAVIOR_BLURB: Record<string, string> = {
  TERMINAL_HOLD: "Buys and holds — rarely resells",
  DISTRIBUTOR: "Buys and resells quickly",
  AGGREGATOR: "Accumulates from many sources",
  FEEDER: "Sources tracts and passes them upstream",
  TRADER: "Buys and sells in similar volume",
};

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
  // Reported up by BuyerRelationships — the header pills and intelligence strip
  // read the same payload the section already fetched (no duplicate request).
  const [net, setNet] = useState<BuyerNetwork | null>(null);
  const [sendDeal, setSendDeal] = useState(false);

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
        companyName: draft.companyName,
        contactFirstName: draft.contactFirstName ?? "", contactLastName: draft.contactLastName ?? "",
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

  const contactPerson = [view.contactFirstName, view.contactLastName].filter(Boolean).join(" ") || view.contactName;
  // Header meta (reference): geography · transactions on record · aliases · added.
  const geo = (() => {
    const st = [...new Set(net?.counties.map((c) => c.state) ?? [])];
    const co = (net?.counties ?? []).slice(0, 3).map((c) => c.county);
    if (co.length === 0) return view.buyBox.states.length ? view.buyBox.states.join(", ") : null;
    return `${st.join(", ")} · ${co.join(", ")}`;
  })();
  const txOnRecord = net ? net.acquisitions + net.dispositions : 0;

  return (
    <div className="page bp-page">
      {/* Breadcrumb (reference) — keeps the browser-back behavior that preserves
          the list's filters/scroll. */}
      <div className="bp-crumbs">
        <button type="button" className="bp-crumb-link" onClick={backToBuyers}>Buyers</button>
        <span>/</span>
        <span className="bp-crumb-cur">{view.companyName}</span>
      </div>

      <div className="bp-titlerow">
        <div style={{ minWidth: 0 }}>
          <div className="bp-titleline">
            <h1 className="bp-title">{view.companyName}</h1>
            <RelationshipDot status={view.relationshipStatus} />
            {net && <CtPill color="var(--accent)">{net.classLabel}</CtPill>}
          </div>
          <div className="bp-meta">
            {contactPerson && <><span>{contactPerson}</span><span className="bp-meta-div" /></>}
            {geo && <><span>{geo}</span><span className="bp-meta-div" /></>}
            {txOnRecord > 0 && <><span>{txOnRecord.toLocaleString("en-US")} transactions on record</span><span className="bp-meta-div" /></>}
            {view.aliases.length > 0 && <><span>{view.aliases.length} recorded alias{view.aliases.length === 1 ? "" : "es"}</span><span className="bp-meta-div" /></>}
            <span>Added {fmtDate(view.createdAt)}</span>
          </div>
        </div>
        <div className="row" style={{ gap: 9 }}>
          {can("editBuyers") && (
            <button className="ct-btn" onClick={() => setSendDeal(true)} title="Email one of your deals to this buyer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></svg>
              Send a Deal
            </button>
          )}
          {can("deleteBuyers") && !editing && <OverflowMenu items={[{ label: "Delete buyer…", danger: true, onClick: () => setConfirmDelete(true) }]} />}
        </div>
      </div>

      {/* Intelligence strip (reference) — everything the research network knows
          about how this buyer behaves, in one scan. */}
      {net && (
        <div className="bp-intel">
          <div className="bp-intel-cell">
            <div className="bp-intel-l">Behavior</div>
            <div className="bp-intel-v" style={{ color: "var(--accent)" }}>{net.classLabel}</div>
            <div className="bp-intel-s">{BEHAVIOR_BLURB[net.klass] ?? "Classified from its transaction flow"}</div>
          </div>
          <div className="bp-intel-cell">
            <div className="bp-intel-l">Median hold</div>
            <div className="bp-intel-v">{net.hold ? `${net.hold.medianMonths} months` : "—"}</div>
            <div className="bp-intel-s">
              {net.hold
                ? `Fastest ${net.hold.fastestMonths} mo · slowest ${net.hold.slowestMonths} mo`
                : net.dispositions === 0 ? "Never resold — holds what it buys" : "No acquire-then-sell round trip on record"}
            </div>
          </div>
          <div className="bp-intel-cell">
            <div className="bp-intel-l">Concentration</div>
            <div className="bp-intel-v">{net.counties[0] ? `${Math.round(net.counties[0].pct * 100)}% ${net.counties[0].county}` : "—"}</div>
            <div className="bp-intel-s">
              {net.counties.slice(1, 3).map((c) => `${c.county} ${Math.round(c.pct * 100)}%`).join(" · ") || "Single county on record"}
            </div>
          </div>
          <div className="bp-intel-cell">
            <div className="bp-intel-l">Last activity</div>
            <div className="bp-intel-v" style={{ color: net.lastActivity ? "var(--green)" : undefined }}>{net.lastActivity ? fmtDate(net.lastActivity.date) : "—"}</div>
            <div className="bp-intel-s">
              {net.lastActivity
                ? `${net.lastActivity.kind === "sold" ? "Sold" : "Acquired"} ${net.lastActivity.tracts} tract${net.lastActivity.tracts === 1 ? "" : "s"} ${net.lastActivity.kind === "sold" ? "to" : "from"} ${net.lastActivity.counterparty}`
                : "No recorded transactions"}
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDelete
          itemLabel="buyer"
          name={view.companyName}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => { await api.del(`/buyers/${id}`); nav("/buyers"); }}
        />
      )}
      {err && <div className="error-text">{err}</div>}

      {/* Contact Info · Buy Box · Contact Tracking, side by side (reference). */}
      <div className="bp-cards">
        {/* Contact Info */}
        <div className="panel">
          <SectionHead title="Contact Info" section="contact" />
          {editContact ? (
            <>
              <Row><Fld l="Company"><input value={view.companyName} onChange={(e) => setD({ companyName: e.target.value })} /></Fld><Fld l="First name"><input value={view.contactFirstName ?? ""} onChange={(e) => setD({ contactFirstName: e.target.value })} /></Fld></Row>
              <Row><Fld l="Last name"><input value={view.contactLastName ?? ""} onChange={(e) => setD({ contactLastName: e.target.value })} /></Fld><Fld l=""><span /></Fld></Row>
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
              <KV k="First name" v={view.contactFirstName} /><KV k="Last name" v={view.contactLastName} />
              <KV k="Email" v={view.email} /><KV k="Phone" v={view.phone ? formatPhone(view.phone) : null} />
              <KV k="Website" v={view.website} />
              <KV k="Address" v={view.mailingAddress} />
              <KV k="City / State / ZIP" v={[view.mailingCity, view.mailingState, view.mailingZip].filter(Boolean).join(", ")} />
              <KV k="Owner(s)" v={view.owners.length ? <ChipList items={view.owners.map((o) => o.name)} /> : null} />
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
              {ARRAY_KEYS.map((k) => <KV key={k} k={k === "assetTypes" ? "Asset types" : k} v={(view.buyBox[k] as string[]).length ? <ChipList items={view.buyBox[k] as string[]} /> : null} />)}
              <KV k="Acreage" v={fmtRange(view.buyBox.minAcreage, view.buyBox.maxAcreage, (n) => n.toLocaleString("en-US"))} />
              <KV k="Price" v={fmtRange(view.buyBox.minPrice, view.buyBox.maxPrice, (n) => money(n))} />
            </div>
          )}
        </div>

      {/* Contact Tracking */}
      <div className="panel">
        <SectionHead title="Contact Tracking" section="tracking" />
        {/* Follow-up alert (reference): amber when due today or overdue. */}
        {(() => {
          if (!view.nextFollowUpDate) return null;
          // Follow-up dates are calendar days stored at UTC midnight — compare
          // day KEYS (as the dashboard's task list does), never local
          // timestamps, or a date due today reads as a day overdue.
          const dayKey = (d: string) => d.slice(0, 10);
          const todayKey = new Date().toISOString().slice(0, 10);
          const dueKey = dayKey(view.nextFollowUpDate);
          if (dueKey > todayKey) return null;
          const days = Math.round((Date.parse(`${dueKey}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86400000);
          const since = view.lastContactDate
            ? Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${dayKey(view.lastContactDate)}T00:00:00Z`)) / 86400000)
            : null;
          return (
            <div className="bp-alert">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 7.5V12l3 1.8" /></svg>
              <div style={{ minWidth: 0 }}>
                <div className="bp-alert-t">{days === 0 ? "Follow-up due today" : `Follow-up ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`}</div>
                <div className="bp-alert-s">{fmtDate(view.nextFollowUpDate)}{since != null && ` · ${since} days since last contact`}</div>
              </div>
            </div>
          );
        })()}
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

      </div>

      {/* Relationships — transaction-network intelligence from research data.
          Mounted even while a section is being edited so the header strip keeps
          its data; the section itself hides its body during edits. */}
      <div style={editing ? { display: "none" } : undefined}>
        {/* Aliases & merges — canonical identity, manual alias/merge tools,
            and the audit trail (with admin undo). */}
        <BuyerAliasManager buyerId={b.id} companyName={view.companyName} aliases={view.aliases} onChanged={load} />
        <BuyerRelationships buyerId={b.id} onNetwork={setNet} />
      </div>

      {/* Deal History — every row clickable */}
      <div className="panel">
        <div className="section-head">
          <div>
            <h3 style={{ margin: 0 }}>Deal History</h3>
            <div className="bp-sub">Deals you've sent to this buyer</div>
          </div>
        </div>
        {view.dealHistory.length === 0 ? (
          <div className="bp-empty">
            <span className="bp-empty-ico">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3h6a1 1 0 0 1 1 1v6L11 20l-7-7L14 3z" /><circle cx="16.5" cy="7.5" r="1.6" /></svg>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="bp-empty-t">No deals sent yet</div>
              <div className="bp-empty-s">
                {net && net.acquisitions > 0
                  ? `Public records show ${net.acquisitions} acquisition${net.acquisitions === 1 ? "" : "s"} — this buyer is active but has never seen one of your packages.`
                  : "Send this buyer one of your packages to start the history."}
              </div>
            </div>
            {can("editBuyers") && <button className="primary" style={{ flexShrink: 0 }} onClick={() => setSendDeal(true)}>Send first deal</button>}
          </div>
        ) : (
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

      {sendDeal && <SendDealPicker buyerId={b.id} buyerName={view.companyName} onClose={() => setSendDeal(false)} onSent={load} />}
    </div>
  );
}

/**
 * "Send a Deal" from the buyer side: pick one of your deals, then hand off to
 * the same email composer the deal page uses (templates, tokens, send log).
 */
function SendDealPicker({ buyerId, buyerName, onClose, onSent }: {
  buyerId: string; buyerName: string; onClose: () => void; onSent: () => void;
}) {
  const [deals, setDeals] = useState<{ id: string; name: string; stage: string; counties: string[] }[] | null>(null);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    api.get<{ id: string; name: string; stage: string; counties: string[] }[]>("/deals?recordType=OPPORTUNITY")
      .then((rows) => setDeals(rows.filter((d) => d.stage !== "CLOSED" && d.stage !== "DEAD")))
      .catch(() => setDeals([]));
  }, []);

  if (picked) {
    return <SendDealEmailModal dealId={picked.id} buyerIds={[buyerId]} dealName={picked.name}
      onClose={onClose} onSent={() => { onSent(); onClose(); }} />;
  }

  const needle = q.trim().toLowerCase();
  const shown = (deals ?? []).filter((d) => !needle || d.name.toLowerCase().includes(needle) || d.counties.some((c) => c.toLowerCase().includes(needle)));

  return (
    <Modal title={`Send a deal to ${buyerName}`} subtitle="Pick the package to email — the composer opens next." onClose={onClose}>
      <div className="field"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your active deals…" /></div>
      {deals == null ? <Spinner /> : shown.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{deals.length === 0 ? "No active deals to send yet." : "No deals match your search."}</p>
      ) : (
        <div className="bp-pick">
          {shown.map((d) => (
            <button key={d.id} type="button" className="bp-pick-row" onClick={() => setPicked({ id: d.id, name: d.name })}>
              <span className="bp-pick-name">{d.name}</span>
              <span className="bp-pick-meta"><ChipList items={d.counties} max={3} /></span>
              <StageBadge stage={d.stage} />
            </button>
          ))}
        </div>
      )}
    </Modal>
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
