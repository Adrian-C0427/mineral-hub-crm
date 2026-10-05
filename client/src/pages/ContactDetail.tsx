import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Bell, CheckSquare, ChevronDown, ChevronLeft, ChevronRight,
  Mail, MapPin, MessageSquare, Palette, Pencil, Phone, Pin, Plus, Search, Send, StickyNote, Trash2, X,
} from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Banner, ConfirmDelete, EmptyState, showToast, UserChip, ChipList, OverflowMenu } from "../components/ui";
import { Select } from "../components/Select";
import { DateField } from "../components/DateField";
import { Avatar, Segmented, Tag } from "../components/kit";
import { fmtDate } from "../lib/format";
import { type ContactRow, TYPES, STATUSES, typeLabel, TypeTag, StatusTag } from "./Contacts";
import { formatPhone, formatPhoneAsYouType, normalizePhone } from "../lib/phone";
import { useIsPhonePortrait } from "../lib/mobile";
import type { UserLite } from "../types";

/**
 * Contact workspace (reference layout): left contact-details rail, center
 * activity timeline + composer, right Notes / Tasks / Reminders / Minerals
 * panel. All data is real: contact fields, tags, and a persisted activity
 * timeline (notes, logged calls / emails / texts, tasks, reminders).
 *
 * Phones (≤760px) show the same panes one at a time behind a five-tab strip
 * under the contact header (Details / Activity / Tasks / Notes / Minerals).
 * The panes stay mounted; styles/contact-mobile.css hides the inactive ones.
 */

type PhoneTab = "details" | "activity" | "tasks" | "notes" | "minerals";

export interface ContactActivityRow {
  id: string;
  kind: "NOTE" | "CALL" | "EMAIL" | "SMS" | "TASK" | "REMINDER" | string;
  title: string | null;
  body: string;
  disposition: string | null;
  durationSeconds: number | null;
  dueDate: string | null;
  completedAt: string | null;
  priority: "LOW" | "MEDIUM" | "HIGH" | string | null;
  assignedTo: { id: string; name: string; avatarColor?: string | null } | null;
  pinned: boolean;
  color?: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

const DISPOSITIONS = ["Connected", "No Answer", "Voicemail", "Bad Number", "Callback Requested"];
/** Outcome tag tone per server disposition (display only). */
const DISPOSITION_TONE: Record<string, "success" | "warn" | "neutral" | "danger" | "accent"> = {
  Connected: "success", Voicemail: "warn", "No Answer": "neutral", "Bad Number": "danger", "Callback Requested": "accent",
};

// Optional note background colors — soft pastels, keyed by name (the server
// stores the key; per-theme shades live in the stylesheet). Swatch hex is only
// the picker preview.
const NOTE_COLORS: { key: string; label: string; hex: string }[] = [
  { key: "yellow", label: "Yellow", hex: "#eab308" },
  { key: "blue", label: "Blue", hex: "#3b82f6" },
  { key: "green", label: "Green", hex: "#22c55e" },
  { key: "purple", label: "Purple", hex: "#8b5cf6" },
  { key: "pink", label: "Pink", hex: "#ec4899" },
  { key: "orange", label: "Orange", hex: "#f97316" },
];

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

/** Timeline kinds: head label, filter label, icon, and colour class. */
const KIND_META: Record<string, { label: string; tag: string; plural: string; icon: JSX.Element; cls: string }> = {
  NOTE: { label: "Internal note", tag: "Note", plural: "Notes", icon: <StickyNote size={14} />, cls: "k-note" },
  CALL: { label: "Outbound call", tag: "Call", plural: "Calls", icon: <Phone size={14} />, cls: "k-call" },
  EMAIL: { label: "Email", tag: "Email", plural: "Emails", icon: <Mail size={14} />, cls: "k-email" },
  SMS: { label: "Text message", tag: "Text", plural: "Texts", icon: <MessageSquare size={14} />, cls: "k-text" },
};

/** Due chip for tasks/reminders. Due dates are calendar days stored at UTC
 *  midnight, so compare the stored day key with today's local day key. */
function DueChip({ iso, done }: { iso: string | null; done: boolean }) {
  if (!iso) return <span className="cw-chip">No date</span>;
  const t = new Date();
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  const key = iso.slice(0, 10);
  if (done || key > today) return <span className="cw-chip">{fmtDate(iso)}</span>;
  if (key === today) return <span className="cw-chip warn">Due today</span>;
  return <span className="cw-chip danger">Overdue · {fmtDate(iso)}</span>;
}

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
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Phone tab strip. A `?task=<id>` deep link lands on the Tasks tab.
  const isPhone = useIsPhonePortrait();
  const [mtab, setMtab] = useState<PhoneTab>(() => (new URLSearchParams(window.location.search).has("task") ? "tasks" : "details"));
  // Bumped by the phone "Text" quick action: Activity shows logged texts and
  // the composer switches to "Log text" (the app logs texts; it never sends).
  const [textJump, setTextJump] = useState(0);
  const mtabsRef = useRef<HTMLDivElement>(null);
  const loaded = contact != null;
  // The strip scrolls sideways on narrow phones: keep the selected tab in view.
  useEffect(() => {
    const strip = mtabsRef.current;
    const active = strip?.querySelector<HTMLElement>(".active");
    if (!strip || !active) return;
    const a = active.getBoundingClientRect(), s = strip.getBoundingClientRect();
    if (a.left < s.left || a.right > s.right) strip.scrollLeft += a.left - s.left - (s.width - a.width) / 2;
  }, [mtab, isPhone, loaded]);

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
  // Timeline pin / delete reuse the activity endpoints the Notes panel uses.
  const updateActivity = async (a: ContactActivityRow, body: Record<string, unknown>) => {
    await api.patch(`/contacts/${id}/activities/${a.id}`, body);
    load();
  };
  const removeActivity = async (a: ContactActivityRow) => {
    await api.del(`/contacts/${id}/activities/${a.id}`);
    load();
  };

