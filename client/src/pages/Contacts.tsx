import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Modal, Banner, MetricCard, SearchInput, ConfirmDelete, Req, showToast } from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
import { Select } from "../components/Select";
import { GeoFields } from "../components/GeoFields";
import { PhoneInput } from "../components/PhoneInput";
import { DateField } from "../components/DateField";
import { fmtDate, toInputDate } from "../lib/format";
import type { UserLite } from "../types";

/**
 * Acquisitions — Contacts.
 *
 * The front door of the acquisitions side of the CRM: sellers, prospects, and
 * inbound leads the team is sourcing from. Architecture note: type/status are
 * server-validated string catalogs (like pipeline stage keys), the table is the
 * shared SortableTable with Customize View, and the record modal is the app's
 * standard form system — so campaigns, follow-up queues, and lead→deal
 * conversion can be added as new columns/tabs/actions without restructuring.
 */

export interface ContactRow {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  entityName: string | null;
  type: string;
  status: string;
  source: string | null;
  email: string | null;
  phone: string | null;
  states: string[];
  counties: string[];
  notes: string | null;
  owner: { id: string; name: string } | null;
  lastContactedAt: string | null;
  nextFollowUpDate: string | null;
  createdAt: string;
}

const TYPES: [string, string][] = [
  ["SELLER", "Seller"], ["PROSPECT", "Prospect"], ["LEAD", "Inbound Lead"], ["REFERRAL", "Referral"], ["OTHER", "Other"],
];
const STATUSES: [string, string][] = [
  ["NEW", "New"], ["CONTACTED", "Contacted"], ["ENGAGED", "Engaged"],
  ["NEGOTIATING", "Negotiating"], ["CONVERTED", "Converted"], ["NOT_INTERESTED", "Not Interested"],
];
const typeLabel = (v: string) => TYPES.find(([k]) => k === v)?.[1] ?? v;
const statusLabel = (v: string) => STATUSES.find(([k]) => k === v)?.[1] ?? v;
// Status → tone class (reuses the app's badge palette).
const STATUS_TONE: Record<string, string> = {
  NEW: "resp-pending", CONTACTED: "resp-pending", ENGAGED: "resp-interested",
  NEGOTIATING: "resp-interested", CONVERTED: "resp-interested", NOT_INTERESTED: "resp-passed",
};

