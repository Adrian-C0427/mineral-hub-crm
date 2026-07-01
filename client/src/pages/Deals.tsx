import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Banner, PriorityBadge, StageBadge, Spinner } from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
import { NewDealModal } from "../components/NewDealModal";
import { money, num, fmtDate } from "../lib/format";
import { useAuth } from "../auth/AuthContext";
import type { DealSummary } from "../types";

type Filter = "ALL" | "HIGH" | "NO_BUYER";

export function Deals() {
  const { can } = useAuth();
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [showNew, setShowNew] = useState(false);
  const nav = useNavigate();

  function load() { api.get<DealSummary[]>("/deals").then(setDeals); }
  useEffect(load, []);

  const overdue = useMemo(() => (deals ?? []).filter((d) => d.isOverdue), [deals]);

  const filtered = useMemo(() => {
    if (!deals) return [];
    if (filter === "HIGH") return deals.filter((d) => d.priority === "HIGH");
    if (filter === "NO_BUYER") return deals.filter((d) => !d.selectedBuyer);
    return deals;
  }, [deals, filter]);

  if (!deals) return <Spinner />;

  const columns: Column<DealSummary>[] = [
    { key: "name", header: "Deal", type: "text", value: (d) => d.name,
      render: (d) => <strong>{d.name}</strong> },
    { key: "priority", header: "Priority", type: "text",
      value: (d) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[d.priority]),
      render: (d) => <PriorityBadge priority={d.priority} /> },
    { key: "stage", header: "Stage", type: "text", value: (d) => d.stage, render: (d) => <StageBadge stage={d.stage} /> },
    { key: "nma", header: "NMA", type: "number", align: "right", value: (d) => d.acreageNma, render: (d) => num(d.acreageNma) },
    { key: "profit", header: "Profit Est.", type: "number", align: "right", value: (d) => d.profitEst, render: (d) => money(d.profitEst) },
    { key: "uc", header: "Under Contract", type: "date", value: (d) => d.dateUnderContract, render: (d) => fmtDate(d.dateUnderContract) },
    { key: "fbb", header: "Find Buyer By", type: "date", value: (d) => d.findBuyerByDate,
      render: (d) => <span style={d.isOverdue ? { color: "var(--red)" } : undefined}>{fmtDate(d.findBuyerByDate)}</span> },
    { key: "oc", header: "Orig. Closing", type: "date", value: (d) => d.originalClosingDate, render: (d) => fmtDate(d.originalClosingDate) },
    { key: "fc", header: "Final Closing", type: "date", value: (d) => d.finalClosingDate, render: (d) => fmtDate(d.finalClosingDate) },
    { key: "buyer", header: "Current Buyer", type: "text", value: (d) => d.selectedBuyer?.name ?? null, render: (d) => d.selectedBuyer?.name ?? "—" },
    { key: "owner", header: "Owner", type: "text", value: (d) => d.relationshipOwner?.name ?? null, render: (d) => d.relationshipOwner?.name ?? "—" },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Deals</h1>
        {can("createDeals") && <button className="primary" onClick={() => setShowNew(true)}>+ New Deal</button>}
      </div>

      {overdue.length > 0 && (
        <Banner kind="warn">
          <strong>{overdue.length} overdue</strong> — past Find Buyer By with no buyer assigned.
        </Banner>
      )}

      <div className="chip-row" style={{ marginBottom: 16 }}>
        {([["ALL", "All"], ["HIGH", "High Priority"], ["NO_BUYER", "No Buyer Assigned"]] as [Filter, string][]).map(([f, label]) => (
          <span key={f} className={`chip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>{label}</span>
        ))}
      </div>

      <SortableTable
        columns={columns}
        rows={filtered}
        rowKey={(d) => d.id}
        onRowClick={(d) => nav(`/deals/${d.id}`)}
        rowClassName={(d) => (d.isOverdue ? "row-overdue" : undefined)}
        defaultSort={{ key: "priority", dir: "asc" }}
        empty="No deals match this filter."
      />

      {showNew && (
        <NewDealModal onClose={() => setShowNew(false)} onCreated={(d) => { setShowNew(false); nav(`/deals/${d.id}`); }} />
      )}
    </div>
  );
}
