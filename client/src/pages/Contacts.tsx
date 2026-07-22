import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Modal, Banner, MetricCard, SearchInput, ConfirmDelete, Req, showToast } from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
import { useRowSelection, BulkBar } from "../components/bulk";
import { downloadCsv } from "../lib/csv";
import { Select } from "../components/Select";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { GeoFields } from "../components/GeoFields";
import { PhoneInput } from "../components/PhoneInput";
import { DateField } from "../components/DateField";
import { fmtDate, toInputDate } from "../lib/format";
import { formatPhone } from "../lib/phone";
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
  tags?: string[];
  listIds?: string[];
  owner: { id: string; name: string } | null;
  lastContactedAt: string | null;
  nextFollowUpDate: string | null;
  createdAt: string;
  updatedAt?: string;
}

export const TYPES: [string, string][] = [
  ["SELLER", "Seller"], ["PROSPECT", "Prospect"], ["LEAD", "Inbound Lead"], ["REFERRAL", "Referral"], ["OTHER", "Other"],
];
export const STATUSES: [string, string][] = [
  ["NEW", "New"], ["CONTACTED", "Contacted"], ["ENGAGED", "Engaged"],
  ["NEGOTIATING", "Negotiating"], ["CONVERTED", "Converted"], ["NOT_INTERESTED", "Not Interested"],
];
export const typeLabel = (v: string) => TYPES.find(([k]) => k === v)?.[1] ?? v;
export const statusLabel = (v: string) => STATUSES.find(([k]) => k === v)?.[1] ?? v;

