import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, SearchInput, ChipList } from "../components/ui";
import { StatStrip, Segmented, Tag } from "../components/kit";
import { Tabs } from "../components/Tabs";
import { dealSearchHaystack } from "../lib/dealSearch";
import { SortableTable, type Column } from "../components/SortableTable";
import { ASSET_TYPE_LABELS } from "../lib/options";
import { PRODUCING_STATUSES, ASSET_MODE_LABEL } from "../lib/assetOptions";
import { useRowSelection, BulkActionsBar } from "../components/bulk";
import { downloadCsv } from "../lib/csv";
import { compactMoney, money, num, acres, fmtDate } from "../lib/format";
import { royaltyLabel, royaltyValue } from "../lib/royalty";
import { perAcreRate } from "../lib/perAcre";
import { roundTo, sumMoney } from "../lib/money";
import { useListState } from "../lib/listState";
import { rememberPageScroll, usePageScrollRestore } from "../lib/pageScroll";
import type { DealSummary, UserLite } from "../types";
import { NewAssetModal } from "../components/NewAssetModal";

// Kept for the detail page and older imports; the vocab lives in lib/assetOptions.
export { OWNERSHIP_TYPES, OWNERSHIP_STATUSES, PRODUCING_STATUSES } from "../lib/assetOptions";

/**
 * Mineral Assets — the company's permanent portfolio of owned mineral interests
 * (recordType = OWNED_ASSET). Distinct from Deals (acquisition opportunities),
 * but backed by the same Deal record so the Sell workflow, documents, map and
 * pipeline are shared, not duplicated. The page is laid out like the Deals
 * list — same header, tabs, table card, bulk bar and Customize View — so the
 * two read as one system.
 */

type Scope = "all" | "hold" | "sale";
const SCOPE_TITLE: Record<Scope, string> = { all: "Mineral Assets", hold: "Assets on Hold", sale: "Assets for Sale" };

const fmtPct = (v: number | null): string => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
/** Gains read green, losses red, wherever they appear in the table. */
const signedMoney = (v: number | null) =>
  v == null ? "—" : <span className={v < 0 ? "profit-neg" : "profit-pos"}>{money(v)}</span>;
/** "3/16 · 18.75%" shown as the fraction with the percent dimmed beside it (as on Deals). */
function royaltyCell(r: string | null | undefined) {
  const label = royaltyLabel(r);
  if (!label) return "—";
  const [frac, pct] = label.split(" · ");
  return <span className="dl-roy"><span>{frac}</span>{pct && <span className="dl-roy-pct">{pct}</span>}</span>;
}
const dateCell = (v: string | null | undefined, overdue = false) =>
  <span className={`dl-date${overdue ? " overdue" : ""}`}>{fmtDate(v)}</span>;

function inScope(d: DealSummary, scope: Scope): boolean {
  if (scope === "hold") return d.assetMode !== "SELL";
  if (scope === "sale") return d.assetMode === "SELL";
  return true;
}

/** A lease that has already expired (by its recorded expiration date). */
const leaseExpired = (d: DealSummary) => !!d.leaseExpirationDate && d.leaseExpirationDate.slice(0, 10) < new Date().toISOString().slice(0, 10);

