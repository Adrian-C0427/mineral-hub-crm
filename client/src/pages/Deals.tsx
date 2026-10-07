import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { Banner, PriorityBadge, StageBadge, Spinner, SearchInput } from "../components/ui";
import { royaltyLabel, royaltyValue } from "../lib/royalty";
import { SortableTable, type Column } from "../components/SortableTable";
import { NewDealModal } from "../components/NewDealModal";
import { useRowSelection, BulkActionsBar } from "../components/bulk";
import { money, num, fmtDate } from "../lib/format";
import { dealSearchHaystack } from "../lib/dealSearch";
import { downloadCsv } from "../lib/csv";
import { Tabs } from "../components/Tabs";
import { useAuth } from "../auth/AuthContext";
import { useStages } from "../stages";
import { useListState } from "../lib/listState";
import { Avatar, Segmented, Tag } from "../components/kit";
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

const shortName = (name: string): string => {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : name;
};

/**
 * Per-acre cost for a row: the deal's stored rate, or — for a multi-deal
 * package (rolled-up totals) or a deal priced only by total — the displayed
 * Our Cost ÷ the displayed acreage, so the columns always reconcile.
 */
function costPerAcre(d: DealSummary, stored: number | null | undefined, acres: number | null | undefined): number | null {
  if (!d.assetCount && stored != null) return stored;
  const cost = d.aggOurPrice ?? d.ourPrice;
  return cost != null && acres ? Math.round((cost / acres) * 100) / 100 : null;
}

const PROFIT_AT_ASK_HINT = "Ask price − Our cost − closing costs: what we'd make selling at our current asking price. Not an offer.";

/** Profit reads green (a loss reads red) wherever it appears in the table. */
const profitCell = (v: number | null) =>
  v == null ? "—" : <span className={v < 0 ? "profit-neg" : "profit-pos"}>{money(v)}</span>;

/** Dates read dimmer than figures; an overdue Find Buyer By reads red. */
const dateCell = (v: string | null | undefined, overdue = false) =>
  <span className={`dl-date${overdue ? " overdue" : ""}`}>{fmtDate(v)}</span>;

