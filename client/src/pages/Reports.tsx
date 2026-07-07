import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  BarChart, PieChart, Pie, Cell,
} from "recharts";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Banner, Modal } from "../components/ui";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { SortableTable, type Column } from "../components/SortableTable";
import { money, pct, num, fmtDate, prettyStage } from "../lib/format";
import { CHART_COLORS, COLOR_REVENUE, COLOR_PROFIT, COLOR_FORECAST, monthLabel, chartTooltip } from "../lib/charts";
import { exportElementToPdf } from "../lib/pdf";
import type { DealSummary } from "../types";

interface Kpis {
  totalDeals: number; dealsAdded: number; dealsClosed: number; dealsLost: number; winRate: number;
  totalDealValue: number; avgDealSize: number; avgTimeToClose: number; revenue: number; grossProfit: number;
  netProfit: number; expenses: number; closingCosts: number; reimbursementsOutstanding: number;
  activeBuyers: number; newBuyers: number; buyerActivity: number;
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

const EMPTY_FILTERS: Record<string, string[]> = { counties: [], basins: [], formations: [], assetTypes: [], operators: [], stages: [], buyers: [], users: [] };

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

export function Reports() {
  const nav = useNavigate();
  const { can, user } = useAuth();
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
  const [exporting, setExporting] = useState(false);
  const [drill, setDrill] = useState<{ title: string; rows: DealSummary[] } | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  const range = useMemo(() => rangeFor(period, custom), [period, custom]);
  const cmp = useMemo(() => compareRange(compare, range.from, range.to), [compare, range.from, range.to]);

  useEffect(() => {
    api.get<FilterOpts>("/reports/filters").then(setOpts).catch(() => {});
  }, []);

  useEffect(() => {
    if (!range.from || !range.to) return;
    setLoading(true);
    // Debounced: rapid filter clicks (each multi-select pick fires this
    // effect) coalesce into one analytics request instead of a burst.
    const t = window.setTimeout(() => {
      const qs = new URLSearchParams();
      qs.set("from", range.from); qs.set("to", range.to);
      if (cmp) { qs.set("compareFrom", cmp.from); qs.set("compareTo", cmp.to); }
      for (const [key, vals] of Object.entries(filters)) for (const v of vals) qs.append(key, v);
      api.get<Analytics>(`/reports/analytics?${qs.toString()}`).then(setData).finally(() => setLoading(false));
    }, 300);
    return () => window.clearTimeout(t);
  }, [range.from, range.to, cmp?.from, cmp?.to, filters]);

  async function onExport() {
    if (!reportRef.current) return;
    setExporting(true);
    try { await exportElementToPdf(reportRef.current, `mineral-hub-report-${range.from}_to_${range.to}.pdf`); }
    finally { setExporting(false); }
  }

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
    ["THIS_MONTH", "This Month"], ["LAST_MONTH", "Last Month"], ["THIS_QUARTER", "This Quarter"],
    ["LAST_QUARTER", "Last Quarter"], ["THIS_YEAR", "This Year"], ["LAST_YEAR", "Last Year"], ["CUSTOM", "Custom"],
  ];

  const k = data?.kpis;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Reports & Analytics</h1>
        {can("exportReports") && <button className="primary" onClick={onExport} disabled={exporting || !data}>{exporting ? "Generating…" : "Export PDF"}</button>}
      </div>

