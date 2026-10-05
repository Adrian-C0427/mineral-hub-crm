import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell,
} from "recharts";
import { ArrowRight, Search } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Banner, Modal, ConfirmDelete, SearchInput, ChipList } from "../components/ui";
import { Segmented, StatStrip, Tag, type StatCell } from "../components/kit";
import { Toggle } from "../components/Toggle";
import { useRowSelection, BulkBar } from "../components/bulk";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { useAbstractIndex } from "../components/AbstractPicker";
import { rankAbstracts, stateName } from "../lib/abstracts";
import { Select } from "../components/Select";
import { GeoFields } from "../components/GeoFields";
import { SortableTable, type Column } from "../components/SortableTable";
import { ChartTypeToggle, useChartType } from "../components/ChartTypeToggle";
import { ResearchImport } from "../components/ResearchImport";
import { ResearchChoropleth, type CountyStat } from "../components/ResearchChoropleth";
import { CLASS_COLORS, CLASS_FALLBACK_COLOR } from "../lib/entityClasses";
import { downloadCsv } from "../lib/csv";
import { fmtDate, num, prettyEnum, prettyDocType } from "../lib/format";
import { CHART_COLORS, chartTooltip } from "../lib/charts";
import { DateField } from "../components/DateField";
import { ChainSection, ClassBadge, PartyColumn, type ChainEntry, type RelParty } from "../components/relationshipViews";

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
  abstracts: { state: string; county: string; abstractId: string }[];
  surveys: { state: string; county: string; survey: string }[];
  buyers: { value: string; label: string }[]; sellers: { value: string; label: string }[]; operators: { value: string; label: string }[];
}
interface DocRecord {
  id: string; state: string; county: string; docTypeRaw: string; docType: string; docClass: string;
  instrumentNumber: string | null; recordingDate: string; grantor: string | null; grantee: string | null;
  /** Individual participants split from multi-party cells at import (may be
   *  empty on legacy rows — display falls back to the raw cell). */
  grantorParties?: string[]; granteeParties?: string[];
  abstractId: string | null; survey: string | null; acreage: number | null; consideration: number | null; source: string;
}
interface PermitRecord {
  id: string; state: string; county: string; apiNumber: string | null; permitNumber: string | null;
  operator: string; leaseName: string | null; wellName: string | null; status: string; trajectory: string;
  activityDate: string; formation: string | null; field: string | null; source: string;
}
interface Paged<T> { total: number; page: number; pageSize: number; rows: T[] }
// Platform RRC W-1 permits (rrc.permits) — read-only public-record rows,
// browsed in their own Records section, never mixed with org imports.
interface RrcPermitRecord {
  id: string; statusNo: string; api8: string | null; county: string; district: string | null;
  leaseName: string | null; wellNo: string | null; operator: string | null;
  permitDate: string | null; acres: number | null; survey: string | null; abstract: string | null;
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

type Period = "LAST_30D" | "LAST_90D" | "LAST_6M" | "LAST_12M" | "THIS_YEAR" | "CUSTOM";
type Compare = "NONE" | "PREV_PERIOD" | "PREV_YEAR";
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
  if (mode === "NONE" || !from || !to) return null;
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
  states: string[];
  counties: string[];
  abstracts: string[];
  surveys: string[];
  docTypes: string[];
  buyers: string[];
  sellers: string[];
  operators: string[];
}
const EMPTY_FILTERS: Filters = { states: [], counties: [], abstracts: [], surveys: [], docTypes: [], buyers: [], sellers: [], operators: [] };

// Customize View — which Overview KPIs show + their order (saved per user).
type ResMetricId = "transactions" | "leases" | "permits" | "horizontalPermits" | "uniqueBuyers" | "uniqueOperators";
const RES_METRICS: [ResMetricId, string][] = [
  ["transactions", "Mineral transactions"], ["leases", "Leasing documents"], ["permits", "Drilling permits"],
  ["horizontalPermits", "Horizontal permits"], ["uniqueBuyers", "Active buyers"], ["uniqueOperators", "Active operators"],
];
const DEFAULT_RES_METRICS: ResMetricId[] = RES_METRICS.map(([id]) => id);
const RES_METRIC_LABEL: Record<ResMetricId, string> = Object.fromEntries(RES_METRICS) as Record<ResMetricId, string>;
interface ResMetricPrefs { order: ResMetricId[]; hidden: ResMetricId[] }
const RES_METRICS_KEY = "mh-research-overview-metrics:v1";
function loadResMetricPrefs(): ResMetricPrefs {
  try { const raw = localStorage.getItem(RES_METRICS_KEY); if (raw) { const p = JSON.parse(raw) as Partial<ResMetricPrefs>; return { order: p.order ?? [], hidden: p.hidden ?? [] }; } } catch { /* ignore */ }
  return { order: [], hidden: [] };
}

type Tab = "overview" | "geography" | "rankings" | "relationships" | "opportunities" | "records" | "data";

/**
 * The Research module analyzes TWO distinct datasets that must never mix:
 * ownership transfers (deeds/conveyances — docClass TRANSACTION) and leasing
 * activity (docClass LEASE). The page-level toggle drives every request's
 * `docClass` param, so records, analytics, rankings, relationships, maps, and
 * filter options are all computed server-side from one dataset at a time.
 */
type Dataset = "TRANSACTION" | "LEASE";
const DATASET_KEY = "mh-research-dataset:v1";
const loadDataset = (): Dataset => {
  try { return localStorage.getItem(DATASET_KEY) === "LEASE" ? "LEASE" : "TRANSACTION"; } catch { return "TRANSACTION"; }
};

// ---------------------------------------------------------------------------
// Relationship-intelligence API types
// ---------------------------------------------------------------------------

