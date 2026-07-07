import { useEffect, useState } from "react";
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

export function Pipeline() {
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<Stage | null>(null);
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

  // The pipeline is the acquisition board — opportunities only. Owned mineral
  // assets are managed in their own module and never appear here.
  function load() { api.get<DealSummary[]>("/deals?recordType=OPPORTUNITY").then(setDeals); }
  useEffect(load, []);

  if (!deals) return <Spinner />;

  const boardDeals = deals;

  function onDrop(col: Stage) {
    setDropCol(null);
    const deal = deals!.find((d) => d.id === dragId);
    setDragId(null);
    if (!deal || deal.stage === col) return;
    setPending({ deal, toStage: col }); // same confirmation as the explicit button
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="row">
          <h1 style={{ marginBottom: 0 }}>Pipeline</h1>
        </div>
        {canCreate && <button className="primary" onClick={() => setShowNew(true)}>+ New Deal</button>}
      </div>

      {/* Transition targets live ABOVE the board so they're always on-screen
          (the board scrolls horizontally). Dropping a card here — or using a
          card's ⋯ button — prompts the Closed/Archive confirmation. */}
      {canMove && <div className="transition-bar">
        {TRANSITIONS.map((t) => (
          <div
            key={t.stage}
            className={`transition-zone ${t.stage === "DEAD" ? "dead" : "closed"} ${dropCol === t.stage ? "drop-target" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDropCol(t.stage); }}
            onDragLeave={() => setDropCol((c) => (c === t.stage ? null : c))}
            onDrop={() => onDrop(t.stage)}
          >
            <span>{t.label}</span>
            <span className="muted" style={{ fontSize: 11 }}>{t.hint}</span>
          </div>
        ))}
      </div>}

      <div className="kanban">
        {COLUMNS.map((col) => {
          const colDeals = boardDeals.filter((d) => d.stage === col);
          return (
            <div
              key={col}
              className={`kanban-col ${dropCol === col ? "drop-target" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDropCol(col); }}
              onDragLeave={() => setDropCol((c) => (c === col ? null : c))}
              onDrop={() => onDrop(col)}
            >
              <div className="kanban-col-head">
                <span>{prettyStage(col)}</span>
                <span className="muted">{colDeals.length}</span>
              </div>
              <div className="kanban-col-body">
                {colDeals.map((d) => (
                  <Card key={d.id} deal={d} canMove={canMove} onDragStart={() => setDragId(d.id)} onClick={() => nav(`/deals/${d.id}`)} onMove={() => setMoving(d)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

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

function Card({ deal, canMove, onDragStart, onClick, onMove }: { deal: DealSummary; canMove: boolean; onDragStart: () => void; onClick: () => void; onMove: () => void }) {
  const isClosing = deal.stage === "CLOSING";
  const isDead = deal.stage === "DEAD";
  return (
    <div
      className={`deal-card prio-${deal.priority.toLowerCase()} ${isDead ? "dead" : ""}`}
      draggable={canMove}
      onDragStart={canMove ? onDragStart : undefined}
      onClick={onClick}
    >
      {canMove && <button
        className="dc-move"
        title="Move to another stage"
        aria-label={`Move ${deal.name} to another stage`}
        onClick={(e) => { e.stopPropagation(); onMove(); }}
      >⋯</button>}
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
    </div>
  );
}