      {/* --- Controls (not captured in PDF) --- */}
      <div className="panel">
        <div className="chip-row" style={{ marginBottom: 10 }}>
          {CHIPS.map(([p, label]) => <span key={p} className={`chip ${period === p ? "active" : ""}`} onClick={() => setPeriod(p)}>{label}</span>)}
        </div>
        {period === "CUSTOM" && (
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field" style={{ marginBottom: 0 }}><label>From</label><input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>To</label><input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></div>
          </div>
        )}
        {/* Advanced filters collapse by default — only date presets show up front. */}
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <button className="small" onClick={() => setShowFilters((s) => !s)}>
            {showFilters ? "▾" : "▸"} Filters{activeFilterChips.length > 0 ? ` (${activeFilterChips.length})` : ""}
          </button>
          {compare !== "NONE" && <span className="muted" style={{ fontSize: 12 }}>Comparison on</span>}
          {activeFilterChips.length > 0 && <button className="small" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>}
        </div>
        {showFilters && (
        <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginTop: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}><label>Compare to</label>
            <select value={compare} onChange={(e) => setCompare(e.target.value as Compare)}>
              <option value="NONE">No comparison</option>
              <option value="PREV_PERIOD">Previous period</option>
              <option value="PREV_YEAR">Previous year</option>
            </select>
          </div>
          {opts && ([
            ["counties", "Counties", opts.counties], ["basins", "Basins", opts.basins],
            ["formations", "Formations", opts.formations], ["assetTypes", "Asset types", opts.assetTypes],
            ["operators", "Operators", opts.operators], ["stages", "Deal status", opts.stages],
          ] as [string, string, string[]][]).map(([key, label, options]) => (
            <div key={key} className="field" style={{ marginBottom: 0, minWidth: 190, flex: 1 }}>
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
              <div className="field" style={{ marginBottom: 0, minWidth: 190, flex: 1 }}><label>Buyers</label>
                <SearchableMultiSelect options={opts.buyers.map((b) => b.id)} labels={idLabels(opts.buyers)}
                  value={filters.buyers} onChange={(ids) => setFilters((f) => ({ ...f, buyers: ids }))} placeholder="Filter buyers…" />
              </div>
              <div className="field" style={{ marginBottom: 0, minWidth: 190, flex: 1 }}><label>Team members</label>
                <SearchableMultiSelect options={opts.users.map((u) => u.id)} labels={idLabels(opts.users)}
                  value={filters.users} onChange={(ids) => setFilters((f) => ({ ...f, users: ids }))} placeholder="Filter team…" />
              </div>
            </>
          )}
        </div>
        )}
      </div>

