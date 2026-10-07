import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronDown, Mail, MessageSquare, Pencil, Phone, StickyNote, Users, X, Zap } from "lucide-react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Banner, BackLink, ConfirmDelete, OverflowMenu, EmptyState, showToast } from "../components/ui";
import { Avatar, Segmented } from "../components/kit";
import { Select } from "../components/Select";
import { StateSelect } from "../components/StateSelect";
import { DateField } from "../components/DateField";
import { useStages, stageColor } from "../stages";
import { ConvertOpportunityModal, OpportunityStageModal, oppDaysInStage, followUpStatus } from "../components/OpportunityBoard";
import { fmtDate, fmtDateLocal, fmtDateTime, num, toInputDate } from "../lib/format";
import { countiesForStates } from "../lib/options";
import { formatPhone, formatPhoneAsYouType, normalizePhone } from "../lib/phone";
import type { ContactRow } from "./Contacts";
import type { Opp, OppActivityRow, UserLite } from "../types";

/**
 * Opportunity page: a prospect's record — seller & contact, property, details,
 * an activity timeline and its stage history — with inline editing (click a
 * value → edit → Save, PATCH /opportunities/:id), stage moves and conversion
 * into a deal. Layout follows Deal Detail; editing follows Contact Detail.
 */

const numOrNull = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const strOrNull = (v: string) => (v.trim() === "" ? null : v.trim());

/** Activity kinds offered by the composer; SYSTEM entries are server-written. */
const KINDS: { key: string; label: string; icon: JSX.Element; cls: string }[] = [
  { key: "NOTE", label: "Note", icon: <StickyNote size={13} />, cls: "k-note" },
  { key: "CALL", label: "Call", icon: <Phone size={13} />, cls: "k-call" },
  { key: "EMAIL", label: "Email", icon: <Mail size={13} />, cls: "k-email" },
  { key: "TEXT", label: "Text", icon: <MessageSquare size={13} />, cls: "k-text" },
  { key: "MEETING", label: "Meeting", icon: <Users size={13} />, cls: "k-meeting" },
];
const kindMeta = (k: string) => KINDS.find((x) => x.key === k) ?? { key: k, label: k === "SYSTEM" ? "System" : k, icon: <Zap size={13} />, cls: k === "SYSTEM" ? "k-system" : "k-note" };

