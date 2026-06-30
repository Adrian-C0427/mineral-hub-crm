import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Spinner } from "../components/ui";
import { NewDealModal } from "../components/NewDealModal";
import { StageChangeModal } from "../components/StageChangeModal";
import { money, num, fmtDate, prettyStage } from "../lib/format";
import type { DealSummary, Stage } from "../types";

const COLUMNS: Stage[] = [
  "UNDER_CONTRACT", "PREPARING_PACKAGE", "SENT_TO_BUYERS",
  "NEGOTIATING", "CLOSING", "CLOSED", "DEAD",
];

export function Pipeline() {
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<Stage | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [pending, setPending] = useState<{ deal: DealSummary; toStage: Stage } | null>(null);
  const nav = useNavigate();

  function load() { api.get<DealSummary[]>("/deals").then(setDeals); }
  useEffect(load, []);

  if (!deals) return <Spinner />;

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
        <h1>Pipeline</h1>
        <button className="primary" onClick={() => setShowNew(true)}>+ New Deal</button>
      </div>

      <div className="kanban">
        {COLUMNS.map((col) => {
          const colDeals = deals.filter((d) => d.stage === col);
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
                  <Card key={d.id} deal={d} onDragStart={() => setDragId(d.id)} onClick={() => nav(`/deals/${d.id}`)} />
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
    </div>
  );
}

function Card({ deal, onDragStart, onClick }: { deal: DealSummary; onDragStart: () => void; onClick: () => void }) {
  const isClosing = deal.stage === "CLOSING";
  const isDead = deal.stage === "DEAD";
  return (
    <div
      className={`deal-card prio-${deal.priority.toLowerCase()} ${isDead ? "dead" : ""}`}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
    >
      <div className="dc-name">{deal.name}</div>
      <div className="dc-meta">
        <span>{[deal.county, deal.state].filter(Boolean).join(", ") || "—"}</span>
        <span>{num(deal.acreageNma)} NMA</span>
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
