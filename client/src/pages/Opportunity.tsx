import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronDown, Mail, MessageSquare, Pencil, Phone, Plus, StickyNote, Users, Zap } from "lucide-react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Banner, BackLink, ConfirmDelete, OverflowMenu, EmptyState, Modal, showToast } from "../components/ui";
import { Segmented, StatStrip, Tag, type StatCell } from "../components/kit";
import { Tabs } from "../components/Tabs";
import { Select } from "../components/Select";
import { UserAvatar, userOptions } from "../components/UserAvatar";
import { DateField } from "../components/DateField";
import { GeoFields } from "../components/GeoFields";
import { useAbstractIndex } from "../components/AbstractPicker";
import { useStages, stageColor } from "../stages";
import { useUnsavedSection } from "../lib/unsaved";
import { ConvertOpportunityModal, OpportunityStageModal, OppAbstract, oppDaysInStage, followUpStatus } from "../components/OpportunityBoard";
import { DocumentsSection, OPP_DOC_FOLDERS, effectiveFolders } from "../components/DocumentsSection";
import { SellerInformation, emptySellerInfo, sellerInfoBody, sellerInfoFromContact, sellerInfoInvalid, sellerInfoMissing, type SellerInfoForm } from "../components/SellerInformation";
import { TaskFormModal, TASK_PRIORITY_META } from "../components/TaskForm";
import { newTaskValues, type TaskFormValues } from "../lib/tasks";
import { isAbstractId } from "../lib/opportunityForm";
import { surveyLabel } from "../lib/abstracts";
import { GeoTagFields } from "../components/GeoTagFields";
import { acres, fmtDate, fmtDateLocal, fmtDateTime, toInputDate } from "../lib/format";
import { formatPhone } from "../lib/phone";
import type { ContactActivityRow } from "./ContactDetail";
import type { Opp, OppActivityRow, UserLite, UserRef } from "../types";
// MapLibre is heavy; only load it when the Location card is shown.
const DealMap = lazy(() => import("../components/DealMap").then((m) => ({ default: m.DealMap })));