/** "1/5 · 20%" shown as the fraction with the percent dimmed beside it. */
function royaltyCell(r: string | null | undefined) {
  const label = royaltyLabel(r);
  if (!label) return "—";
  const [frac, pct] = label.split(" · ");
  return <span className="dl-roy"><span>{frac}</span>{pct && <span className="dl-roy-pct">{pct}</span>}</span>;
}

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
  // Search and stage filter are remembered per tab so Back from a deal
  // restores them (the stage filter per scope, since each scope has its own).
  const [q, setQ] = useListState("deals:q", "");
  // ?new=1 (Dashboard "Create your first deal") opens the modal on arrival.
  const [params, setParams] = useSearchParams();
  const [showNew, setShowNew] = useState(params.get("new") === "1");
  const [users, setUsers] = useState<UserLite[]>([]);
  const sel = useRowSelection();
  const nav = useNavigate();
  const { label: stageLabel, colorOf, stagesOf } = useStages();
  // Stage filter over the rows already loaded ("" = every stage).
  const [stageKey, setStageKey] = useListState(`deals:${scope}:stage`, "");
  const closeNew = () => { setShowNew(false); if (params.get("new")) setParams({}, { replace: true }); };

  function load() { api.get<DealSummary[]>("/deals").then(setDeals); }
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);

  const scoped = useMemo(() => (deals ?? []).filter((d) => inScope(d, scope)), [deals, scope]);
  const overdue = useMemo(() => scoped.filter((d) => d.isOverdue), [scoped]);

  // One segment per stage present in this scope, labelled and coloured by the
  // org's (per-pipeline) stage settings, in board order.
  const stageOptions = useMemo(() => {
    const seen = new Map<string, { count: number; pipelineId?: string | null; pos: number }>();
    for (const d of scoped) {
      const e = seen.get(d.stage);
      if (e) { e.count++; continue; }
      const pos = stagesOf(d.pipelineId).find((s) => s.key === d.stage)?.position ?? Number.MAX_SAFE_INTEGER;
      seen.set(d.stage, { count: 1, pipelineId: d.pipelineId, pos });
    }
    return [...seen.entries()]
      .sort((a, b) => a[1].pos - b[1].pos || stageLabel(a[0]).localeCompare(stageLabel(b[0])))
      .map(([key, e]) => ({ value: key, label: stageLabel(key), count: e.count, dot: colorOf(key, e.pipelineId) }));
  }, [scoped, stagesOf, stageLabel, colorOf]);
  const activeStage = stageOptions.some((o) => o.value === stageKey) ? stageKey : "";

  const filtered = useMemo(() => {
    let rows = scoped;
    if (activeStage) rows = rows.filter((d) => d.stage === activeStage);
    const needle = q.trim().toLowerCase();
    if (needle) rows = rows.filter((d) => dealSearchHaystack(d).includes(needle));
    return rows;
  }, [scoped, q, activeStage]);

  if (!deals) return <Spinner />;

  // Totals row: plain sums of what each column shows, over the listed deals.
  const sumOf = (rows: DealSummary[], pick: (d: DealSummary) => number | null | undefined) => rows.reduce((t, d) => t + (pick(d) ?? 0), 0);
  const acres = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 3 });

  const columns: Column<DealSummary>[] = [
    // The identifying column gets a width floor so names never wrap into a
    // 4-line sliver while less important columns spread out.
    { key: "name", header: "Deal", type: "text", value: (d) => d.name, minWidth: 220, required: true,
      render: (d) => (
        <span className="dl-name">
          <span className="dl-name-txt">{d.name}</span>
          {d.recordType === "OWNED_ASSET" && <Tag tone="accent" title="This is an owned mineral asset marked for sale — not an acquisition opportunity.">Asset · For sale</Tag>}
          {d.assetCount ? <Tag title={`${d.assetCount} asset${d.assetCount > 1 ? "s" : ""} in this seller package`}>{d.assetCount} asset{d.assetCount > 1 ? "s" : ""}</Tag> : null}
        </span>
      ) },
    { key: "priority", header: "Priority", type: "text",
      value: (d) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[d.priority]),
      render: (d) => <span className="dl-priority"><PriorityBadge priority={d.priority} /></span> },
    { key: "stage", header: "Stage", type: "text", value: (d) => d.stage, render: (d) => <span className="dl-stage"><StageBadge stage={d.stage} pipelineId={d.pipelineId} /></span> },
    { key: "nma", header: "NMA", type: "number", align: "right", value: (d) => d.aggAcreageNma ?? d.acreageNma, render: (d) => num(d.aggAcreageNma ?? d.acreageNma),
      total: (rows) => acres(sumOf(rows, (d) => d.aggAcreageNma ?? d.acreageNma)) },
    // Every column is shown by default; users hide what they don't need via
    // Customize View (saved to their profile). `legacyDefaultHidden` marks the
    // columns an older version hid by default, so a browser layout that merely
    // held those old defaults isn't mistaken for a user's choice.
    // Same rollup-then-own-value logic as NMA.
    { key: "nra", header: "NRA", type: "number", align: "right", value: (d) => d.aggNra ?? d.nra, render: (d) => num(d.aggNra ?? d.nra), legacyDefaultHidden: true,
      total: (rows) => acres(sumOf(rows, (d) => d.aggNra ?? d.nra)) },
    // Financial columns. Our Cost uses the package rollup like NMA/NRA; Buyer
    // Purchase Price is the offer Profit Est. is computed from (accepted, else
    // best), so the three reconcile.
    { key: "ourCost", header: "Our cost", type: "number", align: "right", value: (d) => d.aggOurPrice ?? d.ourPrice, render: (d) => money(d.aggOurPrice ?? d.ourPrice), legacyDefaultHidden: true, newlyAdded: true,
      total: (rows) => money(sumOf(rows, (d) => d.aggOurPrice ?? d.ourPrice)) },
    { key: "buyerPrice", header: "Buyer purchase price", type: "number", align: "right", value: (d) => d.buyerPurchasePrice ?? null, render: (d) => money(d.buyerPurchasePrice), legacyDefaultHidden: true, newlyAdded: true,
      total: (rows) => money(sumOf(rows, (d) => d.buyerPurchasePrice)) },
    { key: "ourCostPerNma", header: "Our cost per NMA", type: "number", align: "right",
      value: (d) => costPerAcre(d, d.ourCostPerNma, d.aggAcreageNma ?? d.acreageNma),
      render: (d) => money(costPerAcre(d, d.ourCostPerNma, d.aggAcreageNma ?? d.acreageNma), { cents: true }), newlyAdded: true },
    { key: "ourCostPerNra", header: "Our cost per NRA", type: "number", align: "right",
      value: (d) => costPerAcre(d, d.ourCostPerNra, d.aggNra ?? d.nra),
      render: (d) => money(costPerAcre(d, d.ourCostPerNra, d.aggNra ?? d.nra), { cents: true }), newlyAdded: true },
    // Display-only: every deal field is edited on the Deal page (Deal Characteristics).
    { key: "royaltyRate", header: "Royalty rate", type: "number", align: "right", value: (d) => royaltyValue(d.royaltyRate),
      render: (d) => royaltyCell(d.royaltyRate), legacyDefaultHidden: true, newlyAdded: true },
    { key: "profit", header: "Profit est.", type: "number", align: "right", value: (d) => d.profitEst, render: (d) => profitCell(d.profitEst),
      total: (rows) => { const t = sumOf(rows, (d) => d.profitEst); return <span className={t < 0 ? "dt-totals-neg" : "dt-totals-pos"}>{money(t)}</span>; } },
    // Profit at asking price = ask − Our Cost − closing costs (the deal's own
    // figures, like Profit est.): what we'd make selling at our ask — not an
    // offer. Columns carry no header tooltip, so the hint rides on each cell.
    { key: "profitAtAsk", header: "Profit at asking", type: "number", align: "right", value: (d) => d.profitAtAsk ?? null, newlyAdded: true,
      render: (d) => <span title={PROFIT_AT_ASK_HINT}>{profitCell(d.profitAtAsk ?? null)}</span>,
      total: (rows) => { const t = sumOf(rows, (d) => d.profitAtAsk); return <span className={t < 0 ? "dt-totals-neg" : "dt-totals-pos"}>{money(t)}</span>; } },
    { key: "uc", header: "Under contract", type: "date", value: (d) => d.dateUnderContract, render: (d) => dateCell(d.dateUnderContract), legacyDefaultHidden: true },
    { key: "fbb", header: "Find buyer by", type: "date", value: (d) => d.findBuyerByDate,
      render: (d) => dateCell(d.findBuyerByDate, d.isOverdue) },
    { key: "oc", header: "Orig. closing", type: "date", value: (d) => d.originalClosingDate, render: (d) => dateCell(d.originalClosingDate), legacyDefaultHidden: true },
    { key: "fc", header: "Final closing", type: "date", value: (d) => d.finalClosingDate, render: (d) => dateCell(d.finalClosingDate) },
    { key: "bc", header: "Buyer closing", type: "date", value: (d) => d.buyerClosingDate ?? null, render: (d) => dateCell(d.buyerClosingDate ?? null), legacyDefaultHidden: false, newlyAdded: true },
    { key: "buyer", header: "Current buyer", type: "text", value: (d) => d.selectedBuyer?.name ?? null,
      render: (d) => <span className="ct-dim">{d.selectedBuyer?.name ?? "—"}</span> },
    { key: "owner", header: "Owner", type: "text", value: (d) => d.relationshipOwner?.name ?? null,
      render: (d) => d.relationshipOwner ? (
        <span className="ct-owner">
          <Avatar user={d.relationshipOwner} size={22} />
          <span className="dl-owner-name">{shortName(d.relationshipOwner.name)}</span>
        </span>
      ) : "—" },
  ];

  // Live header stat line: what's in play and what it's projected to make.
  // Plain sums of the Profit Est. and Our Cost columns over this scope.
  const n = scoped.length;
  const projected = scoped.reduce((s, d) => s + (d.profitEst ?? 0), 0);
  const underContract = scoped.reduce((s, d) => s + (d.aggOurPrice ?? d.ourPrice ?? 0), 0);
  const profitStat = (label: string) => projected
    ? <><b className={projected < 0 ? "neg" : "pos"}>{moneyCompact(projected)}</b> {label}</>
    : null;
  const stats: ReactNode[] = (
    scope === "active" ? [<><b>{n}</b> active</>, underContract ? <><b>{moneyCompact(underContract)}</b> under contract</> : null, profitStat("projected profit")]
    : scope === "closed" ? [<><b>{n}</b> closed</>, profitStat("profit")]
    : scope === "archived" ? [<><b>{n}</b> archived</>]
    : [<><b>{n}</b> deal{n === 1 ? "" : "s"} across every stage</>]
  ).filter(Boolean);

  const countFor = (s: Scope) => (deals ?? []).filter((d) => inScope(d, s)).length;
  const tabLabel = (label: string, n: number) => (
    <span className="dl-tab">{label}<span className="tab-badge">{n}</span></span>
  );
  const filtering = !!q || !!activeStage;

  return (
    <div className="page deals-page">
      <div className="page-header">
        <div className="dl-head">
          <h1>{SCOPE_TITLE[scope]}</h1>
          <div className="dl-stats">
            {stats.map((st, i) => <Fragment key={i}>{i > 0 && <span className="dl-stats-dot" aria-hidden="true" />}<span>{st}</span></Fragment>)}
          </div>
        </div>
        {can("createDeals") && (
          <button className="primary dl-new-btn" onClick={() => setShowNew(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            New deal
          </button>
        )}
      </div>

      {/* Scope tabs — the sidebar shows a single "Deals" entry; Active/Closed/
          Archived (and future sections) live here as top tab navigation. */}
      <Tabs
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

      <div className="ct-card dl-card">
        <SortableTable
          customizeId={`deals-list:${scope}`}
          toolbar={
            <>
              <SearchInput value={q} onChange={setQ} placeholder="Search deal, seller, abstract, survey, county, buyer…" ariaLabel="Search deals" />
              {stageOptions.length > 1 && (
                <Segmented
                  ariaLabel="Filter by stage"
                  className="dl-stage-filter"
                  value={activeStage}
                  onChange={setStageKey}
                  options={[{ value: "", label: "All stages", count: n }, ...stageOptions]}
                />
              )}
              {filtering && <span className="dl-showing">Showing {filtered.length} of {n}</span>}
            </>
          }
          /* Selection actions sit inside the card, under the toolbar. */
          subToolbar={
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
                  ["Deal", "Priority", "Stage", "NMA", "NRA", "Our Cost", "Our Cost per NMA", "Our Cost per NRA", "Buyer Purchase Price", "Royalty Rate", "Profit Est.", "Under Contract", "Find Buyer By", "Buyer Closing", "Current Buyer", "Owner", "Profit at Asking"],
                  rows.map((d) => [d.name, d.priority, d.stage, d.acreageNma ?? "", d.nra ?? "", d.aggOurPrice ?? d.ourPrice ?? "",
                    costPerAcre(d, d.ourCostPerNma, d.aggAcreageNma ?? d.acreageNma) ?? "", costPerAcre(d, d.ourCostPerNra, d.aggNra ?? d.nra) ?? "",
                    d.buyerPurchasePrice ?? "", royaltyLabel(d.royaltyRate), d.profitEst ?? "", d.dateUnderContract ?? "", d.findBuyerByDate ?? "", d.buyerClosingDate ?? "", d.selectedBuyer?.name ?? "", d.relationshipOwner?.name ?? "", d.profitAtAsk ?? ""]));
              }}
            />
          }
          columns={columns}
          rows={filtered}
          totalsLabel={(rows) => `Total · ${rows.length} deal${rows.length === 1 ? "" : "s"}`}
          rowKey={(d) => d.id}
          onRowClick={(d) => nav(`/deals/${d.id}`)}
          rowHref={(d) => `/deals/${d.id}`}
          rowClassName={(d) => (d.isOverdue ? "row-overdue" : undefined)}
          defaultSort={{ key: "priority", dir: "asc" }}
          empty={scoped.length === 0
            ? <div className="dl-empty"><strong>{scope === "active" || scope === "all"
              ? (can("createDeals") ? "No deals yet — click “New deal” to create your first one." : "No deals yet.")
              : `No ${scope} deals yet.`}</strong></div>
            : <div className="dl-empty"><strong>No deals match your search.</strong><span>Try a different search{activeStage ? " or clear the stage filter" : ""}.</span></div>}
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
