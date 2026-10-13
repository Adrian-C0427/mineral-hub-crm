import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronDown, Mail, MessageSquare, Pencil, Phone, StickyNote, Users, Zap } from "lucide-react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Banner, BackLink, ConfirmDelete, OverflowMenu, EmptyState, showToast } from "../components/ui";
import { Segmented, StatStrip, type StatCell } from "../components/kit";
import { useStages, stageColor } from "../stages";
import { ConvertOpportunityModal, OpportunityStageModal, OppAbstract, oppDaysInStage, followUpStatus } from "../components/OpportunityBoard";
import { NewOpportunityModal, type OppFormSection } from "../components/NewOpportunityModal";
import { acres, fmtDate, fmtDateLocal, fmtDateTime } from "../lib/format";
import { formatPhone } from "../lib/phone";
import type { Opp, OppActivityRow } from "../types";

/**
 * Opportunity page: a prospect's record in the Deal Detail layout — header
 * (name, stage, pipeline; Edit, Move stage, Convert to deal), a key-facts
 * strip, the details and tracking cards, then the activity timeline and the
 * stage history. Edit opens the same form as New opportunity in edit mode
 * (every field, validated, PATCH /opportunities/:id); stage moves and
 * conversion keep their own dialogs and history.
 */

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
  const [opp, setOpp] = useState<Opp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api.get<Opp>(`/opportunities/${id}`).then(setOpp).catch((e) => setErr(e instanceof ApiError ? e.message : "Could not load the opportunity")), [id]);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="page"><BackLink fallback="/pipeline" /><Banner kind="error">{err}</Banner></div>;
  if (!opp) return <Spinner label="Loading opportunity…" />;
  return <OpportunityRecord key={opp.id} opp={opp} onChange={setOpp} reload={load} />;
}

