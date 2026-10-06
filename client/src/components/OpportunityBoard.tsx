import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { Spinner, showToast, Modal, OverflowMenu } from "./ui";
import { Avatar } from "./kit";
import { Select } from "./Select";
import { num, fmtDate, daysBetween } from "../lib/format";
import { useAuth } from "../auth/AuthContext";
import { stageColor, isOpportunityPipeline, type PipelineInfo } from "../stages";
import { PipelineSettingsModal } from "./PipelineSettingsModal";
import { NewOpportunityModal } from "./NewOpportunityModal";
import type { Opp, OppSummary, PipelineStage, Stage } from "../types";

/**
 * The Pipeline board for an OPPORTUNITIES-kind pipeline: the same columns,
 * cards, drag mechanics and bottom drop zones as the deals board, rendering
 * Opportunity records instead of Deals. The deals board (pages/Pipeline.tsx)
 * is untouched; the drag code below is a copy adapted to opportunities so the
 * two can evolve independently.
 */

// Distance (px) the pointer must travel before a press becomes a drag.
const DRAG_THRESHOLD = 5;
// Touch: a card only picks up after a press-and-hold (see Pipeline.tsx).
const TOUCH_HOLD_MS = 350;
const TOUCH_SLOP = 10;

interface DragState { id: string; w: number; offX: number; offY: number; moved: boolean }

