import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, LineChart, PieChart, Pie, Cell, ReferenceLine,
} from "recharts";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Banner, Modal, EmptyState, ChipList } from "../components/ui";
import { StatStrip, Segmented, type StatCell } from "../components/kit";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { Select } from "../components/Select";
import { GeoFields } from "../components/GeoFields";
import { SortableTable, type Column } from "../components/SortableTable";
import { ChartTypeToggle, useChartType } from "../components/ChartTypeToggle";
import { compactMoney, money, pct, num, fmtDate, fmtDateLocal, prettyStage } from "../lib/format";
import { useStages } from "../stages";
import { CHART_COLORS, COLOR_REVENUE, COLOR_PROFIT, monthLabel, chartTooltip } from "../lib/charts";
import type { DealSummary } from "../types";
import { DateField } from "../components/DateField";

interface Kpis {
  totalDeals: number; dealsAdded: number; dealsClosed: number; dealsLost: number; winRate: number;
  totalDealValue: number; avgDealSize: number; avgTimeToClose: number; revenue: number; grossProfit: number;
  netProfit: number; expenses: number; closingCosts: number; reimbursementsOutstanding: number;
  activeBuyers: number; newBuyers: number; buyerActivity: number;
  /** Realized; null = N/A (no deals closed). */
  costPerDeal: number | null;
  /** Realized net profit ÷ expenses; null = N/A (no expenses / no priced closed deal). */
  roiMultiple: number | null;
  closedWithoutPrice: number;
}

/** The records behind Cost per Deal and ROI (GET /reports/analytics/financials). */
interface Financials {
  range: { from: string; to: string };
  totals: {
    revenue: number; closingCosts: number; grossProfit: number; expenses: number; netProfit: number;
    dealsClosed: number; costPerDeal: number | null; roiMultiple: number | null; closedWithoutPrice: number;
    /** Org-wide: CLOSED deals with no Closing Date, which no period can show. */
    closedWithoutDate: number;
  };
  closedDeals: {
    id: string; name: string; closedAt: string | null; counties: string[]; acceptedAmount: number | null;
    costBasis: number | null; revenue: number | null; closingCosts: number | null; grossProfit: number | null;
  }[];
  /** null when the caller lacks manageExpenses — totals only, no individual rows. */
  expenses: { id: string; date: string; amount: number; category: string | null; notes: string | null; submittedBy: string | null; reimbursed: boolean }[] | null;
}

/** ROI shown as a multiple ("2.5x", "-0.4x"); N/A when it can't be computed. */
function fmtMultiple(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return "N/A";
  const digits = Math.abs(m) >= 10 ? 1 : 2;
  return `${Number(m.toFixed(digits))}x`;
}
interface MonthPoint { month: string; dealsAdded: number; dealsClosed: number; dealsLost: number; revenue: number; netProfit: number; expenses: number; forecast?: boolean }
interface Analytics {
  range: { from: string; to: string };
  compare: { from: string; to: string } | null;
  kpis: Kpis;
  previous: Kpis | null;
  deltas: Record<string, number | null> | null;
  series: MonthPoint[];
  breakdowns: {
    counties: { name: string; count: number }[];
    basins: { name: string; count: number }[];
    formations: { name: string; count: number }[];
    assetTypes: { name: string; count: number }[];
    perUser: { userId: string; name: string; created: number; closed: number; activity: number }[];
  };
  /** Org-wide: CLOSED deals with no Closing Date. Every closed-deal figure keys
   *  on the Closing Date, so these are in no period or month until it is set. */
  closedWithoutDate: number;
}
interface FilterOpts {
  counties: string[]; basins: string[]; formations: string[]; assetTypes: string[]; operators: string[];
  buyers: { id: string; name: string }[]; users: { id: string; name: string }[]; stages: string[];
}

type Period = "THIS_MONTH" | "LAST_MONTH" | "THIS_QUARTER" | "LAST_QUARTER" | "THIS_YEAR" | "LAST_YEAR" | "CUSTOM";
type Compare = "NONE" | "PREV_PERIOD" | "PREV_YEAR";

const iso = (d: Date) => d.toISOString().slice(0, 10);

function rangeFor(period: Period, custom: { from: string; to: string }): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (period) {
    case "THIS_MONTH": return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
    case "LAST_MONTH": return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case "THIS_QUARTER": { const q = Math.floor(m / 3) * 3; return { from: iso(new Date(Date.UTC(y, q, 1))), to: iso(new Date(Date.UTC(y, q + 3, 0))) }; }
    case "LAST_QUARTER": { const q = Math.floor(m / 3) * 3 - 3; return { from: iso(new Date(Date.UTC(y, q, 1))), to: iso(new Date(Date.UTC(y, q + 3, 0))) }; }
    case "THIS_YEAR": return { from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(new Date(Date.UTC(y, 11, 31))) };
    case "LAST_YEAR": return { from: iso(new Date(Date.UTC(y - 1, 0, 1))), to: iso(new Date(Date.UTC(y - 1, 11, 31))) };
    default: return { from: custom.from, to: custom.to };
  }
}

/** Previous comparison window derived from the current range. */
function compareRange(mode: Compare, from: string, to: string): { from: string; to: string } | null {
  if (mode === "NONE" || !from || !to) return null;
  const f = new Date(from), t = new Date(to);
  if (mode === "PREV_YEAR") {
    return { from: iso(new Date(Date.UTC(f.getUTCFullYear() - 1, f.getUTCMonth(), f.getUTCDate()))),
             to: iso(new Date(Date.UTC(t.getUTCFullYear() - 1, t.getUTCMonth(), t.getUTCDate()))) };
  }
  // PREV_PERIOD: same-length window immediately before `from`.
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const prevTo = new Date(f.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);
  return { from: iso(prevFrom), to: iso(prevTo) };
}

const EMPTY_FILTERS: Record<string, string[]> = { states: [], counties: [], basins: [], formations: [], assetTypes: [], operators: [], stages: [], buyers: [], users: [] };

// Customize View — which KPI metrics show, and in what order (saved per user).
type MetricId =
  | "revenue" | "netProfit" | "grossProfit" | "expenses" | "costPerDeal" | "roi" | "dealsClosed" | "dealsAdded"
  | "dealsLost" | "winRate" | "totalDeals" | "totalDealValue" | "avgDealSize" | "avgTimeToClose"
  | "activeBuyers" | "newBuyers" | "buyerActivity" | "reimbursementsOutstanding";