/**
 * Opportunity profile — the Deal Profile layout for a prospect: the same
 * header (name + rename, stage, days in stage; Move stage, Convert, ⋯), the
 * key-facts strip, two persistent cards (Opportunity details, Tracking — edited
 * in place with Save / Cancel like Deal characteristics), then tabs: General
 * (the seller — a linked Contact — and the location map), Activity (timeline
 * + stage history), Tasks (the seller contact's tasks) and Documents (the
 * shared document manager, attached to the opportunity). Opportunities stay
 * their own records: nothing here creates a Deal except Convert, and no deal
 * economics appear.
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

type OppTab = "general" | "activity" | "tasks" | "documents";

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
  const [stageTarget, setStageTarget] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<OppTab>("general");
  const [users, setUsers] = useState<UserLite[]>([]);
  useEffect(() => { api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);

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
  // Back lands on this record's board (the board remembers its pipeline,
  // search and scroll position itself).
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
  const place = [opp.county, opp.state].filter(Boolean).join(", ");
  const estimates = [opp.estNra != null ? `${acres(opp.estNra)} NRA` : null, opp.estAcres != null ? `${acres(opp.estAcres)} gross acres` : null].filter(Boolean).join(" · ");
  const sellerLine = sellerName(opp);

  // Key facts — the prospect at a glance (the Deal page's summary strip).
  const facts: StatCell[] = [
    { label: "Seller", value: sellerLine || "—", sub: opp.companyName && sellerLine !== opp.companyName ? opp.companyName : opp.contact ? "Linked contact" : "No seller yet" },
    { label: "Est. NMA", value: opp.estNma != null ? acres(opp.estNma) : "—", sub: estimates || "No estimate yet" },
    { label: "Location", value: place || "—", sub: opp.abstract || opp.survey ? <OppAbstract abstract={opp.abstract} survey={opp.survey} /> : "No abstract yet" },
    {
      label: "Next follow-up",
      value: opp.nextFollowUpDate ? fmtDate(opp.nextFollowUpDate) : "Not set",
      tone: due?.tone === "danger" ? "danger" : due?.tone === "warn" ? "warn" : "default",
      sub: due && due.tone !== "neutral" ? due.text : opp.lastActivityAt ? `Last activity ${fmtDateLocal(opp.lastActivityAt)}` : undefined,
    },
    { label: "Owner", value: opp.owner ? <UserAvatar user={opp.owner} size={24} withName className="inline" /> : "Unassigned", sub: `Added ${fmtDateLocal(opp.createdAt)}` },
  ];

  const tabLabel = (text: string, count: number) => count > 0
    ? <><span className="tab-lbl" data-label={text}>{text}</span><span className="tab-badge">{count}</span></>
    : text;
  const tasks = useOpenTaskCount(opp.contact?.id ?? null, can("viewContacts"));

  return (
    <div className="page deal-detail opp-page">
      <BackLink fallback="/pipeline" onFallback={selectBoard} />
      <div className="page-header dd-head">
        <div className="dd-head-title">
          <h1>{opp.name}</h1>
          {canEdit && (
            <button type="button" className="icon-btn dd-rename" title="Rename opportunity" aria-label="Rename opportunity" onClick={() => setRenaming(true)}>
              <Pencil size={14} />
            </button>
          )}
          <StageTag label={stageLabel(opp.stage)} color={pipeline ? stageColor(stages, opp.stage) : "var(--ink-4)"} />
          {pipeline && <span className="pl-badge op-pipe" title="Pipeline">{pipeline.name}</span>}
          <span className="dd-days">{days}d in stage</span>
          {converted && <span className="op-tag converted">Converted</span>}
        </div>
        <div className="dd-head-actions">
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

      {/* Persistent cards — Opportunity details + Tracking stay visible on every tab. */}
      <div className="dd-top-grid">
        <DetailsCard opp={opp} canEdit={canEdit} onSaved={setOpp} />
        <TrackingCard opp={opp} canEdit={canEdit} users={users} pipelineName={pipeline?.name ?? null} stageLabel={stageLabel(opp.stage)} onSaved={setOpp} />
      </div>

      <Tabs
        tabs={[
          { key: "general" as const, label: "General" },
          { key: "activity" as const, label: tabLabel("Activity", opp.activities.length) },
          { key: "tasks" as const, label: tabLabel("Tasks", tasks.count) },
          { key: "documents" as const, label: tabLabel("Documents", can("viewDocuments") ? opp.files.length : 0) },
        ]}
        active={tab}
        onSelect={setTab}
      />

      {/* Panels stay mounted and toggle with `hidden` (same as the Deal page). */}
      <div hidden={tab !== "general"}>
        <SellerCard opp={opp} canEdit={canEdit} onSaved={setOpp} />
        <LocationCard opp={opp} />
      </div>

      {/* A display:grid class would defeat the `hidden` attribute, so the grid sits inside. */}
      <div hidden={tab !== "activity"}>
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
                    <span className="op-hist-meta">{fmtDateTime(h.createdAt)}{h.changedBy && <> · <UserAvatar user={h.changedBy} size={16} withName className="inline" /></>}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      </div>

      <div hidden={tab !== "tasks"}>
        <TasksCard contactId={opp.contact?.id ?? null} users={users} onChanged={tasks.refresh} />
      </div>

      <div hidden={tab !== "documents"}>
        <DocumentsSection ownerType="opportunity" ownerId={opp.id} files={opp.files} folders={effectiveFolders(opp.docFolders, OPP_DOC_FOLDERS)}
          onChanged={load} canEdit={can("manageDocuments")} canDelete={can("manageDocuments")} />
      </div>

      {renaming && (
        <RenameModal id={opp.id} current={opp.name} onClose={() => setRenaming(false)} onRenamed={(o) => { setRenaming(false); setOpp(o); }} />
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

/* --------------------------------------------------------------- helpers */

/** The seller's display name: the linked contact's, else the plain fields. */
function sellerName(o: Opp): string {
  if (o.contact) return [o.contact.firstName, o.contact.lastName].filter(Boolean).join(" ") || o.contact.entityName || "";
  return o.sellerName || o.companyName || "";
}

/** Open-task count for the Tasks tab badge (the seller contact's tasks). */
function useOpenTaskCount(contactId: string | null, allowed: boolean): { count: number; refresh: () => void } {
  const [count, setN] = useState(0);
  const refresh = useCallback(() => {
    if (!contactId || !allowed) { setN(0); return; }
    api.get<ContactActivityRow[]>(`/contacts/${contactId}/activities`)
      .then((rows) => setN(rows.filter((a) => a.kind === "TASK" && !a.completedAt).length))
      .catch(() => setN(0));
  }, [contactId, allowed]);
  useEffect(() => { refresh(); }, [refresh]);
  return { count, refresh };
}

/* ---------------------------------------------------------------- cards */

function Card({ title, sub, count, actions, children, className = "" }: { title: string; sub?: ReactNode; count?: number; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`panel dd-card op-card-panel ${className}`}>
      <div className="dd-card-head">
        <div><h3 className="dd-card-title">{title}</h3>{sub && <div className="dd-card-sub">{sub}</div>}</div>
        <div className="dd-card-actions">
          {count != null && count > 0 && <span className="dd-card-count">{count}</span>}
          {actions}
        </div>
      </div>
      {children}
    </div>
  );
}

interface KvRow { k: string; v: ReactNode; title?: string | null }

/** Read-only rows (Deal characteristics' view). */
function KvRows({ groups }: { groups: { title?: string; rows: KvRow[] }[] }) {
  return (
    <>
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
    </>
  );
}

function Fld({ l, children, wide }: { l: string; children: ReactNode; wide?: boolean }) {
  return <div className="field" style={wide ? { gridColumn: "1 / -1" } : undefined}><label>{l}</label>{children}</div>;
}

/** Edit-in-place card chrome: Edit → fields with Save / Cancel (Deal characteristics' pattern). */
function EditableCard({ title, edit, onEdit, onSave, onCancel, canEdit, saving, error, children }: {
  title: string; edit: boolean; onEdit: () => void; onSave: () => void; onCancel: () => void; canEdit: boolean; saving?: boolean; error?: string | null; children: ReactNode;
}) {
  return (
    <div className="panel dd-card ddc-card">
      <div className="dd-card-head">
        <h3 className="dd-card-title">{title}</h3>
        {canEdit && (edit
          ? <div className="dd-card-actions"><button className="small" onClick={onCancel} disabled={saving}>Cancel</button><button className="small primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save"}</button></div>
          : <button className="small" onClick={onEdit}>Edit</button>)}
      </div>
      {children}
      {error && <div className="dd-card-body" style={{ paddingTop: 0 }}><Banner kind="error">{error}</Banner></div>}
    </div>
  );
}