  if (err) return <div className="page"><Banner kind="error">{err}</Banner></div>;
  if (!contact) return <Spinner />;

  const idx = all.findIndex((c) => c.id === contact.id);
  const go = (dir: -1 | 1) => { const n = all[idx + dir]; if (n) nav(`/contacts/${n.id}`); };
  const timeline = (activities ?? []).filter((a) => a.kind !== "TASK" && a.kind !== "REMINDER");
  const acts = activities ?? [];
  const phoneTabs: [PhoneTab, string, number][] = [
    ["details", "Details", 0],
    ["activity", "Activity", timeline.length],
    ["tasks", "Tasks", acts.filter((a) => (a.kind === "TASK" || a.kind === "REMINDER") && !a.completedAt).length],
    ["notes", "Notes", acts.filter((a) => a.kind === "NOTE" || a.kind === "CALL").length],
    ["minerals", "Minerals", 0],
  ];

  return (
    <div className="cw-wrap">
      {/* Detail bar: back + record pager. */}
      <header className="cw-top">
        <Link to="/contacts" className="cw-topback" aria-label="Back to contacts"><ArrowLeft size={15} /></Link>
        <span className="cw-toptitle">Contact Details</span>
        {idx >= 0 && <span className="cw-count">{idx + 1} of {all.length.toLocaleString()}</span>}
        <span className="cw-pager">
          <button className="cw-pgbtn" disabled={idx <= 0} onClick={() => go(-1)} aria-label="Previous contact"><ChevronLeft size={13} /></button>
          <button className="cw-pgbtn" disabled={idx < 0 || idx >= all.length - 1} onClick={() => go(1)} aria-label="Next contact"><ChevronRight size={13} /></button>
        </span>
      </header>

      <div className="cw" data-mtab={isPhone ? mtab : undefined}>
      {/* ============================================== left: contact details */}
      <aside className="cw-left">
        <div className="cw-ident-row">
          <Avatar name={contact.name} size={52} />
          <div className="cw-ident-main">
            <NameField contact={contact} canEdit={canManage} onSave={patch} />
            {isPhone && contact.phone && <div className="cw-ident-phone">{formatPhone(contact.phone)}</div>}
            <div className="cw-pills">
              <TypeTag type={contact.type} />
              <StatusTag status={contact.status} />
            </div>
          </div>
          {canManage && (
            <OverflowMenu items={[{ label: <span className="cw-menu-danger"><Trash2 size={14} /> Delete contact</span>, danger: true, onClick: () => setConfirmDelete(true) }]} />
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

        <FieldSections contact={contact} canManage={canManage} onSave={patch} />
      </aside>

      {/* Phones only: quick actions + the tab strip that picks the visible pane. */}
      {isPhone && (
        <>
          <div className="cw-quick">
            {contact.phone && <a className="cw-qa" href={`tel:${contact.phone}`}><span><Phone size={22} /></span>Call</a>}
            <button type="button" className="cw-qa" onClick={() => { setMtab("activity"); setTextJump((n) => n + 1); }}><span><MessageSquare size={22} /></span>Text</button>
            {contact.email && <a className="cw-qa" href={`mailto:${contact.email}`}><span><Mail size={22} /></span>Email</a>}
            <button type="button" className="cw-qa" onClick={() => setMtab("tasks")}><span><CheckSquare size={22} /></span>Task</button>
            <button type="button" className="cw-qa" onClick={() => setMtab("notes")}><span><StickyNote size={22} /></span>Note</button>
          </div>
          <div className="cw-mtabs" role="tablist" aria-label="Contact sections" ref={mtabsRef}>
            {phoneTabs.map(([k, l, n]) => (
              <button key={k} type="button" role="tab" aria-selected={mtab === k} className={mtab === k ? "active" : ""} onClick={() => setMtab(k)}>
                {l}{n > 0 && <span>{n}</span>}
              </button>
            ))}
          </div>
        </>
      )}

      {/* ============================================== center: timeline */}
      <section className="cw-center">
        <div className="cw-chead">
          <div className="cw-chead-who">
            <Avatar name={contact.name} size={40} />
            <div style={{ minWidth: 0 }}>
              <div className="cw-chead-name">{contact.name}</div>
              {contact.phone && <div className="cw-chead-phone">{formatPhone(contact.phone)}</div>}
            </div>
          </div>
          <div className="cw-chead-acts">
            {contact.phone && <a className="cw-act call" href={`tel:${contact.phone}`} title={`Call ${formatPhone(contact.phone)}`}><Phone size={14} /> Call</a>}
            {contact.email && <a className="cw-act" href={`mailto:${contact.email}`} title={`Email ${contact.email}`}><Mail size={14} /> Email</a>}
          </div>
        </div>

        <Timeline activities={activities} timeline={timeline} canManage={canManage} onUpdate={updateActivity} onRemove={removeActivity} textJump={textJump} />

        {canManage && <Composer contactId={contact.id} onLogged={load} textJump={textJump} />}
      </section>

      {/* ============================================== right: notes/tasks/... */}
      <SidePanel contact={contact} activities={activities ?? []} canManage={canManage} onChanged={load} users={users} phoneTab={isPhone ? mtab : null} />
      </div>

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

/* -------------------------------------------------------------- timeline */

/**
 * Activity timeline in chronological order (oldest first, as logged), in day groups.
 * Filter chips narrow the view by kind (display only). Pin and delete are
 * offered on notes and logged calls — the same entries the Notes panel already
 * lets the team pin and delete; delete asks for a second click.
 */
function Timeline({ activities, timeline, canManage, onUpdate, onRemove, textJump }: {
  activities: ContactActivityRow[] | null; timeline: ContactActivityRow[]; canManage: boolean; textJump: number;
  onUpdate: (a: ContactActivityRow, body: Record<string, unknown>) => Promise<void>;
  onRemove: (a: ContactActivityRow) => Promise<void>;
}) {
  const [kind, setKind] = useState("ALL");
  // Phone "Text" quick action: narrow the timeline to logged texts.
  useEffect(() => { if (textJump) setKind("SMS"); }, [textJump]);
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);

  if (activities === null) return <div className="cw-timeline"><Spinner /></div>;

  const shown = [...(kind === "ALL" ? timeline : timeline.filter((a) => a.kind === kind))]
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  const groups: { label: string; pinned?: boolean; items: ContactActivityRow[] }[] = [];
  for (const a of shown) {
    const last = groups[groups.length - 1];
    if (last && !last.pinned && dayKey(last.items[0].createdAt) === dayKey(a.createdAt)) last.items.push(a);
    else groups.push({ label: dayLabel(a.createdAt), items: [a] });
  }

  return (
    <>
      {timeline.length > 0 && (
        <div className="cw-filters">
          {[["ALL", "All"], ...Object.entries(KIND_META).map(([k, m]) => [k, m.plural])].map(([k, l]) => (
            <button key={k} type="button" className={`cw-fchip ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
              {l}<span>{k === "ALL" ? timeline.length : timeline.filter((a) => a.kind === k).length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="cw-timeline">
        {timeline.length === 0 ? (
          <EmptyState icon={<span className="cw-empty-tile"><MessageSquare size={18} /></span>} title="No activity yet">
            Log your first call, text, email, or internal note below — everything lands on this timeline.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState icon={<span className="cw-empty-tile"><MessageSquare size={18} /></span>} title="Nothing in this filter" />
        ) : groups.map((g) => (
          <div key={g.label + g.items[0].id}>
            <div className={`cw-day ${g.pinned ? "pinned" : ""}`}><span>{g.label}</span><i /></div>
            {g.items.map((a) => {
              const meta = KIND_META[a.kind] ?? KIND_META.NOTE;
              const actionable = canManage && (a.kind === "NOTE" || a.kind === "CALL");
              return (
                <div key={a.id} className={`cw-event ${meta.cls}`}>
                  <span className="cw-kind-ico">{meta.icon}</span>
                  <div className="cw-entry">
                    <div className="cw-entry-head">
                      <span className="cw-entry-title">{a.title ?? meta.label}</span>
                      <span className="cw-kind-tag">{meta.tag}</span>
                      {a.kind === "CALL" && a.disposition && <Tag tone={DISPOSITION_TONE[a.disposition] ?? "neutral"}>{a.disposition}</Tag>}
                      <span className="cw-entry-meta">
                        {fmtTime(a.createdAt)} · {a.createdBy?.name ?? "—"}
                        {a.kind === "CALL" && a.durationSeconds != null && <> · {a.durationSeconds} sec</>}
                      </span>
                      {actionable && (
                        <span className="cw-entry-acts">
                          <button type="button" className={`cw-ibtn ${a.pinned ? "pinned" : ""}`} title={a.pinned ? "Unpin" : "Pin to top"} aria-label={a.pinned ? "Unpin" : "Pin to top"}
                            onClick={() => void onUpdate(a, { pinned: !a.pinned })}><Pin size={13} /></button>
                          <button type="button" className={`cw-ibtn del ${armed === a.id ? "armed" : ""}`}
                            title={armed === a.id ? "Click again to delete" : "Delete"} aria-label={armed === a.id ? "Click again to delete" : "Delete"}
                            onClick={() => { if (armed === a.id) { setArmed(null); void onRemove(a); } else setArmed(a.id); }}><Trash2 size={13} /></button>
                        </span>
                      )}
                    </div>
                    {a.body && <div className="cw-entry-body">{a.body}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
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
    <div className="cw-tags">
      {tags.map((t) => (
        <span key={t} className="cw-tag">
          {t}
          {canManage && <button aria-label={`Remove tag ${t}`} onClick={() => onSave(tags.filter((x) => x !== t))}><X size={10} /></button>}
        </span>
      ))}
      {adding && (
        <input autoFocus className="cw-tag-input" value={draft} placeholder="Tag name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } if (e.key === "Escape") { setDraft(""); setAdding(false); } }} />
      )}
      {canManage && !adding && <button className="cw-tag-add" onClick={() => setAdding(true)}>+ Add tag</button>}
      {tags.length === 0 && !adding && !canManage && <span className="cw-none">No tags yet.</span>}
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
/** Click-to-edit contact name (first + last saved together, still one action). */
function NameField({ contact, canEdit, onSave }: { contact: ContactRow; canEdit: boolean; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = first.trim() !== contact.firstName || last.trim() !== contact.lastName;
  const valid = first.trim() !== "" && last.trim() !== "";

  if (!editing) {
    return (
      <div
        className={`cw-name ${canEdit ? "editable" : ""}`}
        role={canEdit ? "button" : undefined} tabIndex={canEdit ? 0 : undefined}
        title={canEdit ? "Edit name" : undefined}
        onClick={() => { if (canEdit) { setFirst(contact.firstName); setLast(contact.lastName); setEditing(true); } }}
        onKeyDown={canEdit ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFirst(contact.firstName); setLast(contact.lastName); setEditing(true); } } : undefined}
      >
        {contact.name}
      </div>
    );
  }
  const save = async () => {
    if (!dirty || !valid || busy) return;
    setBusy(true);
    try { await onSave({ firstName: first.trim(), lastName: last.trim() }); setEditing(false); } finally { setBusy(false); }
  };
  return (
    <div className="cw-fedit" style={{ flexWrap: "wrap" }}>
      <input autoFocus value={first} onChange={(e) => setFirst(e.target.value)} placeholder="First" aria-label="First name" style={{ flex: "1 1 90px", minWidth: 0 }}
        onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }} />
      <input value={last} onChange={(e) => setLast(e.target.value)} placeholder="Last" aria-label="Last name" style={{ flex: "1 1 90px", minWidth: 0 }}
        onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }} />
      <button className="small primary" disabled={!dirty || !valid || busy} onClick={() => void save()}>Save</button>
      <button className="icon-btn" title="Cancel" aria-label="Cancel name edit" onClick={() => setEditing(false)}><X size={12} /></button>
    </div>
  );
}

/** One inline-editable dossier field: click the value to edit just that field,
 *  Save patches only it, Escape/Cancel restores read-only. */
interface FieldSpec {
  label: string;
  display: React.ReactNode;
  /** Absent = read-only (derived/relation values like Owner). */
  edit?: {
    kind: "text" | "phone" | "date" | "select" | "list";
    value: string;
    options?: { value: string; label: string }[];
    placeholder?: string;
    /** Build the single-field PATCH body from the edited string. */
    body: (v: string) => Record<string, unknown>;
    /** Refuse an empty value (first / last name). */
    required?: boolean;
  };
}

function InlineField({ spec, canEdit, onSave }: { spec: FieldSpec; canEdit: boolean; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = canEdit && !!spec.edit;
  const dirty = editing && spec.edit && v !== spec.edit.value && !(spec.edit.required && v.trim() === "");

  const start = () => { if (!editable) return; setV(spec.edit!.value); setEditing(true); };
  const save = async () => {
    if (!spec.edit || busy || !dirty) return;
    setBusy(true);
    try { await onSave(spec.edit.body(v)); setEditing(false); } finally { setBusy(false); }
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); void save(); }
    if (e.key === "Escape") setEditing(false);
  };

  return (
    <div>
      <div className="cw-flbl">{spec.label}</div>
      {!editing ? (
        <div
          className={`cw-fval ${spec.display == null || spec.display === "" ? "empty" : ""} ${editable ? "editable" : ""}`}
          role={editable ? "button" : undefined} tabIndex={editable ? 0 : undefined}
          title={editable ? `Edit ${spec.label.toLowerCase()}` : undefined}
          onClick={start}
          onKeyDown={editable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); start(); } } : undefined}
        >
          {spec.display ?? "—"}
          {editable && <Pencil size={10} className="cw-fpen" aria-hidden="true" />}
        </div>
      ) : (
        <div className="cw-fedit">
          {spec.edit!.kind === "select" ? (
            <Select ariaLabel={spec.label} value={v} onChange={(nv) => nv && setV(nv)} options={spec.edit!.options ?? []} />
          ) : spec.edit!.kind === "date" ? (
            <DateField value={v} onChange={setV} />
          ) : (
            <input
              autoFocus
              value={v}
              placeholder={spec.edit!.placeholder}
              onChange={(e) => setV(spec.edit!.kind === "phone" ? formatPhoneAsYouType(e.target.value) : e.target.value)}
              onKeyDown={keys}
              aria-label={spec.label}
            />
          )}
          <button className="small primary" disabled={!dirty || busy} onClick={() => void save()}>Save</button>
          <button className="icon-btn" title="Cancel" aria-label="Cancel edit" onClick={() => setEditing(false)}><X size={12} /></button>
        </div>
      )}
    </div>
  );
}

const SECTION_ICONS: Record<string, JSX.Element> = {
  "Contact": <Phone size={15} />,
  "Mineral interest": <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>,
  "Acquisition": <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></svg>,
  "Outreach": <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>,
};

function FieldSections({ contact, canManage, onSave }: { contact: ContactRow; canManage: boolean; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [q, setQ] = useState("");
  // The dossier sections start open; each can be collapsed individually.
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const followUpOverdue = contact.nextFollowUpDate != null && new Date(contact.nextFollowUpDate).getTime() < Date.now();

  const list = (raw: string) => raw.split(",").map((s) => s.trim()).filter(Boolean);
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
  const sections: { title: string; rows: FieldSpec[] }[] = [
    {
      title: "Contact",
      rows: [
        // First and last name are saved together, like the header name editor.
        {
          label: "First name", display: contact.firstName,
          edit: { kind: "text", value: contact.firstName, required: true, body: (v) => ({ firstName: v.trim(), lastName: contact.lastName }) },
        },
        {
          label: "Last name", display: contact.lastName,
          edit: { kind: "text", value: contact.lastName, required: true, body: (v) => ({ firstName: contact.firstName, lastName: v.trim() }) },
        },
        {
          label: "Phone",
          display: contact.phone ? <a href={`tel:${contact.phone}`} onClick={(e) => e.stopPropagation()}>{formatPhone(contact.phone)}</a> : null,
          edit: { kind: "phone", value: formatPhone(contact.phone), placeholder: "(555) 000-0000", body: (v) => ({ phone: normalizePhone(v) || null }) },
        },
        {
          label: "Email",
          display: contact.email ? <a href={`mailto:${contact.email}`} onClick={(e) => e.stopPropagation()}>{contact.email}</a> : null,
          edit: { kind: "text", value: contact.email ?? "", placeholder: "name@example.com", body: (v) => ({ email: v.trim() || null }) },
        },
      ],
    },
    {
      title: "Mineral interest",
      rows: [
        {
          label: "Ownership entity", display: contact.entityName,
          edit: { kind: "text", value: contact.entityName ?? "", body: (v) => ({ entityName: v.trim() || null }) },
        },
        {
          label: "State", display: contact.states.length ? <ChipList items={contact.states} /> : null,
          edit: { kind: "list", value: contact.states.join(", "), placeholder: "Comma-separated", body: (v) => ({ states: list(v) }) },
        },
        {
          label: "Counties", display: contact.counties.length ? <ChipList items={contact.counties} /> : null,
          edit: { kind: "list", value: contact.counties.join(", "), placeholder: "Comma-separated", body: (v) => ({ counties: list(v) }) },
        },
      ],
    },
    {
      title: "Acquisition",
      rows: [
        {
          label: "Role", display: typeLabel(contact.type),
          edit: { kind: "select", value: contact.type, options: TYPES.map(([v, l]) => ({ value: v, label: l })), body: (v) => ({ type: v }) },
        },
        {
          label: "Lead source", display: contact.source,
          edit: { kind: "text", value: contact.source ?? "", body: (v) => ({ source: v.trim() || null }) },
        },
        // Owner is assigned from the identity card's Owner selector above.
        { label: "Owner", display: contact.owner?.name ?? null },
      ],
    },
    {
      title: "Outreach",
      rows: [
        {
          label: "Last contacted", display: contact.lastContactedAt ? fmtDate(contact.lastContactedAt) : null,
          edit: { kind: "date", value: day(contact.lastContactedAt), body: (v) => ({ lastContactedAt: v || null }) },
        },
        {
          label: "Next follow-up",
          display: contact.nextFollowUpDate
            ? <span className={followUpOverdue ? "cw-overdue" : undefined}>{fmtDate(contact.nextFollowUpDate)}{followUpOverdue ? " · overdue" : ""}</span>
            : null,
          edit: { kind: "date", value: day(contact.nextFollowUpDate), body: (v) => ({ nextFollowUpDate: v || null }) },
        },
        { label: "Added", display: fmtDate(contact.createdAt) },
      ],
    },
  ];
  const needle = q.trim().toLowerCase();
  const visible = needle
    ? sections.map((s) => ({ ...s, rows: s.rows.filter((r) => r.label.toLowerCase().includes(needle)) })).filter((s) => s.rows.length)
    : sections;

  return (
    <div className="cw-fields">
      <div className="cw-search">
        <Search size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields…" aria-label="Search contact fields" />
      </div>
      {visible.map((s) => {
        const isOpen = needle ? true : !closed.has(s.title);
        return (
          <div key={s.title} className={`cw-sec ${isOpen ? "open" : ""}`}>
            <button className="cw-sec-head" onClick={() => setClosed((prev) => { const n = new Set(prev); n.has(s.title) ? n.delete(s.title) : n.add(s.title); return n; })} aria-expanded={isOpen}>
              <span className="cw-sec-ico">{SECTION_ICONS[s.title]}</span>
              <span className="cw-sec-name">{s.title}</span>
              <ChevronDown size={14} className="cw-sec-chev" />
            </button>
            {isOpen && (
              <div className="cw-sec-body">
                {s.rows.map((r) => <InlineField key={r.label} spec={r} canEdit={canManage} onSave={onSave} />)}
              </div>
            )}
          </div>
        );
      })}
      {needle && visible.length === 0 && <div className="cw-none">No fields match "{q}".</div>}
      <div className="cw-meta">Added {fmtDate(contact.createdAt)}</div>
    </div>
  );
}

/* --------------------------------------------------------------- composer */

function Composer({ contactId, onLogged, textJump }: { contactId: string; onLogged: () => void; textJump: number }) {
  const [tab, setTab] = useState<"NOTE" | "CALL" | "EMAIL" | "SMS">("NOTE");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [dispo, setDispo] = useState("No Answer");
  const [dur, setDur] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Phone "Text" quick action: switch to "Log text" and bring the form on screen.
  useEffect(() => {
    if (!textJump) return;
    setTab("SMS");
    boxRef.current?.scrollIntoView({ block: "center" });
  }, [textJump]);

  // Internal notes require a concise Title above the detailed note; quick
  // call/email/text logs stay single-field.
  const ready = body.trim() !== "" && (tab !== "NOTE" || title.trim() !== "");
  const send = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api.post(`/contacts/${contactId}/activities`, {
        kind: tab,
        ...(tab === "NOTE" ? { title: title.trim() } : {}),
        body: body.trim(),
        ...(tab === "CALL" ? { disposition: dispo, durationSeconds: dur.trim() === "" ? null : Number(dur) } : {}),
      });
      setTitle(""); setBody(""); setDur("");
      onLogged();
    } finally { setBusy(false); }
  };

  const TABS: [typeof tab, string][] = [["NOTE", "Internal note"], ["CALL", "Log call"], ["EMAIL", "Log email"], ["SMS", "Log text"]];
  const label = TABS.find(([k]) => k === tab)![1];
  return (
    <div className="cw-composer" ref={boxRef}>
      <div className="cw-comp-top">
        <Segmented accent ariaLabel="Entry type" value={tab}
          onChange={(k) => { setTab(k); inputRef.current?.focus(); }}
          options={TABS.map(([k, l]) => ({ value: k, label: l }))} />
        {tab === "CALL" && (
          <div className="cw-outcomes" role="radiogroup" aria-label="Call disposition">
            {DISPOSITIONS.map((d) => (
              <button key={d} type="button" role="radio" aria-checked={dispo === d} className={`cw-pill ${dispo === d ? "active" : ""}`} onClick={() => setDispo(d)}>{d}</button>
            ))}
            <input className="cw-dur" type="number" min={0} value={dur} onChange={(e) => setDur(e.target.value)} placeholder="Duration (sec)" aria-label="Call duration in seconds" />
          </div>
        )}
      </div>
      {tab === "NOTE" && (
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title — concise summary…"
          aria-label="Note title"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); inputRef.current?.focus(); } }}
        />
      )}
      <div className="cw-comp-row">
        <textarea
          ref={inputRef}
          rows={2}
          value={body}
          placeholder={tab === "NOTE" ? "Type an internal note…" : tab === "CALL" ? "Call summary…" : tab === "EMAIL" ? "Email summary…" : "Text summary…"}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <button className="cw-send" disabled={!ready || busy} onClick={() => void send()} title={`${label} — save to timeline`} aria-label="Save to timeline">
          <Send size={16} />
        </button>
      </div>
      <div className="cw-comp-hint">Enter to save · Shift + Enter for a new line</div>
    </div>
  );
}

/* -------------------------------------------------------------- side panel */

const TASK_PRIORITIES: { v: string; label: string; tone: "neutral" | "warn" | "danger" }[] = [
  { v: "LOW", label: "Low", tone: "neutral" },
  { v: "MEDIUM", label: "Medium", tone: "warn" },
  { v: "HIGH", label: "High", tone: "danger" },
];

function SidePanel({ contact, activities, canManage, onChanged, users, phoneTab }: {
  contact: ContactRow; activities: ContactActivityRow[]; canManage: boolean; onChanged: () => void; users: UserLite[];
  /** Phone tab strip selection (null on desktop, where the rail's own tabs rule). */
  phoneTab: PhoneTab | null;
}) {
  // Deep link from the dashboard Tasks widget / task-due notifications:
  // `?task=<id>` opens straight onto the Tasks tab.
  const openedOnTask = useMemo(() => new URLSearchParams(window.location.search).has("task"), []);
  // Tasks is the default rail tab; ?task deep links land there too.
  const [railTab, setTab] = useState<"notes" | "tasks" | "reminders" | "minerals">(openedOnTask ? "tasks" : "tasks");
  // Phones: the page-level strip picks the pane. Its Tasks tab covers tasks and
  // reminders, so the rail's own Tasks / Reminders switch stays in charge there.
  const tab: typeof railTab = phoneTab === "notes" || phoneTab === "minerals" ? phoneTab
    : phoneTab === "tasks" ? (railTab === "reminders" ? "reminders" : "tasks")
    : railTab;
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState("");   // Title — concise summary (required)
  const [note, setNote] = useState("");     // Note — detailed information (required)
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  // Optional background color for the note being composed (null = default).
  const [noteColor, setNoteColor] = useState<string | null>(null);
  // Note id whose inline color palette is open (edit-in-place).
  const [colorPickFor, setColorPickFor] = useState<string | null>(null);
  // Completed tasks fold into a group; a ?task deep link shows them so the
  // linked task is on screen whatever its state.
  const [showDone, setShowDone] = useState(openedOnTask);

  const notes = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = activities.filter((a) => a.kind === "NOTE" || a.kind === "CALL");
    const filtered = needle ? rows.filter((a) => a.body.toLowerCase().includes(needle)) : rows;
    return [...filtered].sort((a, b) => Number(b.pinned) - Number(a.pinned) || +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [activities, q]);
  const tasks = activities.filter((a) => a.kind === "TASK").sort((a, b) => Number(!!a.completedAt) - Number(!!b.completedAt) || +new Date(a.dueDate ?? a.createdAt) - +new Date(b.dueDate ?? b.createdAt));
  const openTasks = tasks.filter((a) => !a.completedAt);
  const doneTasks = tasks.filter((a) => a.completedAt);
  const reminders = activities.filter((a) => a.kind === "REMINDER").sort((a, b) => +new Date(a.dueDate ?? a.createdAt) - +new Date(b.dueDate ?? b.createdAt));
  const noteCount = activities.filter((a) => a.kind === "NOTE" || a.kind === "CALL").length;

  const add = async (kind: "TASK" | "REMINDER" | "NOTE") => {
    if (!draft.trim() || !note.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(`/contacts/${contact.id}/activities`, {
        kind, title: draft.trim(), body: note.trim(), dueDate: due || null,
        ...(kind === "TASK" ? { priority, assignedToId: assignee || null } : {}),
        ...(kind === "NOTE" ? { color: noteColor } : {}),
      });
      setDraft(""); setNote(""); setDue(""); setPriority("MEDIUM"); setAssignee(""); setNoteColor(null);
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

  const taskRow = (a: ContactActivityRow) => {
    const p = TASK_PRIORITIES.find((x) => x.v === a.priority);
    return (
      <div key={a.id} className={`cw-task ${a.completedAt ? "done" : ""}`}>
        <input type="checkbox" checked={!!a.completedAt} disabled={!canManage} onChange={() => void update(a, { completed: !a.completedAt })} aria-label={`Complete ${a.body}`} />
        <div className="cw-task-main">
          <div className="cw-task-title">{a.title ?? a.body}</div>
          {a.title && <div className="cw-task-sub">{a.body}</div>}
          <div className="cw-task-chips">
            <DueChip iso={a.dueDate} done={!!a.completedAt} />
            {p && <Tag tone={p.tone}>{p.label}</Tag>}
            {a.assignedTo && <span className="cw-task-who"><UserChip user={a.assignedTo} size={18} /></span>}
          </div>
        </div>
        {canManage && <button className="cw-ibtn del" title="Delete" aria-label="Delete" onClick={() => void remove(a)}><X size={13} /></button>}
      </div>
    );
  };

  const TABS: [typeof tab, string, number | null][] = [
    ["notes", "Notes", noteCount], ["tasks", "Tasks", openTasks.length], ["reminders", "Reminders", reminders.filter((r) => !r.completedAt).length], ["minerals", "Minerals", null],
  ];

  return (
    <aside className="cw-right">
      <div className="cw-rtabs" role="tablist">
        {TABS.map(([k, l, n]) => (
          <button key={k} role="tab" data-k={k} aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            {l}{n != null && <span className="cw-rtab-n">{n}</span>}
          </button>
        ))}
      </div>

      <div className="cw-rbody">
        {tab === "notes" && (
          <>
            <div className="cw-search">
              <Search size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes…" aria-label="Search notes" />
            </div>
            {canManage && (
              <div className="cw-addcol">
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Title — concise summary…" aria-label="Note title" />
                <div className="cw-addrow">
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note — details…" aria-label="Note details"
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add("NOTE"); } }} />
                  <button className="cw-addbtn" disabled={!draft.trim() || !note.trim() || busy} onClick={() => void add("NOTE")}><Plus size={13} /> Add</button>
                </div>
                {/* Optional background color for the new note. */}
                <div className="note-swatches" role="radiogroup" aria-label="Note color">
                  <button type="button" role="radio" aria-checked={noteColor == null} title="No color"
                    className={`note-swatch none ${noteColor == null ? "active" : ""}`} onClick={() => setNoteColor(null)} />
                  {NOTE_COLORS.map((c) => (
                    <button key={c.key} type="button" role="radio" aria-checked={noteColor === c.key} title={c.label}
                      className={`note-swatch ${noteColor === c.key ? "active" : ""}`} style={{ background: c.hex }}
                      onClick={() => setNoteColor(noteColor === c.key ? null : c.key)} />
                  ))}
                </div>
              </div>
            )}
            {notes.length === 0 && <p className="cw-none">{q.trim() ? `No notes match "${q.trim()}".` : "No notes yet."}</p>}
            {notes.map((a) => (
              <div key={a.id} className={`cw-note ${a.pinned ? "pinned" : ""}`} data-note-color={a.color ?? undefined}>
                <div className="cw-note-head">
                  <span className={`cw-note-ico ${a.kind === "CALL" ? "k-call" : "k-note"}`}>{a.kind === "CALL" ? <Phone size={12} /> : <StickyNote size={12} />}</span>
                  <span className="cw-note-title">{a.title ?? (a.kind === "CALL" ? `Call · ${a.disposition ?? "Logged"}` : "Note")}</span>
                  {canManage && (
                    <span className="cw-note-acts">
                      {a.kind === "NOTE" && (
                        <button className="cw-ibtn" title="Note color" aria-label="Note color"
                          onClick={() => setColorPickFor((cur) => (cur === a.id ? null : a.id))}>
                          <Palette size={13} />
                        </button>
                      )}
                      <button className={`cw-ibtn ${a.pinned ? "pinned" : ""}`} title={a.pinned ? "Unpin" : "Pin"} aria-label={a.pinned ? "Unpin" : "Pin"} onClick={() => void update(a, { pinned: !a.pinned })}><Pin size={13} /></button>
                      <button className="cw-ibtn del" title="Delete" aria-label="Delete" onClick={() => void remove(a)}><X size={13} /></button>
                    </span>
                  )}
                </div>
                {colorPickFor === a.id && (
                  <div className="note-swatches" role="radiogroup" aria-label="Note color">
                    <button type="button" role="radio" aria-checked={!a.color} title="No color"
                      className={`note-swatch none ${!a.color ? "active" : ""}`}
                      onClick={() => { setColorPickFor(null); void update(a, { color: null }); }} />
                    {NOTE_COLORS.map((c) => (
                      <button key={c.key} type="button" role="radio" aria-checked={a.color === c.key} title={c.label}
                        className={`note-swatch ${a.color === c.key ? "active" : ""}`} style={{ background: c.hex }}
                        onClick={() => { setColorPickFor(null); void update(a, { color: c.key }); }} />
                    ))}
                  </div>
                )}
                <div className="cw-note-body">{a.body}</div>
                <div className="cw-note-foot"><span>{fmtDate(a.createdAt)}, {fmtTime(a.createdAt)}</span><span>{a.createdBy?.name ?? ""}</span></div>
              </div>
            ))}
          </>
        )}

        {(tab === "tasks" || tab === "reminders") && (
          <>
            {canManage && (
              <div className="cw-addcol">
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tab === "tasks" ? "Task title…" : "Remind me to…"} aria-label="Title" />
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note — details…" aria-label="Note details"
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(tab === "tasks" ? "TASK" : "REMINDER"); } }} />
                {tab === "tasks" ? (
                  <>
                    <div className="cw-addgrid">
                      <DateField value={due} onChange={setDue} />
                      <Segmented ariaLabel="Priority" value={priority} onChange={(v) => setPriority(v || "MEDIUM")}
                        options={TASK_PRIORITIES.map((p) => ({ value: p.v, label: p.label }))} />
                    </div>
                    <div className="cw-addrow">
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <Select ariaLabel="Assignee" clearable searchable placeholder="Assign to me" value={assignee} onChange={setAssignee}
                          options={users.map((u) => ({ value: u.id, label: u.name }))} />
                      </span>
                      <button className="cw-addbtn" disabled={!draft.trim() || !note.trim() || busy} onClick={() => void add("TASK")}><Plus size={13} /> Add</button>
                    </div>
                  </>
                ) : (
                  <div className="cw-addrow">
                    <span style={{ flex: 1, minWidth: 0 }}><DateField value={due} onChange={setDue} /></span>
                    <button className="cw-addbtn" disabled={!draft.trim() || !note.trim() || busy} onClick={() => void add("REMINDER")}><Plus size={13} /> Add</button>
                  </div>
                )}
              </div>
            )}
            {tab === "tasks" && (
              <>
                <div className="cw-lbl">Up next</div>
                {tasks.length === 0 && (
                  <div className="cw-empty-dash">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" /></svg>
                    <span>No tasks yet — add one above.</span>
                  </div>
                )}
                {openTasks.map(taskRow)}
                {doneTasks.length > 0 && (
                  <>
                    <button type="button" className={`cw-group-toggle ${showDone ? "open" : ""}`} aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                      <ChevronDown size={13} /> Completed ({doneTasks.length})
                    </button>
                    {showDone && doneTasks.map(taskRow)}
                  </>
                )}
              </>
            )}
            {tab === "reminders" && (
              <>
                <div className="cw-lbl">Reminders</div>
                {reminders.length === 0 && <p className="cw-none">No reminders yet.</p>}
                {reminders.map((a) => (
                  <div key={a.id} className="cw-task cw-reminder">
                    <span className="cw-rem-ico"><Bell size={12} /></span>
                    <div className="cw-task-main">
                      <div className="cw-task-title">{a.title ?? a.body}</div>
                      {a.title && <div className="cw-task-sub">{a.body}</div>}
                      {a.dueDate && <div className="cw-task-chips"><DueChip iso={a.dueDate} done={!!a.completedAt} /></div>}
                    </div>
                    {canManage && <button className="cw-ibtn del" title="Delete" aria-label="Delete" onClick={() => void remove(a)}><X size={13} /></button>}
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {tab === "minerals" && (
          <>
            <div className="cw-min-head">
              <span className="cw-lbl">Counties of interest</span>
              <Link to="/map" className="cw-maplink"><MapPin size={13} /> View on map</Link>
            </div>
            {contact.counties.length > 0 ? (
              <div className="cw-tags">
                {contact.counties.map((c) => (
                  <span key={c} className="cw-county"><MapPin size={12} /> {c}{contact.states[0] ? `, ${contact.states[0]}` : ""}</span>
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