/** Whole days since the opportunity entered its current stage. */
export function oppDaysInStage(o: Pick<OppSummary, "currentStageEnteredAt">): number {
  const t = new Date(o.currentStageEnteredAt).getTime();
  if (isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/** Follow-up chip: overdue reads red, today amber, upcoming neutral. */
export function followUpStatus(o: Pick<OppSummary, "nextFollowUpDate">): { text: string; tone: "danger" | "warn" | "neutral" } | null {
  const days = daysBetween(o.nextFollowUpDate);
  if (days == null) return null;
  if (days < 0) return { text: `Overdue ${-days}d`, tone: "danger" };
  if (days === 0) return { text: "Due today", tone: "warn" };
  return { text: `Follow up ${fmtDate(o.nextFollowUpDate)}`, tone: "neutral" };
}

/** "Jane Doe · Acme Minerals" — the seller line of a card. */
export function oppSellerLine(o: Pick<OppSummary, "sellerName" | "companyName">): string | null {
  return [o.sellerName, o.companyName].filter(Boolean).join(" · ") || null;
}

// --- Icons (inline, stroke = currentColor) ---------------------------------
const Svg = ({ size = 14, sw = 1.7, children }: { size?: number; sw?: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const CloseIcon = ({ size = 14, sw = 2.4 }: { size?: number; sw?: number }) => <Svg size={size} sw={sw}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
const SkipIcon = () => <Svg size={14} sw={2.2}><path d="M5 12h12M13 6l6 6-6 6" /></Svg>;
const SlidersIcon = () => <Svg><path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" /></Svg>;
const PlusIcon = () => <Svg sw={2}><path d="M12 5v14M5 12h14" /></Svg>;
const SearchIcon = () => <Svg sw={1.8}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Svg>;
const PinIcon = () => <Svg size={12} sw={1.8}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></Svg>;
const ClockIcon = () => <Svg size={12} sw={1.9}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>;
const PersonIcon = () => <Svg size={12} sw={1.9}><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></Svg>;
const TrayIcon = () => <Svg size={18}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Svg>;

export function OpportunityBoard({ pipeline, pipelines, switcher, showSettings, onOpenSettings, onCloseSettings, onSettingsChanged }: {
  /** The selected (OPPORTUNITIES-kind) pipeline. */
  pipeline: PipelineInfo;
  pipelines: PipelineInfo[];
  /** The page's pipeline switcher (owned by Pipeline.tsx). */
  switcher: ReactNode;
  showSettings: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onSettingsChanged: () => void;
}) {
  const [opps, setOpps] = useState<OppSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [drag, setDrag] = useState<DragState | null>(null);
  const [overCol, setOverCol] = useState<Stage | null>(null);
  const [showNew, setShowNew] = useState(false);
  // Terminal drop (Passed / Lost): confirmed, with an optional reason.
  const [pending, setPending] = useState<{ opp: OppSummary; toStage: Stage } | null>(null);
  // Explicit per-card move from the ⋯ menu.
  const [moving, setMoving] = useState<OppSummary | null>(null);
  const [converting, setConverting] = useState<OppSummary | null>(null);
  const nav = useNavigate();
  const { can } = useAuth();
  // Viewing = viewDeals (the route guard); creating, moving and converting = editDeals.
  const canMove = can("editDeals");
  const canCustomizeStages = can("manageOrgSettings");

  const dragRef = useRef<DragState | null>(null);
  const overRef = useRef<Stage | null>(null);
  const posRef = useRef({ x: 0, y: 0 });
  const cloneRef = useRef<HTMLDivElement>(null);
  dragRef.current = drag;
  overRef.current = overCol;

  function load() {
    api.get<OppSummary[]>(`/opportunities?pipelineId=${encodeURIComponent(pipeline.id)}`).then(setOpps).catch(() => setOpps([]));
  }
  useEffect(load, [pipeline.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const autoScrollTimer = useRef<number | null>(null);
  function autoScrollTick() {
    const d = dragRef.current;
    if (d?.moved) {
      const { x, y } = posRef.current;
      const EDGE = 70, MAX = 16;
      const under = document.elementFromPoint(x, y) as HTMLElement | null;
      const body = under?.closest(".kanban-col")?.querySelector(".kanban-col-body") as HTMLElement | null;
      if (body) {
        const r = body.getBoundingClientRect();
        if (y < r.top + EDGE) body.scrollTop -= MAX * ((r.top + EDGE - y) / EDGE);
        else if (y > r.bottom - EDGE) body.scrollTop += MAX * ((y - (r.bottom - EDGE)) / EDGE);
      }
      const board = document.querySelector(".pl2-page .kanban") as HTMLElement | null;
      if (board) {
        const r = board.getBoundingClientRect();
        if (x < r.left + EDGE) board.scrollLeft -= MAX * ((r.left + EDGE - x) / EDGE);
        else if (x > r.right - EDGE) board.scrollLeft += MAX * ((x - (r.right - EDGE)) / EDGE);
      }
    }
  }

  // ------ pointer-based drag (same mechanics as the deals board)
  function startDrag(e: React.PointerEvent, opp: OppSummary) {
    if (!canMove || e.button !== 0 || opp.convertedDealId) return;
    if ((e.target as HTMLElement).closest(".ovf")) return; // the ⋯ menu button
    const card = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offX = e.clientX - card.left, offY = e.clientY - card.top;
    const start = { x: e.clientX, y: e.clientY };
    posRef.current = start;
    setDrag({ id: opp.id, w: card.width, offX, offY, moved: false });
    if (autoScrollTimer.current == null) autoScrollTimer.current = window.setInterval(autoScrollTick, 16);

    const touch = e.pointerType === "touch";
    let armed = !touch;
    let holdTimer: number | null = null;
    const promote = () => {
      document.body.classList.add("pipeline-dragging");
      setDrag((prev) => (prev ? { ...prev, moved: true } : prev));
    };
    const blockScroll = (ev: TouchEvent) => { if (armed) ev.preventDefault(); };
    if (touch) {
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        armed = true;
        const el = cloneRef.current;
        if (el) { el.style.left = `${posRef.current.x - offX}px`; el.style.top = `${posRef.current.y - offY}px`; }
        promote();
      }, TOUCH_HOLD_MS);
      window.addEventListener("touchmove", blockScroll, { passive: false });
    }

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("touchmove", blockScroll);
      if (holdTimer != null) { window.clearTimeout(holdTimer); holdTimer = null; }
      if (autoScrollTimer.current != null) { window.clearInterval(autoScrollTimer.current); autoScrollTimer.current = null; }
      document.body.classList.remove("pipeline-dragging");
    };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      posRef.current = { x: ev.clientX, y: ev.clientY };
      const dist = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
      if (!armed) {
        if (dist > TOUCH_SLOP) { cleanup(); setDrag(null); setOverCol(null); }
        return;
      }
      const el = cloneRef.current;
      if (el) { el.style.left = `${ev.clientX - d.offX}px`; el.style.top = `${ev.clientY - d.offY}px`; }
      if (!d.moved && dist > DRAG_THRESHOLD) promote();
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const stage = (under?.closest("[data-stage]")?.getAttribute("data-stage") as Stage | null) ?? null;
      if (stage !== overRef.current) setOverCol(stage);
    };
    const onCancel = () => { cleanup(); setDrag(null); setOverCol(null); };
    const onUp = () => {
      cleanup();
      window.getSelection()?.removeAllRanges();
      const d = dragRef.current;
      const target = overRef.current;
      setDrag(null); setOverCol(null);
      if (!d) return;
      if (!d.moved) { nav(`/opportunities/${opp.id}`); return; } // press without drag = open
      if (target && target !== opp.stage) commitMove(opp, target);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  const labelOf = (key: string) => pipeline.stages.find((s) => s.key === key)?.label ?? key;
  const isTerminal = (key: string) => pipeline.stages.some((s) => s.key === key && s.isTerminal);

  /** After a move: a "Converted" toast when the stage triggered automatic
   *  conversion, otherwise "Moved to X · Undo" (undo = move back). */
  function afterMove(before: OppSummary, after: Opp | OppSummary) {
    if (after.convertedDealId && !before.convertedDealId) {
      showToast(<span><strong>{after.name}</strong> was converted to a deal. <Link to={`/deals/${after.convertedDealId}`} className="link-btn">Open deal</Link></span>, "success", 10000);
      return;
    }
    const fromStage = before.stage;
    let used = false;
    const undo = () => {
      if (used) return;
      used = true;
      api.post(`/opportunities/${before.id}/stage`, { toStage: fromStage })
        .then(() => { load(); showToast(`Moved back to ${labelOf(fromStage)}.`); })
        .catch((err) => { load(); showToast(err instanceof ApiError ? err.message : "Could not undo the move.", "error"); });
    };
    showToast(
      <span><strong>{before.name}</strong> moved to {labelOf(after.stage)}. <button className="link-btn" onClick={undo}>Undo</button></span>,
      "success", 10000,
    );
  }

  async function commitMove(opp: OppSummary, col: Stage) {
    // Terminal stages (Passed / Lost) confirm first and take an optional reason.
    if (isTerminal(col)) { setPending({ opp, toStage: col }); return; }
    setOpps((prev) => prev?.map((o) => (o.id === opp.id ? { ...o, stage: col } : o)) ?? prev);
    try {
      const moved = await api.post<Opp>(`/opportunities/${opp.id}/stage`, { toStage: col });
      load();
      afterMove(opp, moved);
    } catch (err) {
      load();
      showToast(err instanceof ApiError ? err.message : "Could not move the opportunity.", "error");
    }
  }

  if (!opps) return <Spinner />;
  const dragOpp = drag ? opps.find((o) => o.id === drag.id) ?? null : null;
  const activeStages = pipeline.stages.filter((s) => !s.isTerminal);
  const terminalStages = pipeline.stages.filter((s) => s.isTerminal);
  const needle = q.trim().toLowerCase();
  const boardOpps = needle
    ? opps.filter((o) => [o.name, o.sellerName, o.companyName, o.county].some((v) => v && v.toLowerCase().includes(needle)))
    : opps;
  const activeKeys = new Set(activeStages.map((s) => s.key));
  const activeCount = boardOpps.filter((o) => activeKeys.has(o.stage) && !o.convertedDealId).length;
  // Stage counts for the settings editor — this pipeline only (null = unknown).
  const stageCount = (pipelineId: string, stageKey: string) => (pipelineId === pipeline.id ? opps.filter((o) => o.stage === stageKey).length : null);

  return (
    <div className="page pl2-page op-board">
      <div className="page-header pl-head">
        <div className="pl-head-main">
          <h1>Pipeline</h1>
          {switcher}
          <div className="pl-stats">
            <span><b>{activeCount}</b> active opportunit{activeCount === 1 ? "y" : "ies"}</span>
          </div>
        </div>
        <div className="pl-toolbar">
          <div className="pl-search op-search">
            <SearchIcon />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, seller, county" aria-label="Search opportunities" />
          </div>
          {canCustomizeStages && (
            <button type="button" className="pl-btn" title="Create, rename, reorder, and delete pipelines; configure stages and conversion" onClick={onOpenSettings}>
              <SlidersIcon /><span>Pipeline settings</span>
            </button>
          )}
          {canMove && <button type="button" className="primary pl-new" onClick={() => setShowNew(true)}><PlusIcon /><span>New opportunity</span></button>}
        </div>
      </div>

      <div className={`kanban ${drag ? "dragging" : ""}`}>
        {activeStages.length === 0 && (
          <div className="pl-nostages">
            <span className="pl-nostages-title">{pipeline.name} has no stages yet</span>
            <span className="pl-nostages-sub">Its terminal stages ({terminalStages.map((s) => s.label).join(" and ") || "Passed and Lost"}) are included automatically.</span>
            {canCustomizeStages && <button type="button" className="primary" onClick={onOpenSettings}>Add stages</button>}
          </div>
        )}
        {activeStages.map((stage) => {
          const col = stage.key;
          const color = stageColor(pipeline.stages, col);
          const colOpps = boardOpps.filter((o) => o.stage === col).sort((a, b) => oppDaysInStage(b) - oppDaysInStage(a));
          const nma = colOpps.reduce((s, o) => s + (o.estNma ?? 0), 0);
          const hiddenBySearch = needle !== "" && opps.some((o) => o.stage === col);
          return (
            <div
              key={col} data-stage={col}
              className={`kanban-col pl-col ${drag && overCol === col && dragOpp?.stage !== col ? "drop-target" : ""}`}
              style={{ "--stage": color } as CSSProperties}
            >
              <div className="pl-col-head">
                <div className="pl-col-title">
                  <span className="pl-col-dot" aria-hidden="true" />
                  <span className="pl-col-name" title={stage.label}>{stage.label}</span>
                  <span className="pl-col-count">{colOpps.length}</span>
                </div>
                <div className="pl-col-total">
                  <span className={`pl-col-sum ${nma > 0 ? "on" : ""}`}>{num(nma)}</span>
                  <span className="pl-col-metric">est. NMA</span>
                </div>
              </div>
              <div className="kanban-col-body pl-col-body">
                {colOpps.map((o) => (
                  <OppCard key={o.id} opp={o} canMove={canMove} dragging={drag?.id === o.id && drag.moved}
                    onPointerDown={(e) => startDrag(e, o)}
                    onOpen={() => nav(`/opportunities/${o.id}`)}
                    onMove={() => setMoving(o)}
                    onConvert={() => setConverting(o)} />
                ))}
                {colOpps.length === 0 && (
                  <div className="pl-empty">
                    <TrayIcon />
                    <span>{hiddenBySearch ? "No opportunities match" : "Drop opportunities here"}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Terminal zones (this pipeline's own terminal stages, e.g. Passed / Lost) —
          fixed at the bottom like Closed / Dead on the deals board. */}
      {canMove && terminalStages.length > 0 && (
        <div className={`pl-zones ${drag?.moved ? "dragging" : ""}`}>
          {terminalStages.map((t, i) => (
            <div
              key={t.key} data-stage={t.key}
              className={`pl-zone op-zone ${drag && overCol === t.key ? "drop-target" : ""}`}
              style={{ "--zone": stageColor(pipeline.stages, t.key) } as CSSProperties}
            >
              <span className="pl-zone-main">
                <span className="pl-zone-ico" aria-hidden="true">{i === terminalStages.length - 1 ? <CloseIcon /> : <SkipIcon />}</span>
                <span className="pl-zone-name">{t.label}</span>
              </span>
              <span className="pl-zone-hint">Drag an opportunity here to mark it {t.label}</span>
            </div>
          ))}
        </div>
      )}

      {drag && drag.moved && dragOpp && (
        <div ref={cloneRef} className="deal-card pl-card op-card drag-clone" style={{ position: "fixed", left: posRef.current.x - drag.offX, top: posRef.current.y - drag.offY, width: drag.w, pointerEvents: "none", zIndex: 1000 }}>
          <OppCardBody opp={dragOpp} />
        </div>
      )}

      {showSettings && (
        <PipelineSettingsModal
          pipelines={pipelines}
          initialId={pipeline.id}
          stageCount={stageCount}
          onClose={() => { onCloseSettings(); load(); }}
          onChanged={() => { onSettingsChanged(); load(); }}
        />
      )}
      {showNew && (
        <NewOpportunityModal pipelines={pipelines} pipelineId={pipeline.id} onClose={() => setShowNew(false)}
          onCreated={(o) => { setShowNew(false); nav(`/opportunities/${o.id}`); }} />
      )}
      {pending && (
        <OpportunityStageModal
          opp={pending.opp}
          pipeline={pipeline}
          initialStage={pending.toStage}
          directTerminal
          onClose={() => setPending(null)}
          onChanged={(o) => { setPending(null); load(); afterMove(pending.opp, o); }}
        />
      )}
      {moving && (
        <OpportunityStageModal
          opp={moving}
          pipeline={pipeline}
          onClose={() => setMoving(null)}
          onChanged={(o) => { setMoving(null); load(); afterMove(moving, o); }}
        />
      )}
      {converting && (
        <ConvertOpportunityModal
          opp={converting}
          pipeline={pipeline}
          pipelines={pipelines}
          onClose={() => setConverting(null)}
          onConverted={() => { setConverting(null); load(); }}
        />
      )}
    </div>
  );
}

function OppCard({ opp, canMove, dragging, onPointerDown, onOpen, onMove, onConvert }: {
  opp: OppSummary; canMove: boolean; dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void; onOpen: () => void; onMove: () => void; onConvert: () => void;
}) {
  const converted = !!opp.convertedDealId;
  const draggable = canMove && !converted;
  const items = [
    { label: "Open", onClick: onOpen },
    ...(canMove && !converted ? [{ label: "Convert to deal…", onClick: onConvert }, { label: "Move stage…", onClick: onMove }] : []),
  ];
  return (
    <div
      className={`deal-card pl-card op-card ${converted ? "converted" : ""} ${dragging ? "drag-source" : ""} ${draggable ? "draggable" : ""}`}
      // Draggable cards open on a press without drag (see startDrag); the rest
      // (viewers, converted) open on an ordinary click.
      onPointerDown={draggable ? onPointerDown : undefined}
      onClick={draggable ? undefined : (e) => { if (!(e.target as HTMLElement).closest(".ovf")) onOpen(); }}
    >
      <OppCardBody opp={opp} action={
        <span className="op-card-menu" onPointerDown={(e) => e.stopPropagation()}>
          <OverflowMenu items={items} ariaLabel={`Actions for ${opp.name}`} />
        </span>
      } />
    </div>
  );
}

/** Card content shared by the board card and the drag clone. */
function OppCardBody({ opp, action }: { opp: OppSummary; action?: ReactNode }) {
  const seller = oppSellerLine(opp);
  const days = oppDaysInStage(opp);
  const due = followUpStatus(opp);
  return (
    <>
      <div className="pl-card-top">
        <span className="pl-card-name" title={opp.name}>{opp.name}</span>
        {opp.convertedDealId && <span className="op-tag converted" title={opp.convertedAt ? `Converted ${fmtDate(opp.convertedAt)}` : "Converted to a deal"}>Converted</span>}
        {action}
      </div>
      {seller && <div className="op-card-seller"><PersonIcon /><span title={seller}>{seller}</span></div>}
      <div className="pl-card-sub">
        <span className="pl-card-loc"><PinIcon /><span className="op-card-place">{[opp.county, opp.state].filter(Boolean).join(", ") || "—"}</span></span>
        <span className="pl-card-days"><ClockIcon />{days === 0 ? "Moved today" : `${days}d in stage`}</span>
      </div>
      <div className="op-card-foot">
        <span className="op-card-nma" title="Estimated net mineral acres">{opp.estNma != null ? `${num(opp.estNma)} NMA` : <span className="dim">NMA —</span>}</span>
        {due && <span className={`pl-due ${due.tone}`}>{due.text}</span>}
        {opp.owner && <span className="op-card-owner"><Avatar user={opp.owner} size={20} title={`Owner: ${opp.owner.name}`} /></span>}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ stage dialog */

/**
 * Move an opportunity between its pipeline's stages. Terminal stages (Passed /
 * Lost) confirm first and take an optional reason, like Dead does for deals;
 * `directTerminal` opens straight on that confirmation (drag onto a zone).
 */
export function OpportunityStageModal({ opp, pipeline, initialStage, directTerminal, onClose, onChanged }: {
  opp: OppSummary; pipeline: PipelineInfo; initialStage?: Stage; directTerminal?: boolean;
  onClose: () => void; onChanged: (o: Opp) => void;
}) {
  const stages: PipelineStage[] = pipeline.stages;
  const [toStage, setToStage] = useState<Stage>(initialStage ?? opp.stage);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labelOf = (key: string) => stages.find((s) => s.key === key)?.label ?? key;
  const terminal = stages.some((s) => s.key === toStage && s.isTerminal);
  const [confirming, setConfirming] = useState(Boolean(directTerminal && terminal));
  const converted = !!opp.convertedDealId;
  // Automatic conversion fires when this move lands on the configured stage.
  const autoConverts = pipeline.convertMode === "AUTO" && !!pipeline.convertStageKey && toStage === pipeline.convertStageKey && toStage !== opp.stage;

  async function commit() {
    setBusy(true); setError(null);
    try {
      const updated = await api.post<Opp>(`/opportunities/${opp.id}/stage`, { toStage, reason: terminal && reason.trim() ? reason.trim() : undefined });
      onChanged(updated);
    } catch (err) {
      setConfirming(false);
      setError(err instanceof ApiError ? err.message : "Failed to change stage");
    } finally { setBusy(false); }
  }

  const reasonField = (
    <div className="field">
      <label>Reason (optional)</label>
      <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this opportunity is being closed out…" />
    </div>
  );

  if (confirming) {
    const cancel = directTerminal ? onClose : () => setConfirming(false);
    return (
      <Modal
        title={`Mark as ${labelOf(toStage)}?`}
        subtitle={<span className="scm-icon dead" aria-hidden="true"><CloseIcon size={16} sw={2.2} /></span>}
        onClose={cancel}
        footer={<>
          <button onClick={cancel} disabled={busy}>Cancel</button>
          <button className="danger" onClick={() => void commit()} disabled={busy}>{busy ? "Moving…" : `Mark as ${labelOf(toStage)}`}</button>
        </>}
      >
        <div className="scm scm-confirm">
          <p className="scm-lead">
            Move <strong>{opp.name}</strong> to <strong>{labelOf(toStage)}</strong>? It leaves the active board; no deal is created or changed.
          </p>
          {reasonField}
          <p className="scm-note">Nothing is deleted. The opportunity, its notes and its stage history stay available from the pipeline.</p>
          {error && <div className="error-text">{error}</div>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Move stage"
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || converted || toStage === opp.stage}
          onClick={() => { if (terminal) setConfirming(true); else void commit(); }}>
          {busy ? "Saving…" : `Move to ${labelOf(toStage)}${terminal ? "…" : ""}`}
        </button>
      </>}
    >
      <div className="scm scm-picker">
        <p className="scm-current">Currently in <strong>{labelOf(opp.stage)}</strong>.</p>
        {converted ? (
          <div className="banner banner-info">This opportunity was converted to a deal, so its stage no longer changes. Work continues on the deal.</div>
        ) : (
          <>
            <div className="field">
              <label>Destination stage</label>
              <Select value={toStage} onChange={(v) => setToStage(v as Stage)} ariaLabel="Destination stage"
                options={stages.map((s) => ({ value: s.key, label: s.label }))} />
            </div>
            {terminal && reasonField}
            {autoConverts && (
              <div className="banner banner-info">
                <strong>{labelOf(toStage)}</strong> converts opportunities automatically: a deal will be created from this one when it lands there.
              </div>
            )}
          </>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- convert dialog */

export interface ConvertResult { opportunity: Opp; deal: { id: string; name: string; stage: Stage; pipelineId?: string | null } }

/**
 * "Convert to deal": shows what will be created from the opportunity's data,
 * lets the user pick the target Deal pipeline when more than one exists, then
 * calls POST /opportunities/:id/convert and offers "Open deal".
 */
export function ConvertOpportunityModal({ opp, pipeline, pipelines, onClose, onConverted }: {
  opp: OppSummary & Partial<Pick<Opp, "contact">>; pipeline: PipelineInfo; pipelines: PipelineInfo[];
  onClose: () => void; onConverted: (r: ConvertResult) => void;
}) {
  const dealPipelines = pipelines.filter((p) => !isOpportunityPipeline(p));
  const orgDefault = dealPipelines.find((p) => p.isDefault) ?? dealPipelines[0];
  const preset = dealPipelines.find((p) => p.id === pipeline.convertToPipelineId) ?? orgDefault;
  const [targetId, setTargetId] = useState(preset?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = dealPipelines.find((p) => p.id === targetId) ?? preset;
  const firstStage = target?.stages.find((s) => !s.isTerminal)?.label ?? "its first stage";
  const seller = opp.contact
    ? [opp.contact.firstName, opp.contact.lastName].filter(Boolean).join(" ") + (opp.contact.entityName ? ` · ${opp.contact.entityName}` : "")
    : oppSellerLine(opp);
  const property = [
    [opp.county, opp.state].filter(Boolean).join(", "),
    opp.abstract ? `Abstract ${opp.abstract}` : null,
    opp.survey ? `${opp.survey} Survey` : null,
  ].filter(Boolean).join(" · ");
  const acreage = [
    opp.estNma != null ? `${num(opp.estNma)} NMA` : opp.estAcres != null ? `${num(opp.estAcres)} acres` : null,
    opp.estNra != null ? `${num(opp.estNra)} NRA` : null,
  ].filter(Boolean).join(" · ");

  async function convert() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<ConvertResult>(`/opportunities/${opp.id}/convert`, targetId ? { pipelineId: targetId } : {});
      showToast(<span><strong>{r.deal.name}</strong> created from the opportunity. <Link to={`/deals/${r.deal.id}`} className="link-btn">Open deal</Link></span>, "success", 10000);
      onConverted(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not convert the opportunity");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Convert to deal"
      subtitle={<>Creates a deal from this opportunity — nothing to re-type</>}
      onClose={onClose}
      footer={<>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" onClick={() => void convert()} disabled={busy || !target}>{busy ? "Converting…" : "Convert to deal"}</button>
      </>}
    >
      <div className="scm op-convert">
        {!target && <div className="banner banner-warn">There is no Deals pipeline to create the deal in. Create one in Pipeline settings first.</div>}
        {dealPipelines.length > 1 && (
          <div className="field">
            <label>Create the deal in</label>
            <Select value={targetId} onChange={setTargetId} ariaLabel="Target deal pipeline"
              options={dealPipelines.map((p) => ({ value: p.id, label: p.name, hint: p.isDefault ? "Default" : undefined }))} />
          </div>
        )}
        <ul className="op-convert-list">
          <li><span>Deal</span><b>{opp.name}</b></li>
          <li><span>Pipeline · stage</span><b>{target?.name ?? "Default pipeline"} · {firstStage}</b></li>
          <li><span>Seller</span><b>{seller ?? <i>None yet — add sellers on the deal</i>}</b></li>
          <li><span>Property</span><b>{property || <i>Not set</i>}</b></li>
          <li><span>Acreage</span><b>{acreage || <i>Not set</i>}</b></li>
          <li><span>Owner</span><b>{opp.owner?.name ?? <i>Unassigned</i>}</b></li>
        </ul>
        <p className="scm-note">
          Notes, source and any abstract or survey that can't be matched carry over to the deal's notes. The opportunity stays here,
          marked <strong>Converted</strong>, with its history.
        </p>
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}
