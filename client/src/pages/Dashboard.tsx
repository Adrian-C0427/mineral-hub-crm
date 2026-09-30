import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { Sun, Moon, X } from "lucide-react";
import GridLayout, { type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Modal, Req, Spinner, StageBadge, showToast } from "../components/ui";
import { ApiError } from "../api/client";
import { Select } from "../components/Select";
import { money, fmtDate, fmtDateLocal } from "../lib/format";
import { useStages } from "../stages";
import { PeriodSegmented } from "../components/PeriodSegmented";
import { DateField } from "../components/DateField";
import { useTheme } from "../theme";
import { layoutRect } from "../lib/viewport";
import { useIsPhonePortrait } from "../lib/mobile";

// Global dashboard period (default YTD). Drives all period-scoped widgets.
type DashPeriod = "THIS_MONTH" | "LAST_MONTH" | "THIS_QUARTER" | "YTD" | "CUSTOM";
const DASH_PERIODS: readonly (readonly [DashPeriod, string])[] = [
  ["THIS_MONTH", "This Month"], ["LAST_MONTH", "Last Month"], ["THIS_QUARTER", "This Quarter"], ["YTD", "YTD"], ["CUSTOM", "Custom"],
];

interface DashTask {
  id: string; title: string; details?: string | null; dueDate: string | null; priority: "LOW" | "MEDIUM" | "HIGH" | string;
  assignedTo: { id: string; name: string } | null; createdBy?: { id: string; name: string } | null;
  /** Null for a standalone task created from the Dashboard. */
  contactId: string | null; contactName: string | null;
  completedAt?: string | null; createdAt?: string;
  /** The viewer may complete it (its owner/author, or a contact manager). */
  canComplete?: boolean;
}

interface DashboardData {
  metrics: {
    activeDeals: number; projectedProfit: number; closedProfitYtd: number; closedDealsCount: number; avgProfitPerDeal: number; offersPending: number; periodLabel?: string;
    /** Total acquisition cost (Our Cost) of active seller deals — what we're under contract for. */
    underContract?: number;
    /** Prior equal-length window (Closed Date keyed) — delta baselines. */
    closedProfitPrev?: number; closedDealsPrev?: number; avgProfitPrev?: number;
  };
  /** Contact tasks that are overdue, due today, or due within 7 days. */
  tasks?: DashTask[];
  overdue: { id: string; name: string; findBuyerByDate: string | null }[];
  stageCounts: { stage: string; count: number }[];
  upcomingFollowUps: { dealId: string; buyerName: string; dealName: string; date: string | null }[];
  recentActivity: { id: string; summary: string; createdAt: string }[];
  topBuyers: { id: string; name: string; companyName: string; volume: number }[];
  profitByMonth: {
    month: string; isCurrent: boolean; profit: number; projected: number;
    /** The deals behind the bar — closed in (or scheduled to close in) the bucket. */
    deals?: { id: string; name: string; stage: string; kind: "closed" | "projected"; amount: number | null; profit: number; date: string }[];
  }[];
  /** Real historical series for the KPI sparklines (optional: older API). */
  trends?: { activeDealsWeekly: number[]; avgProfitPerDeal: number[]; closedWeekly: number[]; offersWeekly: number[] };
}

// Compact currency for KPI values, matching the design ($1.28M / $892K / $47.8K).
function fmtCompact(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${a >= 1e5 ? Math.round(a / 1e3) : (a / 1e3).toFixed(1)}K`;
  return money(v);
}

const pctChange = (cur: number, prev: number): number | null => (prev > 0 ? ((cur - prev) / prev) * 100 : null);

/**
 * Dynamic y-axis for the profit chart. Returns a `max` that sits just above the
 * tallest data point (small buffer, not a fixed scale) plus evenly spaced,
 * round tick values from 0 to that max.
 *
 * The old approach snapped the max up to a coarse 1/2/2.5/5 × 10ⁿ value, which
 * turned a $93K peak into a $200K axis (>2×) and visually flattened the bars.
 * Here we instead pick a "nice" step (1/1.5/2/2.5/3/4/5/6/8 × 10ⁿ) and take the
 * smallest round multiple of it that clears the peak. We try a few gridline
 * counts and keep the TIGHTEST resulting max, so the top of the axis hugs the
 * data — typically ~5–15% headroom — while tick labels stay round.
 */
function niceAxis(peak: number): { max: number; ticks: number[] } {
  if (!(peak > 0)) return { max: 1, ticks: [0, 1] };
  const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  // The max must clear the tallest bar by a hair so it never touches the top.
  const min = peak * 1.03;
  let best: { max: number; step: number } | null = null;
  for (const divs of [4, 5, 6]) {
    const rough = min / divs;
    const mag = 10 ** Math.floor(Math.log10(rough));
    const norm = rough / mag;
    const step = (NICE.find((s) => s >= norm - 1e-9) ?? 10) * mag;
    const max = Math.ceil(min / step - 1e-9) * step;
    if (!best || max < best.max) best = { max, step };
  }
  const ticks: number[] = [];
  for (let t = 0; t <= best!.max + best!.step * 1e-6; t += best!.step) ticks.push(t);
  return { max: best!.max, ticks };
}

/** Design-spec mini trend line (88×28 viewBox, stretched, 2px stroke) with a
 *  soft gradient area fill fading to transparent beneath the line. */
let sparkSeq = 0;
function Spark({ data, color }: { data: number[]; color: string }) {
  // Stable per-instance gradient id (colors repeat across KPI cards).
  const idRef = useRef(`dash-spark-${++sparkSeq}`);
  if (data.length < 2 || !data.some((v) => v !== 0)) return <div style={{ height: 26, marginTop: 8 }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * 88;
      const y = max === min ? 14 : 25 - ((v - min) / (max - min)) * 22;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const id = idRef.current;
  return (
    <svg width="100%" height="26" viewBox="0 0 88 28" preserveAspectRatio="none" style={{ marginTop: 8, display: "block" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.22 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <polygon points={`0,28 ${pts} 88,28`} fill={`url(#${id})`} />
      <polyline points={pts} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" style={{ stroke: color }} />
    </svg>
  );
}