const METRIC_LABELS: Record<MetricId, string> = {
  revenue: "Revenue (gross fees)", netProfit: "Net profit", grossProfit: "Gross profit", expenses: "Expenses",
  costPerDeal: "Cost per deal", roi: "Return on investment (ROI)",
  dealsClosed: "Deals closed", dealsAdded: "Deals added", dealsLost: "Deals lost", winRate: "Win rate",
  totalDeals: "Total deals", totalDealValue: "Total deal value", avgDealSize: "Avg deal size", avgTimeToClose: "Avg time to close",
  activeBuyers: "Active buyers", newBuyers: "New buyers", buyerActivity: "Buyer activity", reimbursementsOutstanding: "Reimbursements outstanding",
};
const DEFAULT_METRICS: MetricId[] = [
  "revenue", "netProfit", "grossProfit", "expenses", "costPerDeal", "roi", "dealsClosed", "dealsAdded", "dealsLost", "winRate",
  "totalDeals", "totalDealValue", "avgDealSize", "avgTimeToClose", "activeBuyers", "newBuyers", "buyerActivity", "reimbursementsOutstanding",
];
interface MetricPrefs { order: MetricId[]; hidden: MetricId[] }
const METRICS_KEY = "mh-reports-metrics:v1";
function loadMetricPrefs(): MetricPrefs {
  try { const raw = localStorage.getItem(METRICS_KEY); if (raw) { const p = JSON.parse(raw) as Partial<MetricPrefs>; return { order: p.order ?? [], hidden: p.hidden ?? [] }; } } catch { /* ignore */ }
  return { order: [], hidden: [] };
}

/** id→label map for pickers; duplicate names get a numeric suffix so two
 *  "John Smith"s remain distinguishable. */
