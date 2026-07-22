import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Bell, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Mail, MapPin, MessageSquare, Phone, Pin, Plus, Search, Send, StickyNote, Trash2, X,
} from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Banner, ConfirmDelete, EmptyState, showToast } from "../components/ui";
import { Select } from "../components/Select";
import { DateField } from "../components/DateField";
import { fmtDate } from "../lib/format";
import { ContactModal, type ContactRow, TYPES, STATUSES, typeLabel, statusLabel } from "./Contacts";
import type { UserLite } from "../types";

/**
 * Contact workspace (reference layout): left contact-details rail, center
 * activity timeline + composer, right Notes / Tasks / Reminders / Minerals
 * panel. All data is real: contact fields, tags, and a persisted activity
 * timeline (notes, logged calls / emails / texts, tasks, reminders).
 */

export interface ContactActivityRow {
  id: string;
  kind: "NOTE" | "CALL" | "EMAIL" | "SMS" | "TASK" | "REMINDER" | string;
  body: string;
  disposition: string | null;
  durationSeconds: number | null;
  dueDate: string | null;
  completedAt: string | null;
  priority: "LOW" | "MEDIUM" | "HIGH" | string | null;
  assignedTo: { id: string; name: string } | null;
  pinned: boolean;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

const DISPOSITIONS = ["Connected", "No Answer", "Voicemail", "Bad Number", "Callback Requested"];
const STATUS_DOT: Record<string, string> = {
  NEW: "var(--accent)", CONTACTED: "var(--amber)", ENGAGED: "var(--green)",
  NEGOTIATING: "var(--green)", CONVERTED: "var(--green)", NOT_INTERESTED: "var(--red)",
};

const initialsOf = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const dayKey = (iso: string): string => new Date(iso).toDateString();
const dayLabel = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

const KIND_META: Record<string, { label: string; icon: JSX.Element; tone: string }> = {
  NOTE: { label: "Internal note", icon: <StickyNote size={14} />, tone: "var(--accent)" },
  CALL: { label: "Outbound call", icon: <Phone size={14} />, tone: "var(--red)" },
  EMAIL: { label: "Email", icon: <Mail size={14} />, tone: "#8b5cf6" },
  SMS: { label: "Text message", icon: <MessageSquare size={14} />, tone: "var(--green)" },
};

export function ContactDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = useAuth();
  const canManage = can("manageContacts");