/** The loaded record (see the page comment above). */
export function OpportunityRecord({ opp, onChange: setOpp, reload: load }: { opp: Opp; onChange: (o: Opp) => void; reload: () => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const { pipelines, label: anyStageLabel, reload: reloadStages, setSelectedId } = useStages();
  // The edit form, open on one of its sections.
  const [editing, setEditing] = useState<OppFormSection | null>(null);
  const [stageTarget, setStageTarget] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The record's pipeline comes from the app's list. When that list doesn't
  // have it (made in another tab, or the list is stale), reload the list once
  // rather than showing another pipeline's stages.
  const pipeline = pipelines.find((p) => p.id === opp.pipelineId);
  const listLoaded = pipelines.some((p) => p.id !== "");
  const reloadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (pipeline || !listLoaded || reloadedFor.current === opp.pipelineId) return;
    reloadedFor.current = opp.pipelineId;
    reloadStages();
  }, [opp.pipelineId, pipeline, listLoaded, reloadStages]);

  const stages = pipeline?.stages ?? [];
  const stageOf = (key: string) => stages.find((s) => s.key === key);
  const stageLabel = (key: string) => stageOf(key)?.label ?? anyStageLabel(key);
  const converted = !!opp.convertedDealId;
  const canEdit = can("editDeals");
  // Converting creates a Deal, so it also needs createDeals (server-enforced).
  const canConvert = canEdit && can("createDeals");
  // Converted opportunities keep their record editable but no longer move or
  // convert; moves need the pipeline's stage list.
  const canMove = canEdit && !converted && !!pipeline;
  const terminal = !!stageOf(opp.stage)?.isTerminal;
  // A deep link's Back lands on this record's board.
  const selectBoard = () => setSelectedId(opp.pipelineId);

  async function remove() {
    setDeleting(true);
    try {
      await api.del(`/opportunities/${opp.id}`);
      showToast("Opportunity deleted");
      if (window.history.length > 1) nav(-1);
      else { selectBoard(); nav("/pipeline", { replace: true }); }
    } catch (e) {
      setDeleting(false); setConfirmDelete(false);
      showToast(e instanceof ApiError ? e.message : "Could not delete", "error");
    }
  }

  const days = oppDaysInStage(opp);
  const due = followUpStatus(opp);
  const contactName = opp.contact ? [opp.contact.firstName, opp.contact.lastName].filter(Boolean).join(" ") || opp.contact.entityName : null;
  const place = [opp.county, opp.state].filter(Boolean).join(", ");
  const estimates = [opp.estNra != null ? `${acres(opp.estNra)} NRA` : null, opp.estAcres != null ? `${acres(opp.estAcres)} gross acres` : null].filter(Boolean).join(" · ");

  // Key facts — the prospect at a glance (Deal Detail's summary strip).
  const facts: StatCell[] = [
    { label: "Stage", value: stageLabel(opp.stage), sub: days === 0 ? "Moved today" : `${days} day${days === 1 ? "" : "s"} in stage` },
    { label: "Est. NMA", value: opp.estNma != null ? acres(opp.estNma) : "—", sub: estimates || "No estimate yet" },
    { label: "Location", value: place || "—", sub: opp.abstract || opp.survey ? <OppAbstract abstract={opp.abstract} survey={opp.survey} /> : "No abstract yet" },
    {
      label: "Next follow-up",
      value: opp.nextFollowUpDate ? fmtDate(opp.nextFollowUpDate) : "Not set",
      tone: due?.tone === "danger" ? "danger" : due?.tone === "warn" ? "warn" : "default",
      sub: due && due.tone !== "neutral" ? due.text : opp.lastActivityAt ? `Last activity ${fmtDateLocal(opp.lastActivityAt)}` : undefined,
    },
    { label: "Owner", value: opp.owner?.name ?? "Unassigned", sub: `Added ${fmtDateLocal(opp.createdAt)}` },
  ];

  return (
    <div className="page deal-detail opp-page">
      <BackLink fallback="/pipeline" onFallback={selectBoard} />
      <div className="page-header dd-head">
        <div className="dd-head-title">
          <h1>{opp.name}</h1>
          <StageTag label={stageLabel(opp.stage)} color={pipeline ? stageColor(stages, opp.stage) : "var(--ink-4)"} />
          {pipeline && <span className="pl-badge op-pipe" title="Pipeline">{pipeline.name}</span>}
          {converted && <span className="op-tag converted">Converted</span>}
        </div>
        <div className="dd-head-actions">
          {canEdit && (
            <button type="button" className="op-edit-btn" onClick={() => setEditing("basics")} title="Edit every field of this opportunity">
              <Pencil size={13} aria-hidden="true" />Edit
            </button>
          )}
          {canMove && <MoveStageMenu stage={opp.stage} stages={stages} onPick={setStageTarget} />}
          {canMove && canConvert && <button type="button" className="primary op-convert-btn" onClick={() => setConverting(true)}>Convert to deal</button>}
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

      <StatStrip cells={facts} min={190} className="dd-summary" />

      <div className="dd-top-grid">
        <KvCard title="Opportunity details" onEdit={canEdit ? () => setEditing("seller") : undefined} groups={[
          {
            title: "Seller & contact",
            rows: [
              { k: "Linked contact", v: opp.contact ? <Link to={`/contacts/${opp.contact.id}`}>{contactName}</Link> : null },
              { k: "Seller name", v: opp.sellerName },
              { k: "Company", v: opp.companyName },
              { k: "Phone", v: opp.phone ? <a href={`tel:${opp.phone}`}>{formatPhone(opp.phone)}</a> : null },
              { k: "Email", v: opp.email ? <a href={`mailto:${opp.email}`}>{opp.email}</a> : null, title: opp.email },
            ],
          },
          {
            title: "Property",
            rows: [
              { k: "State", v: opp.state },
              { k: "County", v: opp.county },
              { k: "Abstract", v: opp.abstract ? <OppAbstract abstract={opp.abstract} /> : null },
              { k: "Survey", v: opp.survey, title: opp.survey },
              { k: "Est. gross acres", v: opp.estAcres != null ? acres(opp.estAcres) : null },
              { k: "Est. NMA", v: opp.estNma != null ? acres(opp.estNma) : null },
              { k: "Est. NRA", v: opp.estNra != null ? acres(opp.estNra) : null },
            ],
          },
        ]} />

        <KvCard title="Tracking" onEdit={canEdit ? () => setEditing("followup") : undefined} groups={[
          {
            rows: [
              { k: "Pipeline", v: pipeline?.name ?? null },
              { k: "Stage", v: stageLabel(opp.stage) },
              { k: "Owner", v: opp.owner?.name ?? null },
              { k: "Source", v: opp.source, title: opp.source },
              {
                k: "Next follow-up",
                v: opp.nextFollowUpDate ? <>{fmtDate(opp.nextFollowUpDate)}{due && due.tone !== "neutral" && <span className={`pl-due ${due.tone}`}>{due.text}</span>}</> : null,
              },
              { k: "Added", v: fmtDateLocal(opp.createdAt) },
              { k: "Last activity", v: opp.lastActivityAt ? fmtDateTime(opp.lastActivityAt) : null },
            ],
          },
        ]}>
          <div className="op-notes-block">
            <div className="ddc-group-title">Notes</div>
            {opp.notes
              ? <p className="op-notes">{opp.notes}</p>
              : <p className="op-notes empty">No notes yet.{canEdit ? " Add them with Edit." : ""}</p>}
          </div>
        </KvCard>
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
                  <span className="op-hist-dot" style={{ background: pipeline ? stageColor(stages, h.toStage) : "var(--ink-4)" }} aria-hidden="true" />
                  <div className="op-hist-main">
                    <span className="op-hist-move">
                      {h.fromStage ? <><span className="dim">{stageLabel(h.fromStage)}</span> → </> : <span className="dim">Created in </span>}<b>{stageLabel(h.toStage)}</b>
                    </span>
                    {h.reason && <span className="op-hist-reason">{h.reason}</span>}
                    <span className="op-hist-meta">{fmtDateTime(h.createdAt)}{h.changedBy ? ` · ${h.changedBy.name}` : ""}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {editing && (
        <NewOpportunityModal opp={opp} pipelines={pipelines} initialSection={editing}
          onClose={() => setEditing(null)}
          onSaved={(o) => { setEditing(null); setOpp(o); showToast("Opportunity saved."); }} />
      )}
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

interface KvRow { k: string; v: ReactNode; title?: string | null }

/** Read-only key/value card (Deal characteristics' view) with an Edit button. */
function KvCard({ title, groups, onEdit, children }: {
  title: string; groups: { title?: string; rows: KvRow[] }[]; onEdit?: () => void; children?: ReactNode;
}) {
  return (
    <div className="panel dd-card ddc-card">
      <div className="dd-card-head">
        <h3 className="dd-card-title">{title}</h3>
        {onEdit && <button className="small" onClick={onEdit}>Edit</button>}
      </div>
      <div className="dd-card-body ddc-view">
        {groups.map((g, i) => (
          <div key={g.title ?? i} className="ddc-group">
            {g.title && <div className="ddc-group-title">{g.title}</div>}
            <div className="ddc-rows">
              {g.rows.map((r) => {
                const empty = r.v == null || r.v === "";
                return (
                  <div key={r.k} className="ddc-row">
                    <span className="ddc-k">{r.k}</span>
                    <span className={`ddc-v ${empty ? "dim" : ""}`} title={r.title ?? (typeof r.v === "string" ? r.v : undefined)}>{empty ? "—" : r.v}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {children}
      </div>
    </div>
  );
}

function StageTag({ label, color }: { label: string; color: string }) {
  return <span className="tag dd-stage-tag" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{label}</span>;
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