export function MineralAssets() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [assets, setAssets] = useState<DealSummary[] | null>(null);
  // ?new=1 opens the create form on arrival (same convention as Deals).
  const [params, setParams] = useSearchParams();
  const [showNew, setShowNew] = useState(params.get("new") === "1");
  const [users, setUsers] = useState<UserLite[]>([]);
  // Search, tab and status filter are remembered per browser tab so Back from
  // an asset restores them (with the table's sort/page and the scroll position).
  const [q, setQ] = useListState("assets:q", "");
  const [scope, setScope] = useListState<Scope>("assets:scope", "all");
  const [statusTab, setStatusTab] = useListState("assets:status", "all");
  const sel = useRowSelection();
  const closeNew = () => { setShowNew(false); if (params.get("new")) setParams({}, { replace: true }); };

  const load = () => api.get<DealSummary[]>("/deals?recordType=OWNED_ASSET").then(setAssets);
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);
  usePageScrollRestore("assets", assets != null);

  const scoped = useMemo(() => (assets ?? []).filter((d) => inScope(d, scope)), [assets, scope]);
  const filtered = useMemo(() => {
    let rows = scoped;
    if (statusTab !== "all") rows = rows.filter((d) => (d.producingStatus ?? "") === statusTab);
    const needle = q.trim().toLowerCase();
    if (needle) rows = rows.filter((d) => dealSearchHaystack(d).includes(needle));
    return rows;
  }, [scoped, q, statusTab]);

  const totals = useMemo(() => {
    const rows = assets ?? [];
    const sum = (f: (d: DealSummary) => number | null) => sumMoney(rows.map(f));
    // Unrealized gain sums each asset's own gain (current value − book value,
    // else purchase price — the server's unrealizedGainLoss). An asset missing
    // either side is left out of BOTH the gain and its cost, instead of
    // counting as $0 value against its full cost.
    const gained = rows.filter((d) => d.unrealizedGainLoss != null);
    return {
      gain: sumMoney(gained.map((d) => d.unrealizedGainLoss)),
      gainBasis: sumMoney(gained.map((d) => d.bookValue ?? d.purchasePrice)),
      count: rows.length,
      currentValue: sum((d) => d.currentValue),
      purchasePrice: sum((d) => d.purchasePrice),
      royalty: sum((d) => d.royaltyIncomeAnnual),
      forSale: rows.filter((d) => d.assetMode === "SELL").length,
      producing: rows.filter((d) => d.producingStatus === "Producing").length,
      noValue: rows.filter((d) => d.currentValue == null).length,
      nra: roundTo(rows.reduce((s, d) => s + (d.nra ?? 0), 0), 4),
    };
  }, [assets]);

  if (!assets) return <Spinner label="Loading mineral assets…" />;

  // Totals row: plain sums of what each column shows, over the listed assets
  // (4 places, the finest any summed column carries).
  const sumOf = (rows: DealSummary[], pick: (d: DealSummary) => number | null | undefined) => roundTo(rows.reduce((t, d) => t + (pick(d) ?? 0), 0), 4);
  const acresTotal = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const moneyTotal = (rows: DealSummary[], pick: (d: DealSummary) => number | null | undefined, signed = false) => {
    const t = sumOf(rows, pick);
    return signed ? <span className={t < 0 ? "dt-totals-neg" : "dt-totals-pos"}>{money(t)}</span> : money(t);
  };

  const columns: Column<DealSummary>[] = [
    // The identifying column gets a width floor so names never wrap into a
    // sliver while less important columns spread out.
    { key: "name", header: "Asset", type: "text", value: (d) => d.name, minWidth: 220, required: true, render: (d) => {
      // Sub-line: which economics are still blank, else surveys / operator.
      const missing = [d.nra == null && d.acreageNma == null && "acreage", d.purchasePrice == null && "cost", d.currentValue == null && "value", !d.acquisitionDate && "acquired date"].filter(Boolean) as string[];
      const sub = (d.surveys ?? []).join(", ") || d.operator || "";
      return (
        <div className="ma-asset">
          <span className="ma-asset-name">
            <strong>{d.name}</strong>
            {d.assetMode === "SELL" && <Tag tone="accent" title="Marked for sale — also in the Pipeline alongside acquisition opportunities.">For sale</Tag>}
          </span>
          {missing.length > 0
            ? <span className="ma-asset-sub missing">Missing {missing.join(", ")}</span>
            : sub && <span className="ma-asset-sub" title={sub}>{sub}</span>}
        </div>
      );
    } },
    { key: "location", header: "Location", type: "text", value: (d) => d.counties.join(", "), render: (d) => <ChipList items={[...d.counties, d.state]} max={4} /> },
    // Standardized asset type (RI/ORRI/…); legacy rows created before the
    // rename still show their old free-text ownershipType.
    { key: "ownershipType", header: "Type", type: "text", value: (d) => d.assetTypes.join("/") || d.ownershipType, render: (d) => (
      d.assetTypes.length
        ? <span className="ma-types">{d.assetTypes.map((t) => <span key={t} className="ma-type" title={ASSET_TYPE_LABELS[t] ?? t}>{t}</span>)}</span>
        : <ChipList items={[d.ownershipType]} />
    ) },
    { key: "mode", header: "Mode", type: "text", value: (d) => d.assetMode ?? "HOLD",
      render: (d) => <Tag dot tone={d.assetMode === "SELL" ? "accent" : "neutral"}>{ASSET_MODE_LABEL[d.assetMode === "SELL" ? "SELL" : "HOLD"]}</Tag>, legacyDefaultHidden: true, newlyAdded: true },
    { key: "producing", header: "Status", type: "text", value: (d) => d.producingStatus,
      render: (d) => d.producingStatus
        ? <Tag dot tone={d.producingStatus === "Producing" ? "success" : "neutral"}>{d.producingStatus}</Tag>
        : <span className="ma-none">—</span> },
    { key: "nma", header: "NMA", type: "number", align: "right", value: (d) => d.acreageNma, render: (d) => acres(d.acreageNma), legacyDefaultHidden: true, newlyAdded: true,
      total: (rows) => acresTotal(sumOf(rows, (d) => d.acreageNma)) },
    { key: "nra", header: "NRA", type: "number", align: "right", value: (d) => d.nra, render: (d) => acres(d.nra),
      total: (rows) => acresTotal(sumOf(rows, (d) => d.nra)) },
    { key: "royaltyRate", header: "Royalty rate", type: "number", align: "right", value: (d) => royaltyValue(d.royaltyRate),
      render: (d) => royaltyCell(d.royaltyRate), legacyDefaultHidden: true, newlyAdded: true },
    { key: "purchasePrice", header: "Cost", type: "number", align: "right", value: (d) => d.purchasePrice, render: (d) => money(d.purchasePrice),
      total: (rows) => moneyTotal(rows, (d) => d.purchasePrice) },
    // Cost per NRA reconciles with the Cost and NRA columns (total ÷ acres).
    { key: "costPerNra", header: "Cost per NRA", type: "number", align: "right", value: (d) => perAcreRate(d.purchasePrice, d.nra),
      render: (d) => money(perAcreRate(d.purchasePrice, d.nra), { cents: true }), legacyDefaultHidden: true, newlyAdded: true },
    { key: "currentValue", header: "Current value", type: "number", align: "right", value: (d) => d.currentValue, render: (d) => <span className="ma-strong">{money(d.currentValue)}</span>,
      total: (rows) => moneyTotal(rows, (d) => d.currentValue) },
    { key: "gain", header: "Unrealized gain", type: "number", align: "right", value: (d) => d.unrealizedGainLoss, render: (d) => signedMoney(d.unrealizedGainLoss), newlyAdded: true,
      total: (rows) => moneyTotal(rows, (d) => d.unrealizedGainLoss, true) },
    { key: "roi", header: "ROI", type: "number", align: "right", value: (d) => d.roiSinceAcquisition, render: (d) => (
      <span className={d.roiSinceAcquisition == null ? "ma-none" : d.roiSinceAcquisition >= 0 ? "ma-pos" : "ma-neg"}>{fmtPct(d.roiSinceAcquisition)}</span>
    ) },
    { key: "income", header: "Income / yr", type: "number", align: "right", value: (d) => d.royaltyIncomeAnnual, render: (d) => money(d.royaltyIncomeAnnual),
      total: (rows) => moneyTotal(rows, (d) => d.royaltyIncomeAnnual) },
    { key: "lease", header: "Lease", type: "text", value: (d) => d.leaseStatuses?.join(", ") || null,
      render: (d) => d.leaseStatuses?.length ? <ChipList items={d.leaseStatuses} max={2} /> : <span className="ma-none">—</span>, legacyDefaultHidden: true, newlyAdded: true },
    { key: "leaseExp", header: "Lease expires", type: "date", align: "right", value: (d) => d.leaseExpirationDate ?? null,
      render: (d) => dateCell(d.leaseExpirationDate, leaseExpired(d)), legacyDefaultHidden: true, newlyAdded: true },
    { key: "operator", header: "Operator", type: "text", value: (d) => d.operator ?? null, render: (d) => <span className="ct-dim">{d.operator || "—"}</span>, legacyDefaultHidden: true, newlyAdded: true },
    { key: "acquired", header: "Acquired", type: "date", align: "right", value: (d) => d.acquisitionDate, render: (d) => dateCell(d.acquisitionDate) },
  ];

  const exportRows = (rows: DealSummary[]) =>
    downloadCsv(`mineral-assets-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Asset", "Mode", "State", "Counties", "Asset Type", "Producing", "NMA", "NRA", "Royalty Rate", "Cost", "Cost per NRA", "Current Value", "Unrealized Gain", "ROI %", "Income / yr", "Lease", "Lease Expires", "Operator", "Acquired"],
      rows.map((a) => [a.name, ASSET_MODE_LABEL[a.assetMode === "SELL" ? "SELL" : "HOLD"], a.state ?? "", a.counties.join("; "), a.assetTypes.join("/") || (a.ownershipType ?? ""), a.producingStatus ?? "",
        a.acreageNma ?? "", a.nra ?? "", royaltyLabel(a.royaltyRate), a.purchasePrice ?? "", perAcreRate(a.purchasePrice, a.nra) ?? "", a.currentValue ?? "", a.unrealizedGainLoss ?? "",
        a.roiSinceAcquisition?.toFixed(1) ?? "", a.royaltyIncomeAnnual ?? "", a.leaseStatuses?.join("; ") ?? "", a.leaseExpirationDate ?? "", a.operator ?? "", a.acquisitionDate ?? ""]));

  // Status filter: All plus each producing status present in this scope.
  const statusOptions = [
    { value: "all", label: "All statuses", count: scoped.length },
    ...PRODUCING_STATUSES.map((st) => ({ value: st, label: st, count: scoped.filter((d) => d.producingStatus === st).length })).filter((t) => t.count > 0 || t.value === statusTab),
  ];
  const activeStatus = statusOptions.some((o) => o.value === statusTab) ? statusTab : "all";
  const gain = totals.gain;

  // Live header stat line, like Deals: what's held and what it's worth.
  const n = scoped.length;
  const value = sumMoney(scoped.map((d) => d.currentValue));
  const scopedGain = sumMoney(scoped.filter((d) => d.unrealizedGainLoss != null).map((d) => d.unrealizedGainLoss));
  const stats: ReactNode[] = [
    <><b>{n}</b> asset{n === 1 ? "" : "s"}{scope === "all" ? " in the portfolio" : scope === "hold" ? " on hold" : " for sale"}</>,
    value ? <><b>{compactMoney(value)}</b> current value</> : null,
    scopedGain ? <><b className={scopedGain < 0 ? "neg" : "pos"}>{compactMoney(scopedGain)}</b> unrealized gain</> : null,
  ].filter(Boolean);
  const countFor = (s: Scope) => (assets ?? []).filter((d) => inScope(d, s)).length;
  const tabLabel = (label: string, c: number) => <span className="dl-tab">{label}<span className="tab-badge">{c}</span></span>;
  const filtering = !!q || activeStatus !== "all";
  const openAsset = (d: DealSummary) => { rememberPageScroll("assets"); nav(`/assets/${d.id}`); };

  return (
    <div className="page page-fill deals-page assets-page">
      <div className="page-header">
        <div className="dl-head">
          <h1>{SCOPE_TITLE[scope]}</h1>
          <div className="dl-stats">
            {stats.map((st, i) => <Fragment key={i}>{i > 0 && <span className="dl-stats-dot" aria-hidden="true" />}<span>{st}</span></Fragment>)}
          </div>
        </div>
        <div className="ma-actions">
          {assets.length > 0 && (
            <button type="button" onClick={() => exportRows(filtered)} title="Export the assets shown to CSV">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
              Export CSV
            </button>
          )}
          {can("createDeals") && (
            <button className="primary dl-new-btn" onClick={() => setShowNew(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              New asset
            </button>
          )}
        </div>
      </div>

      {/* Lifecycle tabs — Hold (portfolio) vs For sale (also in the Pipeline). */}
      <Tabs
        tabs={[
          { key: "all" as const, label: tabLabel("All", countFor("all")) },
          { key: "hold" as const, label: tabLabel("Hold", countFor("hold")) },
          { key: "sale" as const, label: tabLabel("For sale", countFor("sale")) },
        ]}
        active={scope}
        onSelect={setScope}
      />

      <StatStrip min={220} className="ma-stats" cells={[
        { label: "Assets owned", value: num(totals.count),
          sub: [`${totals.producing} producing`, totals.forSale > 0 ? `${totals.forSale} marked for sale` : null].filter(Boolean).join(" · ") },
        { label: "Portfolio value", value: money(totals.currentValue),
          sub: <>Cost basis {money(totals.purchasePrice)}{totals.noValue > 0 && <span className="ma-warn"> · {totals.noValue} without a value</span>}</> },
        { label: "Unrealized gain", value: money(gain), tone: gain > 0 ? "success" : gain < 0 ? "danger" : "default",
          sub: totals.gainBasis > 0
            ? `${fmtPct((gain / totals.gainBasis) * 100)} on cost`
            : totals.currentValue > 0 ? <span className="ma-warn">Cost basis not set — add purchase price for a real gain figure</span> : undefined },
        { label: "Annual royalty income", value: money(totals.royalty), tone: totals.royalty ? "success" : "default",
          sub: totals.royalty ? "Trailing 12 mo · from booked revenue" : "Fills in from royalty revenue booked on each asset" },
      ]} />

      <div className="ct-card dl-card">
        <SortableTable
          customizeId="mineral-assets-list"
          stateKey={`assets:${scope}`}
          toolbar={
            <>
              <SearchInput value={q} onChange={setQ} placeholder="Search asset, abstract, survey, county, operator…" ariaLabel="Search mineral assets" />
              {statusOptions.length > 1 && (
                <Segmented ariaLabel="Filter by producing status" className="dl-stage-filter" value={activeStatus} onChange={setStatusTab} options={statusOptions} />
              )}
              {filtering && <span className="dl-showing">Showing {filtered.length} of {n}</span>}
            </>
          }
          subToolbar={
            <BulkActionsBar
              selectedIds={[...sel.selected]}
              onClear={sel.clear}
              onDone={load}
              users={users}
              itemLabel="asset"
              deleteUrl={can("deleteDeals") ? "/deals/bulk-delete" : undefined}
              assign={can("editDeals") ? { url: "/deals/bulk-assign", key: "assigneeIds" } : undefined}
              onExport={() => exportRows(filtered.filter((a) => sel.selected.has(a.id)))}
            />
          }
          columns={columns}
          rows={filtered}
          totalsLabel={(rows) => `Total · ${rows.length} asset${rows.length === 1 ? "" : "s"}`}
          rowKey={(d) => d.id}
          onRowClick={openAsset}
          rowHref={(d) => `/assets/${d.id}`}
          rowClassName={(d) => (leaseExpired(d) ? "row-overdue" : undefined)}
          defaultSort={{ key: "currentValue", dir: "desc" }}
          empty={scoped.length === 0
            ? <div className="dl-empty"><strong>{scope === "sale"
              ? "No assets are marked for sale."
              : can("createDeals") ? "No mineral assets yet — click “New asset” to add your first one." : "No mineral assets yet."}</strong>
              <span>{scope === "sale" ? "Open an asset and choose “Mark for sale” to market it." : "You can also convert a closed deal into an owned asset from its page."}</span></div>
            : <div className="dl-empty"><strong>No assets match your search.</strong><span>Try a different search{activeStatus !== "all" ? " or clear the status filter" : ""}.</span></div>}
          selection={{ selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll }}
          rowsPerPage={[20, 50, 100, 200]}
          paginationNoun="asset"
          footerExtra={totals.nra ? ` · ${num(totals.nra)} total NRA` : undefined}
        />
      </div>

      {showNew && <NewAssetModal onClose={closeNew} onCreated={(d) => { closeNew(); nav(`/assets/${d.id}`); }} />}
    </div>
  );
}
