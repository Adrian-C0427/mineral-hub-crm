import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Spinner } from "../components/ui";
import { NewDealModal } from "../components/NewDealModal";
import { StageChangeModal } from "../components/StageChangeModal";
import { money, num, fmtDate, prettyStage } from "../lib/format";
import { useAuth } from "../auth/AuthContext";
import type { DealSummary, Stage } from "../types";

// The Pipeline shows only ACTIVE-lifecycle stages as columns. Closed and Dead
// remain valid workflow stages but act as transition points, not columns: the
// TRANSITIONS targets below accept drops (and Move Stage offers them), always
// behind a confirmation, after which the deal leaves the board for the Closed
// Deals / Archived Deals subpage.
const COLUMNS: Stage[] = [
  "UNDER_CONTRACT", "PREPARING_PACKAGE", "SENT_TO_BUYERS",
  "NEGOTIATING", "CLOSING",
];
const TRANSITIONS: { stage: Stage; label: string; hint: string }[] = [
  { stage: "CLOSED", label: "Closed", hint: "→ Closed Deals" },
  { stage: "DEAD", label: "Dead", hint: "→ Archived Deals" },
];

// Distance (px) the pointer must travel before a press becomes a drag — below it
// the gesture is treated as a click (navigate to the deal).
const DRAG_THRESHOLD = 5;

interface DragState { id: string; w: number; offX: number; offY: number; x: number; y: number; moved: boolean }

export function Pipeline() {
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [overCol, setOverCol] = useState<Stage | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [pending, setPending] = useState<{ deal: DealSummary; toStage: Stage } | null>(null);
  // Explicit per-card move (no drag needed): opens the stage modal on the
  // deal's current stage so any destination — including Closed/Dead — is a click away.
  const [moving, setMoving] = useState<DealSummary | null>(null);
  const nav = useNavigate();
  const { can } = useAuth();
  // Viewers can browse the board but not create deals or change stages —
  // hiding the affordances beats letting them click into a 403.
  const canCreate = can("createDeals");
  const canMove = can("editDeals");

  // Latest state for the window pointer handlers (which are bound once per drag).
  const dragRef = useRef<DragState | null>(null);
  const overRef = useRef<Stage | null>(null);
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
    setDrag({ id: deal.id, w: card.width, offX: e.clientX - card.left, offY: e.clientY - card.top, x: e.clientX, y: e.clientY, moved: false });

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const moved = d.moved || Math.hypot(ev.clientX - (d.x - 0), ev.clientY - (d.y - 0)) > DRAG_THRESHOLD || Math.abs(ev.clientX - card.left - d.offX) > DRAG_THRESHOLD;
      // Detect the column/transition under the pointer via a data-stage attribute.
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const zone = el?.closest("[data-stage]") as HTMLElement | null;
      const stage = (zone?.getAttribute("data-stage") as Stage | null) ?? null;
      overRef.current = stage;
      setOverCol(stage);
      setDrag((prev) => (prev ? { ...prev, x: ev.clientX, y: ev.clientY, moved: prev.moved || moved } : prev));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
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
    // through the modal). Normal stage moves are immediate + optimistic.
    if (col === "CLOSED" || col === "DEAD") { setPending({ deal, toStage: col }); return; }
    setDeals((prev) => prev?.map((d) => (d.id === deal.id ? { ...d, stage: col } : d)) ?? prev);
    try { await api.post(`/deals/${deal.id}/stage`, { toStage: col }); load(); }
    catch { load(); }
  }

  if (!deals) return <Spinner />;
  const dragDeal = drag ? deals.find((d) => d.id === drag.id) ?? null : null;

  return (
    <div className="page">
      <div className="page-header">
        <div className="row">
          <h1 style={{ marginBottom: 0 }}>Pipeline</h1>
        </div>
        {canCreate && <button className="primary" onClick={() => setShowNew(true)}>+ New Deal</button>}
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

      <div className={`kanban ${drag ? "dragging" : ""}`}>
        {COLUMNS.map((col) => {
          const colDeals = deals.filter((d) => d.stage === col);
          return (
            <div
              key={col} data-stage={col}
              className={`kanban-col ${drag && overCol === col ? "drop-target" : ""}`}
            >
              <div className="kanban-col-head">
                <span>{prettyStage(col)}</span>
                <span className="muted">{colDeals.length}</span>
              </div>
              <div className="kanban-col-body">
                {colDeals.map((d) => (
                  <Card key={d.id} deal={d} canMove={canMove} dragging={drag?.id === d.id && drag.moved}
                    onPointerDown={(e) => startDrag(e, d)} onMove={() => setMoving(d)} />
                ))}
                {colDeals.length === 0 && <div className="kanban-empty">Drop here</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Floating clone follows the cursor for a natural, lag-free drag. */}
      {drag && drag.moved && dragDeal && (
        <div className="deal-card drag-clone" style={{ position: "fixed", left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.w, pointerEvents: "none", zIndex: 1000 }}>
          <CardBody deal={dragDeal} />
        </div>
      )}

      {showNew && <NewDealModal onClose={() => setShowNew(false)} onCreated={(d) => { setShowNew(false); nav(`/deals/${d.id}`); }} />}
      {pending && (
        <StageChangeModal
          deal={pending.deal}
          initialStage={pending.toStage}
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

function Card({ deal, canMove, dragging, onPointerDown, onMove }: {
  deal: DealSummary; canMove: boolean; dragging: boolean;
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
      <CardBody deal={deal} />
    </div>
  );
}

/** Card content shared by the board card and the drag clone. */
function CardBody({ deal }: { deal: DealSummary }) {
  const isClosing = deal.stage === "CLOSING";
  const isDead = deal.stage === "DEAD";
  return (
    <>
      <div className="dc-name">{deal.name}</div>
      <div className="dc-meta">
        <span>{[deal.counties.join(", "), deal.state].filter(Boolean).join(", ") || "—"}</span>
        {deal.nra != null && <span>{num(deal.nra)} NRA</span>}
      </div>
      <div className="dc-meta" style={{ marginTop: 4 }}>
        <span className={`badge priority-${deal.priority.toLowerCase()}`}>{deal.priority[0] + deal.priority.slice(1).toLowerCase()}</span>
        <span>{money(deal.profitEst)}</span>
        <span>{deal.daysInStage}d in stage</span>
      </div>
      {isClosing && deal.selectedBuyer && <div className="dc-buyer">→ {deal.selectedBuyer.name}</div>}
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
    </>
  );
}
