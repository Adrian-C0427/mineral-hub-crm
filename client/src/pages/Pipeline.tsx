import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Spinner } from "../components/ui";
import { NewDealModal } from "../components/NewDealModal";
import { StageChangeModal } from "../components/StageChangeModal";
import { money, num, fmtDate, prettyStage } from "../lib/format";
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

type RecordFilter = "ALL" | "OPPORTUNITY" | "OWNED_ASSET";

export function Pipeline() {
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<Stage | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [pending, setPending] = useState<{ deal: DealSummary; toStage: Stage } | null>(null);
  const [filter, setFilter] = useState<RecordFilter>("ALL");
  const nav = useNavigate();

  // Load opportunities AND owned assets; the board shows opportunities plus
  // owned assets that are actively being marketed (assetMode === "SELL").
  function load() { api.get<DealSummary[]>("/deals?recordType=ALL").then(setDeals); }
  useEffect(load, []);

  if (!deals) return <Spinner />;

  const boardDeals = deals.filter((d) => {
    const onBoard = d.recordType === "OPPORTUNITY" || (d.recordType === "OWNED_ASSET" && d.assetMode === "SELL");
    if (!onBoard) return false;
    if (filter === "OPPORTUNITY") return d.recordType === "OPPORTUNITY";
    if (filter === "OWNED_ASSET") return d.recordType === "OWNED_ASSET";
    return true;
  });
  const counts = {
    all: deals.filter((d) => d.recordType === "OPPORTUNITY" || (d.recordType === "OWNED_ASSET" && d.assetMode === "SELL")).length,
    opp: deals.filter((d) => d.recordType === "OPPORTUNITY").length,
    owned: deals.filter((d) => d.recordType === "OWNED_ASSET" && d.assetMode === "SELL").length,
  };

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
          <div className="pill-filter">
            <button className={filter === "ALL" ? "active" : ""} onClick={() => setFilter("ALL")}>Both ({counts.all})</button>
            <button className={filter === "OPPORTUNITY" ? "active" : ""} onClick={() => setFilter("OPPORTUNITY")}>Opportunities ({counts.opp})</button>
            <button className={filter === "OWNED_ASSET" ? "active" : ""} onClick={() => setFilter("OWNED_ASSET")}>Owned Assets ({counts.owned})</button>
          </div>
        </div>
        <button className="primary" onClick={() => setShowNew(true)}>+ New Deal</button>
      </div>

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
                  <Card key={d.id} deal={d} onDragStart={() => setDragId(d.id)} onClick={() => nav(d.recordType === "OWNED_ASSET" ? `/assets/${d.id}` : `/deals/${d.id}`)} />
                ))}
              </div>
            </div>
          );
        })}

        {/* Transition targets: dropping here prompts the Closed/Archive confirmation. */}
        <div className="kanban-col kanban-transitions">
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
        </div>
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
  const isOwned = deal.recordType === "OWNED_ASSET";
  return (
    <div
      className={`deal-card prio-${deal.priority.toLowerCase()} ${isDead ? "dead" : ""} ${isOwned ? "owned-asset" : ""}`}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
    >
      <div className="dc-name">{deal.name}</div>
      <div className="dc-meta">
        <span>{[deal.counties.join(", "), deal.state].filter(Boolean).join(", ") || "—"}</span>
        <span>{num(deal.nra)} NRA</span>
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
