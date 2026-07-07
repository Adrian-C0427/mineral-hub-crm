import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, BarChart,
} from "recharts";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Banner, Modal, ConfirmDelete } from "../components/ui";
import { useRowSelection, BulkBar } from "../components/bulk";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { SortableTable, type Column } from "../components/SortableTable";
import { ResearchImport } from "../components/ResearchImport";
import { ResearchChoropleth, type CountyStat } from "../components/ResearchChoropleth";
import { CLASS_COLORS } from "../components/NetworkGraph";
import { downloadCsv } from "../lib/csv";
import { fmtDate, num, prettyEnum } from "../lib/format";
import { CHART_COLORS, chartTooltip } from "../lib/charts";
import { exportElementToPdf } from "../lib/pdf";

/**
 * Research & Market Intelligence — trends in mineral transactions, leasing
 * and drilling activity from imported public records, with hotspot detection
 * and automatically surfaced acquisition opportunities.
 */

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface TrendT { current: number; previous: number; absoluteChange: number; pctChange: number | null; direction: "up" | "down" | "flat" }
interface SeriesPoint { key: string; transactions: number; leases: number; permits: number; total: number; rollingAvg: number }
interface Summary {
  range: { from: string; to: string };
  compare: { from: string; to: string };
  granularity: "day" | "week" | "month";
  kpis: Record<string, number>;
  previous: Record<string, number>;
  trends: Record<string, TrendT>;
  series: SeriesPoint[];
  docTypeBreakdown: { docType: string; count: number }[];
}
interface GeoRow {
  state: string; county: string | null; abstractId: string | null;
  transactions: number; leases: number; permits: number; total: number; previous: number;
  absoluteChange: number; pctChange: number | null; direction: string; zScore: number | null; isHotspot: boolean;
}
interface EntityRow {
  key: string; name: string; count: number; previous: number; absoluteChange: number; pctChange: number | null;
  direction: string; acreage: number; counties: string[]; horizontal: number; newEntrant: boolean;
}
interface Signal {
  id: string; kind: string; severity: number; title: string; detail: string;
  state: string; county: string | null; abstractId: string | null;
  metrics: Record<string, number | null>;
}
interface FilterOpts {
  states: string[]; counties: { state: string; county: string }[]; docTypes: string[];
  buyers: { value: string; label: string }[]; sellers: { value: string; label: string }[]; operators: { value: string; label: string }[];
}
interface DocRecord {
  id: string; state: string; county: string; docTypeRaw: string; docType: string; docClass: string;
  instrumentNumber: string | null; recordingDate: string; grantor: string | null; grantee: string | null;
  abstractId: string | null; survey: string | null; acreage: number | null; consideration: number | null; source: string;
}
interface PermitRecord {
  id: string; state: string; county: string; apiNumber: string | null; permitNumber: string | null;
  operator: string; leaseName: string | null; wellName: string | null; status: string; trajectory: string;
  activityDate: string; formation: string | null; field: string | null; source: string;
}
interface Paged<T> { total: number; page: number; pageSize: number; rows: T[] }

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

type Period = "LAST_30D" | "LAST_90D" | "LAST_6M" | "LAST_12M" | "THIS_YEAR" | "CUSTOM";
type Compare = "PREV_PERIOD" | "PREV_YEAR";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const DAY = 86400000;

function rangeFor(period: Period, custom: { from: string; to: string }): { from: string; to: string } {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (period) {
    case "LAST_30D": return { from: iso(new Date(today.getTime() - 29 * DAY)), to: iso(today) };
    case "LAST_90D": return { from: iso(new Date(today.getTime() - 89 * DAY)), to: iso(today) };
    case "LAST_6M": return { from: iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, today.getUTCDate()))), to: iso(today) };
    case "LAST_12M": return { from: iso(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()))), to: iso(today) };
    case "THIS_YEAR": return { from: iso(new Date(Date.UTC(today.getUTCFullYear(), 0, 1))), to: iso(today) };
    default: return { from: custom.from, to: custom.to };
  }
}

/** For PREV_YEAR we pass explicit compare dates; PREV_PERIOD is the server default. */
function compareParams(mode: Compare, from: string, to: string): { compareFrom?: string; compareTo?: string } {
  if (mode !== "PREV_YEAR" || !from || !to) return {};
  const shift = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return iso(new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()))); };
  return { compareFrom: shift(from), compareTo: shift(to) };
}

const fmtPct = (p: number | null): string => (p == null ? "new" : `${p >= 0 ? "+" : ""}${Math.round(p * 100)}%`);