export function Contacts() {
  const { can } = useAuth();
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editing, setEditing] = useState<ContactRow | "new" | null>(null);
  const canManage = can("manageContacts");

  const load = () => api.get<ContactRow[]>("/contacts").then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);

  const filtered = useMemo(() => {
    let out = rows ?? [];
    if (typeFilter) out = out.filter((r) => r.type === typeFilter);
    if (statusFilter) out = out.filter((r) => r.status === statusFilter);
    const needle = q.trim().toLowerCase();
    if (needle) {
      out = out.filter((r) =>
        [r.name, r.entityName, r.email, r.phone, r.source, r.counties.join(" "), r.states.join(" "), r.owner?.name]
          .filter(Boolean).join(" ").toLowerCase().includes(needle));
    }
    return out;
  }, [rows, q, typeFilter, statusFilter]);

  if (!rows) return <Spinner />;

  const now = Date.now();
  const followUpsDue = rows.filter((r) => r.nextFollowUpDate && new Date(r.nextFollowUpDate).getTime() <= now && r.status !== "CONVERTED" && r.status !== "NOT_INTERESTED").length;
  const newThisMonth = rows.filter((r) => { const d = new Date(r.createdAt); const t = new Date(); return d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear(); }).length;
  const active = rows.filter((r) => r.status !== "CONVERTED" && r.status !== "NOT_INTERESTED").length;

  const columns: Column<ContactRow>[] = [
    { key: "name", header: "Contact", type: "text", value: (r) => r.name, minWidth: 200, required: true,
      render: (r) => (
        <span className="row" style={{ gap: 8, alignItems: "center" }}>
          <strong>{r.name}</strong>
          {r.entityName && <span className="muted" style={{ fontSize: 12.5 }}>· {r.entityName}</span>}
        </span>
      ) },
    { key: "type", header: "Type", type: "text", value: (r) => typeLabel(r.type), render: (r) => <span className="badge resp-pending">{typeLabel(r.type)}</span> },
    { key: "status", header: "Status", type: "text", value: (r) => statusLabel(r.status),
      render: (r) => <span className={`badge ${STATUS_TONE[r.status] ?? "resp-pending"}`}>{statusLabel(r.status)}</span> },
    { key: "phone", header: "Phone", type: "text", value: (r) => r.phone, render: (r) => r.phone ?? "—" },
    { key: "email", header: "Email", type: "text", value: (r) => r.email, render: (r) => r.email ?? "—" },
    { key: "geo", header: "Counties", type: "text", value: (r) => r.counties.join(", "),
      render: (r) => r.counties.length ? r.counties.join(", ") : (r.states.join(", ") || "—") },
    { key: "source", header: "Source", type: "text", value: (r) => r.source, render: (r) => r.source ?? "—", defaultHidden: true },
    { key: "owner", header: "Owner", type: "text", value: (r) => r.owner?.name ?? null, render: (r) => r.owner?.name ?? "—" },
    { key: "last", header: "Last Contact", type: "date", value: (r) => r.lastContactedAt, render: (r) => fmtDate(r.lastContactedAt) },
    { key: "next", header: "Next Follow-up", type: "date", value: (r) => r.nextFollowUpDate,
      render: (r) => {
        const due = r.nextFollowUpDate && new Date(r.nextFollowUpDate).getTime() <= now;
        return <span style={due ? { color: "var(--red)" } : undefined}>{fmtDate(r.nextFollowUpDate)}</span>;
      } },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Contacts</h1>
          <span className="muted" style={{ fontSize: 13.5 }}>Acquisitions — sellers, prospects, and inbound leads you're sourcing from</span>
        </div>
        {canManage && <button className="primary" onClick={() => setEditing("new")}>+ New Contact</button>}
      </div>

      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <MetricCard label="Total Contacts" value={rows.length} />
        <MetricCard label="Active" value={active} hint="Not converted or closed out" />
        <MetricCard label="New This Month" value={newThisMonth} />
        <MetricCard label="Follow-ups Due" value={followUpsDue} valueColor={followUpsDue > 0 ? "var(--amber)" : undefined} />
      </div>

      <SortableTable
        customizeId="contacts-list"
        toolbar={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search name, entity, email, phone, county, owner…" ariaLabel="Search contacts" />
            <Select ariaLabel="Type" width={150} clearable value={typeFilter} onChange={(v) => setTypeFilter(v ?? "")} placeholder="All types"
              options={TYPES.map(([v, l]) => ({ value: v, label: l }))} />
            <Select ariaLabel="Status" width={160} clearable value={statusFilter} onChange={(v) => setStatusFilter(v ?? "")} placeholder="All statuses"
              options={STATUSES.map(([v, l]) => ({ value: v, label: l }))} />
            {(q || typeFilter || statusFilter) && <span className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>Showing {filtered.length} of {rows.length}</span>}
          </>
        }
        columns={columns}
        rows={filtered}
        rowKey={(r) => r.id}
        onRowClick={canManage ? (r) => setEditing(r) : undefined}
        defaultSort={{ key: "next", dir: "asc" }}
        empty={rows.length === 0
          ? (canManage ? "No contacts yet — click “+ New Contact” to start building your acquisitions network." : "No contacts yet.")
          : "No contacts match your filters."}
      />

      {editing && (
        <ContactModal
          contact={editing === "new" ? null : editing}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
          onDeleted={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function ContactModal({ contact, users, onClose, onSaved, onDeleted }: {
  contact: ContactRow | null;
  users: UserLite[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [f, setF] = useState({
    firstName: contact?.firstName ?? "",
    lastName: contact?.lastName ?? "",
    entityName: contact?.entityName ?? "",
    type: contact?.type ?? "PROSPECT",
    status: contact?.status ?? "NEW",
    source: contact?.source ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    notes: contact?.notes ?? "",
    ownerId: contact?.owner?.id ?? "",
    lastContactedAt: toInputDate(contact?.lastContactedAt ?? null),
    nextFollowUpDate: toInputDate(contact?.nextFollowUpDate ?? null),
  });
  const [states, setStates] = useState<string[]>(contact?.states ?? []);
  const [counties, setCounties] = useState<string[]>(contact?.counties ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    if (!f.firstName.trim() || !f.lastName.trim()) { setError("First and last name are required."); return; }
    setBusy(true); setError(null);
    const body = {
      firstName: f.firstName.trim(),
      lastName: f.lastName.trim(),
      entityName: f.entityName.trim() || null,
      type: f.type,
      status: f.status,
      source: f.source.trim() || null,
      email: f.email.trim() || null,
      phone: f.phone.trim() || null,
      states, counties,
      notes: f.notes.trim() || null,
      ownerId: f.ownerId || null,
      lastContactedAt: f.lastContactedAt || null,
      nextFollowUpDate: f.nextFollowUpDate || null,
    };
    try {
      if (contact) await api.patch(`/contacts/${contact.id}`, body);
      else await api.post("/contacts", body);
      showToast(contact ? "Contact updated." : "Contact created.");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the contact");
      setBusy(false);
    }
  }

  return (
    <Modal
      title={contact ? "Edit Contact" : "New Contact"}
      onClose={onClose}
      footer={<>
        {contact && <button className="danger" disabled={busy} onClick={() => setConfirmDelete(true)} style={{ marginRight: "auto" }}>Delete</button>}
        <button className="small" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : contact ? "Save changes" : "Create contact"}</button>
      </>}
    >
      <div className="grid-2">
        <div className="field"><label>First name <Req /></label><input value={f.firstName} onChange={(e) => set("firstName")(e.target.value)} autoFocus /></div>
        <div className="field"><label>Last name <Req /></label><input value={f.lastName} onChange={(e) => set("lastName")(e.target.value)} /></div>
        <div className="field"><label>Company / entity</label><input value={f.entityName} onChange={(e) => set("entityName")(e.target.value)} placeholder="Trust, LLC, family entity…" /></div>
        <div className="field"><label>Source</label><input value={f.source} onChange={(e) => set("source")(e.target.value)} placeholder="Mailer, cold call, referral, web…" /></div>
        <div className="field"><label>Type</label><Select ariaLabel="Contact type" value={f.type} onChange={(v) => v && set("type")(v)} options={TYPES.map(([v, l]) => ({ value: v, label: l }))} /></div>
        <div className="field"><label>Status</label><Select ariaLabel="Contact status" value={f.status} onChange={(v) => v && set("status")(v)} options={STATUSES.map(([v, l]) => ({ value: v, label: l }))} /></div>
        <div className="field"><label>Email</label><input type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} /></div>
        <div className="field"><label>Phone</label><PhoneInput value={f.phone} onChange={set("phone")} /></div>
        <GeoFields states={states} onStatesChange={setStates} counties={counties} onCountiesChange={setCounties} />
        <div className="field"><label>Owner</label><Select ariaLabel="Owner" clearable value={f.ownerId} onChange={(v) => set("ownerId")(v ?? "")} placeholder="Unassigned" options={users.map((u) => ({ value: u.id, label: u.name }))} searchable /></div>
        <div className="field"><label>Last contacted</label><DateField value={f.lastContactedAt} onChange={set("lastContactedAt")} /></div>
        <div className="field"><label>Next follow-up</label><DateField value={f.nextFollowUpDate} onChange={set("nextFollowUpDate")} /></div>
      </div>
      <div className="field"><label>Notes</label><textarea rows={3} value={f.notes} onChange={(e) => set("notes")(e.target.value)} placeholder="Ownership details, conversation history, interests…" /></div>
      {error && <Banner kind="error">{error}</Banner>}

      {confirmDelete && contact && (
        <ConfirmDelete
          name={contact.name}
          itemLabel="contact"
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setBusy(true);
            try { await api.del(`/contacts/${contact.id}`); showToast("Contact deleted."); onDeleted(); }
            catch (e) { setError(e instanceof Error ? e.message : "Could not delete"); setBusy(false); setConfirmDelete(false); }
          }}
        />
      )}
    </Modal>
  );
}
