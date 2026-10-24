import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { PriorityBadge, StageBadge, Spinner, SearchInput, showToast } from "../components/ui";
import { royaltyLabel, royaltyValue } from "../lib/royalty";
import { SortableTable, type Column } from "../components/SortableTable";
import { NewDealModal } from "../components/NewDealModal";
import { useRowSelection, BulkActionsBar } from "../components/bulk";
import { money, num, acres, fmtDate } from "../lib/format";
import { perAcreRates } from "../lib/perAcre";
import { roundTo, sumMoney } from "../lib/money";
import { dealSearchHaystack } from "../lib/dealSearch";
import { downloadCsv } from "../lib/csv";
import { Tabs } from "../components/Tabs";
import { useAuth } from "../auth/AuthContext";
import { useStages } from "../stages";
import { useListState } from "../lib/listState";
import { Segmented, StatStrip, Tag, type StatCell } from "../components/kit";
import { UserAvatar, shortUserName } from "../components/UserAvatar";
import { blendedCost } from "../lib/blendedCost";
import type { DealSummary, DealsVisibility, UserLite } from "../types";

type Scope = "all" | "active" | "closed" | "archived";
const SCOPE_TITLE: Record<Scope, string> = { all: "Deals", active: "Active Deals", closed: "Closed Deals", archived: "Archived Deals" };

/** Hide/Unhide: which deals the list (and every metric on it) includes. */
const VISIBILITY_OPTIONS: { value: DealsVisibility; label: string; title: string }[] = [
  { value: "ACTIVE", label: "Active", title: "Deals that aren't hidden (the default view)" },
  { value: "HIDDEN", label: "Hidden", title: "Only deals you've hidden" },
  { value: "ALL", label: "All", title: "Hidden and active deals together" },
];

/** Blended $/acre as a KPI value: the rate with its unit, or N/A. */
const blendedValue = (rate: number | null, unit: "NMA" | "NRA") =>
  rate == null ? "N/A" : <>{money(rate, { cents: true })}<span className="dl-kpi-unit">/{unit}</span></>;


/**
 * Per-acre costs for a row, from the displayed Our Cost and acreage through
 * lib/perAcre.perAcreRates — the one formula the deal page and the editors
 * use too, so every screen shows the same $/NMA and $/NRA for a deal.
 */
function costPerAcre(d: DealSummary): { perNma: number | null; perNra: number | null } {
  return perAcreRates(d.ourPrice, d.acreageNma, d.nra, royaltyValue(d.royaltyRate));
}