/** "Apr 9 – Jul 7, 2026" (year shown on the end date only when requested). */
function fmtRangeLabel(from: string, to: string, withYear = true): string {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const md = (s: string) => d(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${md(from)} – ${md(to)}${withYear ? `, ${d(to).getUTCFullYear()}` : ""}`;
}

/** The comparison window shown next to the range (mirrors the server default). */
function compareRangeFor(mode: Compare, from: string, to: string): { from: string; to: string } | null {
  if (!from || !to) return null;
  const cp = compareParams(mode, from, to);
  if (cp.compareFrom && cp.compareTo) return { from: cp.compareFrom, to: cp.compareTo };
  const f = new Date(`${from}T00:00:00Z`).getTime();
  const t = new Date(`${to}T00:00:00Z`).getTime();
  const len = t - f + DAY;
  return { from: iso(new Date(f - len)), to: iso(new Date(f - DAY)) };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

interface Filters {
  state: string;
  counties: string[];
  docTypes: string[];
  buyers: string[];
  sellers: string[];
  operators: string[];
}
const EMPTY_FILTERS: Filters = { state: "", counties: [], docTypes: [], buyers: [], sellers: [], operators: [] };

type Tab = "overview" | "geography" | "rankings" | "relationships" | "opportunities" | "records" | "data";

// ---------------------------------------------------------------------------
// Relationship-intelligence API types
// ---------------------------------------------------------------------------

interface RelRow {
  grantorNorm: string; grantor: string; granteeNorm: string; grantee: string;
  count: number; transactions: number; counties: string[]; abstracts: string[];
  firstDate: string | null; lastDate: string | null;
}
interface CoBuyerRow { members: { norm: string; name: string }[]; count: number; counties: string[] }
interface ChainNode { norm: string; name: string; klass: string }
interface ChainHop { fromNorm: string; from: string; toNorm: string; to: string; count: number }
interface ChainRow {
  path: string; feeders: string[]; midTier: string[]; terminus: string | null;
  length: number; strength: number; totalCount: number; counties: string[];
  firstDate: string | null; lastDate: string | null; nodes: ChainNode[]; hops: ChainHop[];
}
interface ClassRow {
  norm: string; name: string; acquisitions: number; dispositions: number;
  distinctGrantors: number; distinctGrantees: number; klass: string; classLabel: string;
}
interface RelationshipsData {
  totals: { transactions: number; relationships: number; entities: number; partnerships: number; chains: number };
  relationships: RelRow[];
  coBuyers: CoBuyerRow[];
  chainTable: ChainRow[];
  classifications: ClassRow[];
  classLabels: Record<string, string>;
}
type TxSelector = { grantorNorm?: string; granteeNorm?: string; members?: string[]; path?: string[]; entityNorm?: string };

export function Research() {
  const { can } = useAuth();
  const [period, setPeriod] = useState<Period>("LAST_90D");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [compare, setCompare] = useState<Compare>("PREV_PERIOD");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [opts, setOpts] = useState<FilterOpts | null>(null);
  const [exporting, setExporting] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);

  const range = useMemo(() => rangeFor(period, custom), [period, custom]);
  const qs = useMemo(() => {
    const q = new URLSearchParams();
    if (range.from) q.set("from", range.from);
    if (range.to) q.set("to", range.to);
    const cp = compareParams(compare, range.from, range.to);
    if (cp.compareFrom && cp.compareTo) { q.set("compareFrom", cp.compareFrom); q.set("compareTo", cp.compareTo); }
    if (filters.state) q.set("state", filters.state);
    for (const c of filters.counties) q.append("county", c);
    for (const t of filters.docTypes) q.append("docType", t);
    for (const b of filters.buyers) q.append("buyer", b);
    for (const s of filters.sellers) q.append("seller", s);
    for (const o of filters.operators) q.append("operator", o);
    return q.toString();
  }, [range.from, range.to, compare, filters]);

  const loadOpts = useCallback(() => { api.get<FilterOpts>("/research/filters").then(setOpts).catch(() => {}); }, []);
  useEffect(loadOpts, [loadOpts]);

  const hasAnyData = opts != null && (opts.states.length > 0 || opts.counties.length > 0);
  const canManage = can("manageResearchData");

  async function onExportPdf() {
    if (!captureRef.current) return;
    setExporting(true);
    try { await exportElementToPdf(captureRef.current, `market-intel-${range.from}_to_${range.to}.pdf`); }
    finally { setExporting(false); }
  }

  const activeFilterCount =
    (filters.state ? 1 : 0) + filters.counties.length + filters.docTypes.length +
    filters.buyers.length + filters.sellers.length + filters.operators.length;

  const drillToRecords = useCallback((patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setTab("records");
  }, []);

  const CHIPS: [Period, string][] = [
    ["LAST_30D", "30D"], ["LAST_90D", "90D"], ["LAST_6M", "6M"],
    ["LAST_12M", "12M"], ["THIS_YEAR", "YTD"], ["CUSTOM", "Custom"],
  ];
  const cmpRange = compareRangeFor(compare, range.from, range.to);
  const rangeDays = range.from && range.to
    ? Math.round((new Date(`${range.to}T00:00:00Z`).getTime() - new Date(`${range.from}T00:00:00Z`).getTime()) / DAY) + 1
    : 0;
  const compareHint = compare === "PREV_YEAR"
    ? "The comparison period is the same date range one year earlier"
    : `The comparison period is the ${rangeDays} days immediately before your selected range`;
  // Show the year on the compare range only when it differs from the current range's year.
  const cmpWithYear = cmpRange != null && range.to !== "" &&
    new Date(`${cmpRange.to}T00:00:00Z`).getUTCFullYear() !== new Date(`${range.to}T00:00:00Z`).getUTCFullYear();
  const TABS: [Tab, string][] = [
    ["overview", "Overview"], ["geography", "Geography"], ["rankings", "Rankings"],
    ["relationships", "Relationships"], ["opportunities", "Opportunities"], ["records", "Records"],
    ...(canManage ? ([["data", "Data & Imports"]] as [Tab, string][]) : []),
  ];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Research & Market Intelligence</h1>
        {can("exportReports") && tab !== "data" && (
          <button className="primary" onClick={onExportPdf} disabled={exporting}>{exporting ? "Generating…" : "Export PDF"}</button>
        )}
      </div>

      {/* --- Period + filter controls --- */}
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div className="seg-control">
            {CHIPS.map(([p, label]) => (
              <span key={p} className={`seg ${period === p ? "active" : ""}`} onClick={() => setPeriod(p)}>
                {p === "CUSTOM" && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                )}
                {label}
              </span>
            ))}
          </div>
          {range.from && range.to ? (
            <div className="row" style={{ gap: 10, alignItems: "center", fontSize: 12.5 }}>
              <span style={{ fontWeight: 600 }}>{fmtRangeLabel(range.from, range.to)}</span>
              {cmpRange && (
                <>
                  <span className="muted" style={{ opacity: 0.7 }}>vs</span>
                  <span className="muted">{fmtRangeLabel(cmpRange.from, cmpRange.to, cmpWithYear)}</span>
                  <span className="q-hint" title={compareHint}>?</span>
                </>
              )}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: 12.5 }}>Select a custom date range</span>
          )}
        </div>
        {period === "CUSTOM" && (
          <div className="row" style={{ marginTop: 10 }}>
            <div className="field" style={{ marginBottom: 0 }}><label>From</label><input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>To</label><input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></div>
          </div>
        )}
        <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 10 }}>
          <button className="small" onClick={() => setShowFilters((s) => !s)}>
            {showFilters ? "▾" : "▸"} Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          {activeFilterCount > 0 && <button className="small" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>}
        </div>
        {showFilters && opts && (
          <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginTop: 10 }}>
            <div className="field" style={{ marginBottom: 0 }}><label>Compare to</label>
              <select value={compare} onChange={(e) => setCompare(e.target.value as Compare)}>
                <option value="PREV_PERIOD">Previous period</option>
                <option value="PREV_YEAR">Previous year</option>
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}><label>State</label>
              <select value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value, counties: [] }))}>
                <option value="">All states</option>
                {opts.states.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0, minWidth: 190, flex: 1 }}><label>Counties</label>
              <SearchableMultiSelect
                options={opts.counties.filter((c) => !filters.state || c.state === filters.state).map((c) => c.county)}
                value={filters.counties}
                onChange={(counties) => setFilters((f) => ({ ...f, counties }))}
                placeholder="Filter counties…"
              />
            </div>
            <div className="field" style={{ marginBottom: 0, minWidth: 190, flex: 1 }}><label>Document types</label>
              <SearchableMultiSelect
                options={opts.docTypes.map(prettyEnum)}
                value={filters.docTypes.map(prettyEnum)}
                onChange={(next) => setFilters((f) => ({ ...f, docTypes: next.map((s) => s.toUpperCase().replace(/ /g, "_")) }))}
                placeholder="Filter doc types…"
              />
            </div>
            {([
              ["buyers", "Buyers", opts.buyers], ["sellers", "Sellers", opts.sellers], ["operators", "Operators", opts.operators],
            ] as [keyof Filters & ("buyers" | "sellers" | "operators"), string, { value: string; label: string }[]][]).map(([key, label, options]) => (
              <div key={key} className="field" style={{ marginBottom: 0, minWidth: 190, flex: 1 }}><label>{label}</label>
                <SearchableMultiSelect
                  options={options.map((o) => o.label)}
                  value={(filters[key] as string[]).map((v) => options.find((o) => o.value === v)?.label ?? v)}
                  onChange={(labels) => setFilters((f) => ({ ...f, [key]: labels.map((l) => options.find((o) => o.label === l)?.value ?? l) }))}
                  placeholder={`Filter ${label.toLowerCase()}…`}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {opts != null && !hasAnyData && tab !== "data" && (
        <Banner kind="info">
          No research data yet. {canManage
            ? <>Head to the <a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => setTab("data")}>Data & Imports</a> tab to load county recordings or drilling permits (or run the sample-data CLI to explore).</>
            : "Ask an administrator to import county recording or permit data."}
        </Banner>
      )}

      <div className="tab-row">
        {TABS.map(([t, label]) => <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{label}</button>)}
      </div>

      <div ref={captureRef} className="report-capture">
        {tab === "overview" && <OverviewTab qs={qs} />}
        {tab === "geography" && <GeographyTab qs={qs} filters={filters} onDrill={drillToRecords} onToggleCounty={(county) =>
          setFilters((f) => ({ ...f, counties: f.counties.includes(county) ? f.counties.filter((c) => c !== county) : [...f.counties, county] }))} />}
        {tab === "rankings" && <RankingsTab qs={qs} opts={opts} onDrill={drillToRecords} />}
        {tab === "relationships" && <RelationshipsTab qs={qs} onDrill={drillToRecords} />}
        {tab === "opportunities" && <OpportunitiesTab qs={qs} onDrill={drillToRecords} />}
        {tab === "records" && <RecordsTab qs={qs} />}
        {tab === "data" && canManage && <ResearchImport onDataChanged={loadOpts} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({ qs }: { qs: string }) {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.get<Summary>(`/research/summary?${qs}`).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [qs]);

  if (loading && !data) return <Spinner label="Analyzing market activity…" />;
  if (!data) return <Banner kind="info">Could not load the summary.</Banner>;
  const t = data.trends;

  const label = (k: string) =>
    data.granularity === "month"
      ? new Date(`${k}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })
      : new Date(`${k}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <>
      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <TrendKpi label="Mineral Transactions" t={t.transactions} />
        <TrendKpi label="Leasing Documents" t={t.leases} />
        <TrendKpi label="Drilling Permits" t={t.permits} />
        <TrendKpi label="Horizontal Permits" t={t.horizontalPermits} />
        <TrendKpi label="Active Buyers" t={t.uniqueBuyers} />
        <TrendKpi label="Active Operators" t={t.uniqueOperators} />
        <div className="metric-card">
          <div className="metric-label">Comparison Window</div>
          <div className="metric-value" style={{ fontSize: 15 }}>{fmtDate(data.compare.from)} – {fmtDate(data.compare.to)}</div>
        </div>
      </div>

      <div className="chart-grid">
        <div className="panel" style={{ gridColumn: "1 / -1" }}>
          <h3>Activity Trend <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(bars per {data.granularity}; line = rolling average of total)</span></h3>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={data.series.map((s) => ({ ...s, label: label(s.key) }))}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip {...chartTooltip} />
              <Legend />
              <Bar dataKey="transactions" name="Transactions" stackId="a" fill={CHART_COLORS[0]} />
              <Bar dataKey="leases" name="Leases" stackId="a" fill={CHART_COLORS[1]} />
              <Bar dataKey="permits" name="Permits" stackId="a" fill={CHART_COLORS[3]} radius={[3, 3, 0, 0]} />
              <Line dataKey="rollingAvg" name="Rolling avg" stroke={CHART_COLORS[2]} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="panel">
          <h3>Document Type Breakdown</h3>
          {data.docTypeBreakdown.length === 0 ? <p className="muted">No documents in this period.</p> : (
            <ResponsiveContainer width="100%" height={Math.max(160, data.docTypeBreakdown.length * 30)}>
              <BarChart data={data.docTypeBreakdown.map((d) => ({ name: prettyEnum(d.docType), count: d.count }))} layout="vertical" margin={{ left: 60 }}>
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
                <Tooltip {...chartTooltip} />
                <Bar dataKey="count" name="Documents" fill={CHART_COLORS[0]} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="panel">
          <h3>Period vs Prior</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={[
              { name: "Transactions", Current: data.kpis.transactions, Prior: data.previous.transactions },
              { name: "Leases", Current: data.kpis.leases, Prior: data.previous.leases },
              { name: "Permits", Current: data.kpis.permits, Prior: data.previous.permits },
            ]}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip {...chartTooltip} />
              <Legend />
              <Bar dataKey="Prior" fill={CHART_COLORS[6]} radius={[3, 3, 0, 0]} />
              <Bar dataKey="Current" fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}

function TrendKpi({ label, t }: { label: string; t?: TrendT }) {
  if (!t) return null;
  const color = t.direction === "flat" ? "var(--text-dim)" : t.direction === "up" ? "#22c55e" : "#ef4444";
  const arrow = t.direction === "flat" ? "→" : t.direction === "up" ? "▲" : "▼";
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{num(t.current)}</div>
      <div className="metric-hint" style={{ color }}>
        {arrow} {fmtPct(t.pctChange)} vs prior ({num(t.previous)})
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

function GeographyTab({ qs, filters, onDrill, onToggleCounty }: {
  qs: string; filters: Filters;
  onDrill: (patch: Partial<Filters>) => void;
  onToggleCounty: (county: string) => void;
}) {
  const [level, setLevel] = useState<"county" | "abstract" | "state">("county");
  const [metric, setMetric] = useState<"activity" | "change">("activity");
  const [data, setData] = useState<{ level: string; rows: GeoRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  // The map always shows county-level stats regardless of the table level.
  const [countyRows, setCountyRows] = useState<GeoRow[]>([]);

  useEffect(() => {
    setLoading(true);
    api.get<{ level: string; rows: GeoRow[] }>(`/research/geography?level=${level}&${qs}`).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [qs, level]);
  useEffect(() => {
    if (level === "county" && data) { setCountyRows(data.rows); return; }
    api.get<{ level: string; rows: GeoRow[] }>(`/research/geography?level=county&${qs}`).then((d) => setCountyRows(d.rows)).catch(() => {});
  }, [qs, level, data]);

  const geoName = (r: GeoRow) =>
    level === "state" ? r.state
      : level === "county" ? `${r.county}, ${r.state}`
        : `${r.abstractId} (${r.county} Co)`;

  const columns: Column<GeoRow>[] = [
    { key: "name", header: level === "state" ? "State" : level === "county" ? "County" : "Abstract", value: geoName, render: (r) => <>{geoName(r)} {r.isHotspot && <span className="badge" style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}>HOTSPOT</span>}</> },
    { key: "transactions", header: "Transactions", value: (r) => r.transactions, align: "right" },
    { key: "leases", header: "Leases", value: (r) => r.leases, align: "right" },
    { key: "permits", header: "Permits", value: (r) => r.permits, align: "right" },
    { key: "total", header: "Total", value: (r) => r.total, align: "right" },
    { key: "previous", header: "Prior", value: (r) => r.previous, align: "right" },
    {
      key: "pctChange", header: "Change", value: (r) => r.pctChange ?? Number.MAX_SAFE_INTEGER, align: "right",
      render: (r) => <span style={{ color: r.absoluteChange > 0 ? "#22c55e" : r.absoluteChange < 0 ? "#ef4444" : "var(--text-dim)" }}>{fmtPct(r.pctChange)} ({r.absoluteChange >= 0 ? "+" : ""}{r.absoluteChange})</span>,
    },
    { key: "zScore", header: "z", value: (r) => r.zScore, align: "right", render: (r) => (r.zScore == null ? "—" : r.zScore.toFixed(1)) },
  ];

  const countyStats: CountyStat[] = useMemo(
    () => countyRows.filter((r) => r.state === "TX" && r.county).map((r) => ({ county: r.county!, total: r.total, pctChange: r.pctChange, isHotspot: r.isHotspot })),
    [countyRows],
  );
  const showMap = countyStats.length > 0 && (!filters.state || filters.state === "TX");

  return (
    <>
      {showMap && (
        <div className="panel">
          <div className="panel-title">
            <h3 style={{ margin: 0 }}>Texas Activity Map <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(red outline = hotspot; click a county to filter)</span></h3>
            <div className="chip-row">
              <span className={`chip ${metric === "activity" ? "active" : ""}`} onClick={() => setMetric("activity")}>Volume</span>
              <span className={`chip ${metric === "change" ? "active" : ""}`} onClick={() => setMetric("change")}>Change</span>
            </div>
          </div>
          <div style={{ maxWidth: 640, margin: "0 auto" }}>
            <ResearchChoropleth stats={countyStats} metric={metric} selected={filters.counties} onSelect={onToggleCounty} />
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">
          <h3 style={{ margin: 0 }}>Activity by {level === "state" ? "State" : level === "county" ? "County" : "Abstract"}</h3>
          <div className="row" style={{ gap: 8 }}>
            <div className="chip-row">
              {(["state", "county", "abstract"] as const).map((l) => (
                <span key={l} className={`chip ${level === l ? "active" : ""}`} onClick={() => setLevel(l)}>{l[0].toUpperCase() + l.slice(1)}</span>
              ))}
            </div>
            <button className="small" disabled={!data?.rows.length} onClick={() => data && downloadCsv(
              `research-geography-${level}.csv`,
              ["Name", "State", "County", "Transactions", "Leases", "Permits", "Total", "Prior", "Change %", "Hotspot"],
              data.rows.map((r) => [geoName(r), r.state, r.county, r.transactions, r.leases, r.permits, r.total, r.previous, r.pctChange == null ? "" : Math.round(r.pctChange * 100), r.isHotspot ? "YES" : ""]),
            )}>Export CSV</button>
          </div>
        </div>
        {loading && !data ? <Spinner /> : !data || data.rows.length === 0 ? <p className="muted">No activity in this period.</p> : (
          <SortableTable
            columns={columns}
            rows={data.rows}
            rowKey={(r) => `${r.state}|${r.county}|${r.abstractId}`}
            defaultSort={{ key: "total", dir: "desc" }}
            onRowClick={(r) => onDrill({ state: r.state, counties: r.county ? [r.county] : [] })}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

interface PreviewItem {
  key: string;
  outcome: "new" | "exact" | "possible";
  proposal: { companyName: string; aliases: string[]; counties: string[]; states: string[]; abstracts: string[]; transactionTypes: string[]; transactionCount: number; firstSeen: string | null; lastSeen: string | null };
  confidence: number | null;
  existing: null | { id: string; companyName: string; counties: string[]; states: string[]; aliases: string[] };
  mergePreview: null | { addCounties: string[]; addStates: string[]; addAliases: string[] };
}
type Decision = { key: string; action: "create" | "merge" | "skip"; mergeIntoBuyerId?: string };

function RankingsTab({ qs, opts, onDrill }: { qs: string; opts: FilterOpts | null; onDrill: (patch: Partial<Filters>) => void }) {
  const [role, setRole] = useState<"buyers" | "sellers" | "operators">("buyers");
  const [data, setData] = useState<{ role: string; rows: EntityRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [review, setReview] = useState<{ auto: Decision[]; possibles: PreviewItem[] } | null>(null);
  const [result, setResult] = useState<{ created: number; merged: number; skipped: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true); setSelected(new Set()); setResult(null); setErr(null);
    api.get<{ role: string; rows: EntityRow[] }>(`/research/entities?role=${role}&${qs}`).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [qs, role]);

  const ROLE_LABEL = { buyers: "Most Active Buyers", sellers: "Most Active Sellers", operators: "Most Active Operators" } as const;
  const isBuyers = role === "buyers";
  const rows = data?.rows ?? [];
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggle = (k: string) => setSelected((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleAll = () => setSelected((p) => (p.size === rows.length ? new Set() : new Set(rows.map((r) => r.key))));

  async function commitDecisions(decisions: Decision[]) {
    const r = await api.post<{ created: number; merged: number; skipped: number }>("/research/buyers/commit", { decisions });
    setResult(r); setSelected(new Set()); setReview(null);
  }
  async function addToBuyers() {
    if (selected.size === 0) return;
    setAdding(true); setErr(null);
    try {
      const { items } = await api.post<{ items: PreviewItem[] }>("/research/buyers/preview", { keys: [...selected] });
      const auto: Decision[] = items.filter((i) => i.outcome !== "possible").map((i) => ({
        key: i.key, action: i.outcome === "exact" ? "merge" : "create", mergeIntoBuyerId: i.existing?.id,
      }));
      const possibles = items.filter((i) => i.outcome === "possible");
      if (possibles.length === 0) await commitDecisions(auto);
      else setReview({ auto, possibles });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not prepare buyers");
    } finally {
      setAdding(false);
    }
  }

  const columns: Column<EntityRow>[] = [
    ...(isBuyers ? ([{
      key: "sel", header: "", value: () => "", width: "1%",
      render: (r: EntityRow) => <input type="checkbox" checked={selected.has(r.key)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.key)} />,
    }] as Column<EntityRow>[]) : []),
    { key: "name", header: "Name", value: (r) => r.name, render: (r) => <>{r.name} {r.newEntrant && <span className="badge" style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>NEW</span>}</> },
    { key: "count", header: role === "operators" ? "Permits" : "Records", value: (r) => r.count, align: "right" },
    { key: "previous", header: "Prior", value: (r) => r.previous, align: "right" },
    {
      key: "pctChange", header: "Change", value: (r) => r.pctChange ?? Number.MAX_SAFE_INTEGER, align: "right",
      render: (r) => <span style={{ color: r.absoluteChange > 0 ? "#22c55e" : r.absoluteChange < 0 ? "#ef4444" : "var(--text-dim)" }}>{fmtPct(r.pctChange)}</span>,
    },
    ...(role === "operators"
      ? ([{ key: "horizontal", header: "Horizontal", value: (r) => r.horizontal, align: "right" }] as Column<EntityRow>[])
      : []),
    { key: "counties", header: "Counties", value: (r) => r.counties.length, render: (r) => r.counties.join(", ") || "—" },
  ];

  const top = rows.slice(0, 10);

  return (
    <>
      <div className="chart-grid">
        <div className="panel" style={{ gridColumn: "1 / -1" }}>
          <div className="panel-title">
            <h3 style={{ margin: 0 }}>{ROLE_LABEL[role]}</h3>
            <div className="row" style={{ gap: 8 }}>
              <div className="chip-row">
                {(["buyers", "sellers", "operators"] as const).map((r) => (
                  <span key={r} className={`chip ${role === r ? "active" : ""}`} onClick={() => setRole(r)}>{r[0].toUpperCase() + r.slice(1)}</span>
                ))}
              </div>
              <button className="small" disabled={!rows.length} onClick={() => data && downloadCsv(
                `research-${role}.csv`,
                ["Name", "Count", "Prior", "Change %", "Counties", "New Entrant"],
                data.rows.map((r) => [r.name, r.count, r.previous, r.pctChange == null ? "" : Math.round(r.pctChange * 100), r.counties.join("; "), r.newEntrant ? "YES" : ""]),
              )}>Export CSV</button>
            </div>
          </div>
          {loading && !data ? <Spinner /> : top.length === 0 ? <p className="muted">No activity in this period.</p> : (
            <ResponsiveContainer width="100%" height={Math.max(160, top.length * 32)}>
              <BarChart data={top} layout="vertical" margin={{ left: 80 }}>
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={200} tick={{ fontSize: 11 }} />
                <Tooltip {...chartTooltip} />
                <Bar dataKey="count" name={role === "operators" ? "Permits" : "Records"} fill={CHART_COLORS[role === "buyers" ? 0 : role === "sellers" ? 4 : 3]} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="panel">
        {/* Selection + bulk actions — turn active buyers into CRM Buyer profiles. */}
        {isBuyers && rows.length > 0 && (
          <div className="row" style={{ gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <label style={{ fontSize: 13, textTransform: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} /> Select all
            </label>
            <span className="muted" style={{ fontSize: 13 }}>{selected.size} selected</span>
            <button className="small primary" disabled={selected.size === 0 || adding} onClick={addToBuyers}>
              {adding ? "Preparing…" : `Add to Buyers${selected.size ? ` (${selected.size})` : ""}`}
            </button>
            {selected.size > 0 && <button className="small" onClick={() => setSelected(new Set())}>Clear</button>}
          </div>
        )}
        {err && <Banner kind="error">{err}</Banner>}
        {result && (
          <Banner kind="info">
            Added to Buyers — <strong>{result.created}</strong> created, <strong>{result.merged}</strong> enriched
            {result.skipped > 0 && <>, {result.skipped} skipped</>}. New profiles are tagged “Research Imported”.
          </Banner>
        )}
        {loading && !data ? <Spinner /> : rows.length > 0 ? (
          <SortableTable
            columns={columns}
            rows={data!.rows}
            rowKey={(r) => r.key}
            defaultSort={{ key: "count", dir: "desc" }}
            onRowClick={(r) => onDrill(role === "buyers" ? { buyers: [r.key] } : role === "sellers" ? { sellers: [r.key] } : { operators: [r.key] })}
          />
        ) : null}
      </div>
      {opts && <p className="muted" style={{ fontSize: 12 }}>Names are grouped after normalizing punctuation and legal suffixes (LLC/LP/Inc), so filings under slightly different spellings roll up together.</p>}

      {review && (
        <AddToBuyersReview
          auto={review.auto}
          possibles={review.possibles}
          onCancel={() => setReview(null)}
          onConfirm={(reviewedDecisions) => commitDecisions([...review.auto, ...reviewedDecisions])}
        />
      )}
    </>
  );
}

/** Review screen for possible-duplicate buyers: merge / create new / skip each. */
function AddToBuyersReview({ auto, possibles, onCancel, onConfirm }: {
  auto: Decision[]; possibles: PreviewItem[];
  onCancel: () => void; onConfirm: (decisions: Decision[]) => void | Promise<void>;
}) {
  const [choices, setChoices] = useState<Record<string, "merge" | "create" | "skip">>(
    Object.fromEntries(possibles.map((p) => [p.key, "merge" as const])),
  );
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    const decisions: Decision[] = possibles.map((p) => ({
      key: p.key, action: choices[p.key], mergeIntoBuyerId: choices[p.key] === "merge" ? p.existing?.id : undefined,
    }));
    await onConfirm(decisions);
    setBusy(false);
  }

  return (
    <Modal title="Review possible duplicate buyers" onClose={onCancel} wide>
      <p className="muted" style={{ marginTop: 0 }}>
        {auto.length > 0 && <>{auto.length} buyer(s) will be added automatically (new or exact matches). </>}
        The following look similar to existing buyers — choose how to handle each.
      </p>
      {possibles.map((p) => (
        <div key={p.key} className="panel" style={{ background: "var(--panel-2)" }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
            <div style={{ minWidth: 240, flex: 1 }}>
              <strong>{p.proposal.companyName}</strong>
              {p.confidence != null && <span className="chip-mini" style={{ marginLeft: 8 }}>{Math.round(p.confidence * 100)}% match</span>}
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Imported: {p.proposal.transactionCount} txns · {p.proposal.counties.join(", ") || "—"} · {p.proposal.states.join(", ") || "—"}
              </div>
              {p.existing && (
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                  Existing “{p.existing.companyName}”: {p.existing.counties.join(", ") || "no counties"} · {p.existing.states.join(", ") || "no states"}
                </div>
              )}
              {p.mergePreview && (p.mergePreview.addCounties.length + p.mergePreview.addStates.length + p.mergePreview.addAliases.length > 0) && (
                <div style={{ fontSize: 12, marginTop: 4, color: "#22c55e" }}>
                  Merge would add: {[
                    p.mergePreview.addCounties.length ? `${p.mergePreview.addCounties.length} counties` : "",
                    p.mergePreview.addStates.length ? `${p.mergePreview.addStates.length} states` : "",
                    p.mergePreview.addAliases.length ? `${p.mergePreview.addAliases.length} aliases` : "",
                  ].filter(Boolean).join(", ")}
                </div>
              )}
            </div>
            <div className="chip-row">
              {(["merge", "create", "skip"] as const).map((c) => (
                <span key={c} className={`chip ${choices[p.key] === c ? "active" : ""}`} onClick={() => setChoices((s) => ({ ...s, [p.key]: c }))}>
                  {c === "merge" ? "Merge with existing" : c === "create" ? "Create new" : "Skip"}
                </span>
              ))}
            </div>
          </div>
        </div>
      ))}
      <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button className="small" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="small primary" onClick={confirm} disabled={busy}>{busy ? "Applying…" : "Confirm & add"}</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Relationships — grantor→grantee graph, co-buyers, chains, classifications
// ---------------------------------------------------------------------------

function ClassBadge({ klass, label }: { klass: string; label: string }) {
  const c = CLASS_COLORS[klass] ?? "#64748b";
  return <span className="badge" style={{ background: `${c}26`, color: c }}>{label}</span>;
}

type RelView = "relationships" | "cobuyers" | "chains" | "entities";

/** Plain-language meaning of each behavioural class (shown as chips + tooltips). */
const CLASS_DESC: Record<string, string> = {
  TERMINAL_HOLD: "Acquires repeatedly and never resells — a long-term holder",
  AGGREGATOR: "Buys from many sources, then consolidates into one or two buyers",
  DISTRIBUTOR: "Buys and resells recurrently across counterparties — an intermediary",
  FEEDER: "Consistently sells into one or two downstream buyers",
  PASS_THROUGH: "Buys and sells, but at low volume",
  SELLER: "Only appears as a grantor (seller) in the data",
  ONE_TIME_BUYER: "A single recorded acquisition, nothing resold",
  UNCLASSIFIED: "Not enough activity to classify",
};

function RelationshipsTab({ qs, onDrill }: { qs: string; onDrill: (patch: Partial<Filters>) => void }) {
  const [data, setData] = useState<RelationshipsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<RelView>("relationships");
  const [tx, setTx] = useState<{ title: string; selector: TxSelector } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [repeatOnly, setRepeatOnly] = useState(false);
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [entity, setEntity] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.get<RelationshipsData>(`/research/relationships?${qs}`).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [qs]);

  if (loading && !data) return <Spinner label="Mapping the acquisition network…" />;
  if (!data) return <Banner kind="info">Could not load relationship analysis.</Banner>;
  if (data.totals.transactions === 0) {
    return <Banner kind="info">No ownership-transfer records in this period. Relationship analysis needs deed/assignment transactions with both a grantor and grantee — widen the date range or import deed data.</Banner>;
  }

  const labelOf = (k: string) => data.classLabels[k] ?? k;

  // Search + view-specific filters (all applied client-side to the loaded set).
  const ql = q.trim().toUpperCase();
  const matches = (...names: (string | null)[]) => !ql || names.some((n) => (n ?? "").toUpperCase().includes(ql));
  const rels = data.relationships.filter((r) => matches(r.grantor, r.grantee) && (!repeatOnly || r.count >= 2));
  const coBuyers = data.coBuyers.filter((p) => matches(...p.members.map((m) => m.name)));
  const chains = data.chainTable.filter((c) => matches(c.path));
  const entities = data.classifications.filter((r) => matches(r.name) && (!classFilter || r.klass === classFilter));

  // Class counts drive the filter chips on the Entities view.
  const classCounts = new Map<string, number>();
  for (const c of data.classifications) classCounts.set(c.klass, (classCounts.get(c.klass) ?? 0) + 1);

  // Headline insights — one-line answers before digging into the tables.
  const topRel = data.relationships[0];
  const topHold = data.classifications.find((c) => c.klass === "TERMINAL_HOLD");
  const topMid = data.classifications.find((c) => c.klass === "AGGREGATOR" || c.klass === "DISTRIBUTOR" || c.klass === "FEEDER");
  const deepChain = [...data.chainTable].sort((a, b) => b.length - a.length || b.totalCount - a.totalCount)[0];

  const VIEWS: [RelView, string][] = [
    ["relationships", `Relationships (${data.totals.relationships})`],
    ["cobuyers", `Co-Buyers (${data.totals.partnerships})`],
    ["chains", `Acquisition Chains (${data.totals.chains})`],
    ["entities", `Entities (${data.totals.entities})`],
  ];

  return (
    <>
      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(5,1fr)" }}>
        <MiniKpi label="Transactions" value={data.totals.transactions} />
        <MiniKpi label="Relationships" value={data.totals.relationships} />
        <MiniKpi label="Entities" value={data.totals.entities} />
        <MiniKpi label="Co-Buyer Groups" value={data.totals.partnerships} />
        <MiniKpi label="Chains" value={data.totals.chains} />
      </div>

      {/* Headline insights — the fastest read on who is driving this market. */}
      {(topRel || topHold || topMid || deepChain) != null && (
        <div className="rel-insights">
          {topRel && (
            <button className="rel-insight" onClick={() => setTx({ title: `${topRel.grantor} → ${topRel.grantee}`, selector: { grantorNorm: topRel.grantorNorm, granteeNorm: topRel.granteeNorm } })}>
              <div className="rel-insight-l">Most Active Relationship</div>
              <div className="rel-insight-v">{topRel.grantor} → {topRel.grantee}</div>
              <div className="muted" style={{ fontSize: 12 }}>{topRel.count} transaction{topRel.count === 1 ? "" : "s"}</div>
            </button>
          )}
          {topHold && (
            <button className="rel-insight" onClick={() => setEntity(topHold.norm)}>
              <div className="rel-insight-l">Largest Terminal Holder</div>
              <div className="rel-insight-v">{topHold.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{topHold.acquisitions} acquisitions · nothing resold</div>
            </button>
          )}
          {topMid && (
            <button className="rel-insight" onClick={() => setEntity(topMid.norm)}>
              <div className="rel-insight-l">Top Intermediary</div>
              <div className="rel-insight-v">{topMid.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{labelOf(topMid.klass)} · bought {topMid.acquisitions} / sold {topMid.dispositions}</div>
            </button>
          )}
          {deepChain && (
            <button className="rel-insight" onClick={() => setView("chains")}>
              <div className="rel-insight-l">Deepest Acquisition Chain</div>
              <div className="rel-insight-v">{deepChain.path}</div>
              <div className="muted" style={{ fontSize: 12 }}>{deepChain.length} hops · {deepChain.totalCount} transactions</div>
            </button>
          )}
        </div>
      )}

      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div className="tab-row" style={{ margin: 0, flex: 1, minWidth: 260 }}>
          {VIEWS.map(([v, l]) => <button key={v} className={`tab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>{l}</button>)}
        </div>
        <input
          style={{ width: 230 }}
          placeholder="Search entities…"
          aria-label="Search entities"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {view === "relationships" && (
        <div className="panel">
          <div className="panel-title">
            <h3 style={{ margin: 0 }}>Grantor → Grantee Relationships</h3>
            <div className="row" style={{ gap: 10, alignItems: "center" }}>
              <label className="dm-chk" style={{ fontSize: 12 }}>
                <input type="checkbox" checked={repeatOnly} onChange={(e) => setRepeatOnly(e.target.checked)} /> Repeat relationships only (2+)
              </label>
              <button className="small" onClick={() => downloadCsv("research-relationships.csv",
                ["Grantor", "Grantee", "Transactions", "Counties", "First", "Last"],
                rels.map((r) => [r.grantor, r.grantee, r.count, r.counties.join("; "), r.firstDate, r.lastDate]))}>Export CSV</button>
            </div>
          </div>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Repeated transfers between the same two parties roll up into one relationship with a transaction count. Click a row for the underlying deeds, or an entity name for its full dossier.</p>
          {rels.length === 0 ? <p className="muted">No relationships match{q ? ` “${q}”` : ""}{repeatOnly ? " with 2+ transactions" : ""}.</p> : (
            <SortableTable
              columns={[
                { key: "grantor", header: "Grantor (Seller)", value: (r: RelRow) => r.grantor, render: (r: RelRow) => <span className="rel-ent" onClick={(e) => { e.stopPropagation(); setEntity(r.grantorNorm); }}>{r.grantor}</span> },
                { key: "arrow", header: "", value: () => "", width: "1%", render: () => <span className="muted">→</span> },
                { key: "grantee", header: "Grantee (Buyer)", value: (r: RelRow) => r.grantee, render: (r: RelRow) => <span className="rel-ent" onClick={(e) => { e.stopPropagation(); setEntity(r.granteeNorm); }}>{r.grantee}</span> },
                { key: "count", header: "Transactions", value: (r: RelRow) => r.count, align: "right" as const },
                { key: "counties", header: "Counties", value: (r: RelRow) => r.counties.length, render: (r: RelRow) => r.counties.join(", ") || "—" },
                { key: "abstracts", header: "Abstracts", value: (r: RelRow) => r.abstracts.length, align: "right" as const, render: (r: RelRow) => r.abstracts.length ? <span title={r.abstracts.join(", ")}>{r.abstracts.length}</span> : "—" },
                { key: "lastDate", header: "Latest", value: (r: RelRow) => r.lastDate ?? "", render: (r: RelRow) => fmtDate(r.lastDate), type: "date" as const },
              ]}
              rows={rels}
              rowKey={(r) => `${r.grantorNorm}→${r.granteeNorm}`}
              defaultSort={{ key: "count", dir: "desc" }}
              onRowClick={(r) => setTx({ title: `${r.grantor} → ${r.grantee}: ${r.count} transaction${r.count === 1 ? "" : "s"}`, selector: { grantorNorm: r.grantorNorm, granteeNorm: r.granteeNorm } })}
            />
          )}
        </div>
      )}

      {view === "cobuyers" && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Co-Buyer Partnerships</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Entities that acquired together on the same recorded instrument, ranked by how often they partner. Click to view the shared transactions.</p>
          {coBuyers.length === 0 ? <p className="muted">No co-buying partnerships {q ? `match “${q}”` : "detected — this needs multiple grantees sharing an instrument number"}.</p> : (
            <div className="rel-list">
              {coBuyers.map((p, i) => (
                <button key={i} className="rel-card" onClick={() => setTx({ title: `Co-buyers: ${p.members.map((m) => m.name).join(", ")}`, selector: { members: p.members.map((m) => m.norm) } })}>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {p.members.map((m, j) => (
                      <span key={m.norm} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <span className="badge resp-pending">{m.name}</span>
                        {j < p.members.length - 1 && <span className="muted">＋</span>}
                      </span>
                    ))}
                  </div>
                  <div className="row" style={{ gap: 10, marginTop: 6 }}>
                    <span className="rel-count">{p.count} shared transaction{p.count === 1 ? "" : "s"}</span>
                    {p.counties.length > 0 && <span className="muted" style={{ fontSize: 12 }}>{p.counties.join(", ")}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "chains" && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Acquisition Chains</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>How interests move through multiple entities. Each row is a complete path; click to expand hops, counties, and supporting transactions.</p>
          {chains.length === 0 ? <p className="muted">No multi-hop acquisition paths {q ? `match “${q}”` : "detected in this period"}.</p> : (
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Platform / Chain</th><th>Feeder Entities</th><th>Aggregator / Mid-Tier</th><th>End Terminus</th><th className="right">Strength</th></tr></thead>
                <tbody>
                  {chains.map((c, i) => (
                    <Fragment key={i}>
                      <tr className="clickable" onClick={() => setExpanded(expanded === i ? null : i)}>
                        <td><strong>{c.path}</strong><div className="muted" style={{ fontSize: 11 }}>{c.length} hops · {c.totalCount} transactions</div></td>
                        <td>{c.feeders.join(", ") || "—"}</td>
                        <td>{c.midTier.join(", ") || "—"}</td>
                        <td>{c.terminus ?? "—"}</td>
                        <td className="right">{c.strength}</td>
                      </tr>
                      {expanded === i && (
                        <tr>
                          <td colSpan={5} style={{ background: "var(--panel-2)" }}>
                            <div className="chain-detail">
                              <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                                {c.nodes.map((n, j) => (
                                  <span key={n.norm} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ cursor: "pointer" }} title={`${CLASS_DESC[n.klass] ?? n.klass} — click for dossier`} onClick={() => setEntity(n.norm)}>
                                      <ClassBadge klass={n.klass} label={n.name} />
                                    </span>
                                    {j < c.nodes.length - 1 && (
                                      <span className="muted" title={`${c.hops[j]?.count} transactions`}>—{c.hops[j]?.count}→</span>
                                    )}
                                  </span>
                                ))}
                              </div>
                              <div className="muted" style={{ fontSize: 12 }}>
                                {c.counties.length > 0 && <>Counties: {c.counties.join(", ")} · </>}
                                {c.firstDate && c.lastDate && <>{fmtDate(c.firstDate)} – {fmtDate(c.lastDate)}</>}
                              </div>
                              <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                                <button className="small" onClick={() => setTx({ title: `Chain: ${c.path}`, selector: { path: c.nodes.map((n) => n.norm) } })}>View supporting transactions →</button>
                                {c.terminus && <button className="small" onClick={() => onDrill({ counties: c.counties })}>Filter records to these counties →</button>}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {view === "entities" && (
        <div className="panel">
          <div className="panel-title">
            <h3 style={{ margin: 0 }}>Market Participants</h3>
            <button className="small" onClick={() => downloadCsv("research-entity-classes.csv",
              ["Entity", "Class", "Acquired", "Sold", "Net", "Distinct Grantors", "Distinct Grantees"],
              entities.map((r) => [r.name, r.classLabel, r.acquisitions, r.dispositions, r.acquisitions - r.dispositions, r.distinctGrantors, r.distinctGrantees]))}>Export CSV</button>
          </div>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Every entity labelled by its acquisition behaviour. Click a class to filter; click an entity for its full dossier.</p>
          <div className="chip-row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
            <span className={`chip ${classFilter == null ? "active" : ""}`} onClick={() => setClassFilter(null)}>All ({data.classifications.length})</span>
            {[...classCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
              <span key={k} className={`chip ${classFilter === k ? "active" : ""}`} onClick={() => setClassFilter(classFilter === k ? null : k)}
                title={CLASS_DESC[k]} style={{ borderColor: CLASS_COLORS[k] ?? undefined }}>
                {labelOf(k)} ({n})
              </span>
            ))}
          </div>
          {classFilter && <p className="muted" style={{ marginTop: 0, fontSize: 12 }}><strong>{labelOf(classFilter)}:</strong> {CLASS_DESC[classFilter] ?? ""}</p>}
          {entities.length === 0 ? <p className="muted">No entities match.</p> : (
            <SortableTable
              columns={[
                { key: "name", header: "Entity", value: (r: ClassRow) => r.name, render: (r: ClassRow) => <strong>{r.name}</strong> },
                { key: "klass", header: "Class", value: (r: ClassRow) => r.classLabel, render: (r: ClassRow) => <span title={CLASS_DESC[r.klass]}><ClassBadge klass={r.klass} label={r.classLabel} /></span> },
                { key: "acquisitions", header: "Acquired", value: (r: ClassRow) => r.acquisitions, align: "right" as const },
                { key: "dispositions", header: "Sold", value: (r: ClassRow) => r.dispositions, align: "right" as const },
                {
                  key: "net", header: "Net Position", value: (r: ClassRow) => r.acquisitions - r.dispositions, align: "right" as const,
                  render: (r: ClassRow) => { const n = r.acquisitions - r.dispositions; return <span style={{ color: n > 0 ? "#22c55e" : n < 0 ? "#ef4444" : "var(--text-dim)" }}>{n > 0 ? "+" : ""}{n}</span>; },
                },
                { key: "distinctGrantors", header: "Sources", value: (r: ClassRow) => r.distinctGrantors, align: "right" as const, render: (r: ClassRow) => <span title="distinct grantors acquired from">{r.distinctGrantors}</span> },
                { key: "distinctGrantees", header: "Buyers", value: (r: ClassRow) => r.distinctGrantees, align: "right" as const, render: (r: ClassRow) => <span title="distinct grantees sold to">{r.distinctGrantees}</span> },
              ]}
              rows={entities}
              rowKey={(r) => r.norm}
              defaultSort={{ key: "acquisitions", dir: "desc" }}
              onRowClick={(r) => setEntity(r.norm)}
            />
          )}
        </div>
      )}

      {entity && (
        <EntityModal
          norm={entity} data={data}
          onClose={() => setEntity(null)}
          onOpenEntity={setEntity}
          onViewTx={(title, selector) => { setEntity(null); setTx({ title, selector }); }}
        />
      )}
      {tx && <TxDrillModal qs={qs} title={tx.title} selector={tx.selector} onClose={() => setTx(null)} onDrillRecords={onDrill} />}
    </>
  );
}

/**
 * Entity dossier — everything the dataset knows about one market participant:
 * classification, flow stats, who it bought from / sold to, co-buying partners,
 * chains it appears in, plus drill-in and Add-to-Buyers actions.
 */
function EntityModal({ norm, data, onClose, onOpenEntity, onViewTx }: {
  norm: string; data: RelationshipsData;
  onClose: () => void;
  onOpenEntity: (norm: string) => void;
  onViewTx: (title: string, selector: TxSelector) => void;
}) {
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  const info = data.classifications.find((c) => c.norm === norm);
  const bought = data.relationships.filter((r) => r.granteeNorm === norm);
  const sold = data.relationships.filter((r) => r.grantorNorm === norm);
  const partners = data.coBuyers.filter((p) => p.members.some((m) => m.norm === norm));
  const chains = data.chainTable.filter((c) => c.nodes.some((n) => n.norm === norm));
  const name = info?.name ?? bought[0]?.grantee ?? sold[0]?.grantor ?? norm;

  async function addToBuyers() {
    setAdding(true);
    try {
      const { items } = await api.post<{ items: { outcome: string; existing?: { id: string } }[] }>("/research/buyers/preview", { keys: [norm] });
      const it = items[0];
      const decision = it && it.outcome === "exact"
        ? { key: norm, action: "merge" as const, mergeIntoBuyerId: it.existing?.id }
        : { key: norm, action: "create" as const };
      const r = await api.post<{ created: number; merged: number }>("/research/buyers/commit", { decisions: [decision] });
      setAdded(r.created ? "Buyer profile created" : "Merged into existing buyer");
    } catch {
      setAdded("Could not add to Buyers");
    } finally {
      setAdding(false);
    }
  }

  const Counterparties = ({ title, rows, dir }: { title: string; rows: RelRow[]; dir: "in" | "out" }) => (
    <div>
      <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>{title}</div>
      {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>None in this period.</p> : (
        <div className="rel-party-list">
          {rows.slice(0, 10).map((r) => {
            const otherNorm = dir === "in" ? r.grantorNorm : r.granteeNorm;
            const otherName = dir === "in" ? r.grantor : r.grantee;
            return (
              <div key={otherNorm} className="rel-party-row">
                <button className="rel-party-name link" onClick={() => onOpenEntity(otherNorm)} title="Open dossier">{otherName}</button>
                <span className="rel-party-meta">
                  <span className="rel-count-mini">{r.count}×</span>
                  <button className="small" onClick={() => onViewTx(
                    dir === "in" ? `${otherName} → ${name}` : `${name} → ${otherName}`,
                    dir === "in" ? { grantorNorm: otherNorm, granteeNorm: norm } : { grantorNorm: norm, granteeNorm: otherNorm },
                  )}>deeds</button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <Modal title={name} onClose={onClose} wide>
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
        {info && <ClassBadge klass={info.klass} label={info.classLabel} />}
        <span className="muted" style={{ fontSize: 13 }}>
          Acquired {info?.acquisitions ?? bought.reduce((s, r) => s + r.count, 0)} · Sold {info?.dispositions ?? sold.reduce((s, r) => s + r.count, 0)}
        </span>
      </div>
      {info && <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>{CLASS_DESC[info.klass]}</p>}

      <div className="rel-columns" style={{ marginTop: 8 }}>
        <Counterparties title="Bought From" rows={bought} dir="in" />
        <Counterparties title="Sold To" rows={sold} dir="out" />
        <div>
          <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>Co-Buying Partners</div>
          {partners.length === 0 ? <p className="muted" style={{ margin: 0 }}>None found.</p> : (
            <div className="rel-party-list">
              {partners.slice(0, 8).map((p, i) => (
                <div key={i} className="rel-party-row">
                  <span style={{ fontSize: 13 }}>{p.members.filter((m) => m.norm !== norm).map((m) => m.name).join(", ")}</span>
                  <span className="rel-count-mini">{p.count}×</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {chains.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>Appears in Chains</div>
          {chains.slice(0, 5).map((c, i) => (
            <div key={i} className="rel-chain" style={{ marginBottom: 6 }}>
              <span style={{ fontSize: 13 }}>{c.path}</span>
              <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>{c.length} hops · {c.totalCount} txns</span>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
        <button className="small" onClick={() => onViewTx(`All transactions involving ${name}`, { entityNorm: norm })}>View all transactions →</button>
        {can("createBuyers") && !added && (
          <button className="small primary" disabled={adding} onClick={addToBuyers}>{adding ? "Adding…" : "Add to Buyers"}</button>
        )}
        {added && <span className="muted" style={{ fontSize: 12 }}>{added}</span>}
      </div>
    </Modal>
  );
}

function MiniKpi({ label, value }: { label: string; value: number }) {
  return <div className="metric-card"><div className="metric-label">{label}</div><div className="metric-value">{num(value)}</div></div>;
}

/** Supporting-transactions drill-in for a relationship / co-buyer set / chain. */
function TxDrillModal({ qs, title, selector, onClose }: {
  qs: string; title: string; selector: TxSelector;
  onClose: () => void; onDrillRecords: (patch: Partial<Filters>) => void;
}) {
  const [rows, setRows] = useState<DocRecord[] | null>(null);
  useEffect(() => {
    api.post<{ rows: DocRecord[] }>(`/research/relationships/transactions?${qs}`, selector)
      .then((d) => setRows(d.rows)).catch(() => setRows([]));
  }, [qs, selector]);

  return (
    <Modal title={title} onClose={onClose} wide>
      {!rows ? <Spinner /> : rows.length === 0 ? <p className="muted">No supporting transactions in the current filters.</p> : (
        <>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <span className="muted" style={{ fontSize: 13 }}>{rows.length} transaction{rows.length === 1 ? "" : "s"}</span>
            <button className="small" onClick={() => downloadCsv("relationship-transactions.csv",
              ["Recorded", "Type", "Grantor", "Grantee", "County", "Abstract", "Instrument #"],
              rows.map((r) => [r.recordingDate.slice(0, 10), r.docTypeRaw, r.grantor, r.grantee, `${r.county}, ${r.state}`, r.abstractId, r.instrumentNumber]))}>Export CSV</button>
          </div>
          <div className="table-scroll" style={{ maxHeight: 420 }}>
            <table className="data-table">
              <thead><tr><th>Recorded</th><th>Type</th><th>Grantor</th><th>Grantee</th><th>County</th><th>Abstract</th><th>Instr #</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.recordingDate)}</td>
                    <td title={r.docTypeRaw}>{prettyEnum(r.docType)}</td>
                    <td>{r.grantor ?? "—"}</td>
                    <td>{r.grantee ?? "—"}</td>
                    <td>{r.county}, {r.state}</td>
                    <td>{r.abstractId ?? "—"}</td>
                    <td>{r.instrumentNumber ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

const SIGNAL_META: Record<string, { label: string; color: string }> = {
  CONFLUENCE: { label: "Multiple Signals", color: "#f59e0b" },
  TRANSACTION_SURGE: { label: "Transaction Surge", color: "#3b82f6" },
  LEASE_SURGE: { label: "Leasing Surge", color: "#22c55e" },
  PERMIT_SURGE: { label: "Permitting Surge", color: "#8b5cf6" },
  ABSTRACT_CONCENTRATION: { label: "Concentrated Buying", color: "#ec4899" },
  NEW_OPERATOR: { label: "New Operator", color: "#06b6d4" },
};

function OpportunitiesTab({ qs, onDrill }: { qs: string; onDrill: (patch: Partial<Filters>) => void }) {
  const [data, setData] = useState<{ signals: Signal[] } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.get<{ signals: Signal[] }>(`/research/opportunities?${qs}`).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [qs]);

  if (loading && !data) return <Spinner label="Scanning for emerging opportunities…" />;
  if (!data) return <Banner kind="info">Could not load opportunities.</Banner>;
  if (data.signals.length === 0) {
    return <Banner kind="info">No statistically significant surges detected in this period — try widening the date range or clearing filters.</Banner>;
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        Signals are detected by comparing the selected period against six equal history windows (z-score ≥ 2 plus a
        material lift), clustering by geography, and flagging new entrants. Higher severity = stronger, higher-volume anomaly.
      </p>
      {data.signals.map((s) => {
        const meta = SIGNAL_META[s.kind] ?? { label: s.kind, color: "#94a3b8" };
        return (
          <div key={s.id} className="panel" style={{ borderLeft: `3px solid ${meta.color}`, display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div style={{ minWidth: 64, textAlign: "center" }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: meta.color }}>{s.severity}</div>
              <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>severity</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="badge" style={{ background: `${meta.color}26`, color: meta.color }}>{meta.label}</span>
                <strong>{s.title}</strong>
              </div>
              <p style={{ margin: "6px 0 8px" }}>{s.detail}</p>
              <button className="small" onClick={() => onDrill({ state: s.state, counties: s.county ? [s.county] : [] })}>
                View underlying records →
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Records (drill-in tables)
// ---------------------------------------------------------------------------

function RecordsTab({ qs }: { qs: string }) {
  const { can } = useAuth();
  const canManage = can("manageResearchData");
  const [kind, setKind] = useState<"documents" | "permits">("documents");
  const [page, setPage] = useState(1);
  const [archived, setArchived] = useState(false);
  const [docs, setDocs] = useState<Paged<DocRecord> | null>(null);
  const [permits, setPermits] = useState<Paged<PermitRecord> | null>(null);
  const [loading, setLoading] = useState(true);
  const sel = useRowSelection();
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const pageSize = 50;

  useEffect(() => { setPage(1); sel.clear(); }, [qs, kind, archived]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLoading(true);
    const url = `/research/${kind}?${qs}&page=${page}&pageSize=${pageSize}${archived ? "&archived=true" : ""}`;
    if (kind === "documents") api.get<Paged<DocRecord>>(url).then(setDocs).catch(() => setDocs(null)).finally(() => setLoading(false));
    else api.get<Paged<PermitRecord>>(url).then(setPermits).catch(() => setPermits(null)).finally(() => setLoading(false));
  }, [qs, kind, page, archived, reloadKey]);

  async function bulk(action: "delete" | "archive" | "unarchive") {
    setBusy(true);
    try {
      await api.post("/research/records/bulk", { kind: kind.toUpperCase(), ids: [...sel.selected], action });
      sel.clear(); setConfirmDel(false); setReloadKey((k) => k + 1);
    } finally { setBusy(false); }
  }
  function exportSelected() {
    if (kind === "documents") {
      const rows = (docs?.rows ?? []).filter((r) => sel.selected.has(r.id));
      downloadCsv("research-documents-selected.csv",
        ["Recording Date", "Type", "Class", "Grantor", "Grantee", "Instrument #", "State", "County", "Abstract"],
        rows.map((r) => [r.recordingDate.slice(0, 10), r.docTypeRaw, r.docClass, r.grantor, r.grantee, r.instrumentNumber, r.state, r.county, r.abstractId]));
    } else {
      const rows = (permits?.rows ?? []).filter((r) => sel.selected.has(r.id));
      downloadCsv("research-permits-selected.csv",
        ["Date", "Operator", "Lease", "Well", "API #", "Permit #", "Status", "Trajectory", "State", "County", "Formation", "Source"],
        rows.map((r) => [r.activityDate.slice(0, 10), r.operator, r.leaseName, r.wellName, r.apiNumber, r.permitNumber, r.status, r.trajectory, r.state, r.county, r.formation, r.source]));
    }
  }

  async function exportAll() {
    // Export up to 2000 most-recent matching rows.
    if (kind === "documents") {
      const d = await api.get<Paged<DocRecord>>(`/research/documents?${qs}&page=1&pageSize=1000`);
      downloadCsv("research-documents.csv",
        ["Recording Date", "Type", "Class", "Grantor", "Grantee", "Instrument #", "State", "County", "Abstract"],
        d.rows.map((r) => [r.recordingDate.slice(0, 10), r.docTypeRaw, r.docClass, r.grantor, r.grantee, r.instrumentNumber, r.state, r.county, r.abstractId]));
    } else {
      const d = await api.get<Paged<PermitRecord>>(`/research/permits?${qs}&page=1&pageSize=1000`);
      downloadCsv("research-permits.csv",
        ["Date", "Operator", "Lease", "Well", "API #", "Permit #", "Status", "Trajectory", "State", "County", "Formation", "Source"],
        d.rows.map((r) => [r.activityDate.slice(0, 10), r.operator, r.leaseName, r.wellName, r.apiNumber, r.permitNumber, r.status, r.trajectory, r.state, r.county, r.formation, r.source]));
    }
  }

  const active = kind === "documents" ? docs : permits;
  const totalPages = active ? Math.max(1, Math.ceil(active.total / pageSize)) : 1;

  const docColumns: Column<DocRecord>[] = [
    { key: "recordingDate", header: "Recorded", value: (r) => r.recordingDate, render: (r) => fmtDate(r.recordingDate), type: "date" },
    { key: "docType", header: "Type", value: (r) => r.docTypeRaw, render: (r) => <span title={r.docTypeRaw}>{prettyEnum(r.docType)}</span> },
    { key: "grantor", header: "Grantor (Seller)", value: (r) => r.grantor },
    { key: "grantee", header: "Grantee (Buyer)", value: (r) => r.grantee },
    { key: "county", header: "County", value: (r) => `${r.county}, ${r.state}` },
    { key: "abstractId", header: "Abstract", value: (r) => r.abstractId },
    { key: "instrumentNumber", header: "Instr #", value: (r) => r.instrumentNumber },
  ];
  const permitColumns: Column<PermitRecord>[] = [
    { key: "activityDate", header: "Date", value: (r) => r.activityDate, render: (r) => fmtDate(r.activityDate), type: "date" },
    { key: "operator", header: "Operator", value: (r) => r.operator },
    { key: "leaseName", header: "Lease / Well", value: (r) => `${r.leaseName ?? ""} ${r.wellName ?? ""}`.trim() || null },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => prettyEnum(r.status) },
    { key: "trajectory", header: "Trajectory", value: (r) => r.trajectory, render: (r) => prettyEnum(r.trajectory) },
    { key: "county", header: "County", value: (r) => `${r.county}, ${r.state}` },
    { key: "formation", header: "Formation", value: (r) => r.formation },
    { key: "apiNumber", header: "API #", value: (r) => r.apiNumber },
  ];

  return (
    <div className="panel">
      <div className="panel-title">
        <div className="chip-row">
          <span className={`chip ${kind === "documents" ? "active" : ""}`} onClick={() => setKind("documents")}>Recorded Documents</span>
          <span className={`chip ${kind === "permits" ? "active" : ""}`} onClick={() => setKind("permits")}>Drilling Permits</span>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          {active && <span className="muted" style={{ fontSize: 12 }}>{num(active.total)} {archived ? "archived " : ""}records</span>}
          {canManage && <label className="dm-chk" style={{ fontSize: 12 }}><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>}
          <button className="small" onClick={exportAll} disabled={!active?.total}>Export CSV</button>
        </div>
      </div>
      {canManage && sel.selected.size > 0 && (
        <BulkBar count={sel.selected.size} onClear={sel.clear}>
          <button className="small" onClick={exportSelected}>Export</button>
          {archived
            ? <button className="small" onClick={() => bulk("unarchive")} disabled={busy}>Unarchive</button>
            : <button className="small" onClick={() => bulk("archive")} disabled={busy}>Archive</button>}
          <button className="small danger" onClick={() => setConfirmDel(true)} disabled={busy}>Delete</button>
        </BulkBar>
      )}
      {loading && !active ? <Spinner /> : !active || active.total === 0 ? <p className="muted">No matching records.</p> : (
        <>
          {kind === "documents"
            ? <SortableTable columns={docColumns} rows={docs!.rows} rowKey={(r) => r.id} selection={canManage ? { selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll } : undefined} />
            : <SortableTable columns={permitColumns} rows={permits!.rows} rowKey={(r) => r.id} selection={canManage ? { selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll } : undefined} />}
          {totalPages > 1 && (
            <div className="row" style={{ gap: 8, alignItems: "center", justifyContent: "flex-end", marginTop: 10 }}>
              <button className="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
              <span className="muted" style={{ fontSize: 12 }}>Page {page} of {num(totalPages)}</span>
              <button className="small" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
      {confirmDel && (
        <ConfirmDelete count={sel.selected.size} itemLabel="record" busy={busy} onCancel={() => setConfirmDel(false)} onConfirm={() => bulk("delete")} />
      )}
    </div>
  );
}