const numStr = (v: number | null | undefined) => (v == null ? "" : String(v));
const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
const txt = (v: string) => (v.trim() === "" ? null : v.trim());

/** Property + acreage — edited in place, saved with PATCH /opportunities/:id. */
function DetailsCard({ opp, canEdit, onSaved }: { opp: Opp; canEdit: boolean; onSaved: (o: Opp) => void }) {
  const seed = useMemo(() => ({
    state: opp.state ?? "", county: opp.county ?? "", abstract: opp.abstract ?? "", survey: opp.survey ?? "",
    estAcres: numStr(opp.estAcres), estNma: numStr(opp.estNma), estNra: numStr(opp.estNra),
    basins: [...(opp.basins ?? [])], formations: [...(opp.formations ?? [])],
  }), [opp]);
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setF(seed), [seed]);
  const discard = () => { setF(seed); setEdit(false); setError(null); };
  const { byId } = useAbstractIndex();
  // A GIS abstract brings its survey along — unless a survey was typed.
  function pickAbstract(ids: string[]) {
    const id = ids[0] ?? "";
    setF((p) => {
      const was = surveyLabel(byId.get(p.abstract)?.survey);
      const next = surveyLabel(byId.get(id)?.survey);
      return { ...p, abstract: id, survey: next && (!p.survey.trim() || p.survey === was) ? next : p.survey };
    });
  }
  async function save() {
    for (const k of ["estAcres", "estNma", "estNra"] as const) {
      if (f[k].trim() !== "" && !(Number.isFinite(Number(f[k])) && Number(f[k]) >= 0)) { setError("Acreage estimates must be numbers of 0 or more"); return; }
    }
    setSaving(true); setError(null);
    try {
      const o = await api.patch<Opp>(`/opportunities/${opp.id}`, {
        state: txt(f.state), county: txt(f.county), abstract: txt(f.abstract), survey: txt(f.survey),
        estAcres: numOrNull(f.estAcres), estNma: numOrNull(f.estNma), estNra: numOrNull(f.estNra),
        basins: f.basins, formations: f.formations,
      });
      setEdit(false); onSaved(o); showToast("Opportunity saved.");
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not save"); }
    finally { setSaving(false); }
  }
  useUnsavedSection(edit, f, seed, save, discard);
  return (
    <EditableCard title="Opportunity details" edit={edit} canEdit={canEdit} saving={saving} error={error} onEdit={() => setEdit(true)} onSave={() => void save()} onCancel={discard}>
      {!edit ? (
        <div className="dd-card-body ddc-view">
          <KvRows groups={[
            { title: "Property", rows: [
              { k: "State", v: opp.state }, { k: "County", v: opp.county },
              { k: "Abstract", v: opp.abstract ? <OppAbstract abstract={opp.abstract} /> : null }, { k: "Survey", v: opp.survey, title: opp.survey },
              { k: "Basin", v: opp.basins?.length ? opp.basins.join(", ") : null }, { k: "Formation", v: opp.formations?.length ? opp.formations.join(", ") : null },
            ] },
            { title: "Acreage (estimates)", rows: [
              { k: "Est. gross acres", v: opp.estAcres != null ? acres(opp.estAcres) : null },
              { k: "Est. NMA", v: opp.estNma != null ? acres(opp.estNma) : null },
              { k: "Est. NRA", v: opp.estNra != null ? acres(opp.estNra) : null },
            ] },
          ]} />
        </div>
      ) : (
        <div className="dd-card-body">
          <div className="dd-grid">
            <GeoFields single
              states={f.state ? [f.state] : []} onStatesChange={(v) => setF((p) => ({ ...p, state: v[0] ?? "" }))}
              counties={f.county ? [f.county] : []} onCountiesChange={(v) => setF((p) => ({ ...p, county: v[0] ?? "" }))}
              abstractIds={f.abstract ? [f.abstract] : []} onAbstractsChange={pickAbstract}
            />
            <Fld l="Survey"><input value={f.survey} onChange={(e) => setF((p) => ({ ...p, survey: e.target.value }))} placeholder="Filled in from the abstract" /></Fld>
            <GeoTagFields autoFill basins={f.basins} onBasinsChange={(v) => setF((p) => ({ ...p, basins: v }))} formations={f.formations} onFormationsChange={(v) => setF((p) => ({ ...p, formations: v }))}
              abstractIds={f.abstract && isAbstractId(f.abstract) ? [f.abstract] : []} counties={f.county ? [f.county] : []} states={f.state ? [f.state] : []} />
            <Fld l="Est. gross acres"><input type="number" min={0} step="any" value={f.estAcres} onChange={(e) => setF((p) => ({ ...p, estAcres: e.target.value }))} aria-label="Estimated gross acres" /></Fld>
            <Fld l="Est. NMA"><input type="number" min={0} step="any" value={f.estNma} onChange={(e) => setF((p) => ({ ...p, estNma: e.target.value }))} aria-label="Estimated NMA" /></Fld>
            <Fld l="Est. NRA"><input type="number" min={0} step="any" value={f.estNra} onChange={(e) => setF((p) => ({ ...p, estNra: e.target.value }))} aria-label="Estimated NRA" /></Fld>
          </div>
        </div>
      )}
    </EditableCard>
  );
}

