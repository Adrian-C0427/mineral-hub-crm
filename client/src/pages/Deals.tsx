import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Banner, PriorityBadge, StageBadge, Spinner } from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
import { NewDealModal } from "../components/NewDealModal";
import { useRowSelection, BulkActionsBar } from "../components/bulk";
import { money, num, fmtDate } from "../lib/format";
import { downloadCsv } from "../lib/csv";
import { useAuth } from "../auth/AuthContext";
import type { DealSummary, UserLite } from "../types";

type Filter = "ALL" | "HIGH" | "NO_BUYER";
type Scope = "all" | "active" | "closed" | "archived";

const SCOPE_TITLE: Record<Scope, string> = { all: "Deals", active: "Active Deals", closed: "Closed Deals", archived: "Archived Deals" };

/** Active = still in play; Closed = won; Archived = dead. */
function inScope(d: DealSummary, scope: Scope): boolean {
  if (scope === "active") return d.stage !== "CLOSED" && d.stage !== "DEAD";
  if (scope === "closed") return d.stage === "CLOSED";
  if (scope === "archived") return d.stage === "DEAD";
  return true;
}

export function Deals({ scope = "all" }: { scope?: Scope }) {
  const { can } = useAuth();
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [showNew, setShowNew] = useState(false);
  const [users, setUsers] = useState<UserLite[]>([]);
  const sel = useRowSelection();
  const nav = useNavigate();

  function load() { api.get<DealSummary[]>("/deals").then(setDeals); }
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);

  const scoped = useMemo(() => (deals ?? []).filter((d) => inScope(d, scope)), [deals, scope]);
  const overdue = useMemo(() => scoped.filter((d) => d.isOverdue), [scoped]);

  const filtered = useMemo(() => {
    if (filter === "HIGH") return scoped.filter((d) => d.priority === "HIGH");
    if (filter === "NO_BUYER") return scoped.filter((d) => !d.selectedBuyer);
    return scoped;
  }, [scoped, filter]);

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
        <h1>{SCOPE_TITLE[scope]}</h1>
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
        selection={{ selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll }}
      />

      <BulkActionsBar
        selectedIds={[...sel.selected]}
        onClear={sel.clear}
        onDone={load}
        users={users}
        itemLabel="deal"
        deleteUrl={can("deleteDeals") ? "/deals/bulk-delete" : undefined}
        assign={can("editDeals") ? { url: "/deals/bulk-assign", key: "assigneeIds" } : undefined}
        archiveUrl={can("editDeals") ? "/deals/bulk-archive" : undefined}
        onExport={() => {
          const rows = filtered.filter((d) => sel.selected.has(d.id));
          downloadCsv(`deals-${new Date().toISOString().slice(0, 10)}.csv`,
            ["Deal", "Priority", "Stage", "NMA", "Profit Est.", "Under Contract", "Find Buyer By", "Current Buyer", "Owner"],
            rows.map((d) => [d.name, d.priority, d.stage, d.acreageNma ?? "", d.profitEst ?? "", d.dateUnderContract ?? "", d.findBuyerByDate ?? "", d.selectedBuyer?.name ?? "", d.relationshipOwner?.name ?? ""]));
        }}
      />

      {showNew && (
        <NewDealModal onClose={() => setShowNew(false)} onCreated={(d) => { setShowNew(false); nav(`/deals/${d.id}`); }} />
      )}
    </div>
  );
}