function Delta({ pct }: { pct: number | null }) {
  if (pct == null || !isFinite(pct) || Math.round(pct) === 0) return null;
  const up = pct > 0;
  return <span className={`dash-delta ${up ? "up" : "down"}`}>{up ? "▲" : "▼"} {Math.abs(Math.round(pct))}%</span>;
}

function Kpi({ label, value, valueColor, delta, series, spark, title }: {
  label: string; value: string | number; valueColor?: string; delta?: number | null;
  series?: number[]; spark?: string; title?: string;
}) {
  return (
    <div className="metric-card dash-kpi" title={title}>
      <div className="dash-kpi-label">{label}</div>
      <div className="dash-kpi-row">
        <span className="dash-kpi-value" style={valueColor ? { color: valueColor } : undefined}>{value}</span>
        <Delta pct={delta ?? null} />
      </div>
      {series ? <Spark data={series} color={spark ?? "var(--accent2)"} /> : <div style={{ height: 26, marginTop: 8 }} />}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Layout model — a real dashboard grid (react-grid-layout): every widget has
// an exact x/y position and w/h size on a 12-column canvas. In Customize mode
// widgets drag anywhere (others move out of the way live, with animated
// transforms) and resize from their edges/corner — the fully-freeform layout
// found in premium analytics tools. Positions persist per browser.
// ---------------------------------------------------------------------------
type WidgetId = "kpis" | "profit" | "stages" | "activity" | "buyers" | "followups" | "tasks";
const WIDGET_LABELS: Record<WidgetId, string> = {
  kpis: "Key metrics", profit: "Profit by month", stages: "Active deals by stage",
  activity: "Recent activity", buyers: "Top buyers", followups: "Upcoming follow-ups",
  tasks: "Tasks",
};
const ALL_WIDGETS: WidgetId[] = ["kpis", "profit", "stages", "activity", "buyers", "followups", "tasks"];

const COLS = 12;
const ROW_H = 30;      // px per grid row (small unit = fine-grained heights)
const GAP = 14;
const MIN_W = 3;
const MIN_H = 4;

interface Cell { x: number; y: number; w: number; h: number }
// Default canvas mirrors the design reference: KPI strip, then the profit
// chart (wide) beside the pipeline funnel, then a 3-up row of tasks / top
// buyers / recent activity, with follow-ups full-width beneath.
const DEFAULT_LAYOUT: Record<WidgetId, Cell> = {
  kpis: { x: 0, y: 0, w: 12, h: 6 },
  profit: { x: 0, y: 6, w: 7, h: 9 },
  stages: { x: 7, y: 6, w: 5, h: 9 },
  tasks: { x: 0, y: 15, w: 4, h: 9 },
  buyers: { x: 4, y: 15, w: 4, h: 9 },
  activity: { x: 8, y: 15, w: 4, h: 9 },
  followups: { x: 0, y: 24, w: 12, h: 7 },
};

interface DashPrefs { layout: Record<WidgetId, Cell>; hidden: WidgetId[] }
const DASH_KEY = "mh-dashboard:v2";

function loadDashPrefs(): DashPrefs {
  try {
    const raw = localStorage.getItem(DASH_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<DashPrefs>;
      const layout = { ...DEFAULT_LAYOUT };
      for (const id of ALL_WIDGETS) {
        const c = p.layout?.[id];
        if (c && [c.x, c.y, c.w, c.h].every((n) => typeof n === "number" && isFinite(n))) layout[id] = c;
      }
      return { layout, hidden: (p.hidden ?? []).filter((id): id is WidgetId => ALL_WIDGETS.includes(id as WidgetId)) };
    }
    // One-time migration from the v1 swap-grid prefs: carry over hidden widgets,
    // let positions start from the (better) default canvas.
    const v1 = localStorage.getItem("mh-dashboard:v1");
    if (v1) {
      const p = JSON.parse(v1) as { hidden?: string[] };
      return {
        layout: { ...DEFAULT_LAYOUT },
        hidden: (p.hidden ?? []).filter((id): id is WidgetId => ALL_WIDGETS.includes(id as WidgetId)),
      };
    }
  } catch { /* ignore */ }
  return { layout: { ...DEFAULT_LAYOUT }, hidden: [] };
}

export function Dashboard() {
  const [d, setD] = useState<DashboardData | null>(null);
  const [period, setPeriod] = useState<DashPeriod>("YTD");
  // Custom reporting range (period === "CUSTOM"): fetch waits for both ends.
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();
  const { label: stageLabel, colorOf: stageColorOf } = useStages();
  const [prefs, setPrefs] = useState<DashPrefs>(loadDashPrefs);
  const [customizing, setCustomizing] = useState(false);
  // A task opened from a notification (or a standalone task's row) —
  // `?task=<id>` in the URL, so the link is shareable and survives reloads.
  const [params, setParams] = useSearchParams();
  const openTaskId = params.get("task");
  const openTask = (id: string) => { const next = new URLSearchParams(params); next.set("task", id); setParams(next); };
  const closeTask = () => { const next = new URLSearchParams(params); next.delete("task"); setParams(next, { replace: true }); };
  const [taskRefresh, setTaskRefresh] = useState(0);
  // The metrics need "View reports"; without it the page explains instead of
  // spinning forever (a task opened from a notification still shows).
  const [denied, setDenied] = useState(false);
  // Profit chart interactivity: hovered bucket (rich tooltip) + clicked bucket
  // (drill-down modal listing the deals behind that bar).
  const [profitHover, setProfitHover] = useState<number | null>(null);
  const [profitDrill, setProfitDrill] = useState<number | null>(null);
  // The drill panel is non-modal (no backdrop / no focus trap), so wire up
  // Escape ourselves.
  useEffect(() => {
    if (profitDrill == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setProfitDrill(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profitDrill]);
  // The panel centers itself in the viewport with pure fixed-position CSS —
  // deliberately independent of the navigation sidebar's state, so it never
  // shifts when the nav expands or collapses.
  useEffect(() => { try { localStorage.setItem(DASH_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } }, [prefs]);

  useEffect(() => {
    const qs = new URLSearchParams({ period });
    if (period === "CUSTOM") {
      if (!customFrom || !customTo || customFrom > customTo) return; // wait for a complete range
      qs.set("from", customFrom); qs.set("to", customTo);
    }
    const load = () => {
      void api.get<DashboardData>(`/dashboard?${qs.toString()}`)
        .then((data) => { setD(data); setDenied(false); })
        .catch((e) => { if (e instanceof ApiError && e.status === 403) setDenied(true); });
    };
    load();
    // Deals are created, edited, moved and removed on other pages (or in other
    // tabs) — refresh when the user comes back so totals like Under Contract
    // are never stale.
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [period, customFrom, customTo]);

  // Grid width tracks the CONTAINER (not the window), so collapsing/expanding
  // the sidebar reflows the canvas immediately. Sub-320px readings are ignored:
  // they only occur transiently (mid-layout, hidden tab) and would collapse the
  // whole canvas into an overlapping mess if honored.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [gridW, setGridW] = useState(0);
  // Portrait phones stack the widgets in one column (saved-layout order)
  // instead of the 12-column canvas; the desktop layout is never rewritten.
  const phoneStack = useIsPhonePortrait();
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(layoutRect(el).width); // zoom-aware layout width
      if (w >= 320) setGridW(w);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [d == null, phoneStack]);

  const visibleIds = useMemo(() => ALL_WIDGETS.filter((id) => !prefs.hidden.includes(id)), [prefs.hidden]);
  const gridLayout: Layout[] = useMemo(
    () => visibleIds.map((id) => ({ i: id, ...prefs.layout[id], minW: MIN_W, minH: MIN_H })),
    [visibleIds, prefs.layout],
  );
  const stackIds = useMemo(
    () => [...visibleIds].sort((a, b) => prefs.layout[a].y - prefs.layout[b].y || prefs.layout[a].x - prefs.layout[b].x),
    [visibleIds, prefs.layout],
  );

  const taskModal = openTaskId ? <TaskDetailModal id={openTaskId} onClose={closeTask} onChanged={() => setTaskRefresh((n) => n + 1)} /> : null;
  if (!d) {
    return (
      <>
        {taskModal}
        {denied ? (
          <div className="page">
            <div className="panel"><p className="muted" style={{ margin: 0 }}>Your role doesn't include the dashboard's business metrics. Ask an owner or admin for "View reports" access.</p></div>
          </div>
        ) : <Spinner />}
      </>
    );
  }

  // Paired bars (design): realized and projected render side by side, so the
  // y-scale is driven by the single largest monthly value of either series.
  // The axis is DYNAMIC — its max sits just above the tallest bar in the
  // SELECTED range (rescales with the range) rather than on a fixed scale, so
  // month-to-month differences stay proportional and readable.
  const maxProfit = Math.max(1, ...d.profitByMonth.map((m) => Math.max(m.profit, m.projected)));
  const { max: niceMax, ticks: axisTicks } = niceAxis(maxProfit);
  // Index of the bucket containing today (-1 when the window is in the past).
  const curIdx = d.profitByMonth.findIndex((m) => m.isCurrent);
  const realized = d.profitByMonth.map((m) => m.profit);
  const projectedSeries = d.profitByMonth.map((m) => m.projected);
  const maxStage = Math.max(1, ...d.stageCounts.map((s) => s.count));

  // Deltas only where an honest baseline exists.
  const t = d.trends;
  const activeDelta = t && t.activeDealsWeekly.length >= 2 ? pctChange(t.activeDealsWeekly[t.activeDealsWeekly.length - 1], t.activeDealsWeekly[0]) : null;
  // Closed-metric deltas compare the SELECTED window against the equal-length
  // window immediately before it (both keyed on Closed Date, computed
  // server-side) — so the percentage always matches the reporting period.
  const m = d.metrics;
  const closedDelta = m.closedProfitPrev !== undefined ? pctChange(m.closedProfitYtd, m.closedProfitPrev) : null;
  const closedCountDelta = m.closedDealsPrev !== undefined ? pctChange(m.closedDealsCount, m.closedDealsPrev) : null;
  const avgDelta = m.avgProfitPrev !== undefined ? pctChange(m.avgProfitPerDeal, m.avgProfitPrev) : null;

  // Brand-new workspace: no active deals and nothing closed yet. Guide the
  // first steps instead of presenting a wall of zeros.
  const firstRun = d.metrics.activeDeals === 0 && d.metrics.closedProfitYtd === 0 && d.recentActivity.length === 0;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  // Time-of-day greeting (design): "Good evening, Adrian".
  const hour = new Date().getHours();
  const daypart = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] || "there";

  const widgetNodes: Record<WidgetId, ReactNode> = {
    kpis: (
      <div className="metrics-row dash-kpis">
        <Kpi label="Under Contract" value={fmtCompact(d.metrics.underContract ?? 0)} title="Total acquisition cost (Our Cost) of every active deal we're under contract with sellers for. Excludes closed and dead deals and owned mineral assets." />
        <Kpi label="Active Deals" value={d.metrics.activeDeals} delta={activeDelta} series={t?.activeDealsWeekly} spark="var(--accent2)" title="Sparkline: active deals per week (8 weeks)" />
        <Kpi label="Projected Profit" value={fmtCompact(d.metrics.projectedProfit)} series={projectedSeries} spark="var(--accent2)" title="Best (or accepted) offer minus cost basis across active deals with offers — the same series as the Projected bars below." />
        <Kpi label={`Closed ${d.metrics.periodLabel ?? "YTD"}`} value={fmtCompact(d.metrics.closedProfitYtd)} valueColor={d.metrics.closedProfitYtd > 0 ? "var(--green)" : undefined} delta={closedDelta} series={curIdx >= 0 ? realized.slice(0, curIdx + 1) : realized} spark="var(--green)" title="Sparkline: realized profit by month" />
        <Kpi label="Closed Deals" value={d.metrics.closedDealsCount} delta={closedCountDelta} series={t?.closedWeekly} spark="var(--green)" title="Deals moved to Closed within the selected range, by Contract Timeline Closed Date. Δ vs the previous equal-length period. Sparkline: closes per week (8 weeks)." />
        <Kpi label="Avg Profit per Deal" value={fmtCompact(d.metrics.avgProfitPerDeal)} delta={avgDelta} series={t?.avgProfitPerDeal} spark="var(--text-dim)" title="Realized profit per closed deal in the selected range (Closed Date). Sparkline: running average across recent closes." />
        <Kpi label="Offers Pending" value={d.metrics.offersPending} series={t?.offersWeekly} spark="var(--amber)" title="Sparkline: offers received per week (8 weeks)" />
      </div>
    ),
    profit: (
      <div className="panel">
        <div className="panel-title" style={{ marginBottom: 0 }}>
          <div>
            <h3 className="dash-h3">Profit by month</h3>
            {/* Per-month totals now sit above each bar (see .bar-val); the header
                keeps just the title + period so the number lives on the chart. */}
            <div className="dash-panel-sub">
              Realized + projected{d.metrics.periodLabel ? ` · ${d.metrics.periodLabel}` : ` in ${new Date().getFullYear()}`}
            </div>
          </div>
          {d.profitByMonth.some((m) => m.profit > 0 || m.projected > 0) && (
            <div className="row" style={{ gap: 14, fontSize: 11.5, fontWeight: 600, color: "var(--text-dim)" }}>
              <span className="row" style={{ gap: 6 }}><span className="dash-swatch" style={{ background: "var(--green)" }} /> Realized</span>
              <span className="row" style={{ gap: 6 }}><span className="dash-swatch dash-swatch-proj" /> Projected</span>
            </div>
          )}
        </div>
        {/* The chart spans the SELECTED reporting period (every month of it,
            yearly buckets for very long custom ranges). Buckets with no
            realized or projected profit show a faint zero placeholder instead
            of vanishing, so the x-axis spacing stays stable. A $-labeled
            y-axis gives scale at a glance (no gridlines — kept minimal);
            hovering shows the full breakdown; clicking a month opens a
            non-blocking details panel. The axis renders ascending: the tick
            array is $0→max and .bar-axis is column-reverse, so $0 sits at the
            bottom. */}
        <div className="bar-chart-wrap">
          <div className="bar-axis" aria-hidden="true">
            {axisTicks.map((tick) => <span key={tick}>{fmtCompact(tick)}</span>)}
          </div>
          <div className="bar-plot">
            <div className="bar-chart">
              {d.profitByMonth.map((m, i) => {
                const empty = m.profit === 0 && m.projected === 0;
                const clickable = (m.deals?.length ?? 0) > 0;
                return (
                  <div
                    className={`bar-col ${m.isCurrent ? "current" : ""} ${clickable ? "clickable" : ""}`} key={m.month}
                    role={clickable ? "button" : undefined} tabIndex={clickable ? 0 : undefined}
                    aria-label={clickable ? `${m.month}: view ${m.deals!.length} deal${m.deals!.length === 1 ? "" : "s"}` : undefined}
                    onMouseEnter={() => setProfitHover(i)} onMouseLeave={() => setProfitHover((h) => (h === i ? null : h))}
                    onClick={clickable ? () => setProfitDrill(i) : undefined}
                    onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setProfitDrill(i); } } : undefined}
                  >
                    <div className="bar-zone">
                      {/* The month's total (realized + projected) floats directly
                          above the taller of the two bars — the highest point of
                          the month's graph. */}
                      {!empty && (
                        <div className="bar-val" style={{ bottom: `${(Math.max(m.profit, m.projected) / niceMax) * 100}%` }}>
                          {fmtCompact(m.profit + m.projected)}
                        </div>
                      )}
                      {empty ? (
                        <div className="bar bar-zero" />
                      ) : (
                        <>
                          {m.profit > 0 && <div className="bar" style={{ height: `${(m.profit / niceMax) * 100}%` }} />}
                          {m.projected > 0 && <div className="bar bar-projected" style={{ height: `${(m.projected / niceMax) * 100}%` }} />}
                        </>
                      )}
                    </div>
                    <div className="bar-label">{m.month}</div>
                  </div>
                );
              })}
            </div>
            {profitHover != null && d.profitByMonth[profitHover] && (() => {
              const m = d.profitByMonth[profitHover];
              const onRight = profitHover >= d.profitByMonth.length / 2;
              return (
                <div className="chart-tip" style={{
                  [onRight ? "right" : "left"]: `${(onRight ? 1 - (profitHover + 0.5) / d.profitByMonth.length : (profitHover + 0.5) / d.profitByMonth.length) * 100}%`,
                }}>
                  <div className="chart-tip-title">{m.month}</div>
                  <div className="chart-tip-row"><span className="dash-swatch" style={{ background: "var(--green)" }} /> Realized <strong>{money(m.profit)}</strong></div>
                  {m.projected > 0 && <div className="chart-tip-row"><span className="dash-swatch dash-swatch-proj" /> Projected <strong>{money(m.projected)}</strong></div>}
                  <div className="chart-tip-row chart-tip-total">Total <strong>{money(m.profit + m.projected)}</strong></div>
                  {(m.deals?.length ?? 0) > 0 && <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>Click for {m.deals!.length} deal{m.deals!.length === 1 ? "" : "s"}</div>}
                </div>
              );
            })()}
          </div>
        </div>
        {d.profitByMonth.every((m) => m.profit === 0 && m.projected === 0) && (
          <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>
            No closed or projected profit in this period — bars fill in as deals close (with a Closed Date) or get an accepted offer with a closing date.
          </p>
        )}
        {profitDrill != null && d.profitByMonth[profitDrill] && (() => {
          const m = d.profitByMonth[profitDrill];
          const closed = (m.deals ?? []).filter((x) => x.kind === "closed");
          const projected = (m.deals ?? []).filter((x) => x.kind === "projected");
          const total = (m.deals ?? []).length;
          const group = (title: string, sub: string, rows: typeof closed) => rows.length > 0 && (
            <div className="drill-group">
              <div className="drill-group-head">
                <span className="drill-group-title">{title}</span>
                <span className="drill-group-count">{rows.length}</span>
              </div>
              <div className="drill-group-sub">{sub}</div>
              {rows.map((x) => (
                <div key={x.id} className="drill-row">
                  <div className="drill-row-main">
                    <Link to={`/deals/${x.id}`} className="drill-row-name">{x.name}</Link>
                    <StageBadge stage={x.stage} />
                  </div>
                  <div className="drill-row-meta">
                    <span className="muted">{fmtDate(x.date)}</span>
                    {x.amount != null && <span>{money(x.amount)}</span>}
                    <span className="drill-profit" style={{ color: x.profit >= 0 ? "var(--green)" : "var(--red)" }}>{money(x.profit)}</span>
                  </div>
                </div>
              ))}
            </div>
          );
          {/* Non-blocking floating panel (no backdrop) — the dashboard stays
              scrollable and clickable while it's open; clicking another month
              simply re-points the panel. Esc or × closes. Portaled to <body>:
              the react-grid-layout item's CSS transform would otherwise turn
              position:fixed into transform-relative positioning. */}
          return createPortal(
            <aside className="drill-panel" role="dialog" aria-label={`${m.month} profit breakdown`}>
              <div className="drill-head">
                <div style={{ minWidth: 0 }}>
                  <h3 className="dash-h3" style={{ margin: 0 }}>{m.month} — profit breakdown</h3>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{total} deal{total === 1 ? "" : "s"} this month</div>
                </div>
                <button className="icon-btn" onClick={() => setProfitDrill(null)} aria-label="Close" style={{ marginLeft: "auto" }}><X size={16} /></button>
              </div>
              <div className="drill-summary">
                <div className="drill-stat">
                  <span className="drill-stat-label"><span className="dash-swatch" style={{ background: "var(--green)" }} /> Realized</span>
                  <strong>{money(m.profit)}</strong>
                </div>
                {m.projected > 0 && (
                  <div className="drill-stat">
                    <span className="drill-stat-label"><span className="dash-swatch dash-swatch-proj" /> Projected</span>
                    <strong>{money(m.projected)}</strong>
                  </div>
                )}
                <div className="drill-stat">
                  <span className="drill-stat-label">Total</span>
                  <strong>{money(m.profit + m.projected)}</strong>
                </div>
              </div>
              <div className="drill-body">
                {group("Closed this month", "Realized — keyed on the Contract Timeline's Closed Date; profit uses the accepted offer.", closed)}
                {group("Scheduled to close", "Projected — active deals with an offer whose anticipated closing lands in this month.", projected)}
              </div>
            </aside>,
            document.body
          );
        })()}
      </div>
    ),
    stages: (
      <div className="panel">
        <div className="panel-title" style={{ marginBottom: 14 }}>
          <h3 className="dash-h3">Pipeline by stage</h3>
          <Link to="/pipeline" className="dash-viewlink">View pipeline →</Link>
        </div>
        {d.stageCounts.every((s) => s.count === 0) ? <p className="muted">No active deals.</p> : (
          <div className="dash-funnel">
            {d.stageCounts.map((s) => (
              <Link className="dash-fun-row" key={s.stage} to={`/pipeline?stage=${s.stage}`}>
                <span className="dash-fun-head">
                  <span className="dash-fun-name"><span className="dash-fun-dot" style={{ background: stageColorOf(s.stage) }} />{stageLabel(s.stage)}</span>
                  <span className="dash-fun-count" style={{ color: s.count > 0 ? "var(--text)" : "var(--text-faint)" }}>{s.count}</span>
                </span>
                <span className="dash-fun-track">
                  <span className="dash-fun-fill" style={{ width: `${(s.count / maxStage) * 100}%`, background: stageColorOf(s.stage) }} />
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    ),
    activity: (
      <div className="panel">
        <div className="panel-title" style={{ marginBottom: 14 }}>
          <h3 className="dash-h3">Recent activity</h3>
        </div>
        {d.recentActivity.length === 0 ? <p className="muted">Nothing yet.</p> : (
          <div className="dash-tl">
            {d.recentActivity.slice(0, 8).map((a, i, arr) => (
              <div className="dash-tl-row" key={a.id}>
                <div className="dash-tl-rail">
                  <span className="dash-tl-dot" />
                  {i < arr.length - 1 && <span className="dash-tl-line" />}
                </div>
                <div className="dash-tl-body">
                  <div className="dash-tl-text">{a.summary}</div>
                  <div className="dash-tl-when">{fmtDateLocal(a.createdAt)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
    buyers: (
      <div className="panel">
        <div className="panel-title" style={{ marginBottom: 12 }}>
          <h3 className="dash-h3">Top buyers YTD</h3>
          <Link to="/buyers" className="dash-viewlink">View buyers →</Link>
        </div>
        {d.topBuyers.length === 0 ? <p className="muted">No closed volume yet.</p> : (() => {
          const topVol = Math.max(1, ...d.topBuyers.map((b) => b.volume));
          const totalVol = Math.max(1, d.topBuyers.reduce((s, b) => s + b.volume, 0));
          const BAR_COLORS = ["#3b82f6", "#a855f7", "#06b6d4", "#f59e0b", "#22c55e"];
          return d.topBuyers.map((b, i) => (
            <Link to={`/buyers/${b.id}`} className="dash-buyer-row" key={b.id}>
              <span className="dash-buyer-top">
                <span className="dash-buyer-name">{b.companyName || b.name}</span>
                <span className="dash-buyer-amt">{fmtCompact(b.volume)}</span>
              </span>
              <span className="dash-buyer-bottom">
                <span className="dash-buyer-track"><span className="dash-buyer-fill" style={{ width: `${(b.volume / topVol) * 100}%`, background: BAR_COLORS[i % BAR_COLORS.length] }} /></span>
                <span className="dash-buyer-share">{Math.round((b.volume / totalVol) * 100)}%</span>
              </span>
            </Link>
          ));
        })()}
      </div>
    ),
    followups: (
      <div className="panel">
        <h3 className="dash-h3" style={{ marginBottom: 6 }}>Upcoming follow-ups</h3>
        {d.upcomingFollowUps.length === 0 ? <p className="muted">No follow-ups scheduled.</p> : d.upcomingFollowUps.map((f, i) => (
          <div className="dash-feed-row" key={i}>
            <span className="dash-soft">{f.buyerName} · <Link to={`/deals/${f.dealId}`}>{f.dealName}</Link></span>
            <span className="dash-faint" style={{ whiteSpace: "nowrap" }}>{fmtDate(f.date)}</span>
          </div>
        ))}
      </div>
    ),
    tasks: <TasksWidget initial={d.tasks ?? []} refreshKey={taskRefresh} onOpenTask={openTask} onChanged={() => setTaskRefresh((n) => n + 1)} />,
  };

  const hiddenIds = ALL_WIDGETS.filter((id) => prefs.hidden.includes(id));
  const isDefaultLayout = prefs.hidden.length === 0 && JSON.stringify(prefs.layout) === JSON.stringify(DEFAULT_LAYOUT);

  // RGL reports the whole layout after every drag/resize — persist it. The
  // same-reference bail-out when nothing changed is LOAD-BEARING: RGL fires
  // this on mount/sync too, and always returning a fresh object would ping-pong
  // renders between RGL and React indefinitely.
  const onLayoutChange = (next: Layout[]) => {
    setPrefs((p) => {
      let changed = false;
      const layout = { ...p.layout };
      for (const item of next) {
        const id = item.i as WidgetId;
        if (!ALL_WIDGETS.includes(id)) continue;
        const cur = layout[id];
        if (cur.x !== item.x || cur.y !== item.y || cur.w !== item.w || cur.h !== item.h) {
          layout[id] = { x: item.x, y: item.y, w: item.w, h: item.h };
          changed = true;
        }
      }
      return changed ? { ...p, layout } : p;
    });
  };

  const hideWidget = (id: WidgetId) => setPrefs((p) => ({ ...p, hidden: [...p.hidden, id] }));
  const showWidget = (id: WidgetId) =>
    setPrefs((p) => {
      // Re-enter at the bottom of the canvas so it never lands on top of
      // something else; the user drags it wherever they want from there.
      const visible = ALL_WIDGETS.filter((w) => !p.hidden.includes(w));
      const bottom = visible.length ? Math.max(...visible.map((w) => p.layout[w].y + p.layout[w].h)) : 0;
      return {
        hidden: p.hidden.filter((k) => k !== id),
        layout: { ...p.layout, [id]: { ...p.layout[id], x: 0, y: bottom } },
      };
    });

  return (
    <div className="page">
      {taskModal}
      <div className="page-header">
        <div>
          <h1 className="dash-title">Good {daypart}, {firstName}</h1>
          <span className="dash-sub">Acquisition snapshot · {today}</span>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <PeriodSegmented options={DASH_PERIODS} value={period} onChange={setPeriod} compact />
          {period === "CUSTOM" && (
            <div className="row" style={{ gap: 6 }}>
              <div style={{ width: 148 }}><DateField value={customFrom} onChange={setCustomFrom} ariaLabel="Custom range from" placeholder="From" /></div>
              <span className="muted">–</span>
              <div style={{ width: 148 }}><DateField value={customTo} onChange={setCustomTo} ariaLabel="Custom range to" placeholder="To" /></div>
            </div>
          )}
          <button type="button" className={`dash-cz-toggle ${customizing ? "active" : ""}`} onClick={() => setCustomizing((c) => !c)} title="Customize dashboard layout">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>
            <span>{customizing ? "Done" : "Customize"}</span>
          </button>
          <button className="dash-icon-btn" title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggleTheme}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          {/* ?new=1 opens the New Deal modal directly (design's header CTA). */}
          <Link to="/deals/active?new=1" className="pbtn-primary dash-newdeal">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            New Deal
          </Link>
        </div>
      </div>

      {firstRun && (
        <div className="panel">
          <div className="panel-title"><h3>Get started</h3></div>
          <p className="muted" style={{ marginTop: 0 }}>
            Welcome to Mineral Hub! These metrics fill in as you work — here's where most teams begin:
          </p>
          <div className="row">
            {/* ?new=1 opens the New Deal modal immediately — one click, not two. */}
            <Link to="/deals/active?new=1" className="primary" style={{ padding: "8px 14px", borderRadius: 6 }}>1 · Create your first deal</Link>
            <Link to="/buyers" style={{ padding: "8px 14px", border: "1px solid var(--border)", borderRadius: 6 }}>2 · Add or import buyers</Link>
            <Link to="/valuation" style={{ padding: "8px 14px", border: "1px solid var(--border)", borderRadius: 6 }}>3 · Import well production data</Link>
          </div>
        </div>
      )}

      {customizing && (
        <div className="panel dash-cz-banner">
          <span className="dash-cz-banner-text">
            {phoneStack
              ? <><strong>Customizing dashboard</strong> — hide or show widgets here; arrange and resize them on a larger screen. Everything saves automatically.</>
              : <><strong>Customizing dashboard</strong> — drag a widget anywhere, resize from its edges or corner, or hide it. Everything saves automatically.</>}
          </span>
          <span className="row" style={{ gap: 8, marginLeft: "auto" }}>
            <button type="button" className="small" disabled={isDefaultLayout} onClick={() => setPrefs({ layout: { ...DEFAULT_LAYOUT }, hidden: [] })}>Restore default</button>
            <button type="button" className="small primary" onClick={() => setCustomizing(false)}>Done</button>
          </span>
        </div>
      )}

      {customizing && hiddenIds.length > 0 && (
        <div className="panel dash-cz-tray">
          <span className="muted" style={{ fontSize: 13 }}>Hidden widgets:</span>
          {hiddenIds.map((id) => (
            <button key={id} type="button" className="dash-cz-chip" onClick={() => showWidget(id)}>+ {WIDGET_LABELS[id]}</button>
          ))}
        </div>
      )}

      {visibleIds.length === 0 && !customizing ? (
        <div className="panel"><p className="muted" style={{ margin: 0 }}>All widgets are hidden. Use <strong>Customize</strong> to bring them back.</p></div>
      ) : phoneStack ? (
        <div className={`dash-stack ${customizing ? "customizing" : ""}`}>
          {stackIds.map((id) => (
            <div key={id} className={`dash-w dash-w-${id} ${customizing ? "cz" : ""}`}>
              {customizing && (
                <div className="dash-cz-bar">
                  <span className="dash-cz-name">{WIDGET_LABELS[id]}</span>
                  <span className="dash-cz-actions">
                    <button type="button" className="dash-cz-btn" onClick={() => hideWidget(id)} title="Hide widget">✕ Hide</button>
                  </span>
                </div>
              )}
              <div className="dash-w-body">{widgetNodes[id]}</div>
            </div>
          ))}
        </div>
      ) : (
        // width:100% so the measuring wrapper never collapses while the grid
        // inside it is still waiting for its first measured width.
        <div ref={wrapRef} style={{ width: "100%" }}>
        {gridW > 0 && <GridLayout
          className={`dash-rgl ${customizing ? "customizing" : ""}`}
          width={gridW}
          layout={gridLayout}
          cols={COLS}
          rowHeight={ROW_H}
          margin={[GAP, GAP]}
          containerPadding={[0, 0]}
          isDraggable={customizing}
          isResizable={customizing}
          resizeHandles={["se", "e", "s"]}
          // Free placement: widgets sit exactly where they're dropped (no
          // auto-packing). preventCollision keeps the rest of the layout
          // perfectly still during a drag — other widgets are never shoved
          // around by a fast mouse movement; a widget simply won't drop onto
          // occupied space. Calm, predictable, and impossible to scramble the
          // whole board by accident.
          compactType={null}
          preventCollision
          draggableCancel=".dash-cz-btn, a, button"
          useCSSTransforms
          onLayoutChange={onLayoutChange}
        >
          {visibleIds.map((id) => (
            <div key={id} className={`dash-w ${customizing ? "cz" : ""}`}>
              {customizing && (
                <div className="dash-cz-bar">
                  <span className="dash-cz-handle" aria-hidden="true">⠿</span>
                  <span className="dash-cz-name">{WIDGET_LABELS[id]}</span>
                  <span className="dash-cz-actions">
                    <button type="button" className="dash-cz-btn" onClick={() => hideWidget(id)} title="Hide widget">✕ Hide</button>
                  </span>
                </div>
              )}
              <div className="dash-w-body">{widgetNodes[id]}</div>
            </div>
          ))}
        </GridLayout>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks widget — every outstanding contact task that needs attention (overdue,
// due today, or due within the next week). Checking a task completes it in the
// database and removes it from the widget instantly; clicking the row opens
// the contact workspace with that task in focus.
// ---------------------------------------------------------------------------
const TASK_PRIORITY_META: Record<string, { label: string; color: string }> = {
  HIGH: { label: "High", color: "var(--red)" },
  MEDIUM: { label: "Medium", color: "var(--amber)" },
  LOW: { label: "Low", color: "var(--green)" },
};

/**
 * Whose tasks the widget lists: "me" (default — My Tasks), "all" users, or one
 * user's id. The list refetches as soon as the selection changes. Tasks can be
 * created here (for yourself or a teammate) and completed in place.
 */
function TasksWidget({ initial, refreshKey, onOpenTask, onChanged }: {
  initial: DashTask[]; refreshKey: number; onOpenTask: (id: string) => void; onChanged: () => void;
}) {
  const { user } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [whose, setWhose] = useState("me");
  const [tasks, setTasks] = useState<DashTask[]>(initial);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { api.get<{ id: string; name: string }[]>("/users").then(setUsers).catch(() => {}); }, []);
  // The dashboard payload already carries My Tasks; refetch for any change
  // after that (a new filter, a created/completed task, returning to the tab).
  const first = useRef(true);
  useEffect(() => {
    let live = true;
    const load = () => {
      setLoading(true);
      api.get<DashTask[]>(`/tasks?assignee=${encodeURIComponent(whose)}`)
        .then((rows) => { if (live) setTasks(rows); })
        .catch(() => {})
        .finally(() => { if (live) setLoading(false); });
    };
    if (first.current && whose === "me") first.current = false; else load();
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { live = false; document.removeEventListener("visibilitychange", onVisible); };
  }, [whose, refreshKey]);
  const userOptions = [
    { value: "me", label: "My Tasks" },
    { value: "all", label: "All Users" },
    ...users.filter((u) => u.id !== user?.id).map((u) => ({ value: u.id, label: u.name })),
  ];
  const showOwner = whose !== "me";
  // Due dates are calendar days stored at UTC midnight — compare day keys, not
  // timestamps, so a task due today never shows as overdue mid-morning.
  const todayKey = new Date().toISOString().slice(0, 10);

  const complete = async (t: DashTask) => {
    if (busy) return;
    setBusy(t.id);
    try {
      await api.patch(`/tasks/${t.id}`, { completed: true });
      setTasks((prev) => prev.filter((x) => x.id !== t.id));
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not complete the task", "error");
    } finally { setBusy(null); }
  };

  return (
    <div className="panel">
      <div className="panel-title dash-task-head" style={{ marginBottom: 12 }}>
        <h3 className="dash-h3">Tasks</h3>
        {tasks.length > 0 && <span className="dash-task-badge">{tasks.length} due</span>}
        <span className="dash-task-filter">
          <Select value={whose} onChange={(v) => setWhose(v || "me")} options={userOptions} searchable={userOptions.length > 8}
            width={116} ariaLabel="Show tasks for" />
        </span>
        <button type="button" className="dash-task-add" onClick={() => setCreating(true)} title="Create a task for yourself or a teammate" aria-label="New task">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      {tasks.length === 0 ? (
        <div className="dash-task-clear">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
          {loading ? "Loading tasks…" : whose === "me" ? "You have no overdue or upcoming tasks" : whose === "all" ? "No overdue or upcoming tasks for anyone" : "No overdue or upcoming tasks for this user"}
        </div>
      ) : tasks.map((t) => {
        const dayKey = t.dueDate ? t.dueDate.slice(0, 10) : null;
        const overdue = dayKey != null && dayKey < todayKey;
        const dueToday = dayKey === todayKey;
        const pr = TASK_PRIORITY_META[t.priority] ?? TASK_PRIORITY_META.MEDIUM;
        const meta = [t.contactName, showOwner && t.assignedTo ? t.assignedTo.name : null].filter(Boolean).join(" · ");
        const body = (
          <>
            <span className="dash-task-title">{t.title}</span>
            {meta && <span className="dash-task-meta">{meta}</span>}
          </>
        );
        return (
          <div className="dash-task-row" key={t.id}>
            {t.canComplete && (
              <input type="checkbox" checked={false} disabled={busy === t.id} onChange={() => void complete(t)}
                title="Mark complete" aria-label={`Complete task: ${t.title}`} />
            )}
            {t.contactId ? (
              <Link to={`/contacts/${t.contactId}?task=${t.id}`} className="dash-task-main" title="Open this task on the contact's workspace">{body}</Link>
            ) : (
              <button type="button" className="dash-task-main dash-task-open" onClick={() => onOpenTask(t.id)} title="Open this task">{body}</button>
            )}
            <span className="dash-task-pr" style={{ color: pr.color, background: `color-mix(in srgb, ${pr.color} 13%, transparent)` }}>{pr.label}</span>
            <span className={`dash-task-due ${overdue ? "overdue" : ""}`}>
              {dayKey == null ? "—" : overdue ? `Overdue · ${fmtDate(t.dueDate!)}` : dueToday ? "Due today" : fmtDate(t.dueDate!)}
            </span>
          </div>
        );
      })}
      {creating && (
        <CreateTaskModal users={users} onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); onChanged(); }} />
      )}
    </div>
  );
}

const PRIORITY_CHOICES = [
  { key: "LOW", label: "Low" }, { key: "MEDIUM", label: "Medium" }, { key: "HIGH", label: "High" },
] as const;

/**
 * New task from the Dashboard: for yourself or assigned to a teammate (who is
 * notified, with a link that opens the task).
 */
function CreateTaskModal({ users, onClose, onCreated }: {
  users: { id: string; name: string }[]; onClose: () => void; onCreated: () => void;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [assignee, setAssignee] = useState(user?.id ?? "");
  const [priority, setPriority] = useState<"LOW" | "MEDIUM" | "HIGH">("MEDIUM");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = [
    { value: user?.id ?? "", label: `Me (${user?.name ?? "you"})` },
    ...users.filter((u) => u.id !== user?.id).map((u) => ({ value: u.id, label: u.name })),
  ];
  const ready = title.trim() !== "" && due !== "";

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<DashTask & { notified: boolean }>("/tasks", {
        title: title.trim(), details: details.trim() || null, priority, dueDate: due,
        assignedToId: assignee && assignee !== user?.id ? assignee : null,
      });
      showToast(created.notified
        ? `Task created and assigned to ${created.assignedTo?.name ?? "your teammate"} — they've been notified.`
        : "Task created.");
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the task");
    } finally { setBusy(false); }
  }

  return (
    <Modal title="New task" subtitle={<>For you or a teammate · assigned teammates are notified</>} onClose={onClose}
      dirty={title.trim() !== "" || details.trim() !== "" || due !== ""}
      footer={
        <>
          <span className="modal-req-note"><Req /> Required</span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={!ready || busy}>{busy ? "Creating…" : "Create task"}</button>
        </>
      }>
      <div className="field"><label>Task {<Req />}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={200} placeholder="e.g. Call the title company about the Leon closing" />
      </div>
      <div className="field"><label>Details</label>
        <textarea rows={3} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Anything the assignee should know…" />
      </div>
      <div className="dash-task-form-row">
        <div className="field"><label>Assign to</label>
          <Select value={assignee} onChange={(v) => setAssignee(v || user?.id || "")} options={options} searchable={options.length > 8} ariaLabel="Assign to" />
        </div>
        <div className="field"><label>Due date {<Req />}</label>
          <DateField value={due} onChange={setDue} ariaLabel="Due date" />
        </div>
      </div>
      <div className="field" style={{ marginBottom: 0 }}><label>Priority</label>
        <div className="seg-control" role="group" aria-label="Priority">
          {PRIORITY_CHOICES.map((p) => (
            <button type="button" key={p.key} className={`seg ${priority === p.key ? "active" : ""}`} aria-pressed={priority === p.key}
              onClick={() => setPriority(p.key)}>{p.label}</button>
          ))}
        </div>
      </div>
      {error && <div className="error-text" style={{ marginTop: 12 }}>{error}</div>}
    </Modal>
  );
}

/** One task, opened from a notification or a standalone task's row. */
function TaskDetailModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [task, setTask] = useState<DashTask | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setTask(null); setMissing(false);
    api.get<DashTask>(`/tasks/${encodeURIComponent(id)}`)
      .then((t) => { if (live) setTask(t); })
      .catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [id]);

  async function setCompleted(completed: boolean) {
    if (!task || busy) return;
    setBusy(true);
    try {
      setTask(await api.patch<DashTask>(`/tasks/${task.id}`, { completed }));
      onChanged();
      showToast(completed ? "Task completed." : "Task reopened.");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not update the task", "error");
    } finally { setBusy(false); }
  }

  const pr = task ? TASK_PRIORITY_META[task.priority] ?? TASK_PRIORITY_META.MEDIUM : null;
  const todayKey = new Date().toISOString().slice(0, 10);
  const overdue = !!task?.dueDate && !task.completedAt && task.dueDate.slice(0, 10) < todayKey;
  return (
    <Modal title={task?.title ?? (missing ? "Task not found" : "Task")} onClose={onClose}
      footer={
        <>
          {task?.contactId && <Link to={`/contacts/${task.contactId}?task=${task.id}`} className="btn-ghost-link" style={{ marginRight: "auto" }}>Open contact</Link>}
          <button onClick={onClose}>Close</button>
          {task?.canComplete && (
            task.completedAt
              ? <button onClick={() => void setCompleted(false)} disabled={busy}>Reopen task</button>
              : <button className="primary" onClick={() => void setCompleted(true)} disabled={busy}>{busy ? "Saving…" : "Mark complete"}</button>
          )}
        </>
      }>
      {missing ? (
        <p className="muted" style={{ margin: 0 }}>This task no longer exists — it may have been deleted.</p>
      ) : !task ? (
        <Spinner label="Loading task…" />
      ) : (
        <div className="dash-task-detail">
          {task.completedAt && <div className="dash-task-done-note">Completed {fmtDateLocal(task.completedAt)}</div>}
          {task.details && <p className="dash-task-details">{task.details}</p>}
          <div className="ddc-grid">
            <div><div className="ddx-label">Due</div><div className={`ddx-val ${overdue ? "neg" : ""}`}>{task.dueDate ? fmtDate(task.dueDate) : "—"}{overdue ? " · overdue" : ""}</div></div>
            <div><div className="ddx-label">Priority</div><div className="ddx-val"><span className="dash-task-pr" style={{ color: pr!.color, background: `color-mix(in srgb, ${pr!.color} 13%, transparent)` }}>{pr!.label}</span></div></div>
            <div><div className="ddx-label">Assigned to</div><div className="ddx-val">{task.assignedTo?.name ?? "—"}</div></div>
            <div><div className="ddx-label">Created by</div><div className="ddx-val">{task.createdBy?.name ?? "—"}{task.createdAt ? ` · ${fmtDateLocal(task.createdAt)}` : ""}</div></div>
            {task.contactName && <div><div className="ddx-label">Contact</div><div className="ddx-val">{task.contactName}</div></div>}
          </div>
        </div>
      )}
    </Modal>
  );
}