export interface ContactListRow { id: string; name: string; count: number }
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
  const [lists, setLists] = useState<ContactListRow[]>([]);
  const [listFilter, setListFilter] = useState<string[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState<null | "filtered" | "selected">(null);
  const [showLists, setShowLists] = useState(false);
  const sel = useRowSelection();
  const canManage = can("manageContacts");
  const nav = useNavigate();

  const load = () => api.get<ContactRow[]>("/contacts").then(setRows).catch(() => setRows([]));
  const loadLists = () => api.get<ContactListRow[]>("/contacts/lists/all").then(setLists).catch(() => {});
  useEffect(() => { load(); loadLists(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);

  const filtered = useMemo(() => {
    let out = rows ?? [];
    if (listFilter.length) out = out.filter((r) => (r.listIds ?? []).some((id) => listFilter.includes(id)));
    if (typeFilter) out = out.filter((r) => r.type === typeFilter);
    if (statusFilter) out = out.filter((r) => r.status === statusFilter);
    const needle = q.trim().toLowerCase();
    if (needle) {
      out = out.filter((r) =>
        [r.name, r.entityName, r.email, r.phone, r.source, r.counties.join(" "), r.states.join(" "), r.owner?.name]
          .filter(Boolean).join(" ").toLowerCase().includes(needle));
    }
    return out;
  }, [rows, q, typeFilter, statusFilter, listFilter]);

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
    { key: "phone", header: "Phone", type: "text", value: (r) => r.phone, render: (r) => (r.phone ? formatPhone(r.phone) : "—") },
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
        <div className="row" style={{ gap: 8 }}>
          {canManage && <button className="small" onClick={() => setShowImport(true)}>Import CSV</button>}
          <button className="small" onClick={() => setShowExport("filtered")}>Export</button>
          {canManage && <button className="primary" onClick={() => setEditing("new")}>+ New Contact</button>}
        </div>
      </div>

      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <MetricCard label="Total Contacts" value={rows.length} />
        <MetricCard label="Active" value={active} hint="Not converted or closed out" />
        <MetricCard label="New This Month" value={newThisMonth} />
        <MetricCard label="Follow-ups Due" value={followUpsDue} valueColor={followUpsDue > 0 ? "var(--amber)" : undefined} />
      </div>

      {/* Lists — reusable groupings; click to filter (multi-select), counts live. */}
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <span className="ddx-label" style={{ marginRight: 2 }}>Lists</span>
        {lists.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>No lists yet.</span>}
        {lists.map((l) => (
          <span key={l.id} className={`chip ${listFilter.includes(l.id) ? "active" : ""}`}
            onClick={() => setListFilter((p) => p.includes(l.id) ? p.filter((x) => x !== l.id) : [...p, l.id])}>
            {l.name} <span style={{ opacity: .65, fontVariantNumeric: "tabular-nums" }}>{l.count}</span>
          </span>
        ))}
        {listFilter.length > 0 && <button className="link-btn" style={{ fontSize: 12 }} onClick={() => setListFilter([])}>Clear</button>}
        {canManage && <button className="small" onClick={() => setShowLists(true)}>Manage lists</button>}
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
        onRowClick={(r) => nav(`/contacts/${r.id}`)}
        rowHref={(r) => `/contacts/${r.id}`}
        defaultSort={{ key: "next", dir: "asc" }}
        empty={rows.length === 0
          ? (canManage ? "No contacts yet — click “+ New Contact” to start building your acquisitions network." : "No contacts yet.")
          : "No contacts match your filters."}
        selection={{ selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll }}
      />

      {canManage && (
        <ContactsBulkBar
          selectedIds={[...sel.selected]}
          users={users}
          lists={lists}
          onClear={sel.clear}
          onDone={() => { load(); loadLists(); }}
          onExport={() => setShowExport("selected")}
        />
      )}


      {editing && (
        <ContactModal
          contact={editing === "new" ? null : editing}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
          onDeleted={() => { setEditing(null); load(); }}
        />
      )}
      {showLists && <ManageListsModal lists={lists} onChanged={() => { loadLists(); load(); }} onClose={() => setShowLists(false)} />}
      {showImport && (
        <Modal title="Import contacts from CSV" wide onClose={() => setShowImport(false)}>
          <ContactImportWizard lists={lists} onDone={() => { load(); loadLists(); }} />
        </Modal>
      )}
      {showExport && (
        <ExportContactsModal
          scope={showExport}
          selected={(rows ?? []).filter((r) => sel.selected.has(r.id))}
          filtered={filtered}
          lists={lists}
          all={rows ?? []}
          onClose={() => setShowExport(null)}
        />
      )}
    </div>
  );
}

export function ContactModal({ contact, users, onClose, onSaved, onDeleted }: {
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

/* ----------------------------------------------------------- bulk actions */

function ContactsBulkBar({ selectedIds, users, lists, onClear, onDone, onExport }: {
  selectedIds: string[];
  users: UserLite[];
  lists: ContactListRow[];
  onClear: () => void;
  onDone: () => void;
  onExport: () => void;
}) {
  const [modal, setModal] = useState<"edit" | "lists" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Bulk edit draft — only touched fields are sent.
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [addTags, setAddTags] = useState("");
  const [addListIds, setAddListIds] = useState<string[]>([]);
  const [removeListIds, setRemoveListIds] = useState<string[]>([]);
  const count = selectedIds.length;

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); setModal(null); onClear(); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Action failed"); }
    finally { setBusy(false); }
  }
  const resetEdit = () => { setStatus(""); setType(""); setOwnerId(""); setFollowUp(""); setAddTags(""); };

  return (
    <>
      <BulkBar count={count} onClear={onClear}>
        <button className="small" onClick={() => { resetEdit(); setModal("edit"); }}>Edit</button>
        <button className="small" onClick={() => { setAddListIds([]); setRemoveListIds([]); setModal("lists"); }}>Lists</button>
        <button className="small" onClick={onExport}>Export</button>
        <button className="small danger" onClick={() => setModal("delete")}>Delete</button>
      </BulkBar>

      {modal === "edit" && (
        <Modal
          title={`Edit ${count} contact${count === 1 ? "" : "s"}`}
          onClose={() => setModal(null)}
          footer={<>
            <button className="small" onClick={() => setModal(null)} disabled={busy}>Cancel</button>
            <button className="primary" disabled={busy || (!status && !type && !ownerId && !followUp && !addTags.trim())}
              onClick={() => run(async () => {
                await api.post("/contacts/bulk-update", {
                  ids: selectedIds,
                  ...(status ? { status } : {}),
                  ...(type ? { type } : {}),
                  ...(ownerId ? { ownerId: ownerId === "__clear" ? null : ownerId } : {}),
                  ...(followUp ? { nextFollowUpDate: followUp } : {}),
                  ...(addTags.trim() ? { addTags: addTags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
                });
                showToast(`Updated ${count} contact${count === 1 ? "" : "s"}.`);
              })}>Apply</button>
          </>}
        >
          <p className="muted" style={{ marginTop: 0 }}>Only the fields you set are applied — everything else is left untouched.</p>
          <div className="grid-2">
            <div className="field"><label>Status</label><Select ariaLabel="Bulk status" clearable placeholder="Keep current" value={status} onChange={(v) => setStatus(v ?? "")} options={STATUSES.map(([v, l]) => ({ value: v, label: l }))} /></div>
            <div className="field"><label>Type</label><Select ariaLabel="Bulk type" clearable placeholder="Keep current" value={type} onChange={(v) => setType(v ?? "")} options={TYPES.map(([v, l]) => ({ value: v, label: l }))} /></div>
            <div className="field"><label>Assign team member</label><Select ariaLabel="Bulk owner" clearable searchable placeholder="Keep current" value={ownerId} onChange={(v) => setOwnerId(v ?? "")}
              options={[{ value: "__clear", label: "— Unassign —" }, ...users.map((u) => ({ value: u.id, label: u.name }))]} /></div>
            <div className="field"><label>Next follow-up</label><DateField value={followUp} onChange={setFollowUp} /></div>
          </div>
          <div className="field"><label>Add tags</label><input value={addTags} onChange={(e) => setAddTags(e.target.value)} placeholder="Comma-separated, e.g. mailer-3, hot" /></div>
          {err && <Banner kind="error">{err}</Banner>}
        </Modal>
      )}

      {modal === "lists" && (
        <Modal
          title={`Lists for ${count} contact${count === 1 ? "" : "s"}`}
          onClose={() => setModal(null)}
          footer={<>
            <button className="small" onClick={() => setModal(null)} disabled={busy}>Cancel</button>
            <button className="primary" disabled={busy || (!addListIds.length && !removeListIds.length)}
              onClick={() => run(async () => {
                await api.post("/contacts/bulk-lists", { ids: selectedIds, addListIds, removeListIds });
                showToast("List memberships updated.");
              })}>Apply</button>
          </>}
        >
          {lists.length === 0 ? (
            <p className="muted" style={{ marginTop: 0 }}>No lists yet — create one from “Manage lists” first.</p>
          ) : (
            <div className="grid-2">
              <div className="field"><label>Add to lists</label>
                <SearchableMultiSelect options={lists.map((l) => l.id)} labels={Object.fromEntries(lists.map((l) => [l.id, l.name]))}
                  value={addListIds} onChange={setAddListIds} placeholder="Choose lists…" /></div>
              <div className="field"><label>Remove from lists</label>
                <SearchableMultiSelect options={lists.map((l) => l.id)} labels={Object.fromEntries(lists.map((l) => [l.id, l.name]))}
                  value={removeListIds} onChange={setRemoveListIds} placeholder="Choose lists…" /></div>
            </div>
          )}
          {err && <Banner kind="error">{err}</Banner>}
        </Modal>
      )}

      {modal === "delete" && (
        <ConfirmDelete
          count={count} itemLabel="contact" busy={busy}
          onCancel={() => setModal(null)}
          onConfirm={() => run(async () => { await api.post("/contacts/bulk-delete", { ids: selectedIds }); showToast(`Deleted ${count} contact${count === 1 ? "" : "s"}.`); })}
        />
      )}
      {err && modal === null && <Banner kind="error">{err}</Banner>}
    </>
  );
}

/* ----------------------------------------------------------- manage lists */

function ManageListsModal({ lists, onChanged, onClose }: {
  lists: ContactListRow[]; onChanged: () => void; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ContactListRow | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }
  const create = () => { const v = name.trim(); if (!v) return; void run(async () => { await api.post("/contacts/lists/all", { name: v }); setName(""); }); };

  return (
    <Modal title="Manage lists" onClose={onClose} footer={<button className="primary" onClick={onClose}>Done</button>}>
      <p className="muted" style={{ marginTop: 0 }}>Reusable groupings for mailers, call queues, and farm areas. Deleting a list never deletes its contacts.</p>
      <div className="stage-editor">
        {lists.map((l) => (
          <div key={l.id} className="stage-row">
            <input defaultValue={l.name} disabled={busy}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== l.name) void run(async () => { await api.patch(`/contacts/lists/${l.id}`, { name: v }); }); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            <span className="muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{l.count} contact{l.count === 1 ? "" : "s"}</span>
            <button type="button" className="stage-del" disabled={busy} title="Delete list" onClick={() => setConfirm(l)}>×</button>
          </div>
        ))}
        {lists.length === 0 && <p className="muted" style={{ margin: "4px 0" }}>No lists yet.</p>}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New list name" disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); create(); } }} style={{ maxWidth: 240 }} />
        <button type="button" className="small" disabled={!name.trim() || busy} onClick={create}>+ Create list</button>
      </div>
      {err && <div className="error-text">{err}</div>}
      {confirm && (
        <ConfirmDelete
          name={confirm.name} itemLabel="list" busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { await run(async () => { await api.del(`/contacts/lists/${confirm.id}`); }); setConfirm(null); }}
        />
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------- CSV import */

type ImportStep = "upload" | "map" | "preview" | "results";
interface CAnalyzeResp { headers: string[]; fields: { key: string; label: string; required?: boolean }[]; suggestedMapping: Record<string, string>; rowCount: number }
interface CPreviewResp { rows: { index: number; status: string; reason: string; name: string; email: string | null; phone: string | null }[]; counts: { new: number; duplicate: number; error: number } }
interface CCommitResp { inserted: number; updated: number; skipped: number; errors: number }

function ContactImportWizard({ lists, onDone }: { lists: ContactListRow[]; onDone: () => void }) {
  const [step, setStep] = useState<ImportStep>("upload");
  const [csv, setCsv] = useState("");
  const [analyze, setAnalyze] = useState<CAnalyzeResp | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<CPreviewResp | null>(null);
  const [result, setResult] = useState<CCommitResp | null>(null);
  const [updateDuplicates, setUpdateDuplicates] = useState(true);
  const [listId, setListId] = useState("");
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    const text = await file.text();
    setCsv(text);
    setBusy(true); setErr(null);
    try {
      const a = await api.post<CAnalyzeResp>("/contacts/import/analyze", { csv: text });
      setAnalyze(a); setMapping(a.suggestedMapping); setStep("map");
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not read CSV"); }
    finally { setBusy(false); }
  }
  async function doPreview() {
    if (!mapping.firstName || !mapping.lastName) { setErr("Map the First Name and Last Name fields to proceed."); return; }
    setBusy(true); setErr(null);
    try { setPreview(await api.post<CPreviewResp>("/contacts/import/preview", { csv, mapping })); setStep("preview"); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Preview failed"); }
    finally { setBusy(false); }
  }
  async function doCommit() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<CCommitResp>("/contacts/import/commit", { csv, mapping, updateDuplicates, listId: listId || null });
      setResult(r); setStep("results"); onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Import failed"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="muted" style={{ marginBottom: 12, fontSize: 12.5 }}>
        Step: {step === "upload" ? "1 · Upload" : step === "map" ? "2 · Map fields" : step === "preview" ? "3 · Preview" : "4 · Results"}
      </div>
      {err && <div className="error-text">{err}</div>}

      {step === "upload" && (
        <div
          className={`dropzone ${drag ? "drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
          onClick={() => document.getElementById("contacts-csv-input")?.click()}
        >
          {busy ? "Reading…" : "Drag & drop a CSV here, or click to choose a file"}
          <input id="contacts-csv-input" type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
        </div>
      )}

      {step === "map" && analyze && (
        <>
          <p className="muted">Map your CSV columns to contact fields. <strong>First and Last Name are required.</strong></p>
          <div className="dd-grid">
            {analyze.fields.map((f) => (
              <div className="field" key={f.key}>
                <label>{f.label}{f.required && <Req />}</label>
                <Select value={mapping[f.key] ?? ""} onChange={(v) => setMapping((m) => ({ ...m, [f.key]: v ?? "" }))}
                  placeholder="— not mapped —" clearable searchable ariaLabel={`Map column for ${f.label}`}
                  options={analyze.headers.map((h) => ({ value: h, label: h }))} />
              </div>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button onClick={() => setStep("upload")}>Back</button>
            <button className="primary" onClick={doPreview} disabled={busy || !mapping.firstName || !mapping.lastName}>Preview ({analyze.rowCount} rows)</button>
          </div>
        </>
      )}

      {step === "preview" && preview && (
        <>
          <div className="row" style={{ gap: 18, marginBottom: 10 }}>
            <span className="badge resp-offer">{preview.counts.new} New</span>
            <span className="badge resp-pending">{preview.counts.duplicate} Duplicate</span>
            <span className="badge resp-no">{preview.counts.error} Error</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 300 }}>
            <table className="data-table">
              <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Phone</th><th>Status</th><th>Reason</th></tr></thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.index} className={r.status === "Error" ? "row-overdue" : r.status === "Duplicate" ? "row-dimmed" : ""}>
                    <td>{r.index + 1}</td><td>{r.name || "—"}</td><td>{r.email ?? "—"}</td><td>{r.phone ? formatPhone(r.phone) : "—"}</td><td>{r.status}</td><td>{r.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ gap: 14, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 7, textTransform: "none", fontSize: 13 }}>
              <input type="checkbox" checked={updateDuplicates} onChange={(e) => setUpdateDuplicates(e.target.checked)} />
              Update duplicates (fill in blank fields, merge tags)
            </label>
            <span className="row" style={{ gap: 7, alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 13 }}>Add imported to list:</span>
              <Select ariaLabel="Target list" width={180} clearable placeholder="— none —" value={listId} onChange={(v) => setListId(v ?? "")}
                options={lists.map((l) => ({ value: l.id, label: l.name }))} />
            </span>
            <span className="spacer" />
            <button onClick={() => setStep("map")}>Back</button>
            <button className="primary" onClick={doCommit} disabled={busy || (preview.counts.new === 0 && !(updateDuplicates && preview.counts.duplicate > 0))}>
              Import {preview.counts.new}{updateDuplicates && preview.counts.duplicate > 0 ? ` + update ${preview.counts.duplicate}` : ""}
            </button>
          </div>
        </>
      )}

      {step === "results" && result && (
        <div>
          <Banner kind="info">
            <strong>{result.inserted}</strong> new · <strong>{result.updated}</strong> updated · {result.skipped} skipped duplicate{result.skipped === 1 ? "" : "s"} · {result.errors} error{result.errors === 1 ? "" : "s"}
          </Banner>
          <button onClick={() => { setStep("upload"); setCsv(""); setAnalyze(null); setPreview(null); setResult(null); }}>Import another file</button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- CSV export */

// Every exportable contact field — the user picks any combination.
const EXPORT_COLUMNS: { key: string; label: string; value: (r: ContactRow, lists: ContactListRow[]) => string | number | null }[] = [
  { key: "firstName", label: "First Name", value: (r) => r.firstName },
  { key: "lastName", label: "Last Name", value: (r) => r.lastName },
  { key: "entityName", label: "Company / Entity", value: (r) => r.entityName },
  { key: "type", label: "Type", value: (r) => typeLabel(r.type) },
  { key: "status", label: "Status", value: (r) => statusLabel(r.status) },
  { key: "source", label: "Source", value: (r) => r.source },
  { key: "email", label: "Email", value: (r) => r.email },
  { key: "phone", label: "Phone", value: (r) => r.phone },
  { key: "states", label: "States", value: (r) => r.states.join("; ") },
  { key: "counties", label: "Counties", value: (r) => r.counties.join("; ") },
  { key: "tags", label: "Tags", value: (r) => (r.tags ?? []).join("; ") },
  { key: "lists", label: "Lists", value: (r, ls) => (r.listIds ?? []).map((id) => ls.find((l) => l.id === id)?.name ?? "").filter(Boolean).join("; ") },
  { key: "owner", label: "Owner", value: (r) => r.owner?.name ?? null },
  { key: "lastContactedAt", label: "Last Contacted", value: (r) => r.lastContactedAt ? fmtDate(r.lastContactedAt) : null },
  { key: "nextFollowUpDate", label: "Next Follow-up", value: (r) => r.nextFollowUpDate ? fmtDate(r.nextFollowUpDate) : null },
  { key: "notes", label: "Notes", value: (r) => r.notes },
  { key: "createdAt", label: "Created", value: (r) => fmtDate(r.createdAt) },
];
const DEFAULT_EXPORT_KEYS = ["firstName", "lastName", "entityName", "type", "status", "email", "phone", "counties", "owner"];

function ExportContactsModal({ scope, selected, filtered, lists, all, onClose }: {
  scope: "filtered" | "selected";
  selected: ContactRow[];
  filtered: ContactRow[];
  lists: ContactListRow[];
  all: ContactRow[];
  onClose: () => void;
}) {
  const [source, setSource] = useState<string>(scope === "selected" && selected.length ? "selected" : "filtered");
  const [keys, setKeys] = useState<string[]>(DEFAULT_EXPORT_KEYS);
  const rows = source === "selected" ? selected
    : source === "filtered" ? filtered
    : source === "all" ? all
    : all.filter((r) => (r.listIds ?? []).includes(source));
  const toggle = (k: string) => setKeys((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k]);
  const cols = EXPORT_COLUMNS.filter((c) => keys.includes(c.key));

  return (
    <Modal
      title="Export contacts"
      onClose={onClose}
      footer={<>
        <button className="small" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={rows.length === 0 || cols.length === 0}
          onClick={() => {
            downloadCsv(`contacts-${new Date().toISOString().slice(0, 10)}.csv`, cols.map((c) => c.label), rows.map((r) => cols.map((c) => c.value(r, lists))));
            onClose();
          }}>Export {rows.length} contact{rows.length === 1 ? "" : "s"}</button>
      </>}
    >
      <div className="field">
        <label>What to export</label>
        <Select ariaLabel="Export scope" value={source} onChange={(v) => v && setSource(v)}
          options={[
            ...(selected.length ? [{ value: "selected", label: `Selected contacts (${selected.length})` }] : []),
            { value: "filtered", label: `Current filtered view (${filtered.length})` },
            { value: "all", label: `All contacts (${all.length})` },
            ...lists.map((l) => ({ value: l.id, label: `List: ${l.name} (${l.count})` })),
          ]} />
      </div>
      <div className="field">
        <label>Columns</label>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {EXPORT_COLUMNS.map((c) => (
            <span key={c.key} className={`chip ${keys.includes(c.key) ? "active" : ""}`} onClick={() => toggle(c.key)}>{c.label}</span>
          ))}
        </div>
        <div className="row" style={{ gap: 10, marginTop: 8 }}>
          <button className="link-btn" style={{ fontSize: 12 }} onClick={() => setKeys(EXPORT_COLUMNS.map((c) => c.key))}>Select all</button>
          <button className="link-btn" style={{ fontSize: 12 }} onClick={() => setKeys([])}>Deselect all</button>
          <button className="link-btn" style={{ fontSize: 12 }} onClick={() => setKeys(DEFAULT_EXPORT_KEYS)}>Reset</button>
        </div>
      </div>
    </Modal>
  );
}
