import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { Banner, PriorityBadge, StageBadge, Spinner, SearchInput } from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
import { NewDealModal } from "../components/NewDealModal";
import { useRowSelection, BulkActionsBar } from "../components/bulk";
import { money, num, fmtDate } from "../lib/format";
import { userAvatarColor } from "../lib/avatarColor";
import { dealSearchHaystack } from "../lib/dealSearch";
import { downloadCsv } from "../lib/csv";
import { Tabs } from "../components/Tabs";
import { useAuth } from "../auth/AuthContext";
import type { DealSummary, UserLite } from "../types";

type Scope = "all" | "active" | "closed" | "archived";

const SCOPE_TITLE: Record<Scope, string> = { all: "Deals", active: "Active Deals", closed: "Closed Deals", archived: "Archived Deals" };

/** Compact money for the header stat line — "$93.7K", "$1.2M". */
function moneyCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1_000) return `$${(v / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${Math.round(v)}`;
}

const initialsOf = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const shortName = (name: string): string => {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : name;
};

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
  const [q, setQ] = useState("");
  // ?new=1 (Dashboard "Create your first deal") opens the modal on arrival.
  const [params, setParams] = useSearchParams();
  const [showNew, setShowNew] = useState(params.get("new") === "1");
  const [users, setUsers] = useState<UserLite[]>([]);
  const sel = useRowSelection();
  const nav = useNavigate();
  const closeNew = () => { setShowNew(false); if (params.get("new")) setParams({}, { replace: true }); };

  function load() { api.get<DealSummary[]>("/deals").then(setDeals); }
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);

  const scoped = useMemo(() => (deals ?? []).filter((d) => inScope(d, scope)), [deals, scope]);
  const overdue = useMemo(() => scoped.filter((d) => d.isOverdue), [scoped]);

  const filtered = useMemo(() => {
    let rows = scoped;
    const needle = q.trim().toLowerCase();
    if (needle) rows = rows.filter((d) => dealSearchHaystack(d).includes(needle));
    return rows;
  }, [scoped, q]);

  if (!deals) return <Spinner />;

  const columns: Column<DealSummary>[] = [
    // The identifying column gets a width floor so names never wrap into a
    // 4-line sliver while less important columns spread out.
    { key: "name", header: "Deal", type: "text", value: (d) => d.name, minWidth: 220, required: true,
      render: (d) => (
        <span className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <strong>{d.name}</strong>
          {d.recordType === "OWNED_ASSET" && <span className="badge resp-interested" title="This is an owned mineral asset marked for sale — not an acquisition opportunity.">Asset · For sale</span>}
          {d.assetCount ? <span className="badge resp-pending" title={`${d.assetCount} asset${d.assetCount > 1 ? "s" : ""} in this seller package`}>{d.assetCount} asset{d.assetCount > 1 ? "s" : ""}</span> : null}
        </span>
      ) },
    { key: "priority", header: "Priority", type: "text",
      value: (d) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[d.priority]),
      render: (d) => <PriorityBadge priority={d.priority} /> },
    { key: "stage", header: "Stage", type: "text", value: (d) => d.stage, render: (d) => <StageBadge stage={d.stage} pipelineId={d.pipelineId} /> },
    { key: "nma", header: "NMA", type: "number", align: "right", value: (d) => d.aggAcreageNma ?? d.acreageNma, render: (d) => num(d.aggAcreageNma ?? d.acreageNma) },
    { key: "profit", header: "Profit Est.", type: "number", align: "right", value: (d) => d.profitEst, render: (d) => money(d.profitEst) },
    // Secondary date columns start hidden (Customize View re-enables them):
    // the default view keeps the columns that drive weekly decisions.
    { key: "uc", header: "Under Contract", type: "date", value: (d) => d.dateUnderContract, render: (d) => fmtDate(d.dateUnderContract), defaultHidden: true },
    { key: "fbb", header: "Find Buyer By", type: "date", value: (d) => d.findBuyerByDate,
      render: (d) => <span style={d.isOverdue ? { color: "var(--red)" } : undefined}>{fmtDate(d.findBuyerByDate)}</span> },
    { key: "oc", header: "Orig. Closing", type: "date", value: (d) => d.originalClosingDate, render: (d) => fmtDate(d.originalClosingDate), defaultHidden: true },
    { key: "fc", header: "Final Closing", type: "date", value: (d) => d.finalClosingDate, render: (d) => fmtDate(d.finalClosingDate) },
    { key: "buyer", header: "Current Buyer", type: "text", value: (d) => d.selectedBuyer?.name ?? null,
      render: (d) => <span className="ct-dim">{d.selectedBuyer?.name ?? "—"}</span> },
    { key: "owner", header: "Owner", type: "text", value: (d) => d.relationshipOwner?.name ?? null,
      render: (d) => d.relationshipOwner ? (
        <span className="ct-owner">
          <span className="ct-owner-av" style={{ background: userAvatarColor(d.relationshipOwner), color: "#fff" }}>{initialsOf(d.relationshipOwner.name)}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortName(d.relationshipOwner.name)}</span>
        </span>
      ) : "—" },
  ];

  // Live header stat line: what's in play and what it's projected to make.
  const projected = scoped.reduce((s, d) => s + (d.profitEst ?? 0), 0);
  const sub =
    scope === "active" ? `${scoped.length} deal${scoped.length === 1 ? "" : "s"} in play${projected ? ` · ${moneyCompact(projected)} projected profit` : ""}`
    : scope === "closed" ? `${scoped.length} closed deal${scoped.length === 1 ? "" : "s"}${projected ? ` · ${moneyCompact(projected)} profit` : ""}`
    : scope === "archived" ? `${scoped.length} archived deal${scoped.length === 1 ? "" : "s"}`
    : `${scoped.length} deal${scoped.length === 1 ? "" : "s"} across every stage`;

  const countFor = (s: Scope) => (deals ?? []).filter((d) => inScope(d, s)).length;
  const tabLabel = (label: string, n: number) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>{label}<span className="tab-badge">{n}</span></span>
  );

  return (
    <div className="page contacts-page">
      <div className="page-header">
        <div>
          <h1>{SCOPE_TITLE[scope]}</h1>
          <div className="page-sub">{sub}</div>
        </div>
        {can("createDeals") && (
          <button className="pbtn pbtn-primary" onClick={() => setShowNew(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            New Deal
          </button>
        )}
      </div>

      {/* Scope tabs — the sidebar shows a single "Deals" entry; Active/Closed/
          Archived (and future sections) live here as top tab navigation. */}
      <Tabs
        style={{ marginBottom: 16 }}
        tabs={[
          { key: "all" as const, label: tabLabel("All", countFor("all")), to: "/deals" },
          { key: "active" as const, label: tabLabel("Active", countFor("active")), to: "/deals/active" },
          { key: "closed" as const, label: tabLabel("Closed", countFor("closed")), to: "/deals/closed" },
          { key: "archived" as const, label: tabLabel("Archived", countFor("archived")), to: "/deals/archived" },
        ]}
        active={scope}
      />

      {overdue.length > 0 && (
        <Banner kind="warn">
          <strong>{overdue.length} overdue</strong> — past Find Buyer By with no buyer assigned.
        </Banner>
      )}

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

      <div className="ct-card" style={{ marginTop: 0 }}>
        <SortableTable
          customizeId={`deals-list:${scope}`}
          toolbar={
            <>
              <SearchInput value={q} onChange={setQ} placeholder="Search deal, seller, abstract, survey, county, buyer…" ariaLabel="Search deals" />
              {q && <span className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>Showing {filtered.length} of {scoped.length}</span>}
            </>
          }
          columns={columns}
          rows={filtered}
          rowKey={(d) => d.id}
          onRowClick={(d) => nav(`/deals/${d.id}`)}
          rowHref={(d) => `/deals/${d.id}`}
          rowClassName={(d) => (d.isOverdue ? "row-overdue" : undefined)}
          defaultSort={{ key: "priority", dir: "asc" }}
          empty={scoped.length === 0
            ? (scope === "active" || scope === "all"
              ? (can("createDeals") ? "No deals yet — click “+ New Deal” to create your first one." : "No deals yet.")
              : `No ${scope} deals yet.`)
            : "No deals match your search."}
          selection={{ selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll }}
          rowsPerPage={[20, 50, 100, 200]}
          paginationNoun="deal"
        />
      </div>

      {showNew && (
        <NewDealModal onClose={closeNew} onCreated={(d) => { closeNew(); nav(`/deals/${d.id}`); }} />
      )}
    </div>
  );
}