export function Opportunity() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = useAuth();
  const { pipelines, stagesOf } = useStages();
  const [opp, setOpp] = useState<Opp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [stageTarget, setStageTarget] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => api.get<Opp>(`/opportunities/${id}`).then(setOpp).catch((e) => setErr(e instanceof ApiError ? e.message : "Could not load the opportunity")), [id]);
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, [load]);

  if (err) return <div className="page"><BackLink fallback="/pipeline" /><Banner kind="error">{err}</Banner></div>;
  if (!opp) return <Spinner />;

  const pipeline = pipelines.find((p) => p.id === opp.pipelineId);
  const stages = pipeline?.stages ?? stagesOf(opp.pipelineId);
  const stageOf = (key: string) => stages.find((s) => s.key === key);
  const stageLabel = (key: string) => stageOf(key)?.label ?? key;
  const converted = !!opp.convertedDealId;
  const canEdit = can("editDeals");
  // Converted opportunities keep their record editable but no longer move or convert.
  const canMove = canEdit && !converted;
  const terminal = !!stageOf(opp.stage)?.isTerminal;

  const patch = async (body: Record<string, unknown>) => {
    try { setOpp(await api.patch<Opp>(`/opportunities/${opp.id}`, body)); }
    catch (e) { showToast(e instanceof ApiError ? e.message : "Could not save", "error"); throw e; }
  };
  const loadContacts = () => { if (!contacts) api.get<ContactRow[]>("/contacts").then(setContacts).catch(() => setContacts([])); };

  async function remove() {
    setDeleting(true);
    try {
      await api.del(`/opportunities/${opp!.id}`);
      showToast("Opportunity deleted");
      nav("/pipeline");
    } catch (e) {
      setDeleting(false); setConfirmDelete(false);
      showToast(e instanceof ApiError ? e.message : "Could not delete", "error");
    }
  }

  const days = oppDaysInStage(opp);
  const due = followUpStatus(opp);
  const contactName = opp.contact ? [opp.contact.firstName, opp.contact.lastName].filter(Boolean).join(" ") : null;
  const countyOptions = countiesForStates(opp.state ? [opp.state] : []);

  return (
    <div className="page deal-detail opp-page">
      <BackLink fallback="/pipeline" />
      <div className="page-header dd-head">
        <div className="dd-head-title">
          <NameField name={opp.name} canEdit={canEdit} onSave={(name) => patch({ name })} />
          <StageTag label={stageLabel(opp.stage)} color={stageColor(stages, opp.stage)} />
          {pipeline && <span className="pl-badge op-pipe" title="Pipeline">{pipeline.name}</span>}
          <span className="dd-days">{days === 0 ? "Moved today" : `${days}d in stage`}</span>
        </div>
        <div className="dd-head-actions">
          <div className="op-owner">
            <Select value={opp.owner?.id ?? ""} onChange={(v) => void patch({ ownerId: v || null })} ariaLabel="Owner" clearable searchable
              placeholder="Unassigned" disabled={!canEdit} options={users.map((u) => ({ value: u.id, label: u.name }))} />
          </div>
          {canMove && <MoveStageMenu stage={opp.stage} stages={stages} onPick={setStageTarget} />}
          {canMove && <button type="button" className="primary op-convert-btn" onClick={() => setConverting(true)}>Convert to deal</button>}
          {canEdit && <OverflowMenu items={[{ label: "Delete opportunity…", danger: true, onClick: () => setConfirmDelete(true) }]} />}
        </div>
      </div>

      {converted && (
        <Banner kind="info">
          Converted to deal <Link to={`/deals/${opp.convertedDealId}`}><strong>{opp.convertedDeal?.name ?? "the deal"}</strong></Link>
          {opp.convertedAt && <> on {fmtDateLocal(opp.convertedAt)}</>}. Work continues on the deal; this record and its history stay here.
        </Banner>
      )}
      {terminal && !converted && (
        <Banner kind="warn">{stageLabel(opp.stage)}{opp.closeReason ? <>: {opp.closeReason}</> : null}</Banner>
      )}

      <div className="op-cards">
        {/* ------------------------------------------------ seller & contact */}
        <Card title="Seller & contact">
          {opp.contact ? (
            <div className="op-contact">
              <Avatar name={contactName || opp.contact.entityName || "?"} size={34} />
              <div className="op-contact-main">
                <Link to={`/contacts/${opp.contact.id}`} className="op-contact-name">{contactName || opp.contact.entityName}</Link>
                {contactName && opp.contact.entityName && <span className="op-contact-sub">{opp.contact.entityName}</span>}
                <span className="op-contact-sub">{[formatPhone(opp.contact.phone) || null, opp.contact.email].filter(Boolean).join(" · ") || "No phone or email on file"}</span>
              </div>
              {canEdit && <button type="button" className="icon-btn op-unlink" title="Unlink contact" aria-label="Unlink contact" onClick={() => void patch({ contactId: null })}><X size={13} /></button>}
            </div>
          ) : (
            <Field label="Contact" display={null} canEdit={canEdit} onStart={loadContacts}
              editor={(v, setV) => (
                <Select value={v} onChange={setV} ariaLabel="Linked contact" searchable clearable placeholder={contacts ? "Search contacts…" : "Loading contacts…"}
                  emptyText="No matching contacts" options={(contacts ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.entityName ?? undefined }))} />
              )}
              value="" body={(v) => ({ contactId: v || null })} onSave={patch} />
          )}
          <div className="op-rows">
            <Field label="Seller name" display={opp.sellerName} value={opp.sellerName ?? ""} canEdit={canEdit} body={(v) => ({ sellerName: strOrNull(v) })} onSave={patch} />
            <Field label="Company" display={opp.companyName} value={opp.companyName ?? ""} canEdit={canEdit} body={(v) => ({ companyName: strOrNull(v) })} onSave={patch} />
            <Field label="Phone" display={opp.phone ? <a href={`tel:${opp.phone}`}>{formatPhone(opp.phone)}</a> : null} value={formatPhone(opp.phone)} canEdit={canEdit}
              format={formatPhoneAsYouType} placeholder="(555) 000-0000" body={(v) => ({ phone: normalizePhone(v) || null })} onSave={patch} />
            <Field label="Email" display={opp.email ? <a href={`mailto:${opp.email}`}>{opp.email}</a> : null} value={opp.email ?? ""} canEdit={canEdit} placeholder="name@example.com" body={(v) => ({ email: strOrNull(v) })} onSave={patch} />
          </div>
        </Card>

        {/* ------------------------------------------------------- property */}
        <Card title="Property">
          <div className="op-rows">
            <Field label="State" display={opp.state} value={opp.state ?? ""} canEdit={canEdit} body={(v) => ({ state: v || null })} onSave={patch}
              editor={(v, setV) => <StateSelect value={v} onChange={setV} />} />
            <Field label="County" display={opp.county} value={opp.county ?? ""} canEdit={canEdit} body={(v) => ({ county: v || null })} onSave={patch}
              editor={(v, setV) => <Select value={v} onChange={setV} ariaLabel="County" searchable clearable creatable placeholder="Search counties…" options={countyOptions} />} />
            <Field label="Abstract" display={opp.abstract} value={opp.abstract ?? ""} canEdit={canEdit} placeholder="e.g. A-123" body={(v) => ({ abstract: strOrNull(v) })} onSave={patch} />
            <Field label="Survey" display={opp.survey} value={opp.survey ?? ""} canEdit={canEdit} body={(v) => ({ survey: strOrNull(v) })} onSave={patch} />
            <Field label="Est. acres" display={opp.estAcres != null ? num(opp.estAcres) : null} value={opp.estAcres != null ? String(opp.estAcres) : ""} canEdit={canEdit} type="number" body={(v) => ({ estAcres: numOrNull(v) })} onSave={patch} />
            <Field label="Est. NMA" display={opp.estNma != null ? num(opp.estNma) : null} value={opp.estNma != null ? String(opp.estNma) : ""} canEdit={canEdit} type="number" body={(v) => ({ estNma: numOrNull(v) })} onSave={patch} />
            <Field label="Est. NRA" display={opp.estNra != null ? num(opp.estNra) : null} value={opp.estNra != null ? String(opp.estNra) : ""} canEdit={canEdit} type="number" body={(v) => ({ estNra: numOrNull(v) })} onSave={patch} />
          </div>
        </Card>

        {/* -------------------------------------------------------- details */}
        <Card title="Details">
          <div className="op-rows">
            <Field label="Source" display={opp.source} value={opp.source ?? ""} canEdit={canEdit} placeholder="Referral, mailer, courthouse…" body={(v) => ({ source: strOrNull(v) })} onSave={patch} />
            <Field label="Next follow-up" value={toInputDate(opp.nextFollowUpDate)} canEdit={canEdit} body={(v) => ({ nextFollowUpDate: v || null })} onSave={patch}
              display={opp.nextFollowUpDate ? <>{fmtDate(opp.nextFollowUpDate)}{due && due.tone !== "neutral" && <span className={`pl-due ${due.tone}`}>{due.text}</span>}</> : null}
              editor={(v, setV) => <DateField value={v} onChange={setV} ariaLabel="Next follow-up" />} />
            <Field label="Added on" display={fmtDateLocal(opp.createdAt)} value="" canEdit={false} body={() => ({})} onSave={patch} />
            <Field label="Last activity" display={opp.lastActivityAt ? fmtDateTime(opp.lastActivityAt) : null} value="" canEdit={false} body={() => ({})} onSave={patch} />
          </div>
          <Field label="Notes" wide display={opp.notes ? <span className="op-notes">{opp.notes}</span> : null} value={opp.notes ?? ""} canEdit={canEdit} multiline body={(v) => ({ notes: strOrNull(v) })} onSave={patch} />
        </Card>
      </div>

      <div className="op-lower">
        <ActivityCard opp={opp} canEdit={canEdit} onLogged={load} />
        <Card title="Stage history" count={opp.stageHistory.length}>
          {opp.stageHistory.length === 0 ? (
            <EmptyState title="No stage changes yet">Moves between stages are recorded here with who made them and why.</EmptyState>
          ) : (
            <div className="op-hist">
              {[...opp.stageHistory].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).map((h) => (
                <div key={h.id} className="op-hist-row">
                  <span className="op-hist-dot" style={{ background: stageColor(stages, h.toStage) }} aria-hidden="true" />
                  <div className="op-hist-main">
                    <span className="op-hist-move"><span className="dim">{stageLabel(h.fromStage)}</span> → <b>{stageLabel(h.toStage)}</b></span>
                    {h.reason && <span className="op-hist-reason">{h.reason}</span>}
                    <span className="op-hist-meta">{fmtDateTime(h.createdAt)}{h.changedBy ? ` · ${h.changedBy.name}` : ""}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {stageTarget && pipeline && (
        <OpportunityStageModal opp={opp} pipeline={pipeline} initialStage={stageTarget}
          onClose={() => setStageTarget(null)}
          onChanged={(o) => {
            setStageTarget(null); setOpp(o);
            if (o.convertedDealId && !opp.convertedDealId) showToast(<span>Converted to a deal. <Link to={`/deals/${o.convertedDealId}`} className="link-btn">Open deal</Link></span>, "success", 10000);
            else showToast(`Moved to ${stageLabel(o.stage)}.`);
          }} />
      )}
      {converting && pipeline && (
        <ConvertOpportunityModal opp={opp} pipeline={pipeline} pipelines={pipelines}
          onClose={() => setConverting(false)} onConverted={(r) => { setConverting(false); setOpp(r.opportunity); }} />
      )}
      {confirmDelete && (
        <ConfirmDelete itemLabel="opportunity" name={opp.name} busy={deleting} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- pieces */

function Card({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <div className="panel dd-card op-card-panel">
      <div className="dd-card-head">
        <h3 className="dd-card-title">{title}</h3>
        {count != null && count > 0 && <span className="dd-card-count">{count}</span>}
      </div>
      <div className="dd-card-body">{children}</div>
    </div>
  );
}

function StageTag({ label, color }: { label: string; color: string }) {
  return <span className="tag dd-stage-tag" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{label}</span>;
}

/** Header name: click the pencil to rename in place (Enter saves, Escape cancels). */
function NameField({ name, canEdit, onSave }: { name: string; canEdit: boolean; onSave: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(name);
  const [busy, setBusy] = useState(false);
  const start = () => { setV(name); setEditing(true); };
  const save = async () => {
    const n = v.trim();
    if (!n || busy) return;
    if (n === name) { setEditing(false); return; }
    setBusy(true);
    try { await onSave(n); setEditing(false); } catch { /* toast shown by caller */ } finally { setBusy(false); }
  };
  if (!editing) {
    return (
      <>
        <h1>{name}</h1>
        {canEdit && <button type="button" className="icon-btn dd-rename" title="Rename opportunity" aria-label="Rename opportunity" onClick={start}><Pencil size={14} /></button>}
      </>
    );
  }
  return (
    <div className="op-name-edit">
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-label="Opportunity name"
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } if (e.key === "Escape") setEditing(false); }} />
      <button className="small primary" disabled={!v.trim() || busy} onClick={() => void save()}>Save</button>
      <button className="icon-btn" title="Cancel" aria-label="Cancel rename" onClick={() => setEditing(false)}><X size={12} /></button>
    </div>
  );
}

/** "Move stage" menu (Deal Detail pattern) scoped to this pipeline's stages. */
function MoveStageMenu({ stage, stages, onPick }: { stage: string; stages: { key: string; label: string }[]; onPick: (stage: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  return (
    <div className="ovf dd-stage" ref={ref}>
      <button type="button" className="dd-stage-btn op-stage-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Move stage <ChevronDown size={13} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open && (
        <div className="ovf-menu dd-stage-menu" role="menu">
          {stages.map((s) => (
            <button key={s.key} type="button" role="menuitem" className={`ovf-item ${s.key === stage ? "current" : ""}`}
              onClick={() => { setOpen(false); onPick(s.key); }}>
              <span>{s.label}</span>
              {s.key === stage && <span className="dd-stage-cur">Current</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One inline-editable field (Contact Detail pattern): click the value to edit
 * just that field; Save patches only it; Escape / ✕ restores read-only.
 */
function Field({ label, display, value, canEdit, body, onSave, editor, type, multiline, placeholder, format, wide, onStart }: {
  label: string;
  display: ReactNode;
  /** Current value as the editor's string. */
  value: string;
  canEdit: boolean;
  /** Build the single-field PATCH body from the edited string. */
  body: (v: string) => Record<string, unknown>;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  /** Custom editor (selects, dates); default is a text input. */
  editor?: (v: string, setV: (v: string) => void) => ReactNode;
  type?: "text" | "number";
  multiline?: boolean;
  placeholder?: string;
  /** Reformat typed text (phone numbers). */
  format?: (v: string) => string;
  /** Full-width row (notes). */
  wide?: boolean;
  /** Called when editing starts (lazy option loading). */
  onStart?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  const empty = display == null || display === "";
  const dirty = v !== value;
  const start = () => { if (!canEdit) return; onStart?.(); setV(value); setEditing(true); };
  const save = async () => {
    if (busy || !dirty) { setEditing(false); return; }
    setBusy(true);
    try { await onSave(body(v)); setEditing(false); } catch { /* toast shown by caller */ } finally { setBusy(false); }
  };
  // Enter saves (textareas: Cmd/Ctrl + Enter, plain Enter adds a line); Escape cancels.
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
    if (e.key === "Escape") setEditing(false);
  };
  return (
    <div className={`op-row ${wide ? "wide" : ""} ${editing ? "editing" : ""}`}>
      <span className="op-k">{label}</span>
      {!editing ? (
        <span className={`op-v ${empty ? "empty" : ""} ${canEdit ? "editable" : ""}`}
          role={canEdit ? "button" : undefined} tabIndex={canEdit ? 0 : undefined}
          title={canEdit ? `Edit ${label.toLowerCase()}` : undefined}
          onClick={start}
          onKeyDown={canEdit ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); start(); } } : undefined}>
          <span className="op-v-text">{empty ? "—" : display}</span>
          {canEdit && <Pencil size={10} className="op-pen" aria-hidden="true" />}
        </span>
      ) : (
        <span className="op-edit">
          {editor ? editor(v, setV) : multiline ? (
            <textarea autoFocus rows={4} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={keys} aria-label={label} />
          ) : (
            <input autoFocus type={type ?? "text"} value={v} placeholder={placeholder} aria-label={label}
              onChange={(e) => setV(format ? format(e.target.value) : e.target.value)} onKeyDown={keys} />
          )}
          <span className="op-edit-acts">
            <button className="small primary" disabled={!dirty || busy} onClick={() => void save()}>Save</button>
            <button className="icon-btn" title="Cancel" aria-label={`Cancel editing ${label.toLowerCase()}`} onClick={() => setEditing(false)}><X size={12} /></button>
          </span>
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- activity */

function ActivityCard({ opp, canEdit, onLogged }: { opp: Opp; canEdit: boolean; onLogged: () => void }) {
  const [kind, setKind] = useState("NOTE");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const items: OppActivityRow[] = [...opp.activities].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const ready = body.trim() !== "";
  async function send() {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api.post(`/opportunities/${opp.id}/activities`, { kind, body: body.trim() });
      setBody("");
      onLogged();
    } catch (e) { showToast(e instanceof ApiError ? e.message : "Could not save the activity", "error"); }
    finally { setBusy(false); }
  }
  return (
    <div className="panel dd-card op-card-panel op-activity">
      <div className="dd-card-head">
        <div><h3 className="dd-card-title">Activity</h3><div className="dd-card-sub">Notes, calls, emails, texts and meetings — newest first</div></div>
        {items.length > 0 && <span className="dd-card-count">{items.length}</span>}
      </div>
      {canEdit && (
        <div className="op-comp">
          <Segmented accent ariaLabel="Activity kind" value={kind} onChange={(k) => { setKind(k); inputRef.current?.focus(); }}
            options={KINDS.map((k) => ({ value: k.key, label: <span className="op-comp-kind">{k.icon}{k.label}</span> }))} />
          <div className="op-comp-row">
            <textarea ref={inputRef} rows={2} value={body} onChange={(e) => setBody(e.target.value)}
              placeholder={kind === "NOTE" ? "Type a note…" : `${kindMeta(kind).label} summary…`}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <button className="primary op-comp-send" disabled={!ready || busy} onClick={() => void send()}>{busy ? "Saving…" : "Log"}</button>
          </div>
          <div className="op-comp-hint">Enter to save · Shift + Enter for a new line</div>
        </div>
      )}
      <div className="dd-card-body op-tl">
        {items.length === 0 ? (
          <EmptyState title="No activity yet">{canEdit ? "Log a note, call, email, text or meeting above — everything lands on this timeline." : "Nothing has been logged on this opportunity."}</EmptyState>
        ) : items.map((a) => {
          const meta = kindMeta(a.kind);
          return (
            <div key={a.id} className={`op-ev ${meta.cls}`}>
              <span className="op-ev-ico" aria-hidden="true">{meta.icon}</span>
              <div className="op-ev-main">
                <div className="op-ev-head">
                  <span className="op-ev-kind">{meta.label}</span>
                  <span className="op-ev-meta">{fmtDateTime(a.createdAt)}{a.createdBy ? ` · ${a.createdBy.name}` : ""}</span>
                </div>
                <div className="op-ev-body">{a.body}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