interface RelRow {
  grantorNorm: string; grantor: string; granteeNorm: string; grantee: string;
  count: number; transactions: number; counties: string[]; abstracts: string[];
  firstDate: string | null; lastDate: string | null;
}
/** Acquisition partnerships only — counts and dates are shared acquisitions. */
interface CoBuyerRow {
  members: { norm: string; name: string }[]; count: number; counties: string[];
  sharedAcquisitions?: number;
  firstDate?: string | null; lastDate?: string | null;
}
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
  const { can, user } = useAuth();
  const [period, setPeriod] = useState<Period>("LAST_90D");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [compare, setCompare] = useState<Compare>("PREV_PERIOD");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [opts, setOpts] = useState<FilterOpts | null>(null);
  const [dataset, setDatasetState] = useState<Dataset>(loadDataset);
  const captureRef = useRef<HTMLDivElement>(null);

  const setDataset = useCallback((d: Dataset) => {
    setDatasetState(d);
    try { localStorage.setItem(DATASET_KEY, d); } catch { /* ignore */ }
    // Entity/doc-type selections belong to one dataset (a deed buyer isn't a
    // lessee); geography and dates carry over.
    setFilters((f) => ({ ...f, buyers: [], sellers: [], docTypes: [] }));
  }, []);

  const range = useMemo(() => rangeFor(period, custom), [period, custom]);
  const qs = useMemo(() => {
    const q = new URLSearchParams();
    q.set("docClass", dataset);
    if (range.from) q.set("from", range.from);
    if (range.to) q.set("to", range.to);
    const cp = compareParams(compare, range.from, range.to);
    if (cp.compareFrom && cp.compareTo) { q.set("compareFrom", cp.compareFrom); q.set("compareTo", cp.compareTo); }
    for (const s of filters.states) q.append("state", s);
    for (const c of filters.counties) q.append("county", c);
    for (const a of filters.abstracts) q.append("abstractId", a);
    for (const sv of filters.surveys) q.append("survey", sv);
    for (const t of filters.docTypes) q.append("docType", t);
    for (const b of filters.buyers) q.append("buyer", b);
    for (const s of filters.sellers) q.append("seller", s);
    for (const o of filters.operators) q.append("operator", o);
    return q.toString();
  }, [range.from, range.to, compare, filters, dataset]);

  // Filter options are dataset-scoped: buyers/sellers/doc types offered come
  // only from the active class's documents.
  const loadOpts = useCallback(() => { api.get<FilterOpts>(`/research/filters?docClass=${dataset}`).then(setOpts).catch(() => {}); }, [dataset]);
  useEffect(loadOpts, [loadOpts]);

  const hasAnyData = opts != null && (opts.states.length > 0 || opts.counties.length > 0);
  const canManage = can("manageResearchData");


  const activeFilterCount =
    filters.states.length + filters.counties.length + filters.abstracts.length + filters.surveys.length + filters.docTypes.length +
    filters.buyers.length + filters.sellers.length + filters.operators.length;
  const compareOff = compare === "NONE";

  const drillToRecords = useCallback((patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setTab("records");
  }, []);

  const CHIPS: [Period, string][] = [
    ["LAST_30D", "30D"], ["LAST_90D", "90D"], ["LAST_6M", "6M"],
    ["LAST_12M", "12M"], ["THIS_YEAR", "YTD"], ["CUSTOM", "Custom"],
  ];
  const cmpRange = compareRangeFor(compare, range.from, range.to);
  // Show the year on the compare range only when it differs from the current range's year.
  const cmpWithYear = cmpRange != null && range.to !== "" &&
    new Date(`${cmpRange.to}T00:00:00Z`).getUTCFullYear() !== new Date(`${range.to}T00:00:00Z`).getUTCFullYear();
  const TABS: [Tab, string][] = [
    ["overview", "Overview"], ["geography", "Geography"], ["rankings", "Rankings"],
    ["relationships", "Relationships"], ["opportunities", "Opportunities"], ["records", "Records"],
    ...(canManage ? ([["data", "Data & imports"]] as [Tab, string][]) : []),
  ];
  const rangeLabel = range.from && range.to ? fmtRangeLabel(range.from, range.to) : "";

  return (
    <div className="page research-page">
      <div className="page-header rs-header">
        <div className="rs-title">
          <h1>Research &amp; Market Intelligence</h1>
          <div className="page-sub rs-sub">
            {range.from && range.to ? (
              <>
                <span className="rs-sub-cur">{rangeLabel}</span>
                {cmpRange ? (
                  <>
                    <span>compared with</span>
                    <span className="rs-sub-prior">{fmtRangeLabel(cmpRange.from, cmpRange.to, cmpWithYear)}</span>
                    <span>({compare === "PREV_YEAR" ? "previous year" : "previous period"})</span>
                  </>
                ) : <span>no comparison</span>}
              </>
            ) : <span>Select a custom date range</span>}
            <span className="rs-sub-dot" aria-hidden="true" />
            <span>{dataset === "LEASE" ? "Leases" : "Transactions"}</span>
          </div>
        </div>
        <div className="reports-toolbar rs-toolbar">
          {/* Dataset switch — Transactions/Deeds vs Leases. Drives docClass on
              every request so the two record classes never mix in any view. */}
          <Segmented<Dataset> ariaLabel="Dataset" value={dataset} onChange={setDataset}
            options={[{ value: "TRANSACTION", label: "Transactions" }, { value: "LEASE", label: "Leases" }]} />
          <Segmented<Period> accent ariaLabel="Period" value={period} onChange={setPeriod}
            options={CHIPS.map(([p, label]) => ({ value: p, label }))} />
          <button type="button" className={`rs-filter-btn ${showFilters || activeFilterCount > 0 ? "on" : ""}`} onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" /></svg>
            Filters{activeFilterCount > 0 && <span className="rs-count-badge">{activeFilterCount}</span>}
          </button>
        </div>
      </div>

      {/* --- Filter controls --- */}
      {showFilters && opts && (
        <div className="rs-filters">
          <div className="rs-filters-head">
            <span className="rs-filters-title">Filters</span>
            <div className="rs-filters-actions">
              <button type="button" className="rs-text-btn" disabled={activeFilterCount === 0} onClick={() => setFilters(EMPTY_FILTERS)}>Clear all</button>
              <button type="button" className="rs-icon-x" aria-label="Close filters" onClick={() => setShowFilters(false)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
          </div>
          <div className="filters-grid rs-fgrid">
            {period === "CUSTOM" && (
              <>
                <div className="field" style={{ marginBottom: 0 }}><label>From</label><DateField value={custom.from} onChange={(v) => setCustom((c) => ({ ...c, from: v }))} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label>To</label><DateField value={custom.to} onChange={(v) => setCustom((c) => ({ ...c, to: v }))} /></div>
              </>
            )}
            <div className="field" style={{ marginBottom: 0 }}><label>Compare to</label>
              <Select value={compare} onChange={(v) => setCompare(v as Compare)} ariaLabel="Compare to"
                options={[
                  { value: "NONE", label: "No comparison" },
                  { value: "PREV_PERIOD", label: "Previous period" },
                  { value: "PREV_YEAR", label: "Previous year" },
                ]} />
            </div>
            {/* Shared geographic hierarchy: all 50 states + cascading counties,
                identical to Buyers/Deals/Reports. Renders State + County fields. */}
            <GeoFields
              states={filters.states} onStatesChange={(states) => setFilters((f) => ({ ...f, states }))}
              counties={filters.counties} onCountiesChange={(counties) => setFilters((f) => ({ ...f, counties }))}
              labels={{ state: "States", county: "Counties" }}
            />
            {/* Abstract completes the State → County → Abstract cascade. Values
                are the research data's abstract ids; options narrow to the
                selected counties/states (all abstracts with activity when no
                county is picked). */}
            <ResearchSurveyFilter
              options={opts.surveys ?? []}
              states={filters.states}
              counties={filters.counties}
              value={filters.surveys}
              onChange={(surveys) => setFilters((f) => ({ ...f, surveys }))}
            />
            <ResearchAbstractFilter
              options={opts.abstracts ?? []}
              states={filters.states}
              counties={filters.counties}
              value={filters.abstracts}
              onChange={(abstracts) => setFilters((f) => ({ ...f, abstracts }))}
            />
            <div className="field" style={{ marginBottom: 0, minWidth: 190, flex: 1 }}><label>Document types</label>
              <SearchableMultiSelect
                options={opts.docTypes}
                labels={Object.fromEntries(opts.docTypes.map((t) => [t, prettyDocType(t)]))}
                value={filters.docTypes}
                onChange={(next) => setFilters((f) => ({ ...f, docTypes: next }))}
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
        </div>
      )}

      {opts != null && !hasAnyData && tab !== "data" && (
        <Banner kind="info">
          No research data yet. {canManage
            ? <>Head to the <a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => setTab("data")}>Data &amp; imports</a> tab to load county recordings or drilling permits (or run the sample-data CLI to explore).</>
            : "Ask an administrator to import county recording or permit data."}
        </Banner>
      )}

      <div className="tab-row rs-tabs" role="tablist">
        {TABS.map(([t, label]) => <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{label}</button>)}
      </div>

      <div ref={captureRef} className="report-capture rs-body">
        {tab === "overview" && <OverviewTab qs={qs} compareOff={compareOff} dataset={dataset} />}
        {tab === "geography" && <GeographyTab qs={qs} filters={filters} compareOff={compareOff} onDrill={drillToRecords}
          onSetCounties={(counties) => setFilters((f) => ({ ...f, counties }))} />}
        {tab === "rankings" && <RankingsTab qs={qs} opts={opts} compareOff={compareOff} onDrill={drillToRecords} dataset={dataset} rangeLabel={rangeLabel} />}
        {tab === "relationships" && <RelationshipsTab qs={qs} onDrill={drillToRecords} dataset={dataset} />}
        {tab === "opportunities" && <OpportunitiesTab qs={qs} onDrill={drillToRecords} />}
        {tab === "records" && <RecordsTab qs={qs} dataset={dataset} />}
        {tab === "data" && canManage && <ResearchImport onDataChanged={loadOpts} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({ qs, compareOff, dataset }: { qs: string; compareOff: boolean; dataset: Dataset }) {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [metricPrefs, setMetricPrefs] = useState<ResMetricPrefs>(loadResMetricPrefs);
  useEffect(() => { try { localStorage.setItem(RES_METRICS_KEY, JSON.stringify(metricPrefs)); } catch { /* ignore */ } }, [metricPrefs]);
  // Customize View — per-chart visualization type (saved per user).
  const [trendType, setTrendType] = useChartType("research-activity", ["bar", "line"], "bar");
  const [docType, setDocType] = useChartType("research-doctypes", ["bar", "pie"], "bar");
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

  // The off-dataset KPI is structurally zero (the server excludes that class),
  // so it never renders — a Leases view shows lease metrics, not empty deed ones.
  const offDataset: ResMetricId = dataset === "TRANSACTION" ? "leases" : "transactions";
  const kpiLabel = (id: ResMetricId): string =>
    dataset === "LEASE" && id === "uniqueBuyers" ? "Active lessees" : RES_METRIC_LABEL[id];
  const orderedMetrics: ResMetricId[] = [...metricPrefs.order.filter((id) => DEFAULT_RES_METRICS.includes(id)), ...DEFAULT_RES_METRICS.filter((id) => !metricPrefs.order.includes(id))];
  const visibleMetrics = orderedMetrics.filter((id) => !metricPrefs.hidden.includes(id) && id !== offDataset);
  const kpiCells: StatCell[] = visibleMetrics.filter((id) => t[id]).map((id) => ({
    label: kpiLabel(id),
    value: num(t[id].current),
    // Change tags are comparative — hidden when comparison is off.
    sub: compareOff ? undefined : <span className="rs-delta-line"><DeltaTag t={t[id]} /><span>vs {num(t[id].previous)}</span></span>,
  }));

  // Series colours — one document series per view (the off-dataset class is
  // excluded server-side, so its series would just be zeros).
  const docKey = dataset === "TRANSACTION" ? "transactions" : "leases";
  const docName = dataset === "TRANSACTION" ? "Transactions" : "Leases";
  const docColor = dataset === "TRANSACTION" ? CHART_COLORS[0] : CHART_COLORS[1];
  const permitColor = CHART_COLORS[3];
  const avgColor = CHART_COLORS[2];
  const axisTick = { fontSize: 11, fill: "var(--ink-4)" };

  const docRows = data.docTypeBreakdown;
  const docTotal = docRows.reduce((s, d) => s + d.count, 0);
  const docMax = Math.max(1, ...docRows.map((d) => d.count));

  // Period vs prior — every value comes straight from the summary payload.
  const pvp: ResMetricId[] = [docKey, "permits", "uniqueBuyers", "uniqueOperators"];

  return (
    <>
      <div className="rs-ov-tools">
        <ResearchMetricsCustomize prefs={metricPrefs} onChange={setMetricPrefs} />
      </div>
      {kpiCells.length > 0 && <StatStrip className="rs-kpis" cells={kpiCells} />}

      <div className="chart-grid rs-ov-grid">
        <section className="panel rs-panel rs-span" >
          <div className="rs-panel-head">
            <div className="rs-panel-titles">
              <h3>Activity trend</h3>
              <span className="rs-panel-sub">Records per {data.granularity} · line is the rolling average of the total</span>
            </div>
            <div className="rs-panel-tools">
              <div className="rs-legend">
                <span><i className="sq" style={{ background: docColor }} />{docName}</span>
                <span><i className="sq" style={{ background: permitColor }} />Permits</span>
                <span><i className="ln" style={{ background: avgColor }} />Rolling avg</span>
              </div>
              <ChartTypeToggle type={trendType} options={["bar", "line"]} onChange={setTrendType} />
            </div>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={data.series.map((s) => ({ ...s, label: label(s.key) }))} margin={{ top: 4, right: 4, left: -8, bottom: 0 }} barCategoryGap="24%">
              <CartesianGrid vertical={false} stroke="var(--line-faint)" />
              <XAxis dataKey="label" tick={axisTick} minTickGap={24} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} />
              <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={36} />
              <Tooltip {...chartTooltip} />
              {trendType === "line" ? (
                <>
                  <Line type="monotone" dataKey={docKey} name={docName} stroke={docColor} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="permits" name="Permits" stroke={permitColor} strokeWidth={2} dot={false} />
                </>
              ) : (
                <>
                  <Bar dataKey={docKey} name={docName} stackId="a" fill={docColor} />
                  <Bar dataKey="permits" name="Permits" stackId="a" fill={permitColor} radius={[3, 3, 0, 0]} />
                </>
              )}
              <Line dataKey="rollingAvg" name="Rolling avg" stroke={avgColor} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </section>

        <section className="panel rs-panel">
          <div className="rs-panel-head">
            <div className="rs-panel-titles"><h3>Document types</h3></div>
            <div className="rs-panel-tools">
              {docRows.length > 0 && <span className="rs-panel-meta">{num(docTotal)} records</span>}
              {docRows.length > 0 && <ChartTypeToggle type={docType} options={["bar", "pie"]} onChange={setDocType} />}
            </div>
          </div>
          {docRows.length === 0 ? <p className="rs-empty">No documents in this period.</p> : docType === "pie" ? (
            <ResponsiveContainer width="100%" height={Math.max(220, docRows.length * 30)}>
              <PieChart>
                <Pie data={docRows.map((d) => ({ name: prettyDocType(d.docType), count: d.count }))} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={85} stroke="var(--surface)" label={(e: { name?: string }) => e.name ?? ""}>
                  {docRows.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip {...chartTooltip} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="rs-doclist">
              {docRows.map((d) => (
                <div key={d.docType} className="rs-docrow" title={`${prettyDocType(d.docType)} · ${num(d.count)}`}>
                  <div className="rs-docrow-top"><span>{prettyDocType(d.docType)}</span><b>{num(d.count)}</b></div>
                  <span className="rs-bar"><i style={{ width: `${(d.count / docMax) * 100}%` }} /></span>
                </div>
              ))}
            </div>
          )}
        </section>

        {!compareOff && (
          <section className="panel rs-panel">
            <div className="rs-panel-head">
              <div className="rs-panel-titles"><h3>Period vs prior</h3></div>
              <div className="rs-legend">
                <span><i className="sq prior" />Prior</span>
                <span><i className="sq" style={{ background: "var(--accent)" }} />Current</span>
              </div>
            </div>
            <div className="rs-pvp">
              {pvp.map((id) => {
                const cur = data.kpis[id] ?? 0, prev = data.previous[id] ?? 0;
                const max = Math.max(1, cur, prev);
                return (
                  <div key={id} className="rs-pvp-item">
                    <div className="rs-pvp-top">
                      <span>{kpiLabel(id)}</span>
                      {t[id] && <DeltaText t={t[id]} />}
                    </div>
                    <div className="rs-pvp-bars">
                      <span className="rs-bar thick prior"><i style={{ width: `${(prev / max) * 100}%` }} /></span><span className="rs-pvp-v prior">{num(prev)}</span>
                      <span className="rs-bar thick"><i style={{ width: `${(cur / max) * 100}%` }} /></span><span className="rs-pvp-v">{num(cur)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

/** Change tag beside a KPI: arrow + percent, "New" when there was no prior activity. */
function DeltaTag({ t }: { t: TrendT }) {
  const arrow = t.direction === "flat" ? "→" : t.direction === "up" ? "▲" : "▼";
  return (
    <span className={`rs-delta ${t.direction}`}>
      {t.pctChange == null ? "New" : `${arrow} ${fmtPct(t.pctChange).replace(/^[+-]/, "")}`}
    </span>
  );
}

/** Coloured change text ("+12%" / "New") used by Period vs prior. */
function DeltaText({ t }: { t: TrendT }) {
  return <span className={`rs-delta-text ${t.direction}`}>{t.pctChange == null ? "New" : fmtPct(t.pctChange)}</span>;
}

/** Customize View popover for the Research Overview KPIs (show/hide + reorder). */
function ResearchMetricsCustomize({ prefs, onChange }: { prefs: ResMetricPrefs; onChange: (p: ResMetricPrefs) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const ordered: ResMetricId[] = [...prefs.order.filter((id) => DEFAULT_RES_METRICS.includes(id)), ...DEFAULT_RES_METRICS.filter((id) => !prefs.order.includes(id))];
  const toggle = (id: ResMetricId) => onChange({ ...prefs, hidden: prefs.hidden.includes(id) ? prefs.hidden.filter((k) => k !== id) : [...prefs.hidden, id] });
  // Drag-and-drop reorder (replaces the old ↑/↓ arrows).
  const [dragId, setDragId] = useState<ResMetricId | null>(null);
  const [overId, setOverId] = useState<ResMetricId | null>(null);
  const reorder = (from: ResMetricId, to: ResMetricId) => {
    if (from === to) return;
    const keys = [...ordered];
    const fi = keys.indexOf(from), ti = keys.indexOf(to);
    if (fi < 0 || ti < 0) return;
    keys.splice(fi, 1); keys.splice(ti, 0, from);
    onChange({ ...prefs, order: keys });
  };
  const isDefault = prefs.order.length === 0 && prefs.hidden.length === 0;
  return (
    <div className="cv-wrap" ref={ref}>
      <button type="button" className={`rs-ghost-btn cv-btn ${open ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title="Customize metrics" aria-expanded={open}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>
        Customize metrics
      </button>
      {open && (
        <div className="cv-menu" role="dialog" aria-label="Customize metrics">
          <div className="cv-head"><strong>Metrics</strong><span className="muted" style={{ fontSize: 12 }}>Show, hide &amp; reorder</span></div>
          <div className="cv-list">
            {ordered.map((id) => (
              <div key={id}
                className={`cv-row ${dragId === id ? "dragging" : ""} ${overId === id && dragId && dragId !== id ? "drop-over" : ""}`}
                onDragOver={(e) => { if (!dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overId !== id) setOverId(id); }}
                onDrop={(e) => { e.preventDefault(); if (dragId) reorder(dragId, id); setDragId(null); setOverId(null); }}
              >
                <span className="cv-drag" title="Drag to reorder" aria-label="Drag to reorder" draggable
                  onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setDragId(null); setOverId(null); }}>⠿</span>
                <label className="cv-check">
                  <input type="checkbox" checked={!prefs.hidden.includes(id)} onChange={() => toggle(id)} />
                  <span>{RES_METRIC_LABEL[id]}</span>
                </label>
              </div>
            ))}
          </div>
          <div className="cv-foot">
            <button type="button" className="small" disabled={isDefault} onClick={() => onChange({ order: [], hidden: [] })}>Restore default</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Abstract filter — third link of the State → County → Abstract cascade in the
 * Research filter bar. Same searchable multi-select as every other abstract
 * selector; options are limited to abstracts with research activity in the
 * currently selected counties (or states), and selections invalidated by a
 * county change are auto-pruned like the county/state cascade.
 */
/** Survey-name filter — same dynamic, county/state-scoped searchable pattern
 *  as the Abstract filter; options come from the imported data itself. */
function ResearchSurveyFilter({ options, states, counties, value, onChange }: {
  options: { state: string; county: string; survey: string }[];
  states: string[]; counties: string[];
  value: string[]; onChange: (v: string[]) => void;
}) {
  const scoped = useMemo(() => {
    const cs = new Set(counties.map((c) => c.toUpperCase()));
    const ss = new Set(states.map((s) => s.toUpperCase()));
    return options.filter((o) =>
      (!counties.length || cs.has(o.county.toUpperCase())) &&
      (!states.length || ss.has(o.state.toUpperCase())));
  }, [options, states.join("|"), counties.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = useMemo(() => [...new Set(scoped.map((o) => o.survey))], [scoped]);

  // Cascade pruning, mirroring the Abstract filter.
  useEffect(() => {
    if (!counties.length && !states.length) return;
    const valid = new Set(names);
    const pruned = value.filter((v) => valid.has(v));
    if (pruned.length !== value.length) onChange(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names.join("|")]);

  return (
    <div className="field" style={{ marginBottom: 0, minWidth: 190, flex: 1 }}><label>Surveys</label>
      <SearchableMultiSelect
        options={names}
        value={value}
        onChange={onChange}
        placeholder={names.length ? "Search surveys…" : "No surveys in the data"}
      />
    </div>
  );
}

function ResearchAbstractFilter({ options, states, counties, value, onChange }: {
  options: { state: string; county: string; abstractId: string }[];
  states: string[]; counties: string[];
  value: string[]; onChange: (v: string[]) => void;
}) {
  const scoped = useMemo(() => {
    const cs = new Set(counties.map((c) => c.toUpperCase()));
    const ss = new Set(states.map((s) => s.toUpperCase()));
    return options.filter((o) =>
      (!counties.length || cs.has(o.county.toUpperCase())) &&
      (!states.length || ss.has(o.state.toUpperCase())));
  }, [options, states.join("|"), counties.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const absIndex = useAbstractIndex();
  const labels = useMemo(() => {
    // The same abstract number can exist in several counties; show each once
    // with every county it's in so the choice stays unambiguous.
    const where = new Map<string, { county: string; state: string }[]>();
    for (const o of scoped) where.set(o.abstractId, [...(where.get(o.abstractId) ?? []), o]);
    const m: Record<string, string> = {};
    for (const [id, locs] of where) {
      if (locs.length === 1) { m[id] = absIndex.label(id, locs[0].county, locs[0].state); continue; }
      const cs = [...new Set(locs.map((l) => l.county))].sort();
      const ss = [...new Set(locs.map((l) => stateName(l.state)))];
      m[id] = `Abstract ${id.replace(/^a\s*-\s*/i, "")} · ${cs.length <= 3 ? `${cs.join(", ")} Counties` : `${cs.length} counties`}, ${ss.join(" / ")}`;
    }
    return m;
  }, [scoped, absIndex]);
  const ids = useMemo(() => [...new Set(scoped.map((o) => o.abstractId))], [scoped]);
  // Number-first ranking as you type; numeric order when the box is empty.
  const rank = useCallback((opts: readonly string[], q: string) =>
    rankAbstracts(opts, q, (id) => ({ abstract: id, text: labels[id] ?? id })), [labels]);

  // Cascade pruning, mirroring GeoFields' county behavior.
  useEffect(() => {
    if (!counties.length && !states.length) return;
    const valid = new Set(ids);
    const pruned = value.filter((v) => valid.has(v));
    if (pruned.length !== value.length) onChange(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join("|")]);

  return (
    <div className="field" style={{ marginBottom: 0, minWidth: 190, flex: 1 }}><label>Abstracts</label>
      <SearchableMultiSelect
        options={ids}
        labels={labels}
        filterOptions={rank}
        value={value}
        onChange={onChange}
        placeholder={ids.length ? "Search abstract # or survey…" : counties.length ? "No abstracts with activity" : "Select a county first"}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

function GeographyTab({ qs, filters, compareOff, onDrill, onSetCounties }: {
  qs: string; filters: Filters; compareOff: boolean;
  onDrill: (patch: Partial<Filters>) => void;
  /** Replace the page-wide county filter (empty array = statewide). */
  onSetCounties: (counties: string[]) => void;
}) {
  const [level, setLevel] = useState<"county" | "abstract" | "state">("county");
  const [metric, setMetric] = useState<"activity" | "change">("activity");
  const [data, setData] = useState<{ level: string; rows: GeoRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  // The map always shows county-level stats regardless of the table level.
  const [countyRows, setCountyRows] = useState<GeoRow[]>([]);
  // Map drill-down: the county the map is zoomed into (null = state overview).
  // The choropleth animates into the county and overlays its abstract mesh
  // (geometry + $ totals via /research/abstract-map) — this superseded the
  // earlier static single-county swap map.
  const [focusCounty, setFocusCounty] = useState<string | null>(null);
  const [focusAbstractRows, setFocusAbstractRows] = useState<GeoRow[]>([]);
  // Hovering a county in the side list outlines it on the map.
  const [hoverCounty, setHoverCounty] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.get<{ level: string; rows: GeoRow[] }>(`/research/geography?level=${level}&${qs}`).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [qs, level]);
  // Seamless level switching: the table keeps showing the PREVIOUS level's
  // rows (gently dimmed) until the new level's data arrives — no flash to a
  // spinner, no rows rendered under the wrong columns. Everything derived
  // from the table (name column, headers, drill links) follows the level of
  // the data on screen (`shownLevel`), never the not-yet-loaded selection.
  const shownLevel = (data?.level as typeof level | undefined) ?? level;
  useEffect(() => {
    // Only reuse the table's rows when they really are county rows (data can
    // briefly hold the previous level while a switch is in flight).
    if (level === "county" && data?.level === "county") { setCountyRows(data.rows); return; }
    api.get<{ level: string; rows: GeoRow[] }>(`/research/geography?level=county&${qs}`).then((d) => setCountyRows(d.rows)).catch(() => {});
  }, [qs, level, data]);
  // Abstract-level stats for the drilled-in county (colors + hotspot outlines
  // on the map's abstract layer). Scoped to that county on top of the shared
  // filters; period filters in `qs` still apply.
  useEffect(() => {
    if (!focusCounty) { setFocusAbstractRows([]); return; }
    const q = new URLSearchParams(qs);
    // County names are matched exactly server-side — use the stats row's own
    // spelling rather than the map feature's ("Leon" vs "LEON").
    const row = countyRows.find((r) => r.county && r.county.toUpperCase() === focusCounty.toUpperCase());
    q.delete("county"); q.append("county", row?.county ?? focusCounty);
    api.get<{ level: string; rows: GeoRow[] }>(`/research/geography?level=abstract&${q}`)
      .then((d) => setFocusAbstractRows(d.rows))
      .catch(() => setFocusAbstractRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs, focusCounty, countyRows.length]);

  const absIndex = useAbstractIndex();
  const geoName = (r: GeoRow) =>
    shownLevel === "state" ? r.state
      : shownLevel === "county" ? `${r.county}, ${r.state}`
        : absIndex.label(r.abstractId, r.county, r.state);

  const columns: Column<GeoRow>[] = [
    { key: "name", header: shownLevel === "state" ? "State" : shownLevel === "county" ? "County" : "Abstract", value: geoName,
      render: (r) => (
        <>
          {/* At abstract level the name is a direct gateway into the records
              behind it — click opens Records filtered to that abstract. */}
          {shownLevel === "abstract" && r.abstractId
            // Standard text color (not link blue) — still clickable via the row.
            ? <a className="rs-geo-name" title={`View records for abstract ${r.abstractId}`}>{geoName(r)}</a>
            : <span className="rs-geo-name">{geoName(r)}</span>}
        </>
      ) },
    { key: "transactions", header: "Transactions", value: (r) => r.transactions, align: "right", render: (r) => <span className={`rec-nowrap ${r.transactions ? "" : "rs-zero"}`}>{num(r.transactions)}</span> },
    { key: "leases", header: "Leases", value: (r) => r.leases, align: "right", render: (r) => <span className={`rec-nowrap ${r.leases ? "" : "rs-zero"}`}>{num(r.leases)}</span> },
    { key: "permits", header: "Permits", value: (r) => r.permits, align: "right", render: (r) => <span className={`rec-nowrap ${r.permits ? "" : "rs-zero"}`}>{num(r.permits)}</span> },
    { key: "total", header: "Total", value: (r) => r.total, align: "right", render: (r) => <b className="rec-nowrap">{num(r.total)}</b> },
    // Prior/Change columns are comparative — hidden when comparison is off.
    ...(compareOff ? [] : ([
      { key: "previous", header: "Prior", value: (r: GeoRow) => r.previous, align: "right", render: (r: GeoRow) => <span className={`rec-nowrap ${r.previous ? "rs-mid" : "rs-zero"}`}>{num(r.previous)}</span> },
      {
        key: "pctChange", header: "Change", value: (r: GeoRow) => r.pctChange ?? Number.MAX_SAFE_INTEGER, align: "right",
        render: (r: GeoRow) => <span className={`rec-nowrap rs-chg ${r.absoluteChange > 0 ? "up" : r.absoluteChange < 0 ? "down" : "flat"}`}>{fmtPct(r.pctChange)} ({r.absoluteChange >= 0 ? "+" : ""}{r.absoluteChange})</span>,
      },
    ] as Column<GeoRow>[])),
    { key: "zScore", header: "Z-score", value: (r) => r.zScore, align: "right",
      render: (r) => <span className={`rs-z ${r.zScore != null && r.zScore >= 1.5 ? "hi" : r.zScore != null && r.zScore >= 1 ? "mid" : ""}`} title="Z-score vs county baseline">{r.zScore == null ? "—" : r.zScore.toFixed(1)}</span> },
  ];

  const countyStats: CountyStat[] = useMemo(
    () => countyRows.filter((r) => r.state === "TX" && r.county).map((r) => ({ county: r.county!, total: r.total, pctChange: r.pctChange, isHotspot: r.isHotspot })),
    [countyRows],
  );
  const showMap = countyStats.length > 0 && (!filters.states.length || filters.states.includes("TX"));
  // Side list: the most active counties on the map, busiest first.
  const activeCounties = useMemo(
    () => countyStats.filter((c) => c.total > 0).sort((a, b) => b.total - a.total).slice(0, 10),
    [countyStats],
  );

  // Selecting a county — from the map or the side list — zooms the map into it
  // and filters the whole Research page to it (every tab follows `qs`).
  const selectCounty = (county: string) => {
    const row = countyRows.find((r) => r.county && r.county.toUpperCase() === county.toUpperCase());
    onSetCounties([row?.county ?? county]);
  };
  const onFocusChange = (c: string | null) => { setFocusCounty(c); if (c === null) onSetCounties([]); };
  const isSelected = (county: string) => filters.counties.some((c) => c.toUpperCase() === county.toUpperCase());
  const hasSelection = focusCounty != null || filters.counties.length > 0;

  return (
    <>
      {showMap && (
        <section className="rs-card rs-map-card">
          <div className="rs-card-head">
            <div className="rs-card-titles">
              <h3>Texas activity</h3>
              <span className="rs-card-sub">
                {metric === "activity"
                  ? "Shaded by records in the period · red outline = hotspot · click a county to zoom into its abstracts"
                  : "Green is up, red is down vs the prior period · click a county to zoom into its abstracts"}
              </span>
            </div>
            <Segmented<"activity" | "change"> accent ariaLabel="Map metric" value={metric} onChange={setMetric}
              options={[{ value: "activity", label: "Volume" }, { value: "change", label: "Change" }]} />
          </div>
          <div className="rs-map-body">
            <div className="rs-map">
              <ResearchChoropleth
                stats={countyStats} metric={metric} selected={filters.counties} qs={qs}
                // Clicking a county filters the whole Research page to it (every
                // tab and visualization follows `qs`); "All counties"/Esc clears
                // the filter and restores the statewide dataset.
                onSelect={selectCounty}
                focusCounty={focusCounty}
                onFocusChange={onFocusChange}
                highlightCounty={hoverCounty}
                abstractStats={focusAbstractRows.filter((r) => r.abstractId).map((r) => ({ abstractId: r.abstractId!, total: r.total, isHotspot: r.isHotspot }))}
                onAbstractClick={(abstractId) => onDrill({
                  states: ["TX"],
                  // Use the county name exactly as the stats row spells it (that's
                  // what the documents store), not the map feature's casing.
                  counties: (() => {
                    const row = countyRows.find((r) => r.county && focusCounty && r.county.toUpperCase() === focusCounty.toUpperCase());
                    return row?.county ? [row.county] : focusCounty ? [focusCounty] : [];
                  })(),
                  abstracts: [abstractId],
                })}
              />
            </div>
            <aside className="rs-map-side">
              {/* Legend — describes the map's real scales: log-scaled volume,
                  and change saturating at ±200% (new activity = strong green). */}
              <div className="rs-legend-block">
                <span className="rs-side-title">{metric === "activity" ? "Records in period" : "Change vs prior period"}</span>
                <span className={`rs-grad ${metric === "activity" ? "vol" : "chg"}`} aria-hidden="true" />
                <span className="rs-grad-labels">
                  {metric === "activity"
                    ? <><span>1</span><span>log scale</span><span>{num(activeCounties[0]?.total ?? 0)}</span></>
                    : <><span>−200%</span><span>0</span><span>+200%</span></>}
                </span>
                <span className="rs-legend-keys">
                  <span><i className="rs-key-hot" />Hotspot</span>
                  <span><i className="rs-key-none" />No activity</span>
                  {metric === "change" && <span><i className="rs-key-new" />New activity</span>}
                </span>
              </div>
              {activeCounties.length > 0 && (
                <div className="rs-side-list">
                  <span className="rs-side-title">Active counties</span>
                  {activeCounties.map((c) => (
                    <button key={c.county} type="button" className={`rs-county-btn ${isSelected(c.county) ? "sel" : ""}`}
                      onClick={() => { onFocusChange(c.county); selectCounty(c.county); }}
                      onMouseEnter={() => setHoverCounty(c.county)} onMouseLeave={() => setHoverCounty(null)}
                      onFocus={() => setHoverCounty(c.county)} onBlur={() => setHoverCounty(null)}>
                      <i className={`rs-sw ${c.isHotspot ? "hot" : ""}`} />
                      <span className="rs-county-name">{c.county}</span>
                      {metric === "activity"
                        ? <b>{num(c.total)}</b>
                        : <b className={`rs-chg ${c.pctChange == null || c.pctChange > 0 ? "up" : c.pctChange < 0 ? "down" : "flat"}`}>{fmtPct(c.pctChange)}</b>}
                    </button>
                  ))}
                </div>
              )}
              {hasSelection && (
                <button type="button" className="rs-outline-btn sm" onClick={() => onFocusChange(null)}>Clear selection</button>
              )}
            </aside>
          </div>
        </section>
      )}

      <section className="rs-card">
        <div className="rs-card-head">
          <div className="rs-card-titles"><h3>Activity by {shownLevel === "state" ? "state" : shownLevel === "county" ? "county" : "abstract"}</h3></div>
          <div className="rs-card-tools">
            <Segmented<"state" | "county" | "abstract"> accent className="rs-seg-sm" ariaLabel="Geography level" value={level} onChange={setLevel}
              options={[{ value: "state", label: "State" }, { value: "county", label: "County" }, { value: "abstract", label: "Abstract" }]} />
            <button type="button" className="rs-outline-btn" disabled={!data?.rows.length} onClick={() => data && downloadCsv(
              `research-geography-${shownLevel}.csv`,
              ["Name", "State", "County", "Transactions", "Leases", "Permits", "Total", "Prior", "Change %", "Hotspot"],
              data.rows.map((r) => [geoName(r), r.state, r.county, r.transactions, r.leases, r.permits, r.total, r.previous, r.pctChange == null ? "" : Math.round(r.pctChange * 100), r.isHotspot ? "YES" : ""]),
            )}>
              <DownloadIcon />
              Export CSV
            </button>
          </div>
        </div>
        {loading && !data ? <Spinner /> : !data || data.rows.length === 0 ? <p className="rs-empty">No activity in this period.</p> : (
          // While a different level loads, the current table stays put and
          // gently dims — the new rows swap in without a spinner flash.
          <div className="rs-table" style={{ opacity: loading ? 0.55 : 1, transition: "opacity 160ms ease", pointerEvents: loading ? "none" : undefined }}>
            <SortableTable
              columns={columns}
              rows={data.rows}
              rowKey={(r) => `${r.state}|${r.county}|${r.abstractId}`}
              defaultSort={{ key: "total", dir: "desc" }}
              onRowClick={(r) => onDrill({
                states: r.state ? [r.state] : [],
                counties: r.county ? [r.county] : [],
                // Abstract rows drill straight to that abstract's records; other
                // levels clear any abstract filter so results aren't over-narrowed.
                abstracts: shownLevel === "abstract" && r.abstractId ? [r.abstractId] : [],
              })}
            />
            <div className="rs-card-foot">
              <span>{num(data.rows.length)} {shownLevel === "state" ? "states" : shownLevel === "county" ? "counties" : "abstracts"} · sorted by total, descending</span>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function DownloadIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>;
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

function RankingsTab({ qs, opts, compareOff, onDrill, dataset, rangeLabel }: { qs: string; opts: FilterOpts | null; compareOff: boolean; onDrill: (patch: Partial<Filters>) => void; dataset: Dataset; rangeLabel: string }) {
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

  // In the Leases dataset the grantee/grantor roles are lessees/lessors — the
  // ranking math is identical, only the vocabulary changes.
  const ROLE_LABEL = dataset === "LEASE"
    ? ({ buyers: "Most active lessees", sellers: "Most active lessors", operators: "Most active operators" } as const)
    : ({ buyers: "Most active buyers", sellers: "Most active sellers", operators: "Most active operators" } as const);
  const ROLE_SEG = dataset === "LEASE"
    ? ({ buyers: "Lessees", sellers: "Lessors", operators: "Operators" } as const)
    : ({ buyers: "Buyers", sellers: "Sellers", operators: "Operators" } as const);
  const isBuyers = role === "buyers";
  const rows = data?.rows ?? [];
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

  // Rank = position in the server's ranking (busiest first).
  const rankOf = useMemo(() => new Map(rows.map((r, i) => [r.key, i + 1])), [rows]);
  const maxRowCount = Math.max(1, ...rows.map((r) => r.count));
  const chgTone = (abs: number) => (abs > 0 ? "up" : abs < 0 ? "down" : "flat");

  const columns: Column<EntityRow>[] = [
    { key: "rank", header: "#", value: (r) => rankOf.get(r.key) ?? null, width: "1%", render: (r) => <span className="rs-rank">{rankOf.get(r.key)}</span> },
    { key: "name", header: "Name", value: (r) => r.name, minWidth: 220,
      render: (r) => <span className="rs-rk-name"><span className="rs-strong">{r.name}</span>{r.newEntrant && <span className="rs-mini-tag new" title="No activity in the prior 12 months">New</span>}</span> },
    { key: "count", header: role === "operators" ? "Permits" : "Records", value: (r) => r.count, align: "right",
      render: (r) => <span className="rs-count-bar"><span className="rs-bar"><i style={{ width: `${(r.count / maxRowCount) * 100}%` }} /></span><b>{num(r.count)}</b></span> },
    // Prior/Change columns are comparative — hidden when comparison is off.
    ...(compareOff ? [] : ([
      { key: "previous", header: "Prior", value: (r: EntityRow) => r.previous, align: "right", render: (r: EntityRow) => <span className={r.previous ? "rs-mid" : "rs-zero"}>{num(r.previous)}</span> },
      {
        key: "pctChange", header: "Change", value: (r: EntityRow) => r.pctChange ?? Number.MAX_SAFE_INTEGER, align: "right",
        render: (r: EntityRow) => <span className={`rs-chg ${chgTone(r.absoluteChange)}`}>{fmtPct(r.pctChange)}</span>,
      },
    ] as Column<EntityRow>[])),
    ...(role === "operators"
      ? ([{ key: "horizontal", header: "Horizontal", value: (r) => r.horizontal, align: "right" }] as Column<EntityRow>[])
      : []),
    { key: "counties", header: "Counties", value: (r) => r.counties.length, render: (r) => <span className="chips-oneline"><ChipList items={r.counties} /></span> },
  ];

  const top = rows.slice(0, 10);

  const drillKey = (k: string) => onDrill(role === "buyers" ? { buyers: [k] } : role === "sellers" ? { sellers: [k] } : { operators: [k] });
  // Nice axis: a rounded maximum (with headroom) + evenly-spaced ticks, so the
  // horizontal bars read against a 0…max scale exactly like the reference.
  const maxCount = top.length ? Math.max(...top.map((r) => r.count)) : 1;
  const niceNum = (x: number) => { const p = Math.pow(10, Math.floor(Math.log10(x || 1))); const f = (x || 1) / p; const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10; return nf * p; };
  const step = niceNum(Math.max(1, maxCount) / 4);
  let niceMax = Math.ceil(maxCount / step) * step; if (niceMax <= maxCount) niceMax += step;
  const ticks: number[] = []; for (let v = 0; v <= niceMax + step * 0.001; v += step) ticks.push(Math.round(v));

  const roleNoun = ROLE_SEG[role].toLowerCase();

  return (
    <>
      <section className="rs-card rs-rank-card">
        <div className="rs-card-head rs-rank-head">
          {/* Selection swaps the title for the Add to Buyers actions —
              turn active buyers into CRM Buyer profiles. */}
          {isBuyers && selected.size > 0 ? (
            <div className="rs-sel-bar">
              <span className="rs-strong">{selected.size} selected</span>
              <button type="button" className="primary rs-btn-sm" disabled={adding} onClick={addToBuyers}>
                {adding ? "Preparing…" : `+ Add to Buyers (${selected.size})`}
              </button>
              <button type="button" className="rs-text-btn muted-btn" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          ) : (
            <div className="rs-card-titles">
              <h3>{ROLE_LABEL[role]}</h3>
              {data && <span className="rs-card-sub">{rangeLabel ? `${rangeLabel} · ` : ""}{num(rows.length)} {roleNoun} with recorded activity</span>}
            </div>
          )}
          <div className="rs-card-tools">
            <Segmented<"buyers" | "sellers" | "operators"> accent className="rs-seg-sm" ariaLabel="Ranking role" value={role} onChange={setRole}
              options={(["buyers", "sellers", "operators"] as const).map((r) => ({ value: r, label: ROLE_SEG[r] }))} />
            <button type="button" className="rs-outline-btn" disabled={!rows.length} onClick={() => data && downloadCsv(
              `research-${role}.csv`,
              ["Name", "Count", "Prior", "Change %", "Counties", "New Entrant"],
              data.rows.map((r) => [r.name, r.count, r.previous, r.pctChange == null ? "" : Math.round(r.pctChange * 100), r.counties.join("; "), r.newEntrant ? "YES" : ""]),
            )}>
              <DownloadIcon />
              Export CSV
            </button>
          </div>
        </div>
        {err && <div className="rs-card-banner"><Banner kind="error">{err}</Banner></div>}
        {result && (
          <div className="rs-card-banner">
            <Banner kind="info">
              Added to Buyers — <strong>{result.created}</strong> created, <strong>{result.merged}</strong> enriched
              {result.skipped > 0 && <>, {result.skipped} skipped</>}. New profiles are tagged “Research Imported”.
            </Banner>
          </div>
        )}
        {loading && !data ? <Spinner /> : top.length === 0 ? <p className="rs-empty">No activity in this period.</p> : (
          <>
            <div className="rk-bars rs-rank-chart">
              <span className="rs-chart-cap">Top {top.length} by {role === "operators" ? "permits" : "records"}</span>
              {top.map((r) => (
                <div key={r.key} className="rk-bar-row" onClick={() => drillKey(r.key)} title={`${r.name} · ${r.count}`}>
                  <div className="rk-bar-name">{r.name}</div>
                  <div className="rk-bar-track">
                    <div className={`rk-bar-fill ${r.newEntrant ? "new" : ""}`} style={{ width: `${(r.count / niceMax) * 100}%` }} />
                  </div>
                  <div className="rs-rank-end">
                    <b>{num(r.count)}</b>
                    {!compareOff && <span className={`rs-chg ${chgTone(r.absoluteChange)}`}>{fmtPct(r.pctChange)}</span>}
                  </div>
                </div>
              ))}
              <div className="rk-bar-row rk-axis-row">
                <div />
                <div className="rk-axis">{ticks.map((t) => <span key={t}>{t}</span>)}</div>
                <div />
              </div>
            </div>
            <div className="rs-table">
              <SortableTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.key}
                defaultSort={{ key: "count", dir: "desc" }}
                selection={isBuyers ? { selected, onToggle: toggle, onToggleAll: () => toggleAll() } : undefined}
                onRowClick={(r) => onDrill(role === "buyers" ? { buyers: [r.key] } : role === "sellers" ? { sellers: [r.key] } : { operators: [r.key] })}
              />
            </div>
          </>
        )}
        {rows.length > 0 && (
          <div className="rs-card-foot">
            <span>{rows.length} {role} · sorted by {role === "operators" ? "permits" : "records"}, descending{isBuyers ? " · select rows to add them to Buyers" : ""}</span>
          </div>
        )}
      </section>
      {opts && <p className="rs-footnote">Names are grouped after normalizing punctuation and legal suffixes (LLC/LP/Inc), so filings under slightly different spellings roll up together.</p>}

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
    <Modal title="Review possible duplicate buyers" onClose={onCancel} wide
      subtitle={<>{auto.length > 0 && <>{auto.length} buyer(s) will be added automatically (new or exact matches). </>}The following look similar to existing buyers — choose how to handle each.</>}
      footer={<>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="primary" onClick={confirm} disabled={busy}>{busy ? "Applying…" : "Confirm & add"}</button>
      </>}>
      <div className="rs-dup-list">
        {possibles.map((p) => (
          <div key={p.key} className="rs-dup">
            <div className="rs-dup-info">
              <div className="rs-dup-name">
                <span className="rs-strong">{p.proposal.companyName}</span>
                {p.confidence != null && <span className="rs-mini-tag">{Math.round(p.confidence * 100)}% match</span>}
              </div>
              <div className="rs-dup-meta">
                Imported: {p.proposal.transactionCount} txns · {p.proposal.counties.join(", ") || "—"} · {p.proposal.states.join(", ") || "—"}
              </div>
              {p.existing && (
                <div className="rs-dup-meta">
                  Existing “{p.existing.companyName}”: {p.existing.counties.join(", ") || "no counties"} · {p.existing.states.join(", ") || "no states"}
                </div>
              )}
              {p.mergePreview && (p.mergePreview.addCounties.length + p.mergePreview.addStates.length + p.mergePreview.addAliases.length > 0) && (
                <div className="rs-dup-merge">
                  Merge would add: {[
                    p.mergePreview.addCounties.length ? `${p.mergePreview.addCounties.length} counties` : "",
                    p.mergePreview.addStates.length ? `${p.mergePreview.addStates.length} states` : "",
                    p.mergePreview.addAliases.length ? `${p.mergePreview.addAliases.length} aliases` : "",
                  ].filter(Boolean).join(", ")}
                </div>
              )}
            </div>
            <Segmented<"merge" | "create" | "skip"> ariaLabel={`How to add ${p.proposal.companyName}`} value={choices[p.key]}
              onChange={(c) => setChoices((s) => ({ ...s, [p.key]: c }))}
              options={[{ value: "merge", label: "Merge with existing" }, { value: "create", label: "Create new" }, { value: "skip", label: "Skip" }]} />
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Relationships — grantor→grantee graph, co-buyers, chains, classifications
// ---------------------------------------------------------------------------

/** Adapt relationship rows to the shared PartyColumn's party shape. */
function relRowsToParties(rows: RelRow[], nameOf: (r: RelRow) => { norm: string; name: string }): RelParty[] {
  return rows
    .map((r) => { const { norm, name } = nameOf(r); return { norm, name, count: r.count, entityType: "company" as const, buyerId: null }; })
    .sort((a, b) => b.count - a.count);
}

/** Adapt chain table rows to the shared ChainSection's entry shape. */
function chainRowsToEntries(rows: ChainRow[], focusNorm: string): ChainEntry[] {
  return rows.map((c) => {
    const idx = focusNorm ? c.nodes.findIndex((n) => n.norm === focusNorm) : -1;
    const position = idx >= 0 ? idx : 0;
    return {
      chain: { nodes: c.nodes, hops: c.hops, length: c.length, strength: c.strength, totalCount: c.totalCount, counties: c.counties },
      position,
      role: c.nodes[position]?.klass ?? "",
    };
  });
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

function RelationshipsTab({ qs, onDrill, dataset }: { qs: string; onDrill: (patch: Partial<Filters>) => void; dataset: Dataset }) {
  const [data, setData] = useState<RelationshipsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<RelView>("relationships");
  const [tx, setTx] = useState<{ title: string; selector: TxSelector } | null>(null);
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

  // Scale for the Transactions mini bars in the relationships table.
  const maxRelCount = Math.max(1, ...rels.map((r) => r.count));

  // Class counts drive the filter chips on the Entities view.
  const classCounts = new Map<string, number>();
  for (const c of data.classifications) classCounts.set(c.klass, (classCounts.get(c.klass) ?? 0) + 1);

  // Headline insights — one-line answers before digging into the tables.
  const topRel = data.relationships[0];
  const topHold = data.classifications.find((c) => c.klass === "TERMINAL_HOLD");
  const topMid = data.classifications.find((c) => c.klass === "AGGREGATOR" || c.klass === "DISTRIBUTOR" || c.klass === "FEEDER");
  const deepChain = [...data.chainTable].sort((a, b) => b.length - a.length || b.totalCount - a.totalCount)[0];

  const VIEWS: [RelView, string, number][] = [
    ["relationships", "Relationships", data.totals.relationships],
    ["cobuyers", "Co-buyers", data.totals.partnerships],
    ["chains", "Acquisition chains", data.totals.chains],
    ["entities", "Entities", data.totals.entities],
  ];

  // In the Leases dataset the graph runs over lease instruments — the counts
  // are lease documents, never transactions, and say so.
  const totalCells: StatCell[] = [
    { label: dataset === "LEASE" ? "Lease documents" : "Transactions", value: num(data.totals.transactions) },
    { label: "Relationships", value: num(data.totals.relationships) },
    { label: "Entities", value: num(data.totals.entities) },
    { label: dataset === "LEASE" ? "Co-lessee groups" : "Co-buyer groups", value: num(data.totals.partnerships) },
    { label: "Chains", value: num(data.totals.chains) },
  ];

  // Group sides arrive as "A + B" — list one party per line; any part of the
  // name opens the group's dossier.
  const partyLines = (name: string, onOpen: () => void) => (
    <span className="rs-parties">
      {name.split(" + ").map((p, i) => (
        <span key={i} className="rel-ent relt-name" onClick={(e) => { e.stopPropagation(); onOpen(); }}>{p}</span>
      ))}
    </span>
  );

  return (
    <>
      <StatStrip className="rs-kpis rs-kpis-sm" min={160} cells={totalCells} />

      {/* Headline insights — the fastest read on who is driving this market. */}
      {(topRel || topHold || topMid || deepChain) != null && (
        <div className="rel-insights rs-highlights">
          {topRel && (
            <button type="button" className="rs-hl" onClick={() => setTx({ title: `${topRel.grantor} → ${topRel.grantee}`, selector: { grantorNorm: topRel.grantorNorm, granteeNorm: topRel.granteeNorm } })}>
              <span className="rs-hl-label"><i style={{ background: "var(--accent)" }} />Most active relationship</span>
              <span className="rs-hl-title">{topRel.grantor} → {topRel.grantee}</span>
              <span className="rs-hl-sub"><span>{topRel.count} transaction{topRel.count === 1 ? "" : "s"}</span><ArrowRight size={13} aria-hidden="true" /></span>
            </button>
          )}
          {topHold && (
            <button type="button" className="rs-hl" onClick={() => setEntity(topHold.norm)}>
              <span className="rs-hl-label"><i style={{ background: "var(--success)" }} />Largest terminal holder</span>
              <span className="rs-hl-title">{topHold.name}</span>
              <span className="rs-hl-sub"><span>{topHold.acquisitions} acquisitions · nothing resold</span><ArrowRight size={13} aria-hidden="true" /></span>
            </button>
          )}
          {topMid && (
            <button type="button" className="rs-hl" onClick={() => setEntity(topMid.norm)}>
              <span className="rs-hl-label"><i style={{ background: "var(--accent-ink)" }} />Top intermediary</span>
              <span className="rs-hl-title">{topMid.name}</span>
              <span className="rs-hl-sub"><span>{labelOf(topMid.klass)} · bought {topMid.acquisitions}, sold {topMid.dispositions}</span><ArrowRight size={13} aria-hidden="true" /></span>
            </button>
          )}
          {deepChain && (
            <button type="button" className="rs-hl" onClick={() => setView("chains")}>
              <span className="rs-hl-label"><i style={{ background: CHART_COLORS[3] }} />Deepest acquisition chain</span>
              <span className="rs-hl-title">{deepChain.path}</span>
              <span className="rs-hl-sub"><span>{deepChain.length} hops · {deepChain.totalCount} transactions</span><ArrowRight size={13} aria-hidden="true" /></span>
            </button>
          )}
        </div>
      )}

      <div className="res-subtabs rs-subtabs">
        <div className="tab-row" role="tablist">
          {VIEWS.map(([v, l, n]) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={`tab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>
              {l} <span className="relv-count">{num(n)}</span>
            </button>
          ))}
        </div>
        <span className="relv-search rs-search">
          <Search size={14} aria-hidden="true" />
          <input
            placeholder="Search entities"
            aria-label="Search entities"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </span>
      </div>

      {view === "relationships" && (
        <section className="rs-card">
          <div className="rs-card-head">
            <div className="rs-card-titles">
              <h3>Grantor → grantee relationships</h3>
              <span className="rs-card-sub">Repeated transfers between the same two parties roll up into one relationship with a transaction count. Click a row for the underlying deeds, or an entity name for its full dossier.</span>
            </div>
            <div className="rs-card-tools">
              <span className="rs-switch">
                <Toggle checked={repeatOnly} onChange={setRepeatOnly} ariaLabel="Repeat relationships only (2+)" />
                <span onClick={() => setRepeatOnly((v) => !v)}>Repeat only (2+)</span>
              </span>
              <button type="button" className="rs-outline-btn" onClick={() => downloadCsv("research-relationships.csv",
                ["Grantor", "Grantee", "Transactions", "Counties", "First", "Last"],
                rels.map((r) => [r.grantor, r.grantee, r.count, r.counties.join("; "), r.firstDate, r.lastDate]))}>
                <DownloadIcon />
                Export CSV
              </button>
            </div>
          </div>
          {rels.length === 0 ? <p className="rs-empty">No relationships match{q ? ` “${q}”` : ""}{repeatOnly ? " with 2+ transactions" : ""}.</p> : (
            <div className="rs-table">
              <SortableTable
                columns={[
                  { key: "grantor", header: "Grantor (seller)", value: (r: RelRow) => r.grantor, minWidth: 200, render: (r: RelRow) => partyLines(r.grantor, () => setEntity(r.grantorNorm)) },
                  { key: "arrow", header: "", value: () => "", width: "1%", render: () => <span className="relt-arrow" aria-hidden="true"><ArrowRight size={13} /></span> },
                  { key: "grantee", header: "Grantee (buyer)", value: (r: RelRow) => r.grantee, minWidth: 220, render: (r: RelRow) => partyLines(r.grantee, () => setEntity(r.granteeNorm)) },
                  {
                    key: "count", header: "Transactions", value: (r: RelRow) => r.count,
                    // Count + a mini bar scaled to the strongest visible relationship.
                    render: (r: RelRow) => (
                      <span className="rs-count-bar lead">
                        <b>{r.count}</b>
                        <span className="rs-bar" aria-hidden="true"><i style={{ width: `${Math.max(10, (r.count / maxRelCount) * 100)}%` }} /></span>
                      </span>
                    ),
                  },
                  // Counties read as plain text — pills added visual noise at a
                  // glance-density this table doesn't need.
                  { key: "counties", header: "Counties", value: (r: RelRow) => r.counties.length, render: (r: RelRow) => r.counties.length ? <span className="relt-counties" title={r.counties.join(", ")}>{r.counties.join(", ")}</span> : <span className="rs-zero">—</span> },
                  { key: "abstracts", header: "Abstracts", value: (r: RelRow) => r.abstracts.length, align: "right" as const, render: (r: RelRow) => r.abstracts.length ? <span title={r.abstracts.join(", ")}><b>{r.abstracts.length}</b></span> : <span className="rs-zero">—</span> },
                  { key: "lastDate", header: "Latest", value: (r: RelRow) => r.lastDate ?? "", align: "right" as const, render: (r: RelRow) => <span className="rs-mid rec-nowrap">{fmtDate(r.lastDate)}</span>, type: "date" as const },
                ]}
                rows={rels}
                rowKey={(r) => `${r.grantorNorm}→${r.granteeNorm}`}
                defaultSort={{ key: "count", dir: "desc" }}
                onRowClick={(r) => setTx({ title: `${r.grantor} → ${r.grantee}: ${r.count} transaction${r.count === 1 ? "" : "s"}`, selector: { grantorNorm: r.grantorNorm, granteeNorm: r.granteeNorm } })}
              />
            </div>
          )}
          <div className="rs-card-foot">
            <span>{num(rels.length)} of {num(data.relationships.length)} relationships shown{repeatOnly ? " · repeat only" : ""}</span>
          </div>
        </section>
      )}

      {view === "cobuyers" && (
        <section className="rs-card">
          <div className="rs-card-head">
            <div className="rs-card-titles">
              <h3>Co-buyer partnerships</h3>
              <span className="rs-card-sub">Entities that acquired mineral interests together as co-grantees on the same recorded transaction, ranked by shared acquisitions. Click to view the shared purchases.</span>
            </div>
          </div>
          {coBuyers.length === 0 ? <p className="rs-empty">No co-buying partnerships {q ? `match “${q}”` : "detected — this needs multiple grantees acquiring on one recorded transaction"}.</p> : (
            <div className="rs-cob-list">
              {coBuyers.map((p, i) => (
                <button key={i} type="button" className="rs-cob" onClick={() => setTx({ title: `Co-buyers: ${p.members.map((m) => m.name).join(", ")}`, selector: { members: p.members.map((m) => m.norm) } })}>
                  <span className="rs-rank">#{i + 1}</span>
                  <span className="rs-cob-body">
                    <span className="rs-cob-members">
                      {p.members.map((m, j) => (
                        <span key={m.norm} className="rs-member"><i style={{ background: MEMBER_COLORS[j % MEMBER_COLORS.length] }} />{m.name}</span>
                      ))}
                    </span>
                    <span className="rs-cob-meta">
                      {p.firstDate && <>First {fmtDate(p.firstDate)}{p.lastDate && p.lastDate !== p.firstDate ? ` · Latest ${fmtDate(p.lastDate)}` : ""}</>}
                      {p.firstDate && p.counties.length > 0 && " · "}
                      {p.counties.length > 0 && p.counties.join(", ")}
                    </span>
                  </span>
                  <span className="rs-cob-count">
                    <b>{num(p.count)}</b>
                    <span>shared acquisition{p.count === 1 ? "" : "s"}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="rs-card-foot"><span>Showing {num(coBuyers.length)} of {num(data.coBuyers.length)} groups</span></div>
        </section>
      )}

      {view === "chains" && (
        <section className="rs-card">
          <div className="rs-card-head">
            <div className="rs-card-titles">
              <h3>Acquisition chains</h3>
              <span className="rs-card-sub">How interests move through multiple entities. Each row is a complete path; click to expand hops, counties, and supporting transactions.</span>
            </div>
          </div>
          {chains.length === 0 ? <p className="rs-empty">No multi-hop acquisition paths {q ? `match “${q}”` : "detected in this period"}.</p> : (
            <div className="rs-chains">
              <ChainSection
                chains={chainRowsToEntries(chains, "")}
                classLabels={data.classLabels}
                focusNorm=""
                renderActions={(_entry, i) => {
                  const c = chains[i];
                  return (
                    <>
                      <button type="button" className="rs-outline-btn sm" onClick={() => setTx({ title: `Chain: ${c.path}`, selector: { path: c.nodes.map((n) => n.norm) } })}>View supporting transactions →</button>
                      {c.terminus && <button type="button" className="rs-outline-btn sm" onClick={() => onDrill({ counties: c.counties })}>Filter records to these counties →</button>}
                      {c.firstDate && c.lastDate && <span className="rs-mid rs-small">{fmtDate(c.firstDate)} – {fmtDate(c.lastDate)}</span>}
                    </>
                  );
                }}
              />
            </div>
          )}
        </section>
      )}

      {view === "entities" && (
        <section className="rs-card">
          <div className="rs-card-head">
            <div className="rs-card-titles">
              <h3>Market participants</h3>
              <span className="rs-card-sub">Every entity labelled by its acquisition behaviour. Click a class to filter; click an entity for its full dossier.</span>
            </div>
            <div className="rs-card-tools">
              <button type="button" className="rs-outline-btn" onClick={() => downloadCsv("research-entity-classes.csv",
                ["Entity", "Class", "Acquired", "Sold", "Net", "Distinct Grantors", "Distinct Grantees"],
                entities.map((r) => [r.name, r.classLabel, r.acquisitions, r.dispositions, r.acquisitions - r.dispositions, r.distinctGrantors, r.distinctGrantees]))}>
                <DownloadIcon />
                Export CSV
              </button>
            </div>
          </div>
          <div className="rs-class-bar">
            <div className="rs-class-chips">
              <button type="button" className={`rs-class-chip ${classFilter == null ? "active" : ""}`} onClick={() => setClassFilter(null)}>
                All <span className="rs-chip-count">{num(data.classifications.length)}</span>
              </button>
              {[...classCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                <button key={k} type="button" className={`rs-class-chip ${classFilter === k ? "active" : ""}`} onClick={() => setClassFilter(classFilter === k ? null : k)}
                  title={CLASS_DESC[k]}>
                  <i style={{ background: CLASS_COLORS[k] ?? CLASS_FALLBACK_COLOR }} />
                  {labelOf(k)} <span className="rs-chip-count">{num(n)}</span>
                </button>
              ))}
            </div>
            {classFilter && <p className="rs-class-desc"><strong>{labelOf(classFilter)}:</strong> {CLASS_DESC[classFilter] ?? ""}</p>}
          </div>
          {entities.length === 0 ? <p className="rs-empty">No entities match.</p> : (
            <div className="rs-table">
              <SortableTable
                columns={[
                  { key: "name", header: "Entity", value: (r: ClassRow) => r.name, minWidth: 240, render: (r: ClassRow) => <span className="rs-strong">{r.name}</span> },
                  { key: "klass", header: "Class", value: (r: ClassRow) => r.classLabel, render: (r: ClassRow) => <span title={CLASS_DESC[r.klass]}><ClassBadge klass={r.klass} label={r.classLabel} /></span> },
                  { key: "acquisitions", header: "Acquired", value: (r: ClassRow) => r.acquisitions, align: "right" as const },
                  { key: "dispositions", header: "Sold", value: (r: ClassRow) => r.dispositions, align: "right" as const },
                  {
                    key: "net", header: "Net position", value: (r: ClassRow) => r.acquisitions - r.dispositions, align: "right" as const,
                    render: (r: ClassRow) => { const n = r.acquisitions - r.dispositions; return <span className={`rs-chg ${n > 0 ? "up" : n < 0 ? "down" : "flat"}`}>{n > 0 ? "+" : ""}{n}</span>; },
                  },
                  { key: "distinctGrantors", header: "Sources", value: (r: ClassRow) => r.distinctGrantors, align: "right" as const, render: (r: ClassRow) => <span title="distinct grantors acquired from">{r.distinctGrantors}</span> },
                  { key: "distinctGrantees", header: "Buyers", value: (r: ClassRow) => r.distinctGrantees, align: "right" as const, render: (r: ClassRow) => <span title="distinct grantees sold to">{r.distinctGrantees}</span> },
                ]}
                rows={entities}
                rowKey={(r) => r.norm}
                defaultSort={{ key: "acquisitions", dir: "desc" }}
                onRowClick={(r) => setEntity(r.norm)}
              />
            </div>
          )}
          <div className="rs-card-foot"><span>Showing {num(entities.length)} of {num(data.classifications.length)} entities</span></div>
        </section>
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

/** Member-square colours for co-buyer groups (order within the group). */
const MEMBER_COLORS = [CHART_COLORS[0], CHART_COLORS[3], CHART_COLORS[5], CHART_COLORS[2], CHART_COLORS[6]];

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

  // Shared PartyColumn shapes: grantors we bought from, grantees we sold to,
  // and co-buying partners aggregated per partner entity.
  const grantorParties = relRowsToParties(bought, (r) => ({ norm: r.grantorNorm, name: r.grantor }));
  const granteeParties = relRowsToParties(sold, (r) => ({ norm: r.granteeNorm, name: r.grantee }));
  const coBuyerParties: RelParty[] = (() => {
    const agg = new Map<string, RelParty>();
    for (const p of partners) for (const m of p.members) {
      if (m.norm === norm) continue;
      const cur = agg.get(m.norm);
      if (cur) cur.count += p.count;
      else agg.set(m.norm, { norm: m.norm, name: m.name, count: p.count, entityType: "company", buyerId: null });
    }
    return [...agg.values()].sort((a, b) => b.count - a.count);
  })();

  const deedsButton = (dir: "in" | "out") => (p: RelParty) => (
    <button type="button" className="rs-deeds-btn" onClick={() => onViewTx(
      dir === "in" ? `${p.name} → ${name}` : `${name} → ${p.name}`,
      dir === "in" ? { grantorNorm: p.norm, granteeNorm: norm } : { grantorNorm: norm, granteeNorm: p.norm },
    )}>Deeds</button>
  );

  const acquired = info?.acquisitions ?? bought.reduce((s, r) => s + r.count, 0);
  const disposed = info?.dispositions ?? sold.reduce((s, r) => s + r.count, 0);
  const net = info ? info.acquisitions - info.dispositions : null;
  const statCells: StatCell[] = [
    { label: "Acquired", value: num(acquired) },
    { label: "Sold", value: num(disposed) },
    { label: "Net position", value: net == null ? "—" : `${net > 0 ? "+" : ""}${net}`, tone: net == null || net === 0 ? "default" : net > 0 ? "success" : "danger" },
    { label: "Sources · buyers", value: info ? `${info.distinctGrantors} · ${info.distinctGrantees}` : "—" },
  ];

  return (
    <Modal title={name} onClose={onClose} wide
      subtitle={info && (
        <span className="rs-dossier-sub">
          <ClassBadge klass={info.klass} label={info.classLabel} />
          <span>{CLASS_DESC[info.klass]}</span>
        </span>
      )}
      footer={<>
        {added && <span className="rs-dossier-status">{added}</span>}
        <button type="button" onClick={() => onViewTx(`All transactions involving ${name}`, { entityNorm: norm })}>View all transactions →</button>
        {can("createBuyers") && !added && (
          <button type="button" className="primary" disabled={adding} onClick={addToBuyers}>{adding ? "Adding…" : "Add to Buyers"}</button>
        )}
      </>}>
      <div className="rs-dossier">
        <StatStrip className="rs-dossier-stats" min={150} cells={statCells} />

        <div className="rel2-cols rs-dossier-cols">
          <PartyColumn title="Acquired from" tone="up" empty="No recorded acquisitions in this period." parties={grantorParties}
            canCreate={false} adding={null} onAdd={() => {}} onOpen={(p) => onOpenEntity(p.norm)}
            alwaysOpenable openTitle="Open dossier" renderExtra={deedsButton("in")} />
          <PartyColumn title="Sold to" tone="down" empty="No recorded dispositions." parties={granteeParties}
            canCreate={false} adding={null} onAdd={() => {}} onOpen={(p) => onOpenEntity(p.norm)}
            alwaysOpenable openTitle="Open dossier" renderExtra={deedsButton("out")} />
          <PartyColumn title="Frequent co-buyers" tone="co" empty="No shared acquisitions found." parties={coBuyerParties}
            canCreate={false} adding={null} onAdd={() => {}} onOpen={(p) => onOpenEntity(p.norm)}
            alwaysOpenable openTitle="Open dossier" />
        </div>

        <div className="rs-dossier-sec">
          <div className="rs-dossier-sec-head">Appears in chains <span className="relv-count">{chains.length}</span></div>
          {chains.length === 0 ? <div className="rs-dashed-empty">Not part of any multi-hop chain in this period.</div> : (
            /* The same compact ChainSection used on Buyer Profiles — collapsed
               summary rows that expand on demand, with the standard chain
               actions (supporting transactions + date range) for full parity
               with the Chains view. */
            <ChainSection
              chains={chainRowsToEntries(chains, norm)}
              classLabels={data.classLabels}
              focusNorm={norm}
              renderActions={(_entry, i) => {
                const c = chains[i];
                return (
                  <>
                    <button type="button" className="rs-outline-btn sm" onClick={() => onViewTx(`Chain: ${c.path}`, { path: c.nodes.map((n) => n.norm) })}>View supporting transactions →</button>
                    {c.firstDate && c.lastDate && <span className="rs-mid rs-small">{fmtDate(c.firstDate)} – {fmtDate(c.lastDate)}</span>}
                  </>
                );
              }}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Supporting-transactions drill-in for a relationship / co-buyer set / chain. */
function TxDrillModal({ qs, title, selector, onClose }: {
  qs: string; title: string; selector: TxSelector;
  onClose: () => void; onDrillRecords: (patch: Partial<Filters>) => void;
}) {
  const absIndex = useAbstractIndex();
  const [rows, setRows] = useState<DocRecord[] | null>(null);
  useEffect(() => {
    api.post<{ rows: DocRecord[] }>(`/research/relationships/transactions?${qs}`, selector)
      .then((d) => setRows(d.rows)).catch(() => setRows([]));
  }, [qs, selector]);

  return (
    <Modal title={title} onClose={onClose} wide>
      {!rows ? <Spinner /> : rows.length === 0 ? <p className="rs-empty flush">No supporting transactions in the current filters.</p> : (
        <div className="rs-deeds">
          <div className="rs-deeds-bar">
            <span className="rs-mid">{rows.length} transaction{rows.length === 1 ? "" : "s"}</span>
            <button type="button" className="rs-outline-btn" onClick={() => downloadCsv("relationship-transactions.csv",
              ["Recorded", "Type", "Grantor", "Grantee", "County", "Abstract", "Instrument #"],
              rows.map((r) => [r.recordingDate.slice(0, 10), r.docTypeRaw, r.grantor, r.grantee, `${r.county}, ${r.state}`, r.abstractId, r.instrumentNumber]))}>
              <DownloadIcon />
              Export CSV
            </button>
          </div>
          <div className="table-scroll rs-deeds-scroll">
            <table className="data-table rs-sticky-head">
              <thead><tr><th>Recorded</th><th>Type</th><th>Grantor</th><th>Grantee</th><th>County</th><th>Abstract</th><th>Instrument #</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="rec-nowrap">{fmtDate(r.recordingDate)}</td>
                    <td title={r.docTypeRaw}><DocTypeTag docType={r.docType} raw={r.docTypeRaw} /></td>
                    <td>{r.grantor ?? <span className="rs-zero">—</span>}</td>
                    <td>{r.grantee ?? <span className="rs-zero">—</span>}</td>
                    <td className="rec-nowrap">{r.county}, {r.state}</td>
                    <td>
                      {r.abstractId ? <span className="rs-strong">{r.abstractId.split(",").map((a) => absIndex.label(a.trim(), r.county, r.state)).join("; ")}</span> : <span className="rs-zero">—</span>}
                      {r.survey && <span className="rs-sub-line">{r.survey}</span>}
                    </td>
                    <td><span className="rs-mono">{r.instrumentNumber ?? "—"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Document-type tag — colour by the normalized type, label as before. */
type TagTone = "neutral" | "accent" | "success" | "warn" | "danger" | "violet" | "cyan";
const DOC_TYPE_TONE: Record<string, TagTone> = {
  ROYALTY_DEED: "accent", MINERAL_DEED: "violet", WARRANTY_MINERAL_DEED: "violet", QUITCLAIM_MINERAL_DEED: "violet",
  MINERAL_CONVEYANCE: "cyan", OG_CONVEYANCE: "cyan", ASSIGNMENT: "cyan", RESERVATION: "warn",
  OG_LEASE: "success", LEASE_MEMO: "success", LEASE_ASSIGNMENT: "cyan", LEASE_AMENDMENT: "accent",
  LEASE_EXTENSION: "accent", LEASE_RATIFICATION: "accent", LEASE_RELEASE: "danger",
};
function DocTypeTag({ docType, raw }: { docType: string; raw?: string }) {
  return <Tag tone={DOC_TYPE_TONE[docType] ?? "neutral"} title={raw}>{prettyDocType(docType)}</Tag>;
}
/** Permit status / trajectory tags. */
const PERMIT_TONE: Record<string, TagTone> = {
  APPROVED: "success", SUBMITTED: "warn", SPUDDED: "accent", COMPLETED: "violet", CANCELED: "danger",
  HORIZONTAL: "success", DIRECTIONAL: "cyan", VERTICAL: "neutral", UNKNOWN: "neutral",
};
function EnumTag({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="rs-zero">—</span>;
  return <Tag tone={PERMIT_TONE[value] ?? "neutral"}>{prettyEnum(value)}</Tag>;
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

const SIGNAL_META: Record<string, { label: string; color: string }> = {
  CONFLUENCE: { label: "Multiple signals", color: "#F59E0B" },
  TRANSACTION_SURGE: { label: "Transaction surge", color: "#3B82F6" },
  LEASE_SURGE: { label: "Leasing surge", color: "#22C55E" },
  PERMIT_SURGE: { label: "Permitting surge", color: "#8B5CF6" },
  ABSTRACT_CONCENTRATION: { label: "Concentrated buying", color: "#EC4899" },
  NEW_OPERATOR: { label: "New operator", color: "#06B6D4" },
};
const SIGNAL_FALLBACK_COLOR = "#A6A6A6";

// Severity (0–100) → intuitive tier color: Low green, Moderate yellow,
// Elevated orange, High red, Critical deep red. Colors are used on dark panel
// backgrounds, so all five stay AA-contrast against the panel surface.
const SEVERITY_TIERS: { min: number; label: string; color: string }[] = [
  // Critical uses the reference red (#ef4444); High steps to a lighter red so
  // the two tiers stay distinguishable side by side.
  { min: 80, label: "Critical", color: "#ef4444" },
  { min: 60, label: "High", color: "#f87171" },
  { min: 40, label: "Elevated", color: "#f97316" },
  { min: 20, label: "Moderate", color: "#eab308" },
  { min: 0, label: "Low", color: "#22c55e" },
];
const severityTier = (n: number) => SEVERITY_TIERS.find((t) => n >= t.min) ?? SEVERITY_TIERS[SEVERITY_TIERS.length - 1];

function OpportunitiesTab({ qs, onDrill }: { qs: string; onDrill: (patch: Partial<Filters>) => void }) {
  const [data, setData] = useState<{ signals: Signal[] } | null>(null);
  const [loading, setLoading] = useState(true);
  // Severity filter — "all" or one of the tier labels above.
  const [sev, setSev] = useState<string>("all");
  useEffect(() => {
    setLoading(true);
    api.get<{ signals: Signal[] }>(`/research/opportunities?${qs}`).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [qs]);

  if (loading && !data) return <Spinner label="Scanning for emerging opportunities…" />;
  if (!data) return <Banner kind="info">Could not load opportunities.</Banner>;
  if (data.signals.length === 0) {
    return <Banner kind="info">No statistically significant surges detected in this period — try widening the date range or clearing filters.</Banner>;
  }

  const tierCount = new Map<string, number>();
  for (const s of data.signals) { const l = severityTier(s.severity).label; tierCount.set(l, (tierCount.get(l) ?? 0) + 1); }
  const criticalCount = tierCount.get("Critical") ?? 0;
  // Only tiers present in this period are offered; a filter whose tier has
  // disappeared (new period/filters) falls back to All.
  const activeSev = sev !== "all" && (tierCount.get(sev) ?? 0) > 0 ? sev : "all";
  const shown = activeSev === "all" ? data.signals : data.signals.filter((s) => severityTier(s.severity).label === activeSev);

  return (
    <section className="rs-card">
      <div className="rs-card-head rs-opp-head">
        <div className="rs-card-titles">
          <h3>Buying signals</h3>
          <span className="rs-card-sub">
            Signals are detected by comparing the selected period against six equal history windows (z-score ≥ 2 plus a
            material lift), clustering by geography, and flagging new entrants. Higher severity = stronger, higher-volume anomaly.
          </span>
        </div>
        <Segmented<string> accent ariaLabel="Severity" value={activeSev} onChange={setSev}
          options={[
            { value: "all", label: "All", count: data.signals.length },
            ...SEVERITY_TIERS.filter((t) => (tierCount.get(t.label) ?? 0) > 0).map((t) => ({ value: t.label, label: t.label, count: tierCount.get(t.label) })),
          ]} />
      </div>
      <div className="rs-opp-list">
        {shown.map((s) => {
          const meta = SIGNAL_META[s.kind] ?? { label: s.kind, color: SIGNAL_FALLBACK_COLOR };
          const tier = severityTier(s.severity);
          return (
            <div key={s.id} className="rs-opp">
              <div className="rs-score">
                <span className="rs-ring" style={{ background: `conic-gradient(${tier.color} ${Math.max(0, Math.min(100, s.severity)) * 3.6}deg, var(--hover-strong) 0)` }}>
                  <span>{s.severity}</span>
                </span>
                <span className="rs-score-tier" style={{ color: tier.color }}>{tier.label}</span>
              </div>
              <div className="rs-opp-body">
                <div className="rs-opp-title">
                  <span className="rs-kind" style={{ "--c": meta.color } as CSSProperties}><i />{meta.label}</span>
                  <strong>{s.title}</strong>
                </div>
                <p className="rs-opp-detail">{s.detail}</p>
              </div>
              <button type="button" className="rs-outline-btn rs-opp-view" onClick={() => onDrill({ states: s.state ? [s.state] : [], counties: s.county ? [s.county] : [] })}>
                View records <ArrowRight size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="rs-card-foot">
        <span>{shown.length} of {data.signals.length} signal{data.signals.length === 1 ? "" : "s"} in this period · {criticalCount} critical · sorted by severity</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Records (drill-in tables)
// ---------------------------------------------------------------------------

interface AbstractBuyer {
  norm: string; name: string; count: number; transactions: number; leases: number;
  amount: number; acreage: number; firstSeen: string; lastSeen: string;
}

// docClass is NOT a records-level filter — the page-level dataset toggle
// (Transactions/Deeds vs Leases) owns record-class separation for every view.
interface RecFilters { abstracts: string[]; counties: string[]; surveys: string[]; docTypes: string[]; grantors: string[]; grantees: string[]; statuses: string[]; trajectories: string[]; instrument: string; from: string; to: string }
const EMPTY_REC_FILTERS: RecFilters = { abstracts: [], counties: [], surveys: [], docTypes: [], grantors: [], grantees: [], statuses: [], trajectories: [], instrument: "", from: "", to: "" };
// grantors/grantees are {value: normalized key, label: display name} — a
// multi-party cell contributes each participant as its own option.
interface RecOptions { counties: string[]; abstracts: string[]; surveys?: string[]; docTypes?: string[]; docClasses?: string[]; grantors?: { value: string; label: string }[]; grantees?: { value: string; label: string }[]; statuses?: string[]; trajectories?: string[] }

function RecordsTab({ qs, dataset }: { qs: string; dataset: Dataset }) {
  const { can } = useAuth();
  const absIndex = useAbstractIndex();
  const canManage = can("manageResearchData");
  const [kind, setKind] = useState<"documents" | "permits" | "rrcPermits">("documents");
  const [page, setPage] = useState(1);
  // Whole-dataset ordering: the sort runs in the DATABASE across every
  // matching record, then the page is cut — never a per-page shuffle.
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "recordingDate", dir: "desc" });
  const [docs, setDocs] = useState<Paged<DocRecord> | null>(null);
  const [permits, setPermits] = useState<Paged<PermitRecord> | null>(null);
  const [rrcPermits, setRrcPermits] = useState<Paged<RrcPermitRecord> | null>(null);
  const [loading, setLoading] = useState(true);
  const sel = useRowSelection();
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  // Free-text search over the WHOLE dataset (matched in the database, so a
  // hit on page 8 surfaces immediately). Debounced so results update as the
  // user types without a request per keystroke; combines with all filters.
  const [search, setSearch] = useState("");
  const [searchQ, setSearchQ] = useState("");
  useEffect(() => { const t = window.setTimeout(() => setSearchQ(search.trim()), 250); return () => window.clearTimeout(t); }, [search]);

  // Records-level filters. Options are DYNAMIC — distinct values from the data
  // currently loaded into Research (under the page's active filters/window),
  // so the dropdowns only ever offer values that exist in the dataset.
  const [showFilters, setShowFilters] = useState(false);
  const [rf, setRf] = useState<RecFilters>(EMPTY_REC_FILTERS);
  const [opts, setOpts] = useState<RecOptions>({ counties: [], abstracts: [] });
  const recAbstractLabels = useMemo(
    () => Object.fromEntries(opts.abstracts.map((a) => [a, absIndex.labelAmong(a, rf.counties)])),
    [opts.abstracts, absIndex, rf.counties],
  );
  const rankRecAbstracts = useCallback((o: readonly string[], q: string) =>
    rankAbstracts(o, q, (a) => ({ abstract: a, text: recAbstractLabels[a] ?? a })), [recAbstractLabels]);
  // The instrument filter is typed too — same debounce so it re-queries
  // smoothly instead of once per keystroke.
  const [instrumentQ, setInstrumentQ] = useState("");
  useEffect(() => { const t = window.setTimeout(() => setInstrumentQ(rf.instrument.trim()), 250); return () => window.clearTimeout(t); }, [rf.instrument]);
  useEffect(() => {
    setRf(EMPTY_REC_FILTERS);
    setSearch(""); setSearchQ("");
    setSort(kind === "documents" ? { key: "recordingDate", dir: "desc" } : kind === "rrcPermits" ? { key: "permitDate", dir: "desc" } : { key: "activityDate", dir: "desc" });
  }, [kind]);
  useEffect(() => {
    api.get<RecOptions>(`/research/records/options?kind=${kind}&${qs}`).then(setOpts)
      .catch(() => setOpts({ counties: [], abstracts: [] }));
  }, [qs, kind]);
  const recQs = useMemo(() => {
    const p = new URLSearchParams(qs);
    for (const a of rf.abstracts) p.append("abstract", a);
    for (const c of rf.counties) p.append("county", c);
    for (const sv of rf.surveys) p.append("survey", sv);
    for (const t of rf.docTypes) p.append("docType", t);
    for (const g of rf.grantors) p.append("seller", g);
    for (const g of rf.grantees) p.append("buyer", g);
    for (const s of rf.statuses) p.append("permitStatus", s);
    for (const t of rf.trajectories) p.append("trajectory", t);
    if (instrumentQ) p.set("instrument", instrumentQ);
    if (rf.from) p.set("from", rf.from);
    if (rf.to) p.set("to", rf.to);
    if (searchQ) p.set("q", searchQ);
    return p.toString();
  }, [qs, rf, searchQ, instrumentQ]);
  const activeFilterCount = rf.abstracts.length + rf.counties.length + rf.surveys.length + rf.docTypes.length +
    rf.grantors.length + rf.grantees.length +
    rf.statuses.length + rf.trajectories.length + (rf.instrument.trim() ? 1 : 0) + (rf.from ? 1 : 0) + (rf.to ? 1 : 0);

  // Abstract Buyer Preview: whenever an abstract is selected (page-level drill
  // or the records Abstract filter), summarize its top 5 buyers above the table
  // so the map → records flow gives immediate context.
  const selAbstracts = useMemo(() => {
    const p = new URLSearchParams(recQs);
    return [...new Set([...p.getAll("abstractId"), ...p.getAll("abstract")])];
  }, [recQs]);
  const [absBuyers, setAbsBuyers] = useState<{ total: number; buyers: AbstractBuyer[] } | null>(null);
  useEffect(() => {
    if (!selAbstracts.length || kind !== "documents") { setAbsBuyers(null); return; }
    let cancelled = false;
    api.get<{ total: number; buyers: AbstractBuyer[] }>(`/research/abstract-buyers?${recQs}`)
      .then((d) => { if (!cancelled) setAbsBuyers(d); })
      .catch(() => { if (!cancelled) setAbsBuyers(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recQs, kind]);

  useEffect(() => { setPage(1); sel.clear(); }, [recQs, kind, pageSize, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLoading(true);
    const base = kind === "rrcPermits" ? "rrc-permits" : kind;
    const url = `/research/${base}?${recQs}&page=${page}&pageSize=${pageSize}&sortBy=${encodeURIComponent(sort.key)}&sortDir=${sort.dir}`;
    if (kind === "documents") api.get<Paged<DocRecord>>(url).then(setDocs).catch(() => setDocs(null)).finally(() => setLoading(false));
    else if (kind === "rrcPermits") api.get<Paged<RrcPermitRecord>>(url).then(setRrcPermits).catch(() => setRrcPermits(null)).finally(() => setLoading(false));
    else api.get<Paged<PermitRecord>>(url).then(setPermits).catch(() => setPermits(null)).finally(() => setLoading(false));
  }, [recQs, kind, page, pageSize, sort, reloadKey]);

  // Deletion is permanent — removed records can never resurface as phantom
  // duplicates in a later import. Ids are sent in chunks under the server's
  // per-request cap, so a whole-dataset selection deletes completely.
  const BULK_CHUNK = 5000;
  async function bulkDelete() {
    setBusy(true);
    try {
      const ids = [...sel.selected];
      for (let i = 0; i < ids.length; i += BULK_CHUNK) {
        await api.post("/research/records/bulk", { kind: kind.toUpperCase(), ids: ids.slice(i, i + BULK_CHUNK), action: "delete" });
      }
      sel.clear(); setConfirmDel(false); setReloadKey((k) => k + 1);
    } finally { setBusy(false); }
  }

  // Select EVERY record matching the current search/filters — across all
  // pages, not just the visible ones — so bulk actions cover the whole
  // filtered dataset.
  const [selectingAll, setSelectingAll] = useState(false);
  async function selectAllMatching() {
    setSelectingAll(true);
    try {
      const d = await api.get<{ total: number; ids: string[] }>(`/research/records/ids?kind=${kind}&${recQs}`);
      sel.toggleAll(d.ids.filter((id) => !sel.selected.has(id))); // additive: selects every not-yet-selected match
    } finally { setSelectingAll(false); }
  }

  /**
   * Every row matching the current filters/search, fetched page by page in
   * server-sorted order. No arbitrary cap: exports cover the entire matching
   * dataset regardless of pagination, and the sequential 1,000-row pages keep
   * memory and request size bounded so large exports don't freeze or fail.
   */
  async function fetchAllRows<T>(base: "documents" | "permits" | "rrc-permits"): Promise<T[]> {
    const out: T[] = [];
    const pageSize = 1000;
    for (let p = 1; ; p++) {
      const d = await api.get<Paged<T>>(`/research/${base}?${recQs}&page=${p}&pageSize=${pageSize}&sortBy=${encodeURIComponent(sort.key)}&sortDir=${sort.dir}`);
      out.push(...d.rows);
      if (out.length >= d.total || d.rows.length === 0) break;
    }
    return out;
  }

  const [exporting, setExporting] = useState(false);
  async function exportRows(onlySelected: boolean) {
    setExporting(true);
    try {
      if (kind === "documents") {
        let rows = await fetchAllRows<DocRecord>("documents");
        if (onlySelected) rows = rows.filter((r) => sel.selected.has(r.id));
        downloadCsv(onlySelected ? "research-documents-selected.csv" : "research-documents.csv",
          ["Recording Date", "Type", "Class", "Grantor", "Grantee", "Instrument #", "State", "County", "Abstract"],
          rows.map((r) => [r.recordingDate.slice(0, 10), r.docTypeRaw, r.docClass, r.grantor, r.grantee, r.instrumentNumber, r.state, r.county, r.abstractId]));
      } else if (kind === "rrcPermits") {
        const rows = await fetchAllRows<RrcPermitRecord>("rrc-permits");
        downloadCsv("rrc-permits.csv",
          ["Permit Date", "Operator", "Lease", "Well #", "County", "Abstract", "Survey", "Unit Acres", "API #", "Permit #"],
          rows.map((r) => [r.permitDate?.slice(0, 10) ?? "", r.operator, r.leaseName, r.wellNo, r.county, r.abstract, r.survey, r.acres != null ? String(r.acres) : "", r.api8 ? `42-${r.api8}` : "", r.statusNo]));
      } else {
        let rows = await fetchAllRows<PermitRecord>("permits");
        if (onlySelected) rows = rows.filter((r) => sel.selected.has(r.id));
        downloadCsv(onlySelected ? "research-permits-selected.csv" : "research-permits.csv",
          ["Date", "Operator", "Lease", "Well", "API #", "Permit #", "Status", "Trajectory", "State", "County", "Formation", "Source"],
          rows.map((r) => [r.activityDate.slice(0, 10), r.operator, r.leaseName, r.wellName, r.apiNumber, r.permitNumber, r.status, r.trajectory, r.state, r.county, r.formation, r.source]));
      }
    } finally { setExporting(false); }
  }
  const exportSelected = () => exportRows(true);
  const exportAll = () => exportRows(false);

  const active = kind === "documents" ? docs : kind === "rrcPermits" ? rrcPermits : permits;
  const totalPages = active ? Math.max(1, Math.ceil(active.total / pageSize)) : 1;

  const dash = <span className="rs-zero">—</span>;
  const docColumns: Column<DocRecord>[] = [
    { key: "recordingDate", header: "Recorded", value: (r) => r.recordingDate, render: (r) => <span className="rs-mid rec-nowrap">{fmtDate(r.recordingDate)}</span>, type: "date" },
    { key: "docType", header: "Type", value: (r) => r.docTypeRaw, render: (r) => <DocTypeTag docType={r.docType} raw={r.docTypeRaw} /> },
    // No `max` on the records chip columns: every party/abstract renders (chips
    // wrap onto extra lines) — nothing hides behind a "+N" indicator.
    { key: "grantor", header: dataset === "LEASE" ? "Grantor (lessor)" : "Grantor (seller)", value: (r) => r.grantor, minWidth: 180, render: (r) => <span className="rec-name"><ChipList items={r.grantorParties?.length ? r.grantorParties : [r.grantor]} /></span> },
    { key: "grantee", header: dataset === "LEASE" ? "Grantee (lessee)" : "Grantee (buyer)", value: (r) => r.grantee, minWidth: 180, render: (r) => <span className="rec-name"><ChipList items={r.granteeParties?.length ? r.granteeParties : [r.grantee]} /></span> },
    { key: "county", header: "County", value: (r) => `${r.county}, ${r.state}`, render: (r) => <span className="rs-mid rec-nowrap">{r.county}, {r.state}</span> },
    { key: "abstractId", header: "Abstract", value: (r) => r.abstractId, align: "right", render: (r) => r.abstractId ? <span className="rs-mid chips-oneline"><ChipList items={r.abstractId.split(",").map((a) => absIndex.label(a.trim(), r.county, r.state))} /></span> : dash },
    { key: "instrumentNumber", header: "Instrument #", value: (r) => r.instrumentNumber, align: "right", render: (r) => r.instrumentNumber ? <span className="rs-mono rec-nowrap">{r.instrumentNumber}</span> : dash },
  ];
  const permitColumns: Column<PermitRecord>[] = [
    { key: "activityDate", header: "Date", value: (r) => r.activityDate, render: (r) => <span className="rs-mid rec-nowrap">{fmtDate(r.activityDate)}</span>, type: "date" },
    { key: "operator", header: "Operator", value: (r) => r.operator, render: (r) => r.operator ? <span className="rec-name">{r.operator}</span> : dash },
    { key: "leaseName", header: "Lease / well", value: (r) => `${r.leaseName ?? ""} ${r.wellName ?? ""}`.trim() || null },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <EnumTag value={r.status} /> },
    { key: "trajectory", header: "Trajectory", value: (r) => r.trajectory, render: (r) => <EnumTag value={r.trajectory} /> },
    { key: "county", header: "County", value: (r) => `${r.county}, ${r.state}`, render: (r) => <span className="rs-mid rec-nowrap">{r.county}, {r.state}</span> },
    { key: "formation", header: "Formation", value: (r) => r.formation },
    { key: "apiNumber", header: "API #", value: (r) => r.apiNumber, align: "right", render: (r) => r.apiNumber ? <span className="rs-mono rec-nowrap">{r.apiNumber}</span> : dash },
  ];

  const rrcPermitColumns: Column<RrcPermitRecord>[] = [
    { key: "permitDate", header: "Permit date", value: (r) => r.permitDate, render: (r) => r.permitDate ? <span className="rs-mid rec-nowrap">{fmtDate(r.permitDate)}</span> : dash, type: "date" },
    { key: "operator", header: "Operator", value: (r) => r.operator, render: (r) => r.operator ? <span className="rec-name">{r.operator}</span> : dash },
    { key: "leaseName", header: "Lease / well", value: (r) => `${r.leaseName ?? ""} ${r.wellNo ?? ""}`.trim() || null, render: (r) => <span>{r.leaseName ?? "—"}{r.wellNo ? ` #${r.wellNo}` : ""}</span> },
    { key: "county", header: "County", value: (r) => r.county, render: (r) => <span className="rs-mid rec-nowrap">{r.county}, TX</span> },
    { key: "abstract", header: "Abstract", value: (r) => r.abstract, align: "right", render: (r) => r.abstract ? <span className="rs-mid chips-oneline"><ChipList items={[absIndex.label(r.abstract, r.county, "TX")]} /></span> : dash },
    { key: "survey", header: "Survey", value: (r) => r.survey },
    { key: "acres", header: "Unit (ac)", value: (r) => r.acres, align: "right", type: "number", render: (r) => r.acres != null ? <span className="rs-mid rec-nowrap">{num(r.acres)}</span> : dash },
    { key: "apiNumber", header: "API #", value: (r) => r.api8, align: "right", render: (r) => r.api8 ? <span className="rs-mono rec-nowrap">{`42-${r.api8.slice(0, 3)}-${r.api8.slice(3)}`}</span> : dash },
  ];

  const kindLabel = kind === "documents" ? (dataset === "LEASE" ? "lease documents" : "transaction documents") : kind === "permits" ? "drilling permits" : "RRC permits (W-1)";

  // Toolbar row (reference order): source segmented control · search · Filters
  // · count · rows per page · Export CSV — Customize View joins on the right
  // via the table's own toolbar row.
  const toolbarContent = (
    <>
      <Segmented<"documents" | "permits" | "rrcPermits"> accent className="rs-seg-sm" ariaLabel="Record type" value={kind} onChange={setKind}
        options={[
          { value: "documents", label: dataset === "LEASE" ? "Lease documents" : "Transaction documents" },
          { value: "permits", label: "Drilling permits" },
          { value: "rrcPermits", label: "RRC permits (W-1)" },
        ]} />
      <SearchInput value={search} onChange={setSearch}
        placeholder={kind === "documents" ? "Search grantor, grantee, instrument #, abstract, survey…" : kind === "rrcPermits" ? "Search operator, lease, API #, abstract, survey…" : "Search operator, lease, well, API #, permit #…"}
        ariaLabel="Search records" />
      <button
        type="button"
        className={`rs-filter-btn sm ${showFilters || activeFilterCount > 0 ? "on" : ""}`}
        onClick={() => setShowFilters((s) => !s)}
        aria-expanded={showFilters}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" /></svg>
        Filters{activeFilterCount > 0 && <span className="rs-count-badge">{activeFilterCount}</span>}
      </button>
      <span className="spacer" />
      {active && <span className="rs-rec-count"><b>{num(active.total)}</b> records</span>}
      <span className="ct-rpp" title="Records per page"><Select value={String(pageSize)} onChange={(v) => setPageSize(Number(v))} options={["20", "50", "100", "200"]} width={68} ariaLabel="Records per page" /></span>
      <button type="button" className="rs-outline-btn" onClick={exportAll} disabled={!active?.total || exporting}>
        <DownloadIcon />
        {exporting ? "Exporting…" : "Export CSV"}
      </button>
    </>
  );

  // Recessed filter strip under the toolbar.
  const filterStrip = showFilters ? (
    <div className="rec-filterbar rs-rec-filters">
      <div className="rec-fgrid">
        <div><div className="rec-flabel">County</div>
          <SearchableMultiSelect options={opts.counties} value={rf.counties} onChange={(v) => setRf((p) => ({ ...p, counties: v }))} placeholder="Counties…" /></div>
        <div><div className="rec-flabel">Survey</div>
          <SearchableMultiSelect options={opts.surveys ?? []} value={rf.surveys} onChange={(v) => setRf((p) => ({ ...p, surveys: v }))} placeholder="Surveys…" /></div>
        <div><div className="rec-flabel">Abstract</div>
          <SearchableMultiSelect options={opts.abstracts} labels={recAbstractLabels} filterOptions={rankRecAbstracts} value={rf.abstracts} onChange={(v) => setRf((p) => ({ ...p, abstracts: v }))} placeholder="Abstract # or survey…" /></div>
        {kind === "rrcPermits" ? null : kind === "documents" ? (
          <>
            <div><div className="rec-flabel">Document type</div>
              <SearchableMultiSelect options={opts.docTypes ?? []} labels={Object.fromEntries((opts.docTypes ?? []).map((t) => [t, prettyDocType(t)]))}
                value={rf.docTypes} onChange={(v) => setRf((p) => ({ ...p, docTypes: v }))} placeholder="Document types…" /></div>
            <div><div className="rec-flabel">Grantor</div>
              <SearchableMultiSelect options={(opts.grantors ?? []).map((g) => g.value)}
                labels={Object.fromEntries((opts.grantors ?? []).map((g) => [g.value, g.label]))}
                value={rf.grantors} onChange={(v) => setRf((p) => ({ ...p, grantors: v }))} placeholder="Grantors…" /></div>
            <div><div className="rec-flabel">Grantee</div>
              <SearchableMultiSelect options={(opts.grantees ?? []).map((g) => g.value)}
                labels={Object.fromEntries((opts.grantees ?? []).map((g) => [g.value, g.label]))}
                value={rf.grantees} onChange={(v) => setRf((p) => ({ ...p, grantees: v }))} placeholder="Grantees…" /></div>
          </>
        ) : (
          <>
            <div><div className="rec-flabel">Status</div>
              <SearchableMultiSelect options={opts.statuses ?? []} labels={Object.fromEntries((opts.statuses ?? []).map((s) => [s, prettyEnum(s)]))}
                value={rf.statuses} onChange={(v) => setRf((p) => ({ ...p, statuses: v }))} placeholder="Statuses…" /></div>
            <div><div className="rec-flabel">Trajectory</div>
              <SearchableMultiSelect options={opts.trajectories ?? []} labels={Object.fromEntries((opts.trajectories ?? []).map((t) => [t, prettyEnum(t)]))}
                value={rf.trajectories} onChange={(v) => setRf((p) => ({ ...p, trajectories: v }))} placeholder="Trajectories…" /></div>
          </>
        )}
        {kind === "documents" && (
          <div><div className="rec-flabel">Instrument #</div>
            <div className="msel msel-single"><div className="msel-box">
              <input className="datef-input" value={rf.instrument} onChange={(e) => setRf((p) => ({ ...p, instrument: e.target.value }))}
                placeholder="e.g. 2026-1038 or partial" aria-label="Filter by instrument number" />
              {rf.instrument && <button type="button" className="msel-clear" aria-label="Clear instrument filter"
                onMouseDown={(e) => { e.preventDefault(); setRf((p) => ({ ...p, instrument: "" })); }}>×</button>}
            </div></div></div>
        )}
        <div><div className="rec-flabel">From</div><DateField value={rf.from} onChange={(v) => setRf((p) => ({ ...p, from: v }))} ariaLabel="Records from date" /></div>
        <div><div className="rec-flabel">To</div><DateField value={rf.to} onChange={(v) => setRf((p) => ({ ...p, to: v }))} ariaLabel="Records to date" /></div>
      </div>
      <div className="rs-rec-filters-foot">
        <span>Filters apply to the {kindLabel} list only.</span>
        {activeFilterCount > 0 && <button type="button" className="rs-text-btn" onClick={() => setRf(EMPTY_REC_FILTERS)}>Clear filters</button>}
      </div>
    </div>
  ) : null;

  return (
    <>
      {kind === "documents" && selAbstracts.length > 0 && absBuyers && absBuyers.buyers.length > 0 && (
        <section className="rs-card rs-topbuyers">
          <div className="rs-topbuyers-head">
            <span className="rs-strong">
              Top buyers — {selAbstracts.map((a) => absIndex.labelAmong(a, rf.counties)).join("; ")}
            </span>
            <span className="rs-mid rs-small">
              {num(absBuyers.total)} buyer{absBuyers.total === 1 ? "" : "s"} in this period
            </span>
          </div>
          {absBuyers.buyers.map((b, i) => (
            <div key={b.norm} className="rs-topbuyer">
              <span className="rs-topbuyer-name">
                <span className="rs-rank">{i + 1}.</span>{b.name}
              </span>
              <span className="rs-mid rs-small rec-nowrap">
                {num(b.count)} record{b.count === 1 ? "" : "s"}
                {b.transactions > 0 && <> · {num(b.transactions)} transaction{b.transactions === 1 ? "" : "s"}</>}
                {b.leases > 0 && <> · {num(b.leases)} lease{b.leases === 1 ? "" : "s"}</>}
                {b.amount > 0 && <> · ${Math.round(b.amount).toLocaleString()}</>}
                {" · last "}{fmtDate(b.lastSeen)}
              </span>
            </div>
          ))}
        </section>
      )}
      {canManage && sel.selected.size > 0 && (
        <BulkBar count={sel.selected.size} onClear={sel.clear}>
          {/* Selects every record matching the current search/filters across
              ALL pages — bulk actions then cover the whole dataset. */}
          {active != null && sel.selected.size < active.total && (
            <button className="small" onClick={selectAllMatching} disabled={selectingAll}>
              {selectingAll ? "Selecting…" : `Select all ${num(active.total)}`}
            </button>
          )}
          <button className="small" onClick={exportSelected} disabled={exporting}>{exporting ? "Exporting…" : "Export"}</button>
          <button className="small danger" onClick={() => setConfirmDel(true)} disabled={busy}>Delete</button>
        </BulkBar>
      )}
      <div className="rec-card rs-records">
        {loading && !active ? (
          <>
            <div className="cv-toolbar"><div className="cv-toolbar-left">{toolbarContent}</div></div>
            {filterStrip}
            <Spinner />
          </>
        ) : !active || active.total === 0 ? (
          <>
            <div className="cv-toolbar"><div className="cv-toolbar-left">{toolbarContent}</div></div>
            {filterStrip}
            <p className="rs-empty">No records match these filters.</p>
          </>
        ) : (
          <>
            {kind === "documents"
              ? <SortableTable customizeId="research-records-docs" columns={docColumns} rows={docs!.rows} rowKey={(r) => r.id} toolbar={toolbarContent} subToolbar={filterStrip} serverSort={{ sort, onSort: setSort }} selection={canManage ? { selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll } : undefined} />
              : kind === "rrcPermits"
              ? <SortableTable customizeId="research-records-rrc-permits" columns={rrcPermitColumns} rows={rrcPermits!.rows} rowKey={(r) => r.id} toolbar={toolbarContent} subToolbar={filterStrip} serverSort={{ sort, onSort: setSort }} />
              : <SortableTable customizeId="research-records-permits" columns={permitColumns} rows={permits!.rows} rowKey={(r) => r.id} toolbar={toolbarContent} subToolbar={filterStrip} serverSort={{ sort, onSort: setSort }} selection={canManage ? { selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll } : undefined} />}
            <div className="rs-card-foot">
              <span>{sel.selected.size > 0 ? `${num(sel.selected.size)} selected · ` : ""}Showing {num(active.rows.length)} of {num(active.total)} records · sorted across all pages by {(kind === "documents" ? (docColumns as Column<never>[]) : kind === "rrcPermits" ? (rrcPermitColumns as Column<never>[]) : (permitColumns as Column<never>[])).find((c) => c.key === sort.key)?.header.toLowerCase() ?? sort.key}, {sort.dir === "asc" ? "ascending" : "descending"}</span>
              {totalPages > 1 && (
                <span className="rs-pager">
                  <button type="button" className="rs-outline-btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
                  <span>Page {page} of {num(totalPages)}</span>
                  <button type="button" className="rs-outline-btn sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
                </span>
              )}
            </div>
          </>
        )}
      </div>
      {confirmDel && (
        <ConfirmDelete count={sel.selected.size} itemLabel="record" busy={busy} onCancel={() => setConfirmDel(false)} onConfirm={bulkDelete} />
      )}
    </>
  );
}
