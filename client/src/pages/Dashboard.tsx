import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Sun, Moon } from "lucide-react";
import { api } from "../api/client";
import { Spinner } from "../components/ui";
import { money, fmtDate, prettyStage } from "../lib/format";
import { NotificationsPanel } from "../components/NotificationsPanel";
import { PeriodSegmented } from "../components/PeriodSegmented";
import { useTheme } from "../theme";

// Global dashboard period (default YTD). Drives all period-scoped widgets.
type DashPeriod = "THIS_MONTH" | "LAST_MONTH" | "THIS_QUARTER" | "YTD";
const DASH_PERIODS: readonly (readonly [DashPeriod, string])[] = [
  ["THIS_MONTH", "This Month"], ["LAST_MONTH", "Last Month"], ["THIS_QUARTER", "This Quarter"], ["YTD", "YTD"],
];

interface DashboardData {
  metrics: { activeDeals: number; projectedProfit: number; closedProfitYtd: number; avgDealSize: number; offersPending: number; periodLabel?: string };
  overdue: { id: string; name: string; findBuyerByDate: string | null }[];
  stageCounts: { stage: string; count: number }[];
  upcomingFollowUps: { dealId: string; buyerName: string; dealName: string; date: string | null }[];
  recentActivity: { id: string; summary: string; createdAt: string }[];
  topBuyers: { id: string; name: string; companyName: string; volume: number }[];
  profitByMonth: { month: string; profit: number; projected: number }[];
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

// Customize View — the user chooses which dashboard widgets show and their order.
type WidgetId = "kpis" | "profit" | "stages" | "activity" | "buyers" | "followups";
const WIDGET_LABELS: Record<WidgetId, string> = {
  kpis: "Key metrics", profit: "Profit by month", stages: "Active deals by stage",
  activity: "Recent activity", buyers: "Top buyers", followups: "Upcoming follow-ups",
};
const DEFAULT_WIDGETS: WidgetId[] = ["kpis", "profit", "stages", "activity", "buyers", "followups"];
interface DashPrefs { order: WidgetId[]; hidden: WidgetId[] }
const DASH_KEY = "mh-dashboard:v1";
function loadDashPrefs(): DashPrefs {
  try { const raw = localStorage.getItem(DASH_KEY); if (raw) { const p = JSON.parse(raw) as Partial<DashPrefs>; return { order: p.order ?? [], hidden: p.hidden ?? [] }; } } catch { /* ignore */ }
  return { order: [], hidden: [] };
}

export function Dashboard() {
  const [d, setD] = useState<DashboardData | null>(null);
  const [period, setPeriod] = useState<DashPeriod>("YTD");
  const { theme, toggleTheme } = useTheme();
  const [prefs, setPrefs] = useState<DashPrefs>(loadDashPrefs);
  useEffect(() => { try { localStorage.setItem(DASH_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } }, [prefs]);

  useEffect(() => { api.get<DashboardData>(`/dashboard?period=${period}`).then(setD); }, [period]);
  if (!d) return <Spinner />;

  // Paired bars (design): realized and projected render side by side, so the
  // y-scale is the single largest monthly value of either series.
  const maxProfit = Math.max(1, ...d.profitByMonth.map((m) => Math.max(m.profit, m.projected)));
  const curMonth = new Date().getMonth();
  const realized = d.profitByMonth.map((m) => m.profit);
  const projectedSeries = d.profitByMonth.map((m) => m.projected);
  const maxStage = Math.max(1, ...d.stageCounts.map((s) => s.count));

  // Deltas only where an honest baseline exists.
  const t = d.trends;
  const activeDelta = t && t.activeDealsWeekly.length >= 2 ? pctChange(t.activeDealsWeekly[t.activeDealsWeekly.length - 1], t.activeDealsWeekly[0]) : null;
  const closedDelta = curMonth > 0 ? pctChange(realized[curMonth], realized[curMonth - 1]) : null;
  const avgDelta = t && t.avgDealSize.length >= 2 ? pctChange(t.avgDealSize[t.avgDealSize.length - 1], t.avgDealSize[t.avgDealSize.length - 2]) : null;

  // Brand-new workspace: no active deals and nothing closed yet. Guide the
  // first steps instead of presenting a wall of zeros.
  const firstRun = d.metrics.activeDeals === 0 && d.metrics.closedProfitYtd === 0 && d.recentActivity.length === 0;
  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  // Each dashboard section is an independently show/hide-able, reorderable widget.
  const overdueAlert = d.overdue.length > 0 ? (
    <div className="dash-alert">
      <span className="dash-alert-icon">!</span>
      <span className="dash-alert-text">
        <b>{d.overdue.length} deal{d.overdue.length > 1 ? "s" : ""} overdue</b> — past Find Buyer By with no buyer assigned:{" "}
        {d.overdue.map((o, i) => (<span key={o.id}>{i > 0 ? ", " : ""}<Link to={`/deals/${o.id}`}>{o.name}</Link></span>))}
      </span>
    </div>
  ) : null;

  const widgetNodes: Record<WidgetId, ReactNode> = {
    kpis: (
      <div className="metrics-row dash-kpis">
        <Kpi label="Active Deals" value={d.metrics.activeDeals} delta={activeDelta} series={t?.activeDealsWeekly} spark="var(--accent)" title="Sparkline: active deals per week (8 weeks)" />
        <Kpi label="Projected Profit" value={fmtCompact(d.metrics.projectedProfit)} series={projectedSeries} spark="var(--accent)" title="Sparkline: projected profit by expected closing month" />
        <Kpi label={`Closed ${d.metrics.periodLabel ?? "YTD"}`} value={fmtCompact(d.metrics.closedProfitYtd)} valueColor="var(--green)" delta={closedDelta} series={realized.slice(0, curMonth + 1)} spark="var(--green)" title="Sparkline: realized profit by month" />
        <Kpi label="Avg Deal Size" value={fmtCompact(d.metrics.avgDealSize)} delta={avgDelta} series={t?.avgDealSize} spark="var(--text-dim)" title="Sparkline: running average across recent closes" />
        <Kpi label="Offers Pending" value={d.metrics.offersPending} series={t?.offersWeekly} spark="var(--amber)" title="Sparkline: offers received per week (8 weeks)" />
      </div>
    ),
    profit: (
      <div className="panel">
        <div className="panel-title" style={{ marginBottom: 0 }}>
          <h3 className="dash-h3">Profit by month</h3>
          <div className="row" style={{ gap: 14, fontSize: 11.5, color: "var(--text-dim)" }}>
            <span className="row" style={{ gap: 5 }}><span className="dash-swatch" style={{ background: "var(--green)" }} /> Realized</span>
            <span className="row" style={{ gap: 5 }}><span className="dash-swatch dash-swatch-proj" /> Projected</span>
          </div>
        </div>
        {d.profitByMonth.every((m) => m.profit === 0 && m.projected === 0) ? (
          <p className="muted" style={{ margin: "12px 0 0" }}>
            No closed or projected profit this year yet — bars appear as deals close or get an accepted offer with a closing date.
          </p>
        ) : (
          <div className="bar-chart">
            {d.profitByMonth.map((m) => (
              <div className="bar-col" key={m.month} title={`${m.month}\nRealized: ${money(m.profit)}\nProjected: ${money(m.projected)}`}>
                <div className="bar-zone">
                  {m.profit > 0 && <div className="bar" style={{ height: `${(m.profit / maxProfit) * 100}%` }} />}
                  {m.projected > 0 && <div className="bar bar-projected" style={{ height: `${(m.projected / maxProfit) * 100}%` }} />}
                </div>
                <div className="bar-label">{m.month}</div>
              </div>
            ))}
          </div>
        )}
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
                  <span className="dash-soft">{prettyStage(s.stage)}</span>
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
            <span className="dash-faint" style={{ whiteSpace: "nowrap" }}>{fmtDate(a.createdAt)}</span>
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
  const widgetSpan: Record<WidgetId, "full" | "half"> = { kpis: "full", profit: "half", stages: "half", activity: "half", buyers: "half", followups: "full" };
  const orderedIds: WidgetId[] = [...prefs.order.filter((id) => DEFAULT_WIDGETS.includes(id)), ...DEFAULT_WIDGETS.filter((id) => !prefs.order.includes(id))];
  const visibleIds = orderedIds.filter((id) => !prefs.hidden.includes(id));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="dash-title">Dashboard</h1>
          <span className="dash-sub">Acquisition snapshot · {today}</span>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <PeriodSegmented options={DASH_PERIODS} value={period} onChange={setPeriod} compact />
          <DashboardCustomize prefs={prefs} onChange={setPrefs} />
          <button className="dash-icon-btn" title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggleTheme}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </div>

      <NotificationsPanel />

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

      {overdueAlert}

      {visibleIds.length === 0 ? (
        <div className="panel"><p className="muted" style={{ margin: 0 }}>All widgets are hidden. Use <strong>Customize View</strong> to bring them back.</p></div>
      ) : (
        <div className="dash-grid">
          {visibleIds.map((id) => (
            <div key={id} className={`dash-w ${widgetSpan[id]}`}>{widgetNodes[id]}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Customize View popover for the Dashboard (show/hide + reorder widgets). */
function DashboardCustomize({ prefs, onChange }: { prefs: DashPrefs; onChange: (p: DashPrefs) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const ordered: WidgetId[] = [...prefs.order.filter((id) => DEFAULT_WIDGETS.includes(id)), ...DEFAULT_WIDGETS.filter((id) => !prefs.order.includes(id))];
  const toggle = (id: WidgetId) => onChange({ ...prefs, hidden: prefs.hidden.includes(id) ? prefs.hidden.filter((k) => k !== id) : [...prefs.hidden, id] });
  const move = (id: WidgetId, dir: -1 | 1) => {
    const keys = [...ordered]; const i = keys.indexOf(id); const j = i + dir;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    onChange({ ...prefs, order: keys });
  };
  const isDefault = prefs.order.length === 0 && prefs.hidden.length === 0;

  return (
    <div className="cv-wrap" ref={ref}>
      <button type="button" className={`dash-icon-btn cv-btn ${open ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title="Customize dashboard">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>
      </button>
      {open && (
        <div className="cv-menu" role="dialog" aria-label="Customize dashboard">
          <div className="cv-head"><strong>Widgets</strong><span className="muted" style={{ fontSize: 12 }}>Show, hide &amp; reorder</span></div>
          <div className="cv-list">
            {ordered.map((id, i) => (
              <div key={id} className="cv-row">
                <label className="cv-check">
                  <input type="checkbox" checked={!prefs.hidden.includes(id)} onChange={() => toggle(id)} />
                  <span>{WIDGET_LABELS[id]}</span>
                </label>
                <span className="cv-move">
                  <button type="button" className="icon-btn" disabled={i === 0} title="Move up" onClick={() => move(id, -1)}>↑</button>
                  <button type="button" className="icon-btn" disabled={i === ordered.length - 1} title="Move down" onClick={() => move(id, 1)}>↓</button>
                </span>
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