const PROFIT_AT_ASK_HINT = "Ask price − Our cost − closing costs: what we'd make selling at our current asking price. Not an offer.";
const BLENDED_HINT = "Blended: total Our cost ÷ total acreage of the listed deals (a weighted average, not the average of each deal's rate).";

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
  const { can, user } = useAuth();
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  // Visibility (Active / Hidden / All) is the user's saved choice (profile),
  // remembered for the tab too so Back from a deal keeps it without a refetch
  // of /me. The list is loaded once (hidden deals included) and the view is
  // applied to that set before anything else — scope, counts, totals, KPIs,
  // exports — so switching views is instant and nothing hidden can leak into
  // a figure. (The server also filters on ?visibility for API consumers.)
  const [visibility, setVisibilityState] = useListState<DealsVisibility>("deals:visibility", user?.dealsVisibility ?? "ACTIVE");
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

  function load() { api.get<DealSummary[]>("/deals?visibility=all").then(setDeals); }
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);
  function setVisibility(v: DealsVisibility) {
    if (v === visibility) return;
    setVisibilityState(v);
    sel.clear();
    api.patch("/auth/preferences", { dealsVisibility: v }).catch(() => {}); // best effort; the tab keeps the choice regardless
  }
  async function setHidden(ids: string[], hidden: boolean) {
    const r = await api.post<{ updated: number }>("/deals/bulk-hidden", { ids, hidden });
    showToast(`${r.updated} deal${r.updated === 1 ? "" : "s"} ${hidden ? "hidden from" : "restored to"} the Deals list`);
  }

  // The view's deals: hidden ones only when the view asks for them.
  const inView = useMemo(() => (deals ?? []).filter((d) => visibility === "ALL" || (visibility === "HIDDEN") === !!d.hiddenAt), [deals, visibility]);
  const scoped = useMemo(() => inView.filter((d) => inScope(d, scope)), [inView, scope]);

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
  // (Rounded to 4 places — the finest any summed column carries — so float
  // tails like 0.30000000000000004 never surface.)
  const sumOf = (rows: DealSummary[], pick: (d: DealSummary) => number | null | undefined) => roundTo(rows.reduce((t, d) => t + (pick(d) ?? 0), 0), 4);

  const columns: Column<DealSummary>[] = [
    // The identifying column gets a width floor so names never wrap into a
    // 4-line sliver while less important columns spread out.
    { key: "name", header: "Deal", type: "text", value: (d) => d.name, minWidth: 220, required: true,
      render: (d) => (
        <span className="dl-name">
          <span className="dl-name-txt">{d.name}</span>
          {d.hiddenAt && visibility !== "HIDDEN" && <Tag title={`Hidden from the default Deals view since ${fmtDate(d.hiddenAt)}`}>Hidden</Tag>}
          {d.recordType === "OWNED_ASSET" && <Tag tone="accent" title="This is an owned mineral asset marked for sale — not an acquisition opportunity.">Asset · For sale</Tag>}
        </span>
      ) },
    // Width floors on the rest keep the columns from re-measuring to every
    // filtered subset's content, so a stage/view switch doesn't reflow the grid.
    { key: "priority", header: "Priority", type: "text", minWidth: 96,
      value: (d) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[d.priority]),
      render: (d) => <span className="dl-priority"><PriorityBadge priority={d.priority} /></span> },
    { key: "stage", header: "Stage", type: "text", minWidth: 150, value: (d) => d.stage, render: (d) => <span className="dl-stage"><StageBadge stage={d.stage} pipelineId={d.pipelineId} /></span> },
    { key: "nma", header: "NMA", type: "number", align: "right", minWidth: 72, value: (d) => d.acreageNma, render: (d) => acres(d.acreageNma),
      total: (rows) => acres(sumOf(rows, (d) => d.acreageNma)) },
    // Every column is shown by default; users hide what they don't need via
    // Customize View (saved to their profile). `legacyDefaultHidden` marks the
    // columns an older version hid by default, so a browser layout that merely
    // held those old defaults isn't mistaken for a user's choice.
    { key: "nra", header: "NRA", type: "number", align: "right", minWidth: 72, value: (d) => d.nra, render: (d) => acres(d.nra), legacyDefaultHidden: true,
      total: (rows) => acres(sumOf(rows, (d) => d.nra)) },
    // Financial columns. Buyer Purchase Price is the offer Profit Est. is
    // computed from (accepted, else best), so the three reconcile.
    { key: "ourCost", header: "Our cost", type: "number", align: "right", minWidth: 110, value: (d) => d.ourPrice, render: (d) => money(d.ourPrice), legacyDefaultHidden: true, newlyAdded: true,
      total: (rows) => money(sumMoney(rows.map((d) => d.ourPrice))) },
    { key: "buyerPrice", header: "Buyer purchase price", type: "number", align: "right", minWidth: 150, value: (d) => d.buyerPurchasePrice ?? null, render: (d) => money(d.buyerPurchasePrice), legacyDefaultHidden: true, newlyAdded: true,
      total: (rows) => money(sumMoney(rows.map((d) => d.buyerPurchasePrice))) },
    // Totals here are the BLENDED rate (Σ Our cost ÷ Σ acres over the listed
    // deals) — the same figure as the KPI above the table, never a mean of rates.
    { key: "ourCostPerNma", header: "Our cost per NMA", type: "number", align: "right", minWidth: 136,
      value: (d) => costPerAcre(d).perNma,
      render: (d) => money(costPerAcre(d).perNma, { cents: true }), newlyAdded: true,
      total: (rows) => { const b = blendedCost(rows); return <span title={BLENDED_HINT}>{b.perNma == null ? "N/A" : money(b.perNma, { cents: true })}</span>; } },
    { key: "ourCostPerNra", header: "Our cost per NRA", type: "number", align: "right", minWidth: 136,
      value: (d) => costPerAcre(d).perNra,
      render: (d) => money(costPerAcre(d).perNra, { cents: true }), newlyAdded: true,
      total: (rows) => { const b = blendedCost(rows); return <span title={BLENDED_HINT}>{b.perNra == null ? "N/A" : money(b.perNra, { cents: true })}</span>; } },
    // Display-only: every deal field is edited on the Deal page (Deal Characteristics).
    { key: "royaltyRate", header: "Royalty rate", type: "number", align: "right", minWidth: 110, value: (d) => royaltyValue(d.royaltyRate),
      render: (d) => royaltyCell(d.royaltyRate), legacyDefaultHidden: true, newlyAdded: true },
    { key: "profit", header: "Profit est.", type: "number", align: "right", minWidth: 110, value: (d) => d.profitEst, render: (d) => profitCell(d.profitEst),
      total: (rows) => { const t = sumMoney(rows.map((d) => d.profitEst)); return <span className={t < 0 ? "dt-totals-neg" : "dt-totals-pos"}>{money(t)}</span>; } },
    // Profit at asking price = ask − Our Cost − closing costs (the deal's own
    // figures, like Profit est.): what we'd make selling at our ask — not an
    // offer. Columns carry no header tooltip, so the hint rides on each cell.
    { key: "profitAtAsk", header: "Profit at asking", type: "number", align: "right", minWidth: 124, value: (d) => d.profitAtAsk ?? null, newlyAdded: true,
      render: (d) => <span title={PROFIT_AT_ASK_HINT}>{profitCell(d.profitAtAsk ?? null)}</span>,
      total: (rows) => { const t = sumMoney(rows.map((d) => d.profitAtAsk)); return <span className={t < 0 ? "dt-totals-neg" : "dt-totals-pos"}>{money(t)}</span>; } },
    { key: "uc", header: "Under contract", type: "date", minWidth: 118, value: (d) => d.dateUnderContract, render: (d) => dateCell(d.dateUnderContract), legacyDefaultHidden: true },
    { key: "fbb", header: "Find buyer by", type: "date", minWidth: 118, value: (d) => d.findBuyerByDate,
      render: (d) => dateCell(d.findBuyerByDate, d.isOverdue) },
    { key: "oc", header: "Closing", type: "date", minWidth: 110, value: (d) => d.originalClosingDate, render: (d) => dateCell(d.originalClosingDate), legacyDefaultHidden: true },
    { key: "fc", header: "Extended closing", type: "date", minWidth: 124, value: (d) => d.finalClosingDate, render: (d) => dateCell(d.finalClosingDate) },
    { key: "bc", header: "Buyer closing", type: "date", minWidth: 118, value: (d) => d.buyerClosingDate ?? null, render: (d) => dateCell(d.buyerClosingDate ?? null), legacyDefaultHidden: false, newlyAdded: true },
    { key: "buyer", header: "Current buyer", type: "text", minWidth: 140, value: (d) => d.selectedBuyer?.name ?? null,
      render: (d) => <span className="ct-dim">{d.selectedBuyer?.name ?? "—"}</span> },
    { key: "owner", header: "Owner", type: "text", minWidth: 120, value: (d) => d.relationshipOwner?.name ?? null,
      render: (d) => d.relationshipOwner ? (
        <span className="ct-owner">
          <UserAvatar user={d.relationshipOwner} size={22} />
          <span className="dl-owner-name">{shortUserName(d.relationshipOwner)}</span>
        </span>
      ) : "—" },
  ];

  const n = scoped.length;

  // KPI strip — the deals in view (this scope + stage filter + search +
  // visibility). Blended cost is Σ Our cost ÷ Σ acreage (lib/blendedCost),
  // recomputed whenever the rows change, so it always matches the table.
  const blend = blendedCost(filtered);
  // Same plain sums as the table's totals row (entered acreage only).
  const nmaInView = sumOf(filtered, (d) => d.acreageNma);
  const nraInView = sumOf(filtered, (d) => d.nra);
  const blendNote = (skipped: number, converted: number, unit: "NMA" | "NRA") => [
    converted > 0 ? `${converted} converted from ${unit === "NMA" ? "NRA" : "NMA"} at the deal's royalty` : null,
    skipped > 0 ? `${skipped} priced deal${skipped === 1 ? "" : "s"} without ${unit} left out` : null,
  ].filter(Boolean).map((s) => ` · ${s}`).join("");
  // Profit figures: the same sums as the table's totals row (Profit est. =
  // best/accepted offer − Our cost − closing costs; Profit at asking = ask −
  // Our cost − closing costs), over the deals that have each figure.
  const withEst = filtered.filter((d) => d.profitEst != null);
  const withAsk = filtered.filter((d) => d.profitAtAsk != null);
  const profitEstTotal = sumMoney(withEst.map((d) => d.profitEst));
  const profitAskTotal = sumMoney(withAsk.map((d) => d.profitAtAsk));
  const profitTone = (v: number, has: boolean): StatCell["tone"] => !has ? "default" : v < 0 ? "danger" : v > 0 ? "success" : "default";
  const dealsWith = (k: number, what: string) => `${k} deal${k === 1 ? "" : "s"} with ${what}`;
  // Figures only — the formula / counts behind each one sit in the cell's
  // tooltip (hover), not under the number.
  const hint = {
    count: filtered.length ? `${acres(nmaInView)} NMA · ${acres(nraInView)} NRA` : "Nothing matches the current filters",
    cost: blend.priced ? `Our cost across ${blend.priced} priced deal${blend.priced === 1 ? "" : "s"}` : "No deal in view has an Our cost yet",
    nma: blend.perNma != null ? `${money(blend.costNma)} ÷ ${acres(blend.nma)} NMA${blendNote(blend.skippedNma, blend.convertedNma, "NMA")}` : "Needs Our cost and NMA on a deal in view",
    nra: blend.perNra != null ? `${money(blend.costNra)} ÷ ${acres(blend.nra)} NRA${blendNote(blend.skippedNra, blend.convertedNra, "NRA")}` : "Needs Our cost and NRA (or a royalty rate) on a deal in view",
    est: withEst.length ? `${dealsWith(withEst.length, "an offer")} · offer − Our cost − closing costs` : "Fills in once a deal in view has an offer",
    ask: withAsk.length ? `${dealsWith(withAsk.length, "an asking price")} · ask − Our cost − closing costs` : "Needs an asking price and Our cost on a deal in view",
  };
  const kpis: StatCell[] = [
    { label: "Deals in view", value: num(filtered.length), title: hint.count },
    { label: "Total acquisition cost", value: money(blend.priced ? blend.cost : null, { blank: "N/A" }), title: hint.cost },
    { label: "Blended cost per NMA", value: blendedValue(blend.perNma, "NMA"), title: `${hint.nma}. ${BLENDED_HINT}` },
    { label: "Blended cost per NRA", value: blendedValue(blend.perNra, "NRA"), title: `${hint.nra}. ${BLENDED_HINT}` },
    { label: "Profit estimate", value: money(withEst.length ? profitEstTotal : null, { blank: "N/A" }), tone: profitTone(profitEstTotal, withEst.length > 0), title: hint.est },
    { label: "Profit at asking", value: money(withAsk.length ? profitAskTotal : null, { blank: "N/A" }), tone: profitTone(profitAskTotal, withAsk.length > 0), title: `${hint.ask}. ${PROFIT_AT_ASK_HINT}` },
  ];

  const countFor = (s: Scope) => inView.filter((d) => inScope(d, s)).length;
  const tabLabel = (label: string, n: number) => (
    <span className="dl-tab">{label}<span className="tab-badge">{n}</span></span>
  );
  const filtering = !!q || !!activeStage;

  return (
    <div className="page page-fill deals-page">
      <div className="page-header">
        <div className="dl-head">
          <h1>{SCOPE_TITLE[scope]}</h1>
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

      {/* Six cells: one row on a wide screen, two rows of three below that. */}
      <StatStrip min={176} className="dl-kpis" cells={kpis} />

      <div className="ct-card dl-card">
        <SortableTable
          customizeId={`deals-list:${scope}`}
          toolbar={
            <>
              <SearchInput value={q} onChange={setQ} placeholder="Search deal, seller, abstract, survey, county, buyer…" ariaLabel="Search deals" />
              {/* Show sits before the stage tray: the tray's width changes with the
                  view (its stages and counts), the Show control's never does. */}
              <span className="dl-vis" title="Hidden deals stay in the system with everything intact; this only controls which ones this page shows and counts.">
                <span className="dl-vis-lbl">Show</span>
                <Segmented ariaLabel="Deal visibility" className="dl-visibility" value={visibility} onChange={setVisibility} options={VISIBILITY_OPTIONS} />
              </span>
              {filtering && <span className="dl-showing">Showing {filtered.length} of {n}</span>}
              {/* The stage tray always takes its own line (deals.css) and is shown
                  whenever there are rows, so the toolbar's height — and the rows'
                  starting position — is the same in every view. */}
              {stageOptions.length > 0 && (
                <Segmented
                  ariaLabel="Filter by stage"
                  className="dl-stage-filter"
                  value={activeStage}
                  onChange={setStageKey}
                  options={[{ value: "", label: "All stages", count: n }, ...stageOptions]}
                />
              )}
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
              actions={can("editDeals") ? [
                ...(visibility !== "HIDDEN" ? [{ label: "Hide", title: "Remove from the default Deals view and its totals (reversible; nothing else changes)", run: (ids: string[]) => setHidden(ids, true) }] : []),
                ...(visibility !== "ACTIVE" ? [{ label: "Unhide", title: "Put back in the default Deals view", run: (ids: string[]) => setHidden(ids, false) }] : []),
              ] : undefined}
              onExport={() => {
                const rows = filtered.filter((d) => sel.selected.has(d.id));
                downloadCsv(`deals-${new Date().toISOString().slice(0, 10)}.csv`,
                  ["Deal", "Priority", "Stage", "NMA", "NRA", "Our Cost", "Our Cost per NMA", "Our Cost per NRA", "Buyer Purchase Price", "Royalty Rate", "Profit Est.", "Under Contract", "Find Buyer By", "Buyer Closing", "Current Buyer", "Owner", "Profit at Asking", "Hidden"],
                  rows.map((d) => [d.name, d.priority, d.stage, d.acreageNma ?? "", d.nra ?? "", d.ourPrice ?? "",
                    costPerAcre(d).perNma ?? "", costPerAcre(d).perNra ?? "",
                    d.buyerPurchasePrice ?? "", royaltyLabel(d.royaltyRate), d.profitEst ?? "", d.dateUnderContract ?? "", d.findBuyerByDate ?? "", d.buyerClosingDate ?? "", d.selectedBuyer?.name ?? "", d.relationshipOwner?.name ?? "", d.profitAtAsk ?? "", d.hiddenAt ? "Yes" : "No"]));
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
            ? <div className="dl-empty"><strong>{visibility === "HIDDEN"
              ? "No hidden deals."
              : scope === "active" || scope === "all"
                ? (can("createDeals") ? "No deals yet — click “New deal” to create your first one." : "No deals yet.")
                : `No ${scope} deals yet.`}</strong>{visibility === "HIDDEN" && <span>Hide a deal from its page (⋯ menu) or select deals here and choose Hide.</span>}</div>
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