      {loading && !data ? <Spinner label="Building analytics…" /> : !data || !k ? <Banner kind="info">No data.</Banner> : (
        <div ref={reportRef} className="report-capture">
          {/* --- Report header (captured in PDF) --- */}
          <div className="report-header panel">
            {user?.organization?.fullLogo
              ? <img src={user.organization.fullLogo} alt={user.organization.name} style={{ maxHeight: 44, maxWidth: 220, objectFit: "contain", display: "block" }} />
              : <div className="brand" style={{ fontSize: 20 }}>Mineral Hub<span className="dot">.</span></div>}
            <h2 style={{ margin: "6px 0 2px" }}>Business Performance Report</h2>
            <p className="muted" style={{ margin: 0 }}>
              Period: {fmtDate(range.from)} – {fmtDate(range.to)}
              {data.compare && <> · Compared to {fmtDate(data.compare.from)} – {fmtDate(data.compare.to)}</>}
            </p>
            <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>Generated {fmtDate(new Date())}</p>
            {activeFilterChips.length > 0 && (
              <p style={{ margin: "10px 0 0", fontSize: 12 }}><strong>Filters:</strong> {activeFilterChips.join(" · ")}</p>
            )}
            <p style={{ marginBottom: 0, marginTop: 10 }}>
              <strong>Executive summary.</strong> Over this period the team closed <strong>{num(k.dealsClosed)}</strong> {k.dealsClosed === 1 ? "deal" : "deals"}{" "}
              generating <strong>{money(k.revenue)}</strong> in revenue and <strong>{money(k.netProfit)}</strong> net profit,
              added <strong>{num(k.dealsAdded)}</strong> new {k.dealsAdded === 1 ? "deal" : "deals"}, and maintained a <strong>{pct(k.winRate)}</strong> win rate.
              Total company expenses were <strong>{money(k.expenses)}</strong> with <strong>{money(k.reimbursementsOutstanding)}</strong> outstanding in reimbursements.
            </p>
            {k.totalDeals === 0 && (
              <Banner kind="info">
                No deal activity in this period yet — these metrics fill in automatically as deals are added and closed. Try a wider date range, or start from the Pipeline.
              </Banner>
            )}
          </div>

          {/* --- KPI grid --- */}
          <div className="metrics-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
            <Kpi label="Revenue (Gross Fees)" value={money(k.revenue)} d={data.deltas?.revenue} onClick={() => drillByDeal("Closed deals", (dd) => dd.stage === "CLOSED")} />
            <Kpi label="Net Profit" value={money(k.netProfit)} d={data.deltas?.netProfit} />
            <Kpi label="Gross Profit" value={money(k.grossProfit)} d={data.deltas?.grossProfit} />
            <Kpi label="Expenses" value={money(k.expenses)} d={data.deltas?.expenses} invert onClick={() => nav("/expenses")} />
            <Kpi label="Deals Closed" value={num(k.dealsClosed)} d={data.deltas?.dealsClosed} onClick={() => drillByDeal("Closed deals", (dd) => dd.stage === "CLOSED")} />
            <Kpi label="Deals Added" value={num(k.dealsAdded)} d={data.deltas?.dealsAdded} />
            <Kpi label="Deals Lost" value={num(k.dealsLost)} d={data.deltas?.dealsLost} invert onClick={() => drillByDeal("Lost (dead) deals", (dd) => dd.stage === "DEAD")} />
            <Kpi label="Win Rate" value={pct(k.winRate)} d={data.deltas?.winRate} />
            <Kpi label="Total Deals" value={num(k.totalDeals)} d={data.deltas?.totalDeals} onClick={() => nav("/deals")} />
            <Kpi label="Total Deal Value" value={money(k.totalDealValue)} d={data.deltas?.totalDealValue} />
            <Kpi label="Avg Deal Size" value={money(k.avgDealSize)} d={data.deltas?.avgDealSize} />
            <Kpi label="Avg Time to Close" value={`${Math.round(k.avgTimeToClose)}d`} d={data.deltas?.avgTimeToClose} invert />
            <Kpi label="Active Buyers" value={num(k.activeBuyers)} d={data.deltas?.activeBuyers} onClick={() => nav("/buyers")} />
            <Kpi label="New Buyers" value={num(k.newBuyers)} d={data.deltas?.newBuyers} />
            <Kpi label="Buyer Activity" value={num(k.buyerActivity)} d={data.deltas?.buyerActivity} />
            <Kpi label="Reimbursements Outstanding" value={money(k.reimbursementsOutstanding)} d={data.deltas?.reimbursementsOutstanding} invert onClick={() => nav("/expenses")} />
          </div>

          {/* --- Trend + breakdowns --- */}
          <div className="chart-grid">
            <div className="panel">
              <h3>Revenue & Net Profit Trend <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(dashed = forecast)</span></h3>
              <TrendChart series={data.series} />
            </div>
            <div className="panel">
              <h3>Deals Added vs Closed</h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.series.filter((s) => !s.forecast).map((s) => ({ ...s, label: monthLabel(s.month) }))}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip {...chartTooltip} />
                  <Legend />
                  <Bar dataKey="dealsAdded" name="Added" fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="dealsClosed" name="Closed" fill={CHART_COLORS[1]} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="dealsLost" name="Lost" fill={CHART_COLORS[4]} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="panel">
              <h3>Asset Type Breakdown</h3>
              {data.breakdowns.assetTypes.length === 0 ? <p className="muted">No data.</p> : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={data.breakdowns.assetTypes} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={85}
                      label={(e: { name?: string }) => e.name ?? ""}
                      onClick={(e: { name?: string }) => e?.name && drillByDeal(`Asset type: ${e.name}`, (dd) => dd.assetTypes.includes(e.name!))}>
                      {data.breakdowns.assetTypes.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} style={{ cursor: "pointer" }} />)}
                    </Pie>
                    <Tooltip {...chartTooltip} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="panel">
              <h3>Most Active Counties</h3>
              <BreakdownBars data={data.breakdowns.counties} onClick={(name) => drillByDeal(`County: ${name}`, (dd) => dd.counties.includes(name))} />
            </div>
            <div className="panel">
              <h3>Most Active Formations</h3>
              <BreakdownBars data={data.breakdowns.formations} color={CHART_COLORS[3]} onClick={(name) => drillByDeal(`Formation: ${name}`, (dd) => dd.formations.includes(name))} />
            </div>
            <div className="panel">
              <h3>Most Active Basins</h3>
              <BreakdownBars data={data.breakdowns.basins} color={CHART_COLORS[5]} onClick={(name) => drillByDeal(`Basin: ${name}`, (dd) => dd.basins.includes(name))} />
            </div>
          </div>
        </div>
      )}

      {drill && (
        <Modal title={`${drill.title} (${drill.rows.length})`} onClose={() => setDrill(null)} wide>
          <DrillTable rows={drill.rows} onOpen={(id) => { setDrill(null); nav(`/deals/${id}`); }} />
        </Modal>
      )}
    </div>
  );
}