function idLabels(items: { id: string; name: string }[]): Record<string, string> {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.name, (counts.get(it.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out: Record<string, string> = {};
  for (const it of items) {
    if ((counts.get(it.name) ?? 0) > 1) {
      const n = (seen.get(it.name) ?? 0) + 1;
      seen.set(it.name, n);
      out[it.id] = `${it.name} (${n})`;
    } else out[it.id] = it.name;
  }
  return out;
}

/** KPI strips: the 18 metrics in three groups (the saved order applies within each group). */
const METRIC_GROUPS: { key: string; label: string; ids: MetricId[] }[] = [
  { key: "fin", label: "Financials", ids: ["revenue", "netProfit", "grossProfit", "expenses", "costPerDeal", "roi"] },
  { key: "deal", label: "Deals", ids: ["dealsClosed", "dealsAdded", "dealsLost", "winRate", "totalDeals", "totalDealValue", "avgDealSize", "avgTimeToClose"] },
  { key: "buy", label: "Buyers & operations", ids: ["activeBuyers", "newBuyers", "buyerActivity", "reimbursementsOutstanding"] },
];
const groupOf = (id: MetricId) => METRIC_GROUPS.find((g) => g.ids.includes(id))?.key ?? "";
const orderedMetrics = (prefs: MetricPrefs): MetricId[] =>
  [...prefs.order.filter((id) => DEFAULT_METRICS.includes(id)), ...DEFAULT_METRICS.filter((id) => !prefs.order.includes(id))];

/** Display value of each metric for a KPI set (current period or the comparison window). */
const METRIC_FMT: Record<MetricId, (x: Kpis) => string> = {
  revenue: (x) => money(x.revenue), netProfit: (x) => money(x.netProfit), grossProfit: (x) => money(x.grossProfit),
  expenses: (x) => money(x.expenses),
  costPerDeal: (x) => (x.costPerDeal == null ? "N/A" : money(x.costPerDeal, { cents: true })),
  roi: (x) => fmtMultiple(x.roiMultiple),
  dealsClosed: (x) => num(x.dealsClosed), dealsAdded: (x) => num(x.dealsAdded), dealsLost: (x) => num(x.dealsLost),
  winRate: (x) => pct(x.winRate), totalDeals: (x) => num(x.totalDeals), totalDealValue: (x) => money(x.totalDealValue),
  avgDealSize: (x) => (x.dealsClosed > 0 ? money(x.avgDealSize) : "—"),
  avgTimeToClose: (x) => (x.dealsClosed > 0 ? `${Math.round(x.avgTimeToClose)}d` : "—"),
  activeBuyers: (x) => num(x.activeBuyers), newBuyers: (x) => num(x.newBuyers), buyerActivity: (x) => num(x.buyerActivity),
  reimbursementsOutstanding: (x) => money(x.reimbursementsOutstanding),
};

/** Compact axis money: $950, $1.2K, $14K, $1.3M. */
function axisMoney(v: number): string {
  return compactMoney(v, { kDigits: (a) => (a >= 10000 ? 0 : 1), minus: "−" });
}
const AXIS_TICK = { fontSize: 11, fill: "var(--ink-4)" };

export function Reports() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [period, setPeriod] = useState<Period>("THIS_YEAR");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [compare, setCompare] = useState<Compare>("NONE");
  const [filters, setFilters] = useState<Record<string, string[]>>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [opts, setOpts] = useState<FilterOpts | null>(null);
  const [data, setData] = useState<Analytics | null>(null);
  // Deals load lazily on the first KPI drill-down — most report views never
  // drill, so the page no longer eagerly pulls the whole deal list.
  const dealsRef = useRef<DealSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<{ title: string; rows: DealSummary[] } | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  // Which KPI metrics are shown + their order (Customize View, saved per user).
  const [metricPrefs, setMetricPrefs] = useState<MetricPrefs>(loadMetricPrefs);
  useEffect(() => { try { localStorage.setItem(METRICS_KEY, JSON.stringify(metricPrefs)); } catch { /* ignore */ } }, [metricPrefs]);
  // Customize View — per-chart visualization type (saved per user).
  const [activityType, setActivityType] = useChartType("reports-activity", ["bar", "line"], "bar");
  const [assetType, setAssetType] = useChartType("reports-asset-types", ["pie", "bar"], "pie");
  // "Most active" panel consolidates the county/formation/basin breakdowns into
  // one card with a segmented selector (reference layout).
  const [geoView, setGeoView] = useState<"counties" | "formations" | "basins">("counties");

  // On phones the period tray scrolls sideways: keep the active period in view.
  const periodRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = periodRef.current?.querySelector<HTMLElement>(".seg");
    const active = strip?.querySelector<HTMLElement>(".seg-item.active");
    if (!strip || !active || strip.scrollWidth <= strip.clientWidth + 1) return;
    const a = active.getBoundingClientRect(), st = strip.getBoundingClientRect();
    if (a.left < st.left || a.right > st.right) strip.scrollLeft += a.left - st.left - (st.width - a.width) / 2;
  }, [period]);

  const range = useMemo(() => rangeFor(period, custom), [period, custom]);
  const cmp = useMemo(() => compareRange(compare, range.from, range.to), [compare, range.from, range.to]);

  useEffect(() => {
    api.get<FilterOpts>("/reports/filters").then(setOpts).catch(() => {});
  }, []);

  // One query string (period, comparison, filters) for every analytics call,
  // so the KPI tiles and their drill-downs always read the same records.
  const query = useMemo(() => {
    const qs = new URLSearchParams();
    qs.set("from", range.from); qs.set("to", range.to);
    if (cmp) { qs.set("compareFrom", cmp.from); qs.set("compareTo", cmp.to); }
    for (const [key, vals] of Object.entries(filters)) for (const v of vals) qs.append(key, v);
    return qs.toString();
  }, [range.from, range.to, cmp?.from, cmp?.to, filters]);

  useEffect(() => {
    if (!range.from || !range.to) return;
    setLoading(true);
    // Debounced: rapid filter clicks (each multi-select pick fires this
    // effect) coalesce into one analytics request instead of a burst.
    const t = window.setTimeout(() => {
      api.get<Analytics>(`/reports/analytics?${query}`).then(setData).finally(() => setLoading(false));
    }, 300);
    return () => window.clearTimeout(t);
  }, [query, range.from, range.to]);
  // Cost per Deal / ROI drill-down (which section opens first).
  const [finDrill, setFinDrill] = useState<"cost" | "roi" | null>(null);


  const activeFilterChips = Object.entries(filters).flatMap(([key, vals]) =>
    vals.map((v) => {
      const label = opts?.buyers.find((b) => b.id === v)?.name ?? opts?.users.find((u) => u.id === v)?.name ?? (key === "stages" ? prettyStage(v) : v);
      return `${key}: ${label}`;
    }),
  );

  async function drillByDeal(title: string, pred: (d: DealSummary) => boolean) {
    if (!dealsRef.current) {
      dealsRef.current = await api.get<DealSummary[]>("/deals").catch(() => [] as DealSummary[]);
    }
    setDrill({ title, rows: dealsRef.current.filter(pred) });
  }

  const CHIPS: [Period, string][] = [
    ["THIS_MONTH", "This month"], ["LAST_MONTH", "Last month"], ["THIS_QUARTER", "This quarter"],
    ["LAST_QUARTER", "Last quarter"], ["THIS_YEAR", "This year"], ["LAST_YEAR", "Last year"], ["CUSTOM", "Custom"],
  ];

  const k = data?.kpis;

  /** One KPI cell: value + comparison pill, hint (or the prior value when comparing). */
  function kpiCell(id: MetricId, o: {
    label: string; d?: number | null; invert?: boolean; tone?: StatCell["tone"]; faint?: boolean;
    onClick?: () => void; hint?: string; realized?: boolean;
  }): StatCell {
    const hasDelta = o.d !== undefined && o.d !== null;
    const up = hasDelta && (o.d as number) > 0;
    // Flat = shows as 0.0% (pct() is to one decimal), so a sub-0.05% move
    // never reads as a colored "+0%".
    const flat = hasDelta && Math.abs(o.d as number) < 0.0005;
    // "good" = improvement. For inverted metrics (expenses, losses) up is bad.
    const good = flat ? null : o.invert ? !up : up;
    const text = METRIC_FMT[id](k!);
    return {
      label: o.label,
      tag: o.realized ? <span title="Realized: closed deals and recorded expenses only — no projections">Realized</span> : undefined,
      value: (
        <>
          <span className={`rp-val ${o.faint ? "rp-faint" : ""}`}>{text}</span>
          {hasDelta && (
            <span className={`rp-delta ${good == null ? "flat" : good ? "good" : "bad"}`} title="Change vs the comparison period">
              {flat ? "" : up ? "+" : "−"}{pct(Math.abs(o.d as number))}
            </span>
          )}
        </>
      ),
      tone: o.tone,
      sub: o.hint ?? (data?.previous ? `Prior ${METRIC_FMT[id](data.previous)}` : undefined),
      onClick: o.onClick,
    };
  }

  return (
    <div className="page reports-page">
      <div className="page-header">
        <div>
          <h1>Reports &amp; analytics</h1>
          <div className="page-sub">
            Business performance · {fmtDate(range.from)} – {fmtDate(range.to)} · Generated {fmtDate(new Date())}
          </div>
        </div>
        <div className="reports-toolbar">
          <div className="rp-period-wrap" ref={periodRef}>
            <Segmented accent className="rp-period" ariaLabel="Report period"
              options={CHIPS.map(([value, label]) => ({ value, label }))} value={period} onChange={setPeriod} />
          </div>
          <div className="rp-toolbar-btns">
            <button className={`rbtn ${showFilters || activeFilterChips.length > 0 ? "active" : ""}`} onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5z" /></svg>
              Filters{activeFilterChips.length > 0 && <span className="rbtn-count">{activeFilterChips.length}</span>}
            </button>
            <MetricsCustomize prefs={metricPrefs} onChange={setMetricPrefs} />
          </div>
        </div>
      </div>

      {period === "CUSTOM" && (
        <div className="rp-custom">
          <span>From</span>
          <DateField value={custom.from} onChange={(v) => setCustom((c) => ({ ...c, from: v }))} ariaLabel="From date" />
          <span>to</span>
          <DateField value={custom.to} onChange={(v) => setCustom((c) => ({ ...c, to: v }))} ariaLabel="To date" />
        </div>
      )}

      {/* --- Filters card (not captured in the report) --- */}
      {showFilters && (
        <section className="reports-filters">
          <div className="filters-head">
            <h3>Filters</h3>
            <div className="row" style={{ gap: 12 }}>
              {compare !== "NONE" && <span className="muted">Comparison on</span>}
              <button className="link-btn rp-clear" disabled={activeFilterChips.length === 0} onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>
            </div>
          </div>
          <div className="filters-grid">
            <div className="field"><label>Compare to</label>
              <Select value={compare} onChange={(v) => setCompare(v as Compare)} ariaLabel="Compare to"
                options={[
                  { value: "NONE", label: "No comparison" },
                  { value: "PREV_PERIOD", label: "Previous period" },
                  { value: "PREV_YEAR", label: "Same period last year" },
                ]} />
            </div>
            {/* Shared geographic hierarchy: all 50 states + cascading counties,
                identical to Buyers/Deals/Research. */}
            <GeoFields
              states={filters.states} onStatesChange={(states) => setFilters((f) => ({ ...f, states }))}
              counties={filters.counties} onCountiesChange={(counties) => setFilters((f) => ({ ...f, counties }))}
              labels={{ state: "States", county: "Counties" }}
            />
            {opts && ([
              ["basins", "Basins", opts.basins],
              ["formations", "Formations", opts.formations], ["assetTypes", "Asset types", opts.assetTypes],
              ["operators", "Operators", opts.operators], ["stages", "Deal status", opts.stages],
            ] as [string, string, string[]][]).map(([key, label, options]) => (
              <div key={key} className="field">
                <label>{label}</label>
                <SearchableMultiSelect
                  options={key === "stages" ? options.map(prettyStage) : options}
                  value={key === "stages" ? filters[key].map(prettyStage) : filters[key]}
                  onChange={(next) => setFilters((f) => ({ ...f, [key]: key === "stages" ? next.map((s) => s.toUpperCase().replace(/ /g, "_")) : next }))}
                  placeholder={`Filter ${label.toLowerCase()}…`}
                />
              </div>
            ))}
            {opts && (
              <>
                {/* ID-based selection with display labels — the old name→id
                    round-trip picked the wrong record when two buyers/users
                    shared a name. */}
                <div className="field"><label>Buyers</label>
                  <SearchableMultiSelect options={opts.buyers.map((b) => b.id)} labels={idLabels(opts.buyers)}
                    value={filters.buyers} onChange={(ids) => setFilters((f) => ({ ...f, buyers: ids }))} placeholder="Filter buyers…" />
                </div>
                <div className="field"><label>Team members</label>
                  <SearchableMultiSelect options={opts.users.map((u) => u.id)} labels={idLabels(opts.users)}
                    value={filters.users} onChange={(ids) => setFilters((f) => ({ ...f, users: ids }))} placeholder="Filter team…" />
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {loading && !data ? <Spinner label="Building analytics…" /> : !data || !k ? <Banner kind="info">No data.</Banner> : (
        <div ref={reportRef} className="report-capture rp-body">
          {/* --- Executive summary --- */}
          <section className="exec-card">
            <div className={`exec-icon ${user?.organization?.fullLogo ? "has-logo" : ""}`}>
              {user?.organization?.fullLogo
                ? <img src={user.organization.fullLogo} alt={user.organization.name} />
                : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" /></svg>}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="exec-title">{user?.organization?.name ?? "Mineral Hub"} · Business performance report</div>
              <p className="exec-text">
                <b>Executive summary.</b> Over this period the team closed <b>{num(k.dealsClosed)}</b> {k.dealsClosed === 1 ? "deal" : "deals"}{" "}
                generating <b>{money(k.revenue)}</b> in revenue and <b className={k.netProfit >= 0 ? "pos" : "neg"}>{money(k.netProfit)}</b> net profit,
                added <b>{num(k.dealsAdded)}</b> new {k.dealsAdded === 1 ? "deal" : "deals"}, and maintained a <b>{pct(k.winRate)}</b> win rate.
                Total company expenses were <b>{money(k.expenses, { cents: true })}</b> with <b className={k.reimbursementsOutstanding > 0 ? "warn" : undefined}>{money(k.reimbursementsOutstanding, { cents: true })}</b> outstanding in reimbursements
                {k.costPerDeal != null && <> — <b>{money(k.costPerDeal, { cents: true })}</b> per closed deal</>}
                {k.roiMultiple != null && <>, a <b className={k.roiMultiple >= 0 ? "pos" : "neg"}>{fmtMultiple(k.roiMultiple)}</b> return on spend</>}.
                {data.compare && <> Compared to {fmtDate(data.compare.from)} – {fmtDate(data.compare.to)}.</>}
              </p>
              {data.closedWithoutDate > 0 && (
                <p className="exec-text">
                  <b className="warn">{num(data.closedWithoutDate)} closed {data.closedWithoutDate === 1 ? "deal has" : "deals have"} no Closing Date</b> and {data.closedWithoutDate === 1 ? "is" : "are"} not shown — set the Closing Date on the deal to place it in a month.
                </p>
              )}
              {activeFilterChips.length > 0 && (
                <p className="exec-text exec-filters"><b>Filters:</b> {activeFilterChips.join(" · ")}</p>
              )}
            </div>
          </section>

          {k.totalDeals === 0 && (
            <div className="panel">
              <EmptyState title="No deal activity in this period yet">
                These metrics fill in automatically as deals are added and closed. Try a wider date range, or start from the Pipeline.
              </EmptyState>
            </div>
          )}

          {/* --- KPI strips (Customize: choose + order the metrics) --- */}
          {(() => {
            const cells: Record<MetricId, StatCell> = {
              revenue: kpiCell("revenue", { label: "Revenue (gross fees)", d: data.deltas?.revenue, tone: k.revenue < 0 ? "danger" : undefined, onClick: () => drillByDeal("Closed deals", (dd) => dd.stage === "CLOSED") }),
              netProfit: kpiCell("netProfit", { label: "Net profit", d: data.deltas?.netProfit, tone: k.netProfit >= 0 ? "success" : "danger" }),
              grossProfit: kpiCell("grossProfit", { label: "Gross profit", d: data.deltas?.grossProfit, tone: k.grossProfit >= 0 ? "success" : "danger" }),
              expenses: kpiCell("expenses", { label: "Expenses", d: data.deltas?.expenses, invert: true, onClick: () => nav("/expenses") }),
              costPerDeal: kpiCell("costPerDeal", {
                label: "Cost per deal", realized: true, faint: k.costPerDeal == null,
                hint: k.costPerDeal == null ? "No deals closed in this period" : `${money(k.expenses, { cents: true })} expenses ÷ ${num(k.dealsClosed)} closed`,
                d: data.deltas?.costPerDeal, invert: true, onClick: () => setFinDrill("cost"),
              }),
              roi: kpiCell("roi", {
                label: "Return on investment", realized: true, faint: k.roiMultiple == null,
                tone: k.roiMultiple == null ? undefined : k.roiMultiple >= 0 ? "success" : "danger",
                hint: k.roiMultiple == null
                  ? (k.expenses <= 0 ? "No expenses recorded in this period" : "Closed deals have no accepted price yet")
                  : `${money(k.netProfit)} net profit ÷ ${money(k.expenses)} expenses`,
                d: data.deltas?.roiMultiple, onClick: () => setFinDrill("roi"),
              }),
              dealsClosed: kpiCell("dealsClosed", { label: "Deals closed", d: data.deltas?.dealsClosed, onClick: () => drillByDeal("Closed deals", (dd) => dd.stage === "CLOSED") }),
              dealsAdded: kpiCell("dealsAdded", { label: "Deals added", d: data.deltas?.dealsAdded }),
              dealsLost: kpiCell("dealsLost", { label: "Deals lost", d: data.deltas?.dealsLost, invert: true, faint: k.dealsLost === 0, onClick: () => drillByDeal("Lost (dead) deals", (dd) => dd.stage === "DEAD") }),
              winRate: kpiCell("winRate", { label: "Win rate", d: data.deltas?.winRate, tone: "success" }),
              totalDeals: kpiCell("totalDeals", { label: "Total deals", d: data.deltas?.totalDeals, onClick: () => nav("/deals") }),
              totalDealValue: kpiCell("totalDealValue", { label: "Total deal value", d: data.deltas?.totalDealValue }),
              avgDealSize: kpiCell("avgDealSize", { label: "Avg deal size (closed)", d: k.dealsClosed > 0 ? data.deltas?.avgDealSize : undefined }),
              avgTimeToClose: kpiCell("avgTimeToClose", { label: "Avg time to close", d: k.dealsClosed > 0 ? data.deltas?.avgTimeToClose : undefined, invert: true }),
              activeBuyers: kpiCell("activeBuyers", { label: "Active buyers", d: data.deltas?.activeBuyers, onClick: () => nav("/buyers") }),
              newBuyers: kpiCell("newBuyers", { label: "New buyers", d: data.deltas?.newBuyers }),
              buyerActivity: kpiCell("buyerActivity", { label: "Buyer activity", d: data.deltas?.buyerActivity }),
              reimbursementsOutstanding: kpiCell("reimbursementsOutstanding", {
                label: "Reimbursements outstanding", d: data.deltas?.reimbursementsOutstanding, invert: true,
                tone: k.reimbursementsOutstanding > 0 ? "warn" : undefined, onClick: () => nav("/expenses"),
              }),
            };
            const visible = orderedMetrics(metricPrefs).filter((id) => !metricPrefs.hidden.includes(id));
            if (visible.length === 0) {
              return <div className="rp-all-hidden">All metrics are hidden. Use Customize to show them again.</div>;
            }
            return METRIC_GROUPS.map((g) => {
              const ids = visible.filter((id) => g.ids.includes(id));
              if (ids.length === 0) return null;
              return (
                <div className="rp-kgroup" key={g.key}>
                  <div className="rp-kgroup-label">{g.label}</div>
                  <StatStrip min={220} cells={ids.map((id) => cells[id])} />
                </div>
              );
            });
          })()}

          {/* --- Trend + breakdowns --- */}
          <div className="chart-grid">
            <section className="panel rp-chart">
              <div className="rp-chart-head">
                <div>
                  <h3>Revenue &amp; net profit</h3>
                  <span className="rp-chart-sub">Monthly{data.series.some((s) => s.forecast) ? " · faded bars and dashed line are forecast" : ""}</span>
                </div>
              </div>
              <TrendChart series={data.series} />
              <div className="cl">
                <span className="cl-item"><span className="cl-dot" style={{ background: COLOR_REVENUE }} />Revenue</span>
                <span className="cl-item"><span className="cl-line" style={{ background: COLOR_PROFIT }} />Net profit</span>
                {data.series.some((s) => s.forecast) && <span className="cl-item"><span className="cl-line dashed" />Forecast</span>}
              </div>
            </section>
            <section className="panel rp-chart">
              <div className="rp-chart-head">
                <h3>Deals added vs closed</h3>
                <ChartTypeToggle type={activityType} options={["bar", "line"]} onChange={setActivityType} />
              </div>
              {(() => {
                const rows = data.series.filter((s) => !s.forecast).map((s) => ({ ...s, label: monthLabel(s.month) }));
                const Wrap = activityType === "line" ? LineChart : BarChart;
                return (
                  <ResponsiveContainer width="100%" height={240}>
                    <Wrap data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--line-faint)" />
                      <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} />
                      <Tooltip {...chartTooltip} cursor={{ fill: "var(--chart-col-hover)", stroke: "var(--line-strong)" }} />
                      {activityType === "line" ? (
                        <>
                          <Line type="monotone" dataKey="dealsAdded" name="Added" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} />
                          <Line type="monotone" dataKey="dealsClosed" name="Closed" stroke={CHART_COLORS[1]} strokeWidth={2} dot={false} />
                          <Line type="monotone" dataKey="dealsLost" name="Lost" stroke={CHART_COLORS[4]} strokeWidth={2} dot={false} />
                        </>
                      ) : (
                        <>
                          <Bar dataKey="dealsAdded" name="Added" fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} maxBarSize={18} />
                          <Bar dataKey="dealsClosed" name="Closed" fill={CHART_COLORS[1]} radius={[3, 3, 0, 0]} maxBarSize={18} />
                          <Bar dataKey="dealsLost" name="Lost" fill={CHART_COLORS[4]} radius={[3, 3, 0, 0]} maxBarSize={18} />
                        </>
                      )}
                    </Wrap>
                  </ResponsiveContainer>
                );
              })()}
              <div className="cl">
                <span className="cl-item"><span className="cl-dot" style={{ background: CHART_COLORS[0] }} />Added</span>
                <span className="cl-item"><span className="cl-dot" style={{ background: CHART_COLORS[1] }} />Closed</span>
                <span className="cl-item"><span className="cl-dot" style={{ background: CHART_COLORS[4] }} />Lost</span>
              </div>
            </section>
            <section className="panel rp-chart">
              <div className="rp-chart-head">
                <h3>Asset type breakdown</h3>
                {data.breakdowns.assetTypes.length > 0 && <ChartTypeToggle type={assetType} options={["pie", "bar"]} onChange={setAssetType} />}
              </div>
              {data.breakdowns.assetTypes.length === 0 ? <p className="rp-empty">No deals were added in this period.</p> : assetType === "bar" ? (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={data.breakdowns.assetTypes} layout="vertical" margin={{ left: 8, right: 8 }}>
                    <CartesianGrid horizontal={false} stroke="var(--line-faint)" />
                    <XAxis type="number" allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ ...AXIS_TICK, fill: "var(--ink-2)" }} axisLine={false} tickLine={false} width={110} />
                    <Tooltip {...chartTooltip} cursor={{ fill: "var(--chart-col-hover)" }} />
                    <Bar dataKey="count" name="Deals" radius={[0, 4, 4, 0]} maxBarSize={22} cursor="pointer"
                      onClick={(e: { name?: string }) => e?.name && drillByDeal(`Asset type: ${e.name}`, (dd) => dd.assetTypes.includes(e.name!))}>
                      {data.breakdowns.assetTypes.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={data.breakdowns.assetTypes} dataKey="count" nameKey="name" cx="50%" cy="50%" innerRadius={52} outerRadius={85} paddingAngle={1} stroke="none"
                      label={(e: { name?: string }) => e.name ?? ""}
                      onClick={(e: { name?: string }) => e?.name && drillByDeal(`Asset type: ${e.name}`, (dd) => dd.assetTypes.includes(e.name!))}>
                      {data.breakdowns.assetTypes.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} style={{ cursor: "pointer" }} />)}
                    </Pie>
                    <Tooltip {...chartTooltip} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </section>
            <section className="panel rp-chart">
              <div className="rp-chart-head">
                <h3>Most active</h3>
                <Segmented ariaLabel="Breakdown dimension" value={geoView} onChange={setGeoView}
                  options={[{ value: "counties", label: "Counties" }, { value: "formations", label: "Formations" }, { value: "basins", label: "Basins" }]} />
              </div>
              {geoView === "counties" && <RankedRows data={data.breakdowns.counties} onClick={(name) => drillByDeal(`County: ${name}`, (dd) => dd.counties.includes(name))} />}
              {geoView === "formations" && <RankedRows data={data.breakdowns.formations} onClick={(name) => drillByDeal(`Formation: ${name}`, (dd) => dd.formations.includes(name))} />}
              {geoView === "basins" && <RankedRows data={data.breakdowns.basins} onClick={(name) => drillByDeal(`Basin: ${name}`, (dd) => dd.basins.includes(name))} />}
            </section>
          </div>
        </div>
      )}

      {finDrill && (
        <FinancialsDrill query={query} focus={finDrill} onClose={() => setFinDrill(null)}
          onOpenDeal={(id) => { setFinDrill(null); nav(`/deals/${id}`); }} onOpenExpenses={() => { setFinDrill(null); nav("/expenses"); }} />
      )}
      {drill && (
        <Modal title={`${drill.title} (${drill.rows.length})`} onClose={() => setDrill(null)} wide>
          <DrillTable rows={drill.rows} onOpen={(id) => { setDrill(null); nav(`/deals/${id}`); }} />
        </Modal>
      )}
    </div>
  );
}