  const [contact, setContact] = useState<ContactRow | null>(null);
  const [all, setAll] = useState<ContactRow[]>([]);
  const [activities, setActivities] = useState<ContactActivityRow[] | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => {
    api.get<ContactRow>(`/contacts/${id}`).then(setContact).catch(() => setErr("Contact not found."));
    api.get<ContactActivityRow[]>(`/contacts/${id}/activities`).then(setActivities).catch(() => setActivities([]));
  }, [id]);
  useEffect(() => {
    load();
    api.get<ContactRow[]>("/contacts").then(setAll).catch(() => {});
    api.get<UserLite[]>("/users").then(setUsers).catch(() => {});
  }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    const updated = await api.patch<ContactRow>(`/contacts/${id}`, body);
    setContact(updated);
  };

  if (err) return <div className="page"><Banner kind="error">{err}</Banner></div>;
  if (!contact) return <Spinner />;

  const idx = all.findIndex((c) => c.id === contact.id);
  const go = (dir: -1 | 1) => { const n = all[idx + dir]; if (n) nav(`/contacts/${n.id}`); };
  const timeline = (activities ?? []).filter((a) => a.kind !== "TASK" && a.kind !== "REMINDER");

  return (
    <div className="cw">
      {/* ============================================== left: contact details */}
      <aside className="cw-left">
        <div className="cw-left-head">
          <Link to="/contacts" className="cw-back"><ArrowLeft size={14} /> Contact Details</Link>
          <span className="cw-pager">
            {idx >= 0 && <span className="cw-count">{idx + 1} / {all.length.toLocaleString()}</span>}
            <button className="cw-pgbtn" disabled={idx <= 0} onClick={() => go(-1)} aria-label="Previous contact"><ChevronLeft size={11} /></button>
            <button className="cw-pgbtn" disabled={idx < 0 || idx >= all.length - 1} onClick={() => go(1)} aria-label="Next contact"><ChevronRight size={11} /></button>
          </span>
        </div>

        <div className="cw-ident">
          <div className="cw-ident-row">
            <span className="cw-avatar lg">{initialsOf(contact.name)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="cw-name">{contact.name}</div>
              <div className="cw-substatus">
                <span className="cw-dot" style={{ background: STATUS_DOT[contact.status] ?? "var(--accent)" }} />
                {typeLabel(contact.type)} · {statusLabel(contact.status)}
              </div>
            </div>
            {canManage && (
              <button className="cw-del" title="Delete contact" aria-label="Delete contact" onClick={() => setConfirmDelete(true)}><Trash2 size={12} /></button>
            )}
          </div>

          <div className="cw-two">
            <div>
              <div className="cw-lbl">Owner</div>
              <Select ariaLabel="Owner" clearable searchable placeholder="Unassigned" disabled={!canManage}
                value={contact.owner?.id ?? ""} onChange={(v) => void patch({ ownerId: v || null })}
                options={users.map((u) => ({ value: u.id, label: u.name }))} />
            </div>
            <div>
              <div className="cw-lbl">Status</div>
              <Select ariaLabel="Status" disabled={!canManage}
                value={contact.status} onChange={(v) => v && void patch({ status: v })}
                options={STATUSES.map(([v, l]) => ({ value: v, label: l }))} />
            </div>
          </div>

          <Tags contact={contact} canManage={canManage} onSave={(tags) => void patch({ tags })} />
        </div>

        <FieldSections contact={contact} onEdit={canManage ? () => setEditing(true) : undefined} />
      </aside>

      {/* ============================================== center: timeline */}
      <section className="cw-center">
        <div className="cw-chead">
          <div className="row" style={{ gap: 12, alignItems: "center" }}>
            <span className="cw-avatar">{initialsOf(contact.name)}</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{contact.name}</div>
              {contact.phone && <div className="cw-mono muted">{contact.phone}</div>}
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {contact.phone && <a className="cw-act call" href={`tel:${contact.phone}`} title={`Call ${contact.phone}`}><Phone size={14} /></a>}
            {contact.email && <a className="cw-act" href={`mailto:${contact.email}`} title={`Email ${contact.email}`}><Mail size={14} /></a>}
          </div>
        </div>

        <div className="cw-timeline">
          {activities === null ? <Spinner /> : timeline.length === 0 ? (
            <EmptyState title="No activity yet">
              Log your first call, text, email, or internal note below — everything lands on this timeline.
            </EmptyState>
          ) : (
            timeline.map((a, i) => {
              const meta = KIND_META[a.kind] ?? KIND_META.NOTE;
              const newDay = i === 0 || dayKey(timeline[i - 1].createdAt) !== dayKey(a.createdAt);
              return (
                <div key={a.id}>
                  {newDay && (
                    <div className="cw-day">
                      <span className="cw-day-line" /><span className="cw-day-chip">{dayLabel(a.createdAt)}</span><span className="cw-day-line" />
                    </div>
                  )}
                  <div className="cw-event">
                    <div className="cw-bubble">
                      <div className="cw-bubble-head">
                        <span className="cw-kind-ico" style={{ color: meta.tone, background: `color-mix(in srgb, ${meta.tone} 12%, transparent)` }}>{meta.icon}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="cw-bubble-title">
                            {meta.label}{a.kind === "CALL" && a.disposition ? ` · ${a.disposition}` : ""}
                          </div>
                          {a.kind === "CALL" && a.durationSeconds != null && (
                            <div className="cw-mono muted" style={{ marginTop: 2 }}>{a.durationSeconds} sec</div>
                          )}
                        </div>
                        {a.kind === "CALL" && a.disposition && (
                          <span className={`cw-dispo ${a.disposition === "Connected" ? "ok" : "warn"}`}>{a.disposition}</span>
                        )}
                      </div>
                      {a.body && <div className="cw-bubble-body">{a.body}</div>}
                    </div>
                    <div className="cw-event-meta"><span className="cw-mono">{fmtTime(a.createdAt)}</span> · <span>{a.createdBy?.name ?? "—"}</span></div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {canManage && <Composer contactId={contact.id} onLogged={load} />}
      </section>

      {/* ============================================== right: notes/tasks/... */}
      <SidePanel contact={contact} activities={activities ?? []} canManage={canManage} onChanged={load} users={users} />

      {editing && (
        <ContactModal
          contact={contact}
          users={users}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }}
          onDeleted={() => nav("/contacts")}
        />
      )}
      {confirmDelete && (
        <ConfirmDelete
          name={contact.name}
          itemLabel="contact"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => { await api.del(`/contacts/${contact.id}`); showToast("Contact deleted."); nav("/contacts"); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ tags */

function Tags({ contact, canManage, onSave }: { contact: ContactRow; canManage: boolean; onSave: (tags: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const tags = contact.tags ?? [];
  const add = () => {
    const v = draft.trim();
    if (v && !tags.includes(v)) onSave([...tags, v]);
    setDraft(""); setAdding(false);
  };
  return (
    <div style={{ marginTop: 14 }}>
      <div className="cw-tags-head">
        <span className="cw-lbl" style={{ marginBottom: 0 }}>Tags <span className="cw-mono" style={{ color: "var(--text-dim)" }}>({tags.length})</span></span>
        {canManage && <button className="cw-tag-add" title="Add tag" aria-label="Add tag" onClick={() => setAdding(true)}><Plus size={10} /></button>}
      </div>
      <div className="cw-tags">
        {tags.map((t) => (
          <span key={t} className="cw-tag">
            {t}
            {canManage && <button aria-label={`Remove tag ${t}`} onClick={() => onSave(tags.filter((x) => x !== t))}><X size={9} /></button>}
          </span>
        ))}
        {adding && (
          <input autoFocus className="cw-tag-input" value={draft} placeholder="New tag…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } if (e.key === "Escape") { setDraft(""); setAdding(false); } }} />
        )}
        {tags.length === 0 && !adding && <span className="muted" style={{ fontSize: 12 }}>No tags yet.</span>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- field sections */

/**
 * Purpose-built for mineral acquisitions (not a generic CRM rail): who to
 * reach, what minerals they hold and where, how the lead entered the
 * pipeline, and the outreach cadence. All sections start open — this rail is
 * the at-a-glance dossier — and each can be collapsed individually.
 */
function FieldSections({ contact, onEdit }: { contact: ContactRow; onEdit?: () => void }) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const followUpOverdue = contact.nextFollowUpDate != null && new Date(contact.nextFollowUpDate).getTime() < Date.now();

  const sections: { title: string; rows: [string, React.ReactNode][] }[] = [
    {
      title: "Reach the Owner",
      rows: [
        ["Phone", contact.phone ? <a className="cw-mono" href={`tel:${contact.phone}`}>{contact.phone}</a> : null],
        ["Email", contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : null],
      ],
    },
    {
      title: "Mineral Interest",
      rows: [
        ["Ownership entity", contact.entityName],
        ["Counties", contact.counties.length ? contact.counties.join(", ") : null],
        ["State", contact.states.length ? contact.states.join(", ") : null],
      ],
    },
    {
      title: "Acquisition",
      rows: [
        ["Role", typeLabel(contact.type)],
        ["Lead source", contact.source],
        ["Owner", contact.owner?.name ?? null],
      ],
    },
    {
      title: "Outreach Cadence",
      rows: [
        ["Last contacted", contact.lastContactedAt ? fmtDate(contact.lastContactedAt) : null],
        ["Next follow-up", contact.nextFollowUpDate
          ? <span style={followUpOverdue ? { color: "var(--red)", fontWeight: 600 } : undefined}>{fmtDate(contact.nextFollowUpDate)}{followUpOverdue ? " · overdue" : ""}</span>
          : null],
      ],
    },
  ];
  const needle = q.trim().toLowerCase();
  const visible = needle
    ? sections.map((s) => ({ ...s, rows: s.rows.filter(([l]) => l.toLowerCase().includes(needle)) })).filter((s) => s.rows.length)
    : sections;

  return (
    <div className="cw-fields">
      <div className="cw-search">
        <Search size={12} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields…" aria-label="Search contact fields" />
      </div>
      {visible.map((s) => {
        const isOpen = needle ? true : !closed.has(s.title);
        return (
          <div key={s.title} className={`cw-sec ${isOpen ? "open" : ""}`}>
            <button className="cw-sec-head" onClick={() => setClosed((prev) => { const n = new Set(prev); n.has(s.title) ? n.delete(s.title) : n.add(s.title); return n; })} aria-expanded={isOpen}>
              <span>{s.title}</span>
              {isOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
            {isOpen && (
              <div className="cw-sec-body">
                {s.rows.map(([label, value]) => (
                  <div key={label}>
                    <div className="cw-flbl">{label}</div>
                    <div className={`cw-fval ${value == null || value === "" ? "empty" : ""}`}>{value ?? "—"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="cw-meta muted">Added {fmtDate(contact.createdAt)}</div>
      {onEdit && <button className="small" style={{ marginTop: 4 }} onClick={onEdit}>Edit contact</button>}
    </div>
  );
}

/* --------------------------------------------------------------- composer */

function Composer({ contactId, onLogged }: { contactId: string; onLogged: () => void }) {
  const [tab, setTab] = useState<"NOTE" | "CALL" | "EMAIL" | "SMS">("NOTE");
  const [body, setBody] = useState("");
  const [dispo, setDispo] = useState("No Answer");
  const [dur, setDur] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(`/contacts/${contactId}/activities`, {
        kind: tab,
        body: body.trim(),
        ...(tab === "CALL" ? { disposition: dispo, durationSeconds: dur.trim() === "" ? null : Number(dur) } : {}),
      });
      setBody(""); setDur("");
      onLogged();
    } finally { setBusy(false); }
  };

  const TABS: [typeof tab, string][] = [["NOTE", "Internal note"], ["CALL", "Log call"], ["EMAIL", "Log email"], ["SMS", "Log text"]];
  return (
    <div className="cw-composer">
      <div className="cw-comp-tabs">
        {TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => { setTab(k); inputRef.current?.focus(); }}>{l}</button>
        ))}
      </div>
      {tab === "CALL" && (
        <div className="row" style={{ gap: 8, marginBottom: 8 }}>
          <Select ariaLabel="Call disposition" width={180} value={dispo} onChange={(v) => v && setDispo(v)}
            options={DISPOSITIONS.map((d) => ({ value: d, label: d }))} />
          <input type="number" min={0} value={dur} onChange={(e) => setDur(e.target.value)} placeholder="Duration (sec)" style={{ width: 130 }} aria-label="Call duration in seconds" />
        </div>
      )}
      <div className="cw-comp-row">
        <textarea
          ref={inputRef}
          rows={1}
          value={body}
          placeholder={tab === "NOTE" ? "Type an internal note…" : tab === "CALL" ? "Call summary…" : tab === "EMAIL" ? "Email summary…" : "Text summary…"}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <button className="cw-send" disabled={!body.trim() || busy} onClick={() => void send()} title="Save to timeline" aria-label="Save to timeline">
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- side panel */

const TASK_PRIORITIES = [
  { v: "LOW", label: "Low", color: "var(--green)" },
  { v: "MEDIUM", label: "Medium", color: "var(--amber)" },
  { v: "HIGH", label: "High", color: "var(--red)" },
];

function SidePanel({ contact, activities, canManage, onChanged, users }: {
  contact: ContactRow; activities: ContactActivityRow[]; canManage: boolean; onChanged: () => void; users: UserLite[];
}) {
  // Deep link from the dashboard Tasks widget / task-due notifications:
  // `?task=<id>` opens straight onto the Tasks tab.
  const openedOnTask = useMemo(() => new URLSearchParams(window.location.search).has("task"), []);
  const [tab, setTab] = useState<"notes" | "tasks" | "reminders" | "minerals">(openedOnTask ? "tasks" : "notes");
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);

  const notes = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = activities.filter((a) => a.kind === "NOTE" || a.kind === "CALL");
    const filtered = needle ? rows.filter((a) => a.body.toLowerCase().includes(needle)) : rows;
    return [...filtered].sort((a, b) => Number(b.pinned) - Number(a.pinned) || +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [activities, q]);
  const tasks = activities.filter((a) => a.kind === "TASK").sort((a, b) => Number(!!a.completedAt) - Number(!!b.completedAt) || +new Date(a.dueDate ?? a.createdAt) - +new Date(b.dueDate ?? b.createdAt));
  const reminders = activities.filter((a) => a.kind === "REMINDER").sort((a, b) => +new Date(a.dueDate ?? a.createdAt) - +new Date(b.dueDate ?? b.createdAt));

  const add = async (kind: "TASK" | "REMINDER" | "NOTE") => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(`/contacts/${contact.id}/activities`, {
        kind, body: draft.trim(), dueDate: due || null,
        ...(kind === "TASK" ? { priority, assignedToId: assignee || null } : {}),
      });
      setDraft(""); setDue(""); setPriority("MEDIUM"); setAssignee("");
      onChanged();
    } finally { setBusy(false); }
  };
  const update = async (a: ContactActivityRow, body: Record<string, unknown>) => {
    await api.patch(`/contacts/${contact.id}/activities/${a.id}`, body);
    onChanged();
  };
  const remove = async (a: ContactActivityRow) => {
    await api.del(`/contacts/${contact.id}/activities/${a.id}`);
    onChanged();
  };

  return (
    <aside className="cw-right">
      <div className="cw-rtabs">
        {([["notes", "Notes"], ["tasks", "Tasks"], ["reminders", "Reminders"], ["minerals", "Minerals"]] as const).map(([k, l]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div className="cw-rbody">
        {tab === "notes" && (
          <>
            <div className="cw-search" style={{ marginTop: 0 }}>
              <Search size={12} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes…" aria-label="Search notes" />
            </div>
            {canManage && (
              <div className="row" style={{ gap: 8 }}>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a note…" style={{ flex: 1 }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add("NOTE"); } }} />
                <button className="primary small" disabled={!draft.trim() || busy} onClick={() => void add("NOTE")}><Plus size={11} /> Add</button>
              </div>
            )}
            {notes.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>No notes yet.</p>}
            {notes.map((a) => (
              <div key={a.id} className={`cw-note ${a.pinned ? "pinned" : ""}`}>
                <div className="cw-note-head">
                  <span className="cw-kind-ico sm" style={{
                    color: a.kind === "CALL" ? "var(--amber)" : "var(--accent)",
                    background: `color-mix(in srgb, ${a.kind === "CALL" ? "var(--amber)" : "var(--accent)"} 13%, transparent)`,
                  }}>{a.kind === "CALL" ? <Phone size={12} /> : <StickyNote size={12} />}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{a.kind === "CALL" ? `Call · ${a.disposition ?? "Logged"}` : "Note"}</span>
                  {canManage && (
                    <span className="row" style={{ gap: 2 }}>
                      <button className="icon-btn" title={a.pinned ? "Unpin" : "Pin"} onClick={() => void update(a, { pinned: !a.pinned })}><Pin size={12} /></button>
                      <button className="icon-btn" title="Delete" onClick={() => void remove(a)}><X size={12} /></button>
                    </span>
                  )}
                </div>
                <div className="cw-note-body">{a.body}</div>
                <div className="cw-note-foot"><span className="cw-mono">{fmtDate(a.createdAt)}, {fmtTime(a.createdAt)}</span><span>{a.createdBy?.name ?? ""}</span></div>
              </div>
            ))}
          </>
        )}

        {(tab === "tasks" || tab === "reminders") && (
          <>
            {canManage && (
              <>
                <div className="cw-addrow">
                  <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tab === "tasks" ? "New task…" : "New reminder…"}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(tab === "tasks" ? "TASK" : "REMINDER"); } }} />
                  <DateField value={due} onChange={setDue} />
                  <button className="primary small" disabled={!draft.trim() || busy} onClick={() => void add(tab === "tasks" ? "TASK" : "REMINDER")}><Plus size={11} /> Add</button>
                </div>
                {tab === "tasks" && (
                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <Select ariaLabel="Priority" value={priority} onChange={(v) => setPriority(v || "MEDIUM")}
                      options={TASK_PRIORITIES.map((p) => ({ value: p.v, label: `${p.label} priority` }))} />
                    <Select ariaLabel="Assignee" clearable searchable placeholder="Assign to me" value={assignee} onChange={setAssignee}
                      options={users.map((u) => ({ value: u.id, label: u.name }))} />
                  </div>
                )}
              </>
            )}
            {tab === "tasks" && (
              <>
                <div className="cw-lbl">Up next</div>
                {tasks.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>No tasks yet.</p>}
                {tasks.map((a) => (
                  <div key={a.id} className={`cw-task ${a.completedAt ? "done" : ""}`}>
                    <input type="checkbox" checked={!!a.completedAt} disabled={!canManage} onChange={() => void update(a, { completed: !a.completedAt })} aria-label={`Complete ${a.body}`} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="cw-task-title">{a.body}</div>
                      <div className="row" style={{ gap: 6, marginTop: 2, flexWrap: "wrap" }}>
                        {a.dueDate && <span className="cw-mono" style={{ fontSize: 11, color: a.completedAt ? "var(--text-dim)" : "var(--amber)" }}>{fmtDate(a.dueDate)}</span>}
                        {a.priority && (() => {
                          const p = TASK_PRIORITIES.find((x) => x.v === a.priority);
                          return p ? <span style={{ fontSize: 10.5, fontWeight: 700, color: p.color, background: `color-mix(in srgb, ${p.color} 13%, transparent)`, borderRadius: 999, padding: "1px 7px" }}>{p.label}</span> : null;
                        })()}
                        {a.assignedTo && <span className="muted" style={{ fontSize: 11 }}>{a.assignedTo.name}</span>}
                      </div>
                    </div>
                    {canManage && <button className="icon-btn" title="Delete" onClick={() => void remove(a)}><X size={12} /></button>}
                  </div>
                ))}
              </>
            )}
            {tab === "reminders" && (
              <>
                <div className="cw-lbl">Reminders</div>
                {reminders.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>No reminders yet.</p>}
                {reminders.map((a) => (
                  <div key={a.id} className="cw-reminder">
                    <span className="cw-kind-ico sm" style={{ color: "var(--amber)", background: "color-mix(in srgb, var(--amber) 13%, transparent)" }}><Bell size={12} /></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="cw-task-title">{a.body}</div>
                      {a.dueDate && <div className="cw-mono" style={{ fontSize: 11, color: "var(--amber)", marginTop: 2 }}>{fmtDate(a.dueDate)}</div>}
                    </div>
                    {canManage && <button className="icon-btn" title="Delete" onClick={() => void remove(a)}><X size={12} /></button>}
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {tab === "minerals" && (
          <>
            <div className="cw-tags-head">
              <span className="cw-lbl" style={{ marginBottom: 0 }}>Minerals owned</span>
              <Link to="/map" style={{ fontSize: 11.5, fontWeight: 600 }}>View on map</Link>
            </div>
            {contact.counties.length > 0 ? (
              <div className="cw-tags">
                {contact.counties.map((c) => (
                  <span key={c} className="cw-tag"><MapPin size={9} /> {c}{contact.states[0] ? `, ${contact.states[0]}` : ""}</span>
                ))}
              </div>
            ) : null}
            <EmptyState icon={<CheckSquare size={18} />} title="No holdings linked yet">
              Mineral holdings tied to this contact will appear here as the acquisitions module grows —
              for now their counties of interest are shown above.
            </EmptyState>
          </>
        )}
      </div>
    </aside>
  );
}
