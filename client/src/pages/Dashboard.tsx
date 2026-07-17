import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Sun, Moon, X } from "lucide-react";
import GridLayout, { type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { api } from "../api/client";
import { Spinner, StageBadge } from "../components/ui";
import { money, fmtDate, fmtDateLocal } from "../lib/format";
import { useStages } from "../stages";
import { PeriodSegmented } from "../components/PeriodSegmented";
import { DateField } from "../components/DateField";
import { useTheme } from "../theme";

// Global dashboard period (default YTD). Drives all period-scoped widgets.
type DashPeriod = "THIS_MONTH" | "LAST_MONTH" | "THIS_QUARTER" | "YTD" | "CUSTOM";
const DASH_PERIODS: readonly (readonly [DashPeriod, string])[] = [
  ["THIS_MONTH", "This Month"], ["LAST_MONTH", "Last Month"], ["THIS_QUARTER", "This Quarter"], ["YTD", "YTD"], ["CUSTOM", "Custom"],
];

interface DashboardData {
  metrics: { activeDeals: number; projectedProfit: number; closedProfitYtd: number; avgDealSize: number; offersPending: number; periodLabel?: string };
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
  trends?: { activeDealsWeekly: number[]; avgDealSize: number[]; offersWeekly: number[] };
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

/** Round a chart maximum up to a friendly 1/2/2.5/5 × 10ⁿ so axis ticks land on clean values. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * mag) return m * mag;
  return 10 * mag;
}

/** Design-spec mini trend line (88×28 viewBox, stretched, 2px stroke). */
function Spark({ data, color }: { data: number[]; color: string }) {
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
  return (
    <svg width="100%" height="26" viewBox="0 0 88 28" preserveAspectRatio="none" style={{ marginTop: 8, display: "block" }}>
      <polyline points={pts} fill="none" strokeWidth="2" style={{ stroke: color }} />
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
      {series ? <Spark data={series} color={spark ?? "var(--accent)"} /> : <div style={{ height: 26, marginTop: 8 }} />}
    </div>
  );
}

// Stage funnel fill colors, per the design (accent/amber/green resolve per theme).
const STAGE_FILL: Record<string, string> = {
  UNDER_CONTRACT: "var(--accent)",
  PREPARING_PACKAGE: "#6366f1",
  SENT_TO_BUYERS: "#8b5cf6",
  NEGOTIATING: "var(--amber)",
  CLOSING: "var(--green)",
};

// ---------------------------------------------------------------------------
// Layout model — a real dashboard grid (react-grid-layout): every widget has
// an exact x/y position and w/h size on a 12-column canvas. In Customize mode
// widgets drag anywhere (others move out of the way live, with animated
// transforms) and resize from their edges/corner — the fully-freeform layout
// found in premium analytics tools. Positions persist per browser.
// ---------------------------------------------------------------------------
type WidgetId = "kpis" | "profit" | "stages" | "activity" | "buyers" | "followups";
const WIDGET_LABELS: Record<WidgetId, string> = {
  kpis: "Key metrics", profit: "Profit by month", stages: "Active deals by stage",
  activity: "Recent activity", buyers: "Top buyers", followups: "Upcoming follow-ups",
};
const ALL_WIDGETS: WidgetId[] = ["kpis", "profit", "stages", "activity", "buyers", "followups"];

const COLS = 12;
const ROW_H = 30;      // px per grid row (small unit = fine-grained heights)
const GAP = 14;
const MIN_W = 3;
const MIN_H = 4;

interface Cell { x: number; y: number; w: number; h: number }
const DEFAULT_LAYOUT: Record<WidgetId, Cell> = {
  kpis: { x: 0, y: 0, w: 12, h: 6 },
  profit: { x: 0, y: 6, w: 6, h: 9 },
  stages: { x: 6, y: 6, w: 6, h: 9 },
  activity: { x: 0, y: 15, w: 6, h: 8 },
  buyers: { x: 6, y: 15, w: 6, h: 8 },
  followups: { x: 0, y: 23, w: 12, h: 7 },
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
  const { label: stageLabel } = useStages();
  const [prefs, setPrefs] = useState<DashPrefs>(loadDashPrefs);
  const [customizing, setCustomizing] = useState(false);
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
    api.get<DashboardData>(`/dashboard?${qs.toString()}`).then(setD);
  }, [period, customFrom, customTo]);

  // Grid width tracks the CONTAINER (not the window), so collapsing/expanding
  // the sidebar reflows the canvas immediately. Sub-320px readings are ignored:
  // they only occur transiently (mid-layout, hidden tab) and would collapse the
  // whole canvas into an overlapping mess if honored.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [gridW, setGridW] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w >= 320) setGridW(w);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [d == null]);

  const visibleIds = useMemo(() => ALL_WIDGETS.filter((id) => !prefs.hidden.includes(id)), [prefs.hidden]);
  const gridLayout: Layout[] = useMemo(
    () => visibleIds.map((id) => ({ i: id, ...prefs.layout[id], minW: MIN_W, minH: MIN_H })),
    [visibleIds, prefs.layout],
  );

  if (!d) return <Spinner />;

  // Paired bars (design): realized and projected render side by side, so the
  // y-scale is the single largest monthly value of either series, rounded up
  // to a clean axis maximum so the $-gridlines land on friendly numbers.
  // Scale to the tallest bar in the SELECTED range (rescales with the range)
  // with ~12% headroom so the tallest bar never presses against the top.
  const maxProfit = Math.max(1, ...d.profitByMonth.map((m) => Math.max(m.profit, m.projected)));
  const niceMax = niceCeil(maxProfit * 1.12);
  const axisTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * niceMax);
  // Index of the bucket containing today (-1 when the window is in the past).
  const curIdx = d.profitByMonth.findIndex((m) => m.isCurrent);
  const realized = d.profitByMonth.map((m) => m.profit);
  const projectedSeries = d.profitByMonth.map((m) => m.projected);
  const maxStage = Math.max(1, ...d.stageCounts.map((s) => s.count));

  // Deltas only where an honest baseline exists.
  const t = d.trends;
  const activeDelta = t && t.activeDealsWeekly.length >= 2 ? pctChange(t.activeDealsWeekly[t.activeDealsWeekly.length - 1], t.activeDealsWeekly[0]) : null;
  const closedDelta = curIdx > 0 ? pctChange(realized[curIdx], realized[curIdx - 1]) : null;
  const avgDelta = t && t.avgDealSize.length >= 2 ? pctChange(t.avgDealSize[t.avgDealSize.length - 1], t.avgDealSize[t.avgDealSize.length - 2]) : null;

  // Brand-new workspace: no active deals and nothing closed yet. Guide the
  // first steps instead of presenting a wall of zeros.
  const firstRun = d.metrics.activeDeals === 0 && d.metrics.closedProfitYtd === 0 && d.recentActivity.length === 0;
  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const widgetNodes: Record<WidgetId, ReactNode> = {
    kpis: (
      <div className="metrics-row dash-kpis">
        <Kpi label="Active Deals" value={d.metrics.activeDeals} delta={activeDelta} series={t?.activeDealsWeekly} spark="var(--accent)" title="Sparkline: active deals per week (8 weeks)" />
        <Kpi label="Projected Profit" value={fmtCompact(d.metrics.projectedProfit)} series={projectedSeries} spark="var(--accent)" title="Best (or accepted) offer minus cost basis across active deals with offers — the same series as the Projected bars below." />
        <Kpi label={`Closed ${d.metrics.periodLabel ?? "YTD"}`} value={fmtCompact(d.metrics.closedProfitYtd)} valueColor={d.metrics.closedProfitYtd > 0 ? "var(--green)" : undefined} delta={closedDelta} series={curIdx >= 0 ? realized.slice(0, curIdx + 1) : realized} spark="var(--green)" title="Sparkline: realized profit by month" />
        <Kpi label="Avg Deal Size" value={fmtCompact(d.metrics.avgDealSize)} delta={avgDelta} series={t?.avgDealSize} spark="var(--text-dim)" title="Sparkline: running average across recent closes" />
        <Kpi label="Offers Pending" value={d.metrics.offersPending} series={t?.offersWeekly} spark="var(--amber)" title="Sparkline: offers received per week (8 weeks)" />
      </div>
    ),
    profit: (
      <div className="panel">
        <div className="panel-title" style={{ marginBottom: 0 }}>
          <h3 className="dash-h3">Profit by month</h3>
          {d.profitByMonth.some((m) => m.profit > 0 || m.projected > 0) && (
            <div className="row" style={{ gap: 14, fontSize: 11.5, color: "var(--text-dim)" }}>
              <span className="row" style={{ gap: 5 }}><span className="dash-swatch" style={{ background: "var(--green)" }} /> Realized</span>
              <span className="row" style={{ gap: 5 }}><span className="dash-swatch dash-swatch-proj" /> Projected</span>
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
          <h3 className="dash-h3">Active deals by stage</h3>
          <Link to="/pipeline" className="muted" style={{ fontSize: 12 }}>View pipeline →</Link>
        </div>
        {d.stageCounts.every((s) => s.count === 0) ? <p className="muted">No active deals.</p> : (
          <div className="dash-funnel">
            {d.stageCounts.map((s) => (
              <Link className="dash-fun-row" key={s.stage} to={`/pipeline?stage=${s.stage}`}>
                <span className="dash-fun-head">
                  <span className="dash-soft">{stageLabel(s.stage)}</span>
                  <span className="dash-faintish">{s.count}</span>
                </span>
                <span className="dash-fun-track">
                  <span className="dash-fun-fill" style={{ width: `${(s.count / maxStage) * 100}%`, background: STAGE_FILL[s.stage] ?? "var(--accent)" }} />
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    ),
    activity: (
      <div className="panel">
        <h3 className="dash-h3" style={{ marginBottom: 6 }}>Recent activity</h3>
        {d.recentActivity.length === 0 ? <p className="muted">Nothing yet.</p> : d.recentActivity.slice(0, 8).map((a) => (
          <div className="dash-feed-row" key={a.id}>
            <span className="dash-soft">{a.summary}</span>
            <span className="dash-faint" style={{ whiteSpace: "nowrap" }}>{fmtDateLocal(a.createdAt)}</span>
          </div>
        ))}
      </div>
    ),
    buyers: (
      <div className="panel">
        <h3 className="dash-h3" style={{ marginBottom: 6 }}>Top buyers YTD</h3>
        {d.topBuyers.length === 0 ? <p className="muted">No closed volume yet.</p> : d.topBuyers.map((b, i) => (
          <div className="dash-rank-row" key={b.id}>
            <span className="dash-faint" style={{ width: 14 }}>{i + 1}</span>
            <Link to={`/buyers/${b.id}`} className="dash-rank-name">{b.companyName || b.name}</Link>
            <span className="dash-rank-amt">{fmtCompact(b.volume)}</span>
          </div>
        ))}
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
      <div className="page-header">
        <div>
          <h1 className="dash-title">Dashboard</h1>
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
            <Link to="/deals/active?new=1" className="primary" style={{ padding: "8px 14px", borderRadius: 8 }}>1 · Create your first deal</Link>
            <Link to="/buyers" style={{ padding: "8px 14px", border: "1px solid var(--border)", borderRadius: 8 }}>2 · Add or import buyers</Link>
            <Link to="/valuation" style={{ padding: "8px 14px", border: "1px solid var(--border)", borderRadius: 8 }}>3 · Import well production data</Link>
          </div>
        </div>
      )}

      {customizing && (
        <div className="panel dash-cz-banner">
          <span className="dash-cz-banner-text">
            <strong>Customizing dashboard</strong> — drag a widget anywhere, resize from its edges or corner, or hide it. Everything saves automatically.
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
          // auto-packing); colliding widgets are pushed live during the drag.
          compactType={null}
          preventCollision={false}
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
