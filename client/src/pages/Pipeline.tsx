import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Modal, Spinner, showToast } from "../components/ui";
import { Select } from "../components/Select";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { dealSearchHaystack } from "../lib/dealSearch";
import { NewDealModal } from "../components/NewDealModal";
import { StageChangeModal } from "../components/StageChangeModal";
import { money, num, fmtDate } from "../lib/format";
import { useAuth } from "../auth/AuthContext";
import { useStages } from "../stages";
import { PipelineStagesModal } from "../components/PipelineStagesModal";
import type { DealSummary, Stage } from "../types";

// The Pipeline shows only ACTIVE-lifecycle stages as columns. Closed and Dead
// remain valid workflow stages but act as transition points, not columns: the
// TRANSITIONS targets below accept drops (and Move Stage offers them), always
// behind a confirmation, after which the deal leaves the board for the Closed
// Deals / Archived Deals subpage.
const TRANSITIONS: { stage: Stage; label: string; hint: string }[] = [
  { stage: "CLOSED", label: "Closed", hint: "→ Closed Deals" },
  { stage: "DEAD", label: "Dead", hint: "→ Archived Deals" },
];

// Distance (px) the pointer must travel before a press becomes a drag — below it
// the gesture is treated as a click (navigate to the deal).
const DRAG_THRESHOLD = 5;

interface DragState { id: string; w: number; offX: number; offY: number; moved: boolean }

// ---------------------------------------------------------------------------
// Customize View — the buyer tailors what deal cards show + how dense they are.
// Persisted locally (per user/browser) like the rest of the app's view prefs.
// ---------------------------------------------------------------------------
type CardField = "location" | "nra" | "priority" | "profit" | "days" | "buyer" | "dates";
type CardSort = "priority" | "days" | "profit" | "name";
interface PipelinePrefs { density: "comfortable" | "compact"; fields: Record<CardField, boolean>; sort: CardSort }
const CARD_FIELDS: [CardField, string][] = [
  ["location", "Location"], ["nra", "NRA"], ["priority", "Priority"], ["profit", "Est. profit"],
  ["days", "Days in stage"], ["buyer", "Selected buyer"], ["dates", "Key dates"],
];
const DEFAULT_PREFS: PipelinePrefs = {
  density: "comfortable",
  fields: { location: true, nra: true, priority: true, profit: true, days: true, buyer: true, dates: true },
  sort: "priority",
};
const PREFS_KEY = "mh-pipeline-view:v1";
function loadPrefs(): PipelinePrefs {
  try { const raw = localStorage.getItem(PREFS_KEY); if (raw) { const p = JSON.parse(raw) as PipelinePrefs; return { ...DEFAULT_PREFS, ...p, fields: { ...DEFAULT_PREFS.fields, ...(p.fields ?? {}) } }; } } catch { /* ignore */ }
  return DEFAULT_PREFS;
}
// ---------------------------------------------------------------------------
// Filters — narrow the board to specific opportunities using existing deal
// attributes. Filtering never changes the pipeline structure: every stage
// column stays in place, only the cards inside are narrowed.
// ---------------------------------------------------------------------------
interface PipelineFilterState {
  q: string;
  priority: "" | "HIGH" | "MEDIUM" | "LOW";
  states: string[];
  counties: string[];
  buyerId: string;
  assigneeId: string;
  overdueOnly: boolean;
  // Acreage ranges (inclusive); empty string = unbounded.
  nraMin: string; nraMax: string;
  nmaMin: string; nmaMax: string;
}
const EMPTY_FILTERS: PipelineFilterState = {
  q: "", priority: "", states: [], counties: [], buyerId: "", assigneeId: "", overdueOnly: false,
  nraMin: "", nraMax: "", nmaMin: "", nmaMax: "",
};
const bound = (s: string): number | null => { const n = Number(s); return s.trim() !== "" && isFinite(n) ? n : null; };
/** Inclusive range test; deals without the metric are excluded once a bound is set. */
function inRange(v: number | null | undefined, min: number | null, max: number | null): boolean {
  if (min === null && max === null) return true;
  if (v == null) return false;
  return (min === null || v >= min) && (max === null || v <= max);
}
function activeFilterCount(f: PipelineFilterState): number {
  return (f.q.trim() ? 1 : 0) + (f.priority ? 1 : 0) + (f.states.length ? 1 : 0) +
    (f.counties.length ? 1 : 0) + (f.buyerId ? 1 : 0) + (f.assigneeId ? 1 : 0) + (f.overdueOnly ? 1 : 0) +
    (bound(f.nraMin) !== null || bound(f.nraMax) !== null ? 1 : 0) +
    (bound(f.nmaMin) !== null || bound(f.nmaMax) !== null ? 1 : 0);
}
function applyPipelineFilters(rows: DealSummary[], f: PipelineFilterState): DealSummary[] {
  const needle = f.q.trim().toLowerCase();
  return rows.filter((d) =>
    (!needle || dealSearchHaystack(d).includes(needle)) &&
    (!f.priority || d.priority === f.priority) &&
    (!f.states.length || d.states.some((s) => f.states.includes(s)) || (d.state != null && f.states.includes(d.state))) &&
    (!f.counties.length || d.counties.some((c) => f.counties.includes(c))) &&
    (!f.buyerId || d.selectedBuyer?.id === f.buyerId) &&
    (!f.assigneeId || d.assignees.some((a) => a.id === f.assigneeId) || d.relationshipOwner?.id === f.assigneeId) &&
    (!f.overdueOnly || d.isOverdue) &&
    // Package rollups (agg*) represent the card the user sees — filter on those.
    inRange(d.aggNra ?? d.nra, bound(f.nraMin), bound(f.nraMax)) &&
    inRange(d.aggAcreageNma ?? d.acreageNma, bound(f.nmaMin), bound(f.nmaMax)));
}

const PRIORITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
function sortDeals(rows: DealSummary[], sort: CardSort): DealSummary[] {
  const cmp: Record<CardSort, (a: DealSummary, b: DealSummary) => number> = {
    priority: (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || b.daysInStage - a.daysInStage,
    days: (a, b) => b.daysInStage - a.daysInStage,
    profit: (a, b) => (b.profitEst ?? 0) - (a.profitEst ?? 0),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return [...rows].sort(cmp[sort]);
}

export function Pipeline() {
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [overCol, setOverCol] = useState<Stage | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [pending, setPending] = useState<{ deal: DealSummary; toStage: Stage } | null>(null);
  // Explicit per-card move (no drag needed): opens the stage modal on the
  // deal's current stage so any destination — including Closed/Dead — is a click away.
  const [moving, setMoving] = useState<DealSummary | null>(null);
  // Card view preferences (density, visible fields, in-column sort).
  const [prefs, setPrefs] = useState<PipelinePrefs>(loadPrefs);
  const [filters, setFilters] = useState<PipelineFilterState>(EMPTY_FILTERS);
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } }, [prefs]);
  const nav = useNavigate();
  const { can } = useAuth();
  const { active: activeStages, reload: reloadStages, label, pipelines, selected, selectedId, setSelectedId } = useStages();
  const [showStages, setShowStages] = useState(false);
  const [showNewPipeline, setShowNewPipeline] = useState(false);
  // Viewers can browse the board but not create deals or change stages —
  // hiding the affordances beats letting them click into a 403.
  const canCreate = can("createDeals");
  const canMove = can("editDeals");
  const canCustomizeStages = can("manageOrgSettings");

  // Latest state for the window pointer handlers (which are bound once per drag).
  const dragRef = useRef<DragState | null>(null);
  const overRef = useRef<Stage | null>(null);
  // Live pointer position + the floating clone element — updated directly during
  // a drag so the board doesn't re-render on every pointermove (the lag source).
  const posRef = useRef({ x: 0, y: 0 });
  const cloneRef = useRef<HTMLDivElement>(null);
  dragRef.current = drag;
  overRef.current = overCol;

  // The pipeline is the acquisition board — opportunities only. Owned mineral
  // assets are managed in their own module and never appear here.
  function load() { api.get<DealSummary[]>("/deals?recordType=OPPORTUNITY").then(setDeals); }
  useEffect(load, []);

  // ------ pointer-based drag: the card follows the cursor with no native-DnD lag
  function startDrag(e: React.PointerEvent, deal: DealSummary) {
    if (!canMove || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".dc-move")) return; // the ⋯ menu button
    const card = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offX = e.clientX - card.left, offY = e.clientY - card.top;
    const start = { x: e.clientX, y: e.clientY };
    posRef.current = start;
    setDrag({ id: deal.id, w: card.width, offX, offY, moved: false });

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      posRef.current = { x: ev.clientX, y: ev.clientY };
      // Move the floating clone directly — no React re-render of the board.
      const el = cloneRef.current;
      if (el) { el.style.left = `${ev.clientX - d.offX}px`; el.style.top = `${ev.clientY - d.offY}px`; }
      // Promote press → drag once, past the threshold (one state update, then none).
      if (!d.moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_THRESHOLD) {
        document.body.classList.add("pipeline-dragging");
        setDrag((prev) => (prev ? { ...prev, moved: true } : prev));
      }
      // Re-render only when the hovered column/transition actually changes.
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const stage = (under?.closest("[data-stage]")?.getAttribute("data-stage") as Stage | null) ?? null;
      if (stage !== overRef.current) setOverCol(stage);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("pipeline-dragging");
      window.getSelection()?.removeAllRanges(); // clear any stray text selection from the drag
      const d = dragRef.current;
      const target = overRef.current;
      setDrag(null); setOverCol(null);
      if (!d) return;
      if (!d.moved) { nav(`/deals/${deal.id}`); return; } // press without drag = open
      if (target && target !== deal.stage) commitMove(deal, target);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  async function commitMove(deal: DealSummary, col: Stage) {
    // Terminal stages carry downstream effects — confirm first (their move runs
    // through the modal). Normal stage moves are immediate + optimistic, with
    // an Undo in the toast: an accidental 20px drag shouldn't silently rewrite
    // stage history.
    if (col === "CLOSED" || col === "DEAD") { setPending({ deal, toStage: col }); return; }
    const fromStage = deal.stage;
    setDeals((prev) => prev?.map((d) => (d.id === deal.id ? { ...d, stage: col } : d)) ?? prev);
    try {
      await api.post(`/deals/${deal.id}/stage`, { toStage: col });
      load();
      showToast(
        <span>
          Moved <strong>{deal.name}</strong> to {label(col)}.{" "}
          <button
            className="link-btn"
            onClick={() => {
              void api.post(`/deals/${deal.id}/stage`, { toStage: fromStage })
                .then(() => { load(); showToast(`Moved back to ${label(fromStage)}.`); })
                .catch(() => showToast("Could not undo the move.", "error"));
            }}
          >
            Undo
          </button>
        </span>,
      );
    }
    catch { load(); }
  }

  if (!deals) return <Spinner />;
  const dragDeal = drag ? deals.find((d) => d.id === drag.id) ?? null : null;
  // Board shows ONLY the selected pipeline's deals. A null pipelineId means the
  // org's default pipeline (legacy rows and the common case).
  const pipelineDeals = deals.filter((d) => (selected.isDefault ? !d.pipelineId || d.pipelineId === selected.id : d.pipelineId === selected.id));
  const boardDeals = applyPipelineFilters(pipelineDeals, filters);
  const filtersActive = activeFilterCount(filters) > 0;

  return (
    <div className="page">
      <div className="page-header">
        <div className="row">
          <h1 style={{ marginBottom: 0 }}>Pipeline</h1>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {filtersActive && <span className="muted" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>Showing {boardDeals.length} of {pipelineDeals.length}</span>}
          {/* Pipeline selector — switch boards; each pipeline has its own stages. */}
          <Select
            ariaLabel="Pipeline"
            width={190}
            options={pipelines.map((p) => ({ value: p.id, label: p.name }))}
            value={selectedId}
            onChange={(v) => v && setSelectedId(v)}
          />
          {canCustomizeStages && <button className="small" title="Create a new pipeline with its own stages" onClick={() => setShowNewPipeline(true)}>+ New pipeline</button>}
          <PipelineFilters deals={pipelineDeals} filters={filters} onChange={setFilters} />
          {canCustomizeStages && <button className="small" onClick={() => setShowStages(true)}>Customize stages</button>}
          <PipelineCustomize prefs={prefs} onChange={setPrefs} />
          {canCreate && <button className="primary" onClick={() => setShowNew(true)}>+ New Deal</button>}
        </div>
      </div>

      {/* Transition targets live ABOVE the board so they're always on-screen. */}
      {canMove && <div className="transition-bar">
        {TRANSITIONS.map((t) => (
          <div
            key={t.stage} data-stage={t.stage}
            className={`transition-zone ${t.stage === "DEAD" ? "dead" : "closed"} ${drag && overCol === t.stage ? "drop-target" : ""}`}
          >
            <span>{t.label}</span>
            <span className="muted" style={{ fontSize: 11 }}>{t.hint}</span>
          </div>
        ))}
      </div>}

      {activeStages.length === 0 && (
        <div className="panel" style={{ textAlign: "center", padding: "36px 20px" }}>
          <p style={{ margin: 0 }}><strong>This pipeline has no stages yet.</strong></p>
          <p className="muted" style={{ margin: "6px 0 14px" }}>Build it from scratch — add your first stage to start moving deals through it. Closed and Dead are already included.</p>
          {canCustomizeStages && <button className="primary" onClick={() => setShowStages(true)}>Add stages</button>}
        </div>
      )}
      <div className={`kanban ${prefs.density === "compact" ? "compact" : ""} ${drag ? "dragging" : ""}`}>
        {activeStages.map((stage) => {
          const col = stage.key;
          const colDeals = sortDeals(boardDeals.filter((d) => d.stage === col), prefs.sort);
          return (
            <div
              key={col} data-stage={col}
              className={`kanban-col ${drag && overCol === col ? "drop-target" : ""}`}
            >
              <div className="kanban-col-head">
                <span>{stage.label}</span>
                <span className="muted">{colDeals.length}</span>
              </div>
              <div className="kanban-col-body">
                {colDeals.map((d) => (
                  <Card key={d.id} deal={d} canMove={canMove} fields={prefs.fields} dragging={drag?.id === d.id && drag.moved}
                    onPointerDown={(e) => startDrag(e, d)} onMove={() => setMoving(d)} />
                ))}
                {colDeals.length === 0 && <div className="kanban-empty">Drop here</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Floating clone follows the cursor for a natural, lag-free drag. Its
          position is updated imperatively (cloneRef) during the drag. */}
      {drag && drag.moved && dragDeal && (
        <div ref={cloneRef} className="deal-card drag-clone" style={{ position: "fixed", left: posRef.current.x - drag.offX, top: posRef.current.y - drag.offY, width: drag.w, pointerEvents: "none", zIndex: 1000 }}>
          <CardBody deal={dragDeal} fields={prefs.fields} />
        </div>
      )}

      {showStages && (
        <PipelineStagesModal
          pipeline={selected}
          onClose={() => setShowStages(false)}
          onChanged={() => { reloadStages(); load(); }}
          onPipelineDeleted={() => { setShowStages(false); setSelectedId(""); reloadStages(); load(); }}
        />
      )}
      {showNewPipeline && (
        <NewPipelineModal
          onClose={() => setShowNewPipeline(false)}
          onCreated={(id) => { setShowNewPipeline(false); reloadStages(); setSelectedId(id); }}
        />
      )}
      {showNew && <NewDealModal pipelineId={selected.id || undefined} onClose={() => setShowNew(false)} onCreated={(d) => { setShowNew(false); nav(`/deals/${d.id}`); }} />}
      {pending && (
        <StageChangeModal
          deal={pending.deal}
          initialStage={pending.toStage}
          directTerminal
          onClose={() => setPending(null)}
          onChanged={() => { setPending(null); load(); }}
        />
      )}
      {moving && (
        <StageChangeModal
          deal={moving}
          onClose={() => setMoving(null)}
          onChanged={() => { setMoving(null); load(); }}
        />
      )}
    </div>
  );
}

function Card({ deal, canMove, fields, dragging, onPointerDown, onMove }: {
  deal: DealSummary; canMove: boolean; fields: Record<CardField, boolean>; dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void; onMove: () => void;
}) {
  const isDead = deal.stage === "DEAD";
  return (
    <div
      className={`deal-card prio-${deal.priority.toLowerCase()} ${isDead ? "dead" : ""} ${dragging ? "drag-source" : ""} ${canMove ? "draggable" : ""}`}
      onPointerDown={canMove ? onPointerDown : undefined}
    >
      {canMove && <button
        className="dc-move"
        title="Move to another stage"
        aria-label={`Move ${deal.name} to another stage`}
        onClick={(e) => { e.stopPropagation(); onMove(); }}
        onPointerDown={(e) => e.stopPropagation()}
      >⋯</button>}
      <CardBody deal={deal} fields={fields} />
    </div>
  );
}

/** Card content shared by the board card and the drag clone. Which facts appear
 *  is driven by the user's Customize View field preferences. */
function CardBody({ deal, fields }: { deal: DealSummary; fields: Record<CardField, boolean> }) {
  const isClosing = deal.stage === "CLOSING";
  const isDead = deal.stage === "DEAD";
  const showLoc = fields.location, showNra = fields.nra && deal.nra != null;
  const row2 = fields.priority || fields.profit || fields.days;
  return (
    <>
      <div className="dc-name">{deal.name}{deal.assetCount ? <span className="dc-assets"> · {deal.assetCount} asset{deal.assetCount > 1 ? "s" : ""}</span> : null}</div>
      {(showLoc || showNra) && (
        <div className="dc-meta">
          {showLoc && <span>{[deal.counties.join(", "), deal.state].filter(Boolean).join(", ") || "—"}</span>}
          {showNra && <span>{num((deal.aggNra ?? deal.nra)!)} NRA</span>}
        </div>
      )}
      {row2 && (
        <div className="dc-meta" style={{ marginTop: 4 }}>
          {fields.priority && <span className={`badge priority-${deal.priority.toLowerCase()}`}>{deal.priority[0] + deal.priority.slice(1).toLowerCase()}</span>}
          {fields.profit && <span>{money(deal.profitEst)}</span>}
          {fields.days && <span>{deal.daysInStage}d in stage</span>}
        </div>
      )}
      {fields.buyer && isClosing && deal.selectedBuyer && <div className="dc-buyer">→ {deal.selectedBuyer.name}</div>}
      {fields.dates && (
        <div className="dc-meta" style={{ marginTop: 4 }}>
          {isClosing ? (
            <>
              <span>Orig: {fmtDate(deal.originalClosingDate)}</span>
              <span>Final: {fmtDate(deal.finalClosingDate)}</span>
            </>
          ) : (
            !isDead && <span>Find buyer by: {fmtDate(deal.findBuyerByDate)}</span>
          )}
        </div>
      )}
    </>
  );
}

/** Filters popover for the Pipeline board — same design language as Customize View. */
function PipelineFilters({ deals, filters, onChange }: {
  deals: DealSummary[]; filters: PipelineFilterState; onChange: (f: PipelineFilterState) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Option lists come from the deals actually on the board.
  const states = [...new Set(deals.flatMap((d) => [...d.states, ...(d.state ? [d.state] : [])]))].sort();
  const counties = [...new Set(deals.flatMap((d) => d.counties))].sort();
  const buyers = [...new Map(deals.flatMap((d) => (d.selectedBuyer ? [[d.selectedBuyer.id, d.selectedBuyer.name] as const] : []))).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const people = [...new Map(deals.flatMap((d) => [
    ...d.assignees.map((a) => [a.id, a.name] as const),
    ...(d.relationshipOwner ? [[d.relationshipOwner.id, d.relationshipOwner.name] as const] : []),
  ])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const n = activeFilterCount(filters);

  return (
    <div className="cv-wrap" ref={ref}>
      <button type="button" className={`small cv-btn ${open || n > 0 ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title="Filter the board">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
        Filters{n > 0 ? ` (${n})` : ""}
      </button>
      {open && (
        <div className="cv-menu" role="dialog" aria-label="Filter board" style={{ width: 280 }}>
          <div className="cv-head"><strong>Filter opportunities</strong></div>
          <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="field" style={{ marginBottom: 0 }}><label>Search</label>
              <input value={filters.q} onChange={(e) => onChange({ ...filters, q: e.target.value })} placeholder="Deal, seller, abstract, survey…" aria-label="Search pipeline deals" />
            </div>
            <div className="field" style={{ marginBottom: 0 }}><label>Priority</label>
              <Select value={filters.priority} onChange={(v) => onChange({ ...filters, priority: v as PipelineFilterState["priority"] })} clearable placeholder="Any priority" ariaLabel="Filter by priority"
                options={[{ value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Medium" }, { value: "LOW", label: "Low" }]} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}><label>State</label>
              <SearchableMultiSelect options={states} value={filters.states} onChange={(v) => onChange({ ...filters, states: v })} placeholder="Any state" />
            </div>
            <div className="field" style={{ marginBottom: 0 }}><label>County</label>
              <SearchableMultiSelect options={counties} value={filters.counties} onChange={(v) => onChange({ ...filters, counties: v })} placeholder="Any county" />
            </div>
            <div className="field" style={{ marginBottom: 0 }}><label>Selected buyer</label>
              <Select value={filters.buyerId} onChange={(v) => onChange({ ...filters, buyerId: v })} clearable searchable placeholder="Any buyer" ariaLabel="Filter by buyer"
                options={buyers.map(([value, label]) => ({ value, label }))} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}><label>Team member</label>
              <Select value={filters.assigneeId} onChange={(v) => onChange({ ...filters, assigneeId: v })} clearable searchable placeholder="Anyone" ariaLabel="Filter by team member"
                options={people.map(([value, label]) => ({ value, label }))} />
            </div>
            {/* From/To side by side on one line — the inputs split the row's
                width evenly (flex) so they never wrap into a vertical stack,
                at any panel width. */}
            <div className="field" style={{ marginBottom: 0 }}><label>NRA range</label>
              <div className="row" style={{ gap: 6, flexWrap: "nowrap", alignItems: "center" }}>
                <input type="number" min={0} style={{ flex: 1, minWidth: 0 }} value={filters.nraMin} onChange={(e) => onChange({ ...filters, nraMin: e.target.value })} placeholder="From" aria-label="Minimum NRA" />
                <span className="muted">–</span>
                <input type="number" min={0} style={{ flex: 1, minWidth: 0 }} value={filters.nraMax} onChange={(e) => onChange({ ...filters, nraMax: e.target.value })} placeholder="To" aria-label="Maximum NRA" />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}><label>NMA range</label>
              <div className="row" style={{ gap: 6, flexWrap: "nowrap", alignItems: "center" }}>
                <input type="number" min={0} style={{ flex: 1, minWidth: 0 }} value={filters.nmaMin} onChange={(e) => onChange({ ...filters, nmaMin: e.target.value })} placeholder="From" aria-label="Minimum NMA" />
                <span className="muted">–</span>
                <input type="number" min={0} style={{ flex: 1, minWidth: 0 }} value={filters.nmaMax} onChange={(e) => onChange({ ...filters, nmaMax: e.target.value })} placeholder="To" aria-label="Maximum NMA" />
              </div>
            </div>
            <label className="cv-row cv-check" style={{ justifyContent: "flex-start", padding: 0 }}>
              <input type="checkbox" checked={filters.overdueOnly} onChange={() => onChange({ ...filters, overdueOnly: !filters.overdueOnly })} /> <span>Overdue only</span>
            </label>
          </div>
          <div className="cv-foot">
            <button type="button" className="small" disabled={n === 0} onClick={() => onChange(EMPTY_FILTERS)}>Clear all</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Customize View popover for the Pipeline board (density, fields, sort). */
function PipelineCustomize({ prefs, onChange }: { prefs: PipelinePrefs; onChange: (p: PipelinePrefs) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const toggleField = (k: CardField) => onChange({ ...prefs, fields: { ...prefs.fields, [k]: !prefs.fields[k] } });

  return (
    <div className="cv-wrap" ref={ref}>
      <button type="button" className={`small cv-btn ${open ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title="Customize the board">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>
        Customize View
      </button>
      {open && (
        <div className="cv-menu" role="dialog" aria-label="Customize board">
          <div className="cv-head"><strong>Card density</strong></div>
          <div className="cv-seg" style={{ padding: "8px 12px" }}>
            <div className="seg-control" style={{ width: "100%" }}>
              <span className={`seg ${prefs.density === "comfortable" ? "active" : ""}`} onClick={() => onChange({ ...prefs, density: "comfortable" })}>Comfortable</span>
              <span className={`seg ${prefs.density === "compact" ? "active" : ""}`} onClick={() => onChange({ ...prefs, density: "compact" })}>Compact</span>
            </div>
          </div>
          <div className="cv-head" style={{ borderTop: "1px solid var(--border)" }}><strong>Card fields</strong></div>
          <div className="cv-list">
            {CARD_FIELDS.map(([k, label]) => (
              <label key={k} className="cv-row cv-check" style={{ justifyContent: "flex-start" }}>
                <input type="checkbox" checked={prefs.fields[k]} onChange={() => toggleField(k)} /> <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="cv-head" style={{ borderTop: "1px solid var(--border)" }}><strong>Sort within a stage</strong></div>
          <div style={{ padding: "8px 12px" }}>
            <Select value={prefs.sort} onChange={(v) => onChange({ ...prefs, sort: v as CardSort })} ariaLabel="Sort cards by"
              options={[
                { value: "priority", label: "Priority" },
                { value: "days", label: "Days in stage" },
                { value: "profit", label: "Est. profit" },
                { value: "name", label: "Name A–Z" },
              ]} />
          </div>
          <div className="cv-foot">
            <button type="button" className="small" onClick={() => onChange(DEFAULT_PREFS)}>Restore default</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small create-pipeline dialog: name it, get the default stage set, switch to it. */
function NewPipelineModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const p = await api.post<{ id: string }>("/pipeline/pipelines", { name: name.trim() });
      showToast(`Pipeline "${name.trim()}" created.`);
      onCreated(p.id);
    } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); setBusy(false); }
  };
  return (
    <Modal title="New pipeline" onClose={onClose} footer={<>
      <button onClick={onClose} disabled={busy}>Cancel</button>
      <button className="primary" onClick={create} disabled={!name.trim() || busy}>Create pipeline</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>
        A new pipeline starts blank so you can define your own stages from scratch.
        Closed and Dead are always included automatically and work exactly like today.
      </p>
      <label>Pipeline name</label>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Leasing"
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void create(); } }} />
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}