/** Customize popover for the Reports KPI strips (show/hide + reorder metrics within each group). */
function MetricsCustomize({ prefs, onChange }: { prefs: MetricPrefs; onChange: (p: MetricPrefs) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const ordered = orderedMetrics(prefs);
  const toggle = (id: MetricId) => onChange({ ...prefs, hidden: prefs.hidden.includes(id) ? prefs.hidden.filter((k) => k !== id) : [...prefs.hidden, id] });
  // Drag-and-drop reorder (within a group — the strips are grouped).
  const [dragId, setDragId] = useState<MetricId | null>(null);
  const [overId, setOverId] = useState<MetricId | null>(null);
  const reorder = (from: MetricId, to: MetricId) => {
    if (from === to || groupOf(from) !== groupOf(to)) return;
    const keys = [...ordered];
    const fi = keys.indexOf(from), ti = keys.indexOf(to);
    if (fi < 0 || ti < 0) return;
    keys.splice(fi, 1); keys.splice(ti, 0, from);
    onChange({ ...prefs, order: keys });
  };
  /** ↑/↓: swap with the neighbouring metric of the same group. */
  const move = (id: MetricId, dir: -1 | 1) => {
    const seq = ordered.filter((x) => groupOf(x) === groupOf(id));
    const other = seq[seq.indexOf(id) + dir];
    if (!other) return;
    const keys = [...ordered];
    const a = keys.indexOf(id), b = keys.indexOf(other);
    [keys[a], keys[b]] = [keys[b], keys[a]];
    onChange({ ...prefs, order: keys });
  };
  const isDefault = prefs.order.length === 0 && prefs.hidden.length === 0;
  const shown = DEFAULT_METRICS.filter((id) => !prefs.hidden.includes(id)).length;

  return (
    <div className="cv-wrap" ref={ref}>
      <button type="button" className={`rbtn cv-btn ${open ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title="Customize metrics" aria-expanded={open}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" /></svg>
        Customize
      </button>
      {open && (
        <div className="cv-menu rp-cust" role="dialog" aria-label="Customize metrics">
          <div className="cv-head"><strong>Metrics</strong><span className="rp-cust-n">{shown} of {DEFAULT_METRICS.length} shown</span></div>
          <div className="cv-list">
            {METRIC_GROUPS.map((g) => {
              const seq = ordered.filter((id) => groupOf(id) === g.key);
              return (
                <div className="rp-cust-group" key={g.key}>
                  <div className="rp-cust-glabel">{g.label}</div>
                  {seq.map((id, i) => (
                    <div key={id}
                      className={`cv-row ${dragId === id ? "dragging" : ""} ${overId === id && dragId && dragId !== id && groupOf(dragId) === g.key ? "drop-over" : ""}`}
                      onDragOver={(e) => { if (!dragId || groupOf(dragId) !== g.key) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overId !== id) setOverId(id); }}
                      onDrop={(e) => { e.preventDefault(); if (dragId) reorder(dragId, id); setDragId(null); setOverId(null); }}
                    >
                      <span className="cv-drag" title="Drag to reorder" aria-label="Drag to reorder" draggable
                        onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = "move"; }}
                        onDragEnd={() => { setDragId(null); setOverId(null); }}>⠿</span>
                      <label className="cv-check">
                        <input type="checkbox" checked={!prefs.hidden.includes(id)} onChange={() => toggle(id)} />
                        <span>{METRIC_LABELS[id]}</span>
                      </label>
                      <span className="rp-cust-move">
                        <button type="button" aria-label={`Move ${METRIC_LABELS[id]} up`} disabled={i === 0} onClick={() => move(id, -1)}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>
                        </button>
                        <button type="button" aria-label={`Move ${METRIC_LABELS[id]} down`} disabled={i === seq.length - 1} onClick={() => move(id, 1)}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="cv-foot">
            <span />
            <button type="button" className="small" disabled={isDefault} onClick={() => onChange({ order: [], hidden: [] })}>Restore defaults</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface TrendRow { label: string; revenue: number; netProfit: number | null; netProfitF: number | null; expenses: number | null; forecast: boolean }

/** Hover card for the revenue chart: the month's revenue, expenses (actual months) and net profit. */
function TrendTip({ active, payload }: { active?: boolean; payload?: { payload: TrendRow }[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  const net = r.netProfit ?? r.netProfitF;
  return (
    <div className="rp-tip">
      <div className="rp-tip-t">{r.label}{r.forecast ? " · forecast" : ""}</div>
      <div className="rp-tip-row"><span><i style={{ background: COLOR_REVENUE }} />Revenue</span><b>{money(r.revenue)}</b></div>
      {r.expenses != null && <div className="rp-tip-row"><span><i style={{ background: "var(--ink-4)" }} />Expenses</span><b>{money(r.expenses)}</b></div>}
      {net != null && <div className="rp-tip-row"><span><i style={{ background: COLOR_PROFIT }} />Net profit</span><b className={net < 0 ? "neg" : undefined}>{money(net)}</b></div>}
    </div>
  );
}

function TrendChart({ series }: { series: MonthPoint[] }) {
  const lastActual = series.reduce((idx, s, i) => (!s.forecast ? i : idx), 0);
  const rows: TrendRow[] = series.map((s, i) => ({
    label: monthLabel(s.month),
    revenue: s.revenue,
    netProfit: s.forecast ? null : s.netProfit,
    // The forecast line connects from the last actual point.
    netProfitF: s.forecast || i === lastActual ? s.netProfit : null,
    expenses: s.forecast ? null : s.expenses,
    forecast: Boolean(s.forecast),
  }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--line-faint)" />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={axisMoney} tick={AXIS_TICK} axisLine={false} tickLine={false} width={52} />
        <ReferenceLine y={0} stroke="var(--line-hover)" />
        <Tooltip content={<TrendTip />} cursor={{ fill: "var(--chart-col-hover)" }} isAnimationActive={false} wrapperStyle={{ outline: "none", zIndex: 50 }} />
        <Bar dataKey="revenue" name="Revenue" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={COLOR_REVENUE} fillOpacity={r.forecast ? 0.22 : 1}
              stroke={r.forecast ? COLOR_REVENUE : "none"} strokeDasharray={r.forecast ? "3 3" : undefined} strokeWidth={r.forecast ? 1 : 0} />
          ))}
        </Bar>
        <Line type="linear" dataKey="netProfit" name="Net profit" stroke={COLOR_PROFIT} strokeWidth={2.2} dot={false} connectNulls isAnimationActive={false} />
        <Line type="linear" dataKey="netProfitF" name="Net profit (forecast)" stroke={COLOR_PROFIT} strokeOpacity={0.8} strokeDasharray="5 4" strokeWidth={2.2} dot={false} connectNulls legendType="none" isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Ranked breakdown rows (Most active); clicking a row drills into its deals. */
function RankedRows({ data, onClick }: { data: { name: string; count: number }[]; onClick?: (name: string) => void }) {
  if (data.length === 0) return <p className="rp-empty">No activity in this period.</p>;
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="rp-rank">
      {data.map((d, i) => (
        <button type="button" key={d.name} className="rp-rank-row" onClick={() => onClick?.(d.name)} title={`Show deals: ${d.name}`}>
          <span className="rp-rank-n">{i + 1}</span>
          <span className="rp-rank-l">{d.name}</span>
          <span className="rp-rank-bar"><i className={i === 0 ? "top" : ""} style={{ width: `${(d.count / max) * 100}%` }} /></span>
          <span className="rp-rank-c"><b>{num(d.count)}</b> {d.count === 1 ? "deal" : "deals"}</span>
        </button>
      ))}
    </div>
  );
}

function DrillTable({ rows, onOpen }: { rows: DealSummary[]; onOpen: (id: string) => void }) {
  const { label: stageLabel } = useStages();
  const cols: Column<DealSummary>[] = [
    { key: "name", header: "Deal", type: "text", value: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
    { key: "stage", header: "Stage", type: "text", value: (r) => r.stage, render: (r) => stageLabel(r.stage) },
    { key: "loc", header: "Counties", type: "text", value: (r) => r.counties.join(", "), render: (r) => <ChipList items={r.counties} max={4} /> },
    { key: "ask", header: "Ask", type: "number", align: "right", value: (r) => r.askPrice, render: (r) => money(r.askPrice) },
    { key: "buyer", header: "Buyer", type: "text", value: (r) => r.selectedBuyer?.name ?? "" },
  ];
  return <SortableTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => onOpen(r.id)} empty="No matching deals." />;
}

/**
 * Cost per Deal & ROI drill-down: the formula with its inputs, then the exact
 * records behind it — every deal closed in the period and every expense dated
 * in it — for the report's current period and filters. Realized results only.
 */
function FinancialsDrill({ query, focus, onClose, onOpenDeal, onOpenExpenses }: {
  query: string; focus: "cost" | "roi"; onClose: () => void; onOpenDeal: (id: string) => void; onOpenExpenses: () => void;
}) {
  const [data, setData] = useState<Financials | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<"deals" | "expenses">(focus === "cost" ? "expenses" : "deals");
  useEffect(() => {
    let live = true;
    api.get<Financials>(`/reports/analytics/financials?${query}`)
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [query]);

  const t = data?.totals;
  const dealCols: Column<Financials["closedDeals"][number]>[] = [
    { key: "name", header: "Deal", type: "text", value: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
    { key: "closed", header: "Closed", type: "date", value: (r) => r.closedAt, render: (r) => fmtDateLocal(r.closedAt) },
    { key: "accepted", header: "Accepted", type: "number", align: "right", value: (r) => r.acceptedAmount, render: (r) => r.acceptedAmount == null ? <span className="muted">No accepted offer</span> : money(r.acceptedAmount) },
    { key: "cost", header: "Cost Basis", type: "number", align: "right", value: (r) => r.costBasis, render: (r) => money(r.costBasis) },
    { key: "revenue", header: "Revenue", type: "number", align: "right", value: (r) => r.revenue, render: (r) => money(r.revenue) },
    { key: "closing", header: "Closing Costs", type: "number", align: "right", value: (r) => r.closingCosts, render: (r) => money(r.closingCosts) },
    { key: "gross", header: "Gross Profit", type: "number", align: "right", value: (r) => r.grossProfit,
      render: (r) => r.grossProfit == null ? "—" : <span className={r.grossProfit < 0 ? "profit-neg" : "profit-pos"}>{money(r.grossProfit)}</span> },
  ];
  const expenseCols: Column<NonNullable<Financials["expenses"]>[number]>[] = [
    { key: "date", header: "Date", type: "date", value: (r) => r.date, render: (r) => fmtDate(r.date) },
    { key: "category", header: "Category", type: "text", value: (r) => r.category ?? "", render: (r) => r.category ?? <span className="muted">Uncategorized</span> },
    { key: "notes", header: "Notes", type: "text", value: (r) => r.notes ?? "", render: (r) => <span className="exp-notes">{r.notes ?? "—"}</span> },
    { key: "by", header: "Submitted By", type: "text", value: (r) => r.submittedBy ?? "" },
    { key: "reimbursed", header: "Reimbursed", type: "text", value: (r) => (r.reimbursed ? "Yes" : "No") },
    { key: "amount", header: "Amount", type: "number", align: "right", value: (r) => r.amount, render: (r) => money(r.amount, { cents: true }) },
  ];

  return (
    <Modal title="Cost per Deal & Return on Investment" wide onClose={onClose}
      subtitle={data ? <>{fmtDate(data.range.from)} – {fmtDate(data.range.to)} · realized results with the report's filters</> : undefined}>
      {error ? <Banner kind="error">Could not load the financial records for this period.</Banner> : !data || !t ? <Spinner label="Loading financial records…" /> : (
        <>
          <div className="fin-formulas">
            <div className="fin-formula">
              <div className="ddx-label">Cost per Deal</div>
              <div className="fin-formula-v">{t.costPerDeal == null ? "N/A" : money(t.costPerDeal, { cents: true })}</div>
              <div className="fin-formula-x">
                {t.costPerDeal == null
                  ? <>No deals closed in this period, so there is nothing to divide {money(t.expenses, { cents: true })} of expenses across.</>
                  : <>{money(t.expenses, { cents: true })} total expenses ÷ {num(t.dealsClosed)} {t.dealsClosed === 1 ? "deal" : "deals"} closed</>}
              </div>
            </div>
            <div className="fin-formula">
              <div className="ddx-label">Return on Investment</div>
              <div className="fin-formula-v" style={{ color: t.roiMultiple == null ? undefined : t.roiMultiple >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMultiple(t.roiMultiple)}</div>
              <div className="fin-formula-x">
                {t.roiMultiple == null
                  ? (t.expenses <= 0 ? <>No expenses recorded in this period — a multiple can't be calculated.</> : <>No closed deal has an accepted price, so revenue can't be measured yet.</>)
                  : <>{money(t.netProfit)} net profit after expenses ÷ {money(t.expenses)} total expenses</>}
              </div>
            </div>
          </div>
          <div className="fin-recon" aria-label="Net profit reconciliation">
            <span>Revenue (Gross Fees) <b>{money(t.revenue, { cents: true })}</b></span>
            <span>− Closing Costs <b>{money(t.closingCosts, { cents: true })}</b></span>
            <span>− Expenses <b>{money(t.expenses, { cents: true })}</b></span>
            <span>= Net Profit <b className={t.netProfit < 0 ? "profit-neg" : "profit-pos"}>{money(t.netProfit, { cents: true })}</b></span>
          </div>
          <p className="muted fin-note">
            Realized results only: deals closed in this period and expenses dated in it. Open deals, projected profit and forecasts are excluded.
            {t.closedWithoutPrice > 0 && <> <b style={{ color: "var(--amber)" }}>{num(t.closedWithoutPrice)} closed {t.closedWithoutPrice === 1 ? "deal has" : "deals have"} no accepted offer</b> and {t.closedWithoutPrice === 1 ? "adds" : "add"} no revenue.</>}
            {t.closedWithoutDate > 0 && <> <b style={{ color: "var(--amber)" }}>{num(t.closedWithoutDate)} closed {t.closedWithoutDate === 1 ? "deal has" : "deals have"} no Closing Date</b> and {t.closedWithoutDate === 1 ? "is" : "are"} not shown in any period.</>}
          </p>
          <div className="seg-control subtle" role="tablist" aria-label="Records" style={{ marginBottom: 12 }}>
            <button role="tab" aria-selected={tab === "deals"} className={`seg ${tab === "deals" ? "active" : ""}`} onClick={() => setTab("deals")}>Closed deals ({data.closedDeals.length})</button>
            {data.expenses && <button role="tab" aria-selected={tab === "expenses"} className={`seg ${tab === "expenses" ? "active" : ""}`} onClick={() => setTab("expenses")}>Expenses ({data.expenses.length})</button>}
          </div>
          {tab === "deals" || !data.expenses
            ? <SortableTable columns={dealCols} rows={data.closedDeals} rowKey={(r) => r.id} onRowClick={(r) => onOpenDeal(r.id)} empty="No deals closed in this period." />
            : <SortableTable columns={expenseCols} rows={data.expenses} rowKey={(r) => r.id} onRowClick={() => onOpenExpenses()} empty="No expenses recorded in this period." />}
        </>
      )}
    </Modal>
  );
}