function Kpi({ label, value, d, invert, onClick }: { label: string; value: string; d?: number | null; invert?: boolean; onClick?: () => void }) {
  const hasDelta = d !== undefined && d !== null;
  const up = hasDelta && (d as number) > 0;
  const flat = hasDelta && (d as number) === 0;
  // "good" = improvement. For inverted metrics (expenses, losses) up is bad.
  const good = flat ? null : invert ? !up : up;
  const color = good == null ? "var(--text-dim)" : good ? "#22c55e" : "#ef4444";
  const arrow = flat ? "→" : up ? "▲" : "▼";
  return (
    <div className="metric-card" style={onClick ? { cursor: "pointer" } : undefined} onClick={onClick}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {hasDelta && <div className="metric-hint" style={{ color }}>{arrow} {pct(Math.abs(d as number))} vs prior</div>}
    </div>
  );
}

function TrendChart({ series }: { series: MonthPoint[] }) {
  const lastActual = series.reduce((idx, s, i) => (!s.forecast ? i : idx), 0);
  const rows = series.map((s, i) => ({
    label: monthLabel(s.month),
    revenue: s.forecast ? null : s.revenue,
    netProfit: s.forecast ? null : s.netProfit,
    // Forecast lines connect from the last actual point.
    revenueF: s.forecast || i === lastActual ? s.revenue : null,
    netProfitF: s.forecast || i === lastActual ? s.netProfit : null,
  }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={rows}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={(v) => money(v)} tick={{ fontSize: 11 }} width={70} />
        <Tooltip {...chartTooltip} formatter={(v: number) => money(v)} />
        <Legend />
        <Line type="monotone" dataKey="revenue" name="Revenue" stroke={COLOR_REVENUE} strokeWidth={2} dot={false} connectNulls />
        <Line type="monotone" dataKey="netProfit" name="Net Profit" stroke={COLOR_PROFIT} strokeWidth={2} dot={false} connectNulls />
        <Line type="monotone" dataKey="revenueF" name="Revenue (forecast)" stroke={COLOR_REVENUE} strokeDasharray="5 4" strokeWidth={2} dot={false} connectNulls legendType="none" />
        <Line type="monotone" dataKey="netProfitF" name="Net Profit (forecast)" stroke={COLOR_FORECAST} strokeDasharray="5 4" strokeWidth={2} dot={false} connectNulls legendType="none" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function BreakdownBars({ data, color = CHART_COLORS[0], onClick }: { data: { name: string; count: number }[]; color?: string; onClick?: (name: string) => void }) {
  if (data.length === 0) return <p className="muted">No data.</p>;
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={110} />
        <Tooltip {...chartTooltip} />
        <Bar dataKey="count" name="Deals" fill={color} radius={[0, 3, 3, 0]} cursor="pointer"
          onClick={(e: { name?: string }) => e?.name && onClick?.(e.name)} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function DrillTable({ rows, onOpen }: { rows: DealSummary[]; onOpen: (id: string) => void }) {
  const cols: Column<DealSummary>[] = [
    { key: "name", header: "Deal", type: "text", value: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
    { key: "stage", header: "Stage", type: "text", value: (r) => r.stage, render: (r) => prettyStage(r.stage) },
    { key: "loc", header: "Counties", type: "text", value: (r) => r.counties.join(", "), render: (r) => r.counties.join(", ") || "—" },
    { key: "ask", header: "Ask", type: "number", align: "right", value: (r) => r.askPrice, render: (r) => money(r.askPrice) },
    { key: "buyer", header: "Buyer", type: "text", value: (r) => r.selectedBuyer?.name ?? "" },
  ];
  return <SortableTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => onOpen(r.id)} empty="No matching deals." />;
}