/** Owner, source, follow-up and notes — edited in place. */
function TrackingCard({ opp, canEdit, users, pipelineName, stageLabel, onSaved }: {
  opp: Opp; canEdit: boolean; users: UserLite[]; pipelineName: string | null; stageLabel: string; onSaved: (o: Opp) => void;
}) {
  const seed = useMemo(() => ({ ownerId: opp.owner?.id ?? "", source: opp.source ?? "", nextFollowUpDate: toInputDate(opp.nextFollowUpDate), notes: opp.notes ?? "" }), [opp]);
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setF(seed), [seed]);
  const discard = () => { setF(seed); setEdit(false); setError(null); };
  async function save() {
    setSaving(true); setError(null);
    try {
      const o = await api.patch<Opp>(`/opportunities/${opp.id}`, { ownerId: f.ownerId || null, source: txt(f.source), nextFollowUpDate: f.nextFollowUpDate || null, notes: txt(f.notes) });
      setEdit(false); onSaved(o); showToast("Opportunity saved.");
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not save"); }
    finally { setSaving(false); }
  }
  useUnsavedSection(edit, f, seed, save, discard);
  const due = followUpStatus(opp);
  const ownerList: UserRef[] = opp.owner && !users.some((u) => u.id === opp.owner!.id) ? [opp.owner, ...users] : users;
  const ownerOptions = userOptions(ownerList);
  return (
    <EditableCard title="Tracking" edit={edit} canEdit={canEdit} saving={saving} error={error} onEdit={() => setEdit(true)} onSave={() => void save()} onCancel={discard}>
      {!edit ? (
        <div className="dd-card-body ddc-view">
          <KvRows groups={[{ rows: [
            { k: "Pipeline", v: pipelineName }, { k: "Stage", v: stageLabel }, { k: "Owner", v: opp.owner ? <UserAvatar user={opp.owner} size={18} withName className="inline" /> : null }, { k: "Source", v: opp.source, title: opp.source },
            { k: "Next follow-up", v: opp.nextFollowUpDate ? <>{fmtDate(opp.nextFollowUpDate)}{due && due.tone !== "neutral" && <span className={`pl-due ${due.tone}`}>{due.text}</span>}</> : null },
            { k: "Added", v: fmtDateLocal(opp.createdAt) }, { k: "Last activity", v: opp.lastActivityAt ? fmtDateTime(opp.lastActivityAt) : null },
          ] }]} />
          <div className="op-notes-block">
            <div className="ddc-group-title">Notes</div>
            {opp.notes ? <p className="op-notes">{opp.notes}</p> : <p className="op-notes empty">No notes yet.{canEdit ? " Add them with Edit." : ""}</p>}
          </div>
        </div>
      ) : (
        <div className="dd-card-body">
          <div className="dd-grid op-track-edit">
            <Fld l="Owner"><Select value={f.ownerId} onChange={(v) => setF((p) => ({ ...p, ownerId: v }))} ariaLabel="Owner" clearable searchable placeholder="Unassigned" options={ownerOptions} /></Fld>
            <Fld l="Source"><input value={f.source} onChange={(e) => setF((p) => ({ ...p, source: e.target.value }))} placeholder="Referral, mailer, courthouse…" /></Fld>
            <Fld l="Next follow-up"><DateField value={f.nextFollowUpDate} onChange={(v) => setF((p) => ({ ...p, nextFollowUpDate: v }))} ariaLabel="Next follow-up" /></Fld>
            <Fld l="Notes" wide><textarea rows={4} value={f.notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} placeholder="Anything worth remembering about this prospect…" /></Fld>
          </div>
        </div>
      )}
    </EditableCard>
  );
}

/** The seller — a linked Contact (the shared record); edited through the same
 *  Seller Information block as New opportunity / New deal. */
function SellerCard({ opp, canEdit, onSaved }: { opp: Opp; canEdit: boolean; onSaved: (o: Opp) => void }) {
  const [editing, setEditing] = useState(false);
  const c = opp.contact;
  const name = sellerName(opp);
  const phone = c?.phone ?? opp.phone;
  const email = c?.email ?? opp.email;
  const mailing = c ? [c.mailingStreet, c.mailingCity, [c.mailingState, c.mailingZip].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  const hasSeller = !!(name || opp.companyName || phone || email);
  return (
    <div className="panel dd-card seller-panel">
      <div className="dd-card-head">
        <div>
          <h3 className="dd-card-title">Seller</h3>
          <div className="dd-card-sub">{c ? <>Linked contact · <Link to={`/contacts/${c.id}`}>open the contact record</Link></> : "Who owns the minerals — kept as a contact record"}</div>
        </div>
        {canEdit && <button className="small primary dd-add-btn" onClick={() => setEditing(true)}>{hasSeller ? <><Pencil size={13} aria-hidden="true" />Edit seller</> : <><Plus size={13} strokeWidth={2.2} aria-hidden="true" />Add seller</>}</button>}
      </div>
      {!hasSeller ? (
        <p className="seller-empty">No seller information yet.{canEdit && " Add the seller to record their contact details — a contact is created or linked."}</p>
      ) : (
        <div className="dd-card-body ddc-view">
          <KvRows groups={[{ rows: [
            { k: "Name", v: name || null },
            { k: "Entity", v: c ? c.entityName : opp.companyName },
            { k: "Phone", v: phone ? <a href={`tel:${phone}`}>{formatPhone(phone)}</a> : null },
            { k: "Email", v: email ? <a href={`mailto:${email}`}>{email}</a> : null, title: email },
            { k: "Preferred contact", v: c?.preferredContact ? c.preferredContact.charAt(0) + c.preferredContact.slice(1).toLowerCase() : null },
            { k: "Mailing address", v: mailing || null, title: mailing },
          ] }]} />
        </div>
      )}
      {editing && <SellerModal opp={opp} onClose={() => setEditing(false)} onSaved={(o) => { setEditing(false); onSaved(o); }} />}
    </div>
  );
}

function SellerModal({ opp, onClose, onSaved }: { opp: Opp; onClose: () => void; onSaved: (o: Opp) => void }) {
  const [seller, setSeller] = useState<SellerInfoForm>(() => {
    if (opp.contact) {
      const c = opp.contact;
      return sellerInfoFromContact({ id: c.id, firstName: c.firstName, lastName: c.lastName, entityName: c.entityName, phone: c.phone, email: c.email,
        mailingStreet: c.mailingStreet ?? null, mailingCity: c.mailingCity ?? null, mailingState: c.mailingState ?? null, mailingZip: c.mailingZip ?? null });
    }
    const name = (opp.sellerName ?? "").trim(); const i = name.lastIndexOf(" ");
    return { ...emptySellerInfo(), kind: opp.companyName && !name ? "ENTITY" : "INDIVIDUAL", entityType: "OTHER",
      firstName: i < 0 ? name : name.slice(0, i), lastName: i < 0 ? "" : name.slice(i + 1), companyName: opp.companyName ?? "", phone: opp.phone ?? "", email: opp.email ?? "" };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = sellerInfoMissing(seller);
  async function save() {
    const bad = sellerInfoInvalid(seller);
    if (missing.length) { setError(`Required: ${missing.join(", ")}`); return; }
    if (bad.length) { setError(bad.join(" · ")); return; }
    setBusy(true); setError(null);
    try {
      const o = await api.patch<Opp>(`/opportunities/${opp.id}`, { seller: sellerInfoBody(seller) });
      showToast("Seller saved."); onSaved(o);
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not save the seller"); setBusy(false); }
  }
  return (
    <Modal title={opp.contact || opp.sellerName || opp.companyName ? "Edit seller" : "Add seller"} subtitle="The seller is a contact record — shared with every deal and prospect of theirs" onClose={onClose} wide dirty
      footer={<>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" onClick={() => void save()} disabled={busy || missing.length > 0} title={missing.length ? "Enabled once the seller has a name" : undefined}>{busy ? "Saving…" : "Save seller"}</button>
      </>}>
      <SellerInformation value={seller} onChange={setSeller} autoFocus />
      {error && <Banner kind="error">{error}</Banner>}
    </Modal>
  );
}

/** Location card: the prospect's abstract on the map (GIS abstracts only). */
function LocationCard({ opp }: { opp: Opp }) {
  const ids = opp.abstract && isAbstractId(opp.abstract) ? [opp.abstract] : [];
  const place = [opp.county, opp.state].filter(Boolean).join(", ");
  return (
    <div className="panel dd-card dd-location">
      <div className="dd-card-head">
        <div>
          <h3 className="dd-card-title">Location</h3>
          {(opp.abstract || place) && <div className="dd-card-sub">{[opp.abstract ? <OppAbstract key="a" abstract={opp.abstract} survey={opp.survey} /> : null, place].filter(Boolean).map((x, i) => <span key={i}>{i > 0 && " · "}{x}</span>)}</div>}
        </div>
        <span className="dd-card-note">The prospect's abstract and geographic extent</span>
      </div>
      <div className="dd-card-body">
        <Suspense fallback={<Spinner label="Loading map…" />}><DealMap abstractIds={ids} noun="opportunity" abstractsWhere="Opportunity details" /></Suspense>
        {ids.length === 0 && (
          <p className="muted dd-location-hint">
            {opp.abstract ? "This abstract was typed as written; pick it from the county's list under Opportunity details → Edit → Abstract to draw it." : <>No abstract yet — add it under <strong>Opportunity details → Edit → Abstract</strong> and the map will draw this prospect's extent.</>}
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- tasks */

/** The seller contact's tasks — the same task records the contact workspace
 *  and the Dashboard use (POST / PATCH /contacts/:id/activities). */
function TasksCard({ contactId, users, onChanged }: { contactId: string | null; users: UserLite[]; onChanged: () => void }) {
  const { can, user } = useAuth();
  const canView = can("viewContacts");
  const canManage = can("manageContacts");
  const [rows, setRows] = useState<ContactActivityRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ContactActivityRow | null>(null);
  const load = useCallback(() => {
    if (!contactId || !canView) { setRows([]); return; }
    api.get<ContactActivityRow[]>(`/contacts/${contactId}/activities`).then(setRows).catch(() => setRows([]));
  }, [contactId, canView]);
  useEffect(() => { load(); }, [load]);
  const tasks = (rows ?? []).filter((a) => a.kind === "TASK")
    .sort((a, b) => Number(!!a.completedAt) - Number(!!b.completedAt) || +new Date(a.dueDate ?? a.createdAt) - +new Date(b.dueDate ?? b.createdAt));
  const open = tasks.filter((t) => !t.completedAt).length;
  const refresh = () => { load(); onChanged(); };
  async function toggle(t: ContactActivityRow) {
    await api.patch(`/contacts/${contactId}/activities/${t.id}`, { completed: !t.completedAt });
    refresh();
  }
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card title="Tasks" sub={contactId ? "To-dos for this prospect — kept on the seller's contact, so they also show on the Dashboard and the contact workspace" : "Tasks live on the seller's contact record"}
      count={open} className="op-tasks"
      actions={contactId && canManage ? <button className="small primary dd-add-btn" onClick={() => setAdding(true)}><Plus size={13} strokeWidth={2.2} aria-hidden="true" />Add task</button> : null}>
      <div className="dd-card-body">
        {!contactId ? (
          <EmptyState title="Add the seller first">Tasks are kept on the seller's contact record. Add the seller under <strong>General → Seller</strong> and tasks appear here.</EmptyState>
        ) : !canView ? (
          <EmptyState title="Contacts are not available to you">Tasks for this prospect live on its seller contact, which your role can't view.</EmptyState>
        ) : rows == null ? <Spinner /> : tasks.length === 0 ? (
          <EmptyState title="No tasks yet">{canManage ? "Add a task to keep this prospect moving — a due date, a priority and who owns it." : "Nothing has been assigned on this prospect."}</EmptyState>
        ) : (
          <ul className="op-tasks-list">
            {tasks.map((t) => {
              const done = !!t.completedAt;
              const dueKey = t.dueDate ? t.dueDate.slice(0, 10) : null;
              const overdue = !done && dueKey != null && dueKey < today;
              const pri = TASK_PRIORITY_META[t.priority ?? "MEDIUM"] ?? TASK_PRIORITY_META.MEDIUM;
              return (
                <li key={t.id} className={`op-task ${done ? "done" : ""}`}>
                  <input type="checkbox" checked={done} disabled={!canManage} onChange={() => void toggle(t)} aria-label={done ? "Reopen task" : "Complete task"} />
                  <button type="button" className="op-task-main" onClick={() => canManage && setEditing(t)} disabled={!canManage} title={canManage ? "Edit task" : undefined}>
                    <span className="op-task-title">{t.title ?? t.body}</span>
                    {t.title && t.body !== t.title && <span className="op-task-body">{t.body}</span>}
                    <span className="op-task-meta">
                      <Tag tone={pri.tone} dot>{pri.label}</Tag>
                      {dueKey && <span className={overdue ? "op-task-due overdue" : "op-task-due"}>{overdue ? "Overdue · " : "Due "}{fmtDate(t.dueDate!)}</span>}
                      {t.assignedTo && <span>· <UserAvatar user={t.assignedTo} size={16} withName className="inline" /></span>}
                      {done && <span>· Completed {fmtDateLocal(t.completedAt!)}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {adding && contactId && (
        <TaskFormModal mode="create" kind="TASK" initial={newTaskValues(user?.id ?? "")} users={users} dueRequired
          subtitle="Kept on the seller's contact — also on the Dashboard task list"
          onClose={() => setAdding(false)}
          onSubmit={async (v: TaskFormValues) => {
            await api.post(`/contacts/${contactId}/activities`, {
              kind: "TASK", title: v.title.trim(), body: v.details.trim() || v.title.trim(), dueDate: v.due || null, priority: v.priority, assignedToId: v.assignee || null,
            });
            setAdding(false); showToast("Task added."); refresh();
          }} />
      )}
      {editing && contactId && (
        <TaskFormModal mode="edit" kind="TASK" users={users} assigneeName={editing.assignedTo?.name ?? null}
          initial={{ title: editing.title ?? editing.body, details: editing.body, due: editing.dueDate ? editing.dueDate.slice(0, 10) : "", priority: (editing.priority as TaskFormValues["priority"]) ?? "MEDIUM", assignee: editing.assignedTo?.id ?? editing.createdBy?.id ?? "", done: !!editing.completedAt }}
          onClose={() => setEditing(null)}
          onSubmit={async (v: TaskFormValues) => {
            await api.patch(`/contacts/${contactId}/activities/${editing.id}`, {
              title: v.title.trim(), details: v.details.trim() || null, dueDate: v.due || null, priority: v.priority, assignedToId: v.assignee || null, completed: v.done,
            });
            setEditing(null); showToast("Task updated."); refresh();
          }} />
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- chrome */

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

function RenameModal({ id, current, onClose, onRenamed }: { id: string; current: string; onClose: () => void; onRenamed: (o: Opp) => void }) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const n = name.trim();
    if (!n) { setError("Give the opportunity a name."); return; }
    if (n === current) { onClose(); return; }
    setBusy(true); setError(null);
    try {
      const o = await api.patch<Opp>(`/opportunities/${id}`, { name: n });
      showToast("Opportunity renamed", "success");
      onRenamed(o);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not rename the opportunity"); setBusy(false); }
  }
  return (
    <Modal title="Rename opportunity" onClose={onClose} dirty={name.trim() !== current}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <div className="field">
        <label>Opportunity name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />
      </div>
      {error && <Banner kind="error">{error}</Banner>}
    </Modal>
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
                  <span className="op-ev-meta">{fmtDateTime(a.createdAt)}{a.createdBy && <> · <UserAvatar user={a.createdBy} size={16} withName className="inline" /></>}</span>
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
