import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
import GridLayout, { type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Modal, Req, Spinner, StageBadge, showToast } from "../components/ui";
import { ApiError } from "../api/client";
import { Select } from "../components/Select";
import { Segmented, StatStrip, Tag } from "../components/kit";
import { initialsOf } from "../lib/avatarColor";
import { compactMoney, money, fmtDate, fmtDateLocal } from "../lib/format";
import { useStages } from "../stages";
import { CalendarGlyph } from "../components/PeriodSegmented";
import { DateField } from "../components/DateField";
import { useTheme, isLightTheme } from "../theme";
import { layoutRect } from "../lib/viewport";
import { useIsPhonePortrait } from "../lib/mobile";

// Global dashboard period (default YTD). Drives all period-scoped widgets.
type DashPeriod = "THIS_MONTH" | "LAST_MONTH" | "THIS_QUARTER" | "YTD" | "CUSTOM";
const DASH_PERIODS: readonly (readonly [DashPeriod, string])[] = [
  ["THIS_MONTH", "This month"], ["LAST_MONTH", "Last month"], ["THIS_QUARTER", "This quarter"], ["YTD", "YTD"], ["CUSTOM", "Custom"],
];

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Display name of the loaded reporting window, from the server's `periodLabel`
 * ("This Month", "Last Month", "This Quarter", "Custom", "YTD"). Calendar math
 * is in UTC, like the server's window. `year` is set when the window sits in
 * one calendar year (chart title suffix).
 */
function periodDisplay(label: string | undefined, from: string, to: string): { long: string; year: number | null } {
  const now = new Date();
  const y = now.getUTCFullYear(), mo = now.getUTCMonth();
  switch (label) {
    case "This Month": return { long: `${MONTHS_LONG[mo]} ${y}`, year: y };
    case "Last Month": {
      const ly = mo === 0 ? y - 1 : y;
      return { long: `${MONTHS_LONG[(mo + 11) % 12]} ${ly}`, year: ly };
    }
    case "This Quarter": return { long: `Q${Math.floor(mo / 3) + 1} ${y}`, year: y };
    case "Custom":
      return {
        long: from && to ? `${fmtDate(from)} – ${fmtDate(to)}` : "Custom range",
        year: from && to && from.slice(0, 4) === to.slice(0, 4) ? Number(from.slice(0, 4)) : null,
      };
    default: return { long: `Year to date, ${y}`, year: y };
  }
}

const Chevron = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);
const CheckIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

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
    /** Profit at asking price: active deals with no offer yet, if sold at our ask (optional: older API). */
    profitAtAsk?: number;
  };
  /** Contact tasks that are overdue, due today, or due within 7 days. */
  tasks?: DashTask[];
  overdue: { id: string; name: string; findBuyerByDate: string | null }[];
  stageCounts: { stage: string; count: number }[];
  upcomingFollowUps: { dealId: string; buyerName: string; dealName: string; date: string | null }[];
  recentActivity: { id: string; summary: string; createdAt: string; dealId?: string | null }[];
  topBuyers: { id: string; name: string; companyName: string; volume: number }[];
  profitByMonth: {
    month: string; isCurrent: boolean; profit: number; projected: number;
    /** Profit at asking price for the bucket's no-offer deals (optional: older API). */
    atAsk?: number;
    /** The deals behind the bar — closed in (or scheduled to close in) the bucket. */
    deals?: { id: string; name: string; stage: string; kind: "closed" | "projected" | "atAsk"; amount: number | null; profit: number; date: string }[];
  }[];
  /** Real historical series for the KPI sparklines (optional: older API). */
  trends?: { activeDealsWeekly: number[]; avgProfitPerDeal: number[]; closedWeekly: number[]; offersWeekly: number[] };
}

// Compact currency for KPI values, matching the design ($1.28M / $892K / $47.8K).
function fmtCompact(v: number): string {
  return compactMoney(v, { mDigits: 2, kDigits: (a) => (a >= 1e5 ? 0 : 1), trim: false, small: (x) => money(x) });
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

function Delta({ pct }: { pct: number | null }) {
  if (pct == null || !isFinite(pct) || Math.round(pct) === 0) return null;
  const up = pct > 0;
  const n = Math.abs(Math.round(pct)).toLocaleString("en-US");
  return (
    <span className={`dash-delta ${up ? "up" : "down"}`} aria-label={`${up ? "Up" : "Down"} ${n}%`}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={up ? "M12 19V5M6 11l6-6 6 6" : "M12 5v14M6 13l6 6 6-6"} />
      </svg>
      {n}%
    </span>
  );
}


// ---------------------------------------------------------------------------
// Layout model — a real dashboard grid (react-grid-layout): every widget has
// an exact x/y position and w/h size on a 12-column canvas. In Customize mode
// widgets drag anywhere (others move out of the way live, with animated
// transforms) and resize from their edges/corner — the fully-freeform layout
// found in premium analytics tools. Positions persist per browser.
// ---------------------------------------------------------------------------
// Widget ids are persisted in saved layouts — never rename them. "profit" is
// the Profit overview: realized hero + chart with the key-metric strip along
// its bottom edge (one card, as designed). "kpis" was that strip as its own
// widget in earlier versions and now only exists in saved v2 layouts.
type WidgetId = "profit" | "stages" | "activity" | "buyers" | "followups" | "tasks";
const WIDGET_LABELS: Record<WidgetId, string> = {
  profit: "Profit overview", stages: "Pipeline",
  activity: "Recent activity", buyers: "Top buyers", followups: "Upcoming follow-ups",
  tasks: "Tasks",
};
const ALL_WIDGETS: WidgetId[] = ["profit", "stages", "buyers", "activity", "tasks", "followups"];

const COLS = 12;
const ROW_H = 30;      // px per grid row (small unit = fine-grained heights)
const GAP = 16;
const MIN_W = 3;
const MIN_H = 4;

interface Cell { x: number; y: number; w: number; h: number }
// Default canvas = the design's: profit overview full width (12), pipeline (7)
// beside top buyers (5), then recent activity (6), tasks (3) and follow-ups (3).
// Heights are the design's card heights rounded to whole grid rows.
const DEFAULT_LAYOUT: Record<WidgetId, Cell> = {
  profit: { x: 0, y: 0, w: 12, h: 10 },
  stages: { x: 0, y: 10, w: 7, h: 6 },
  buyers: { x: 7, y: 10, w: 5, h: 6 },
  activity: { x: 0, y: 16, w: 6, h: 8 },
  tasks: { x: 6, y: 16, w: 3, h: 8 },
  followups: { x: 9, y: 16, w: 3, h: 8 },
};
/** Customize readout, e.g. "7 / 12 cols · 306px". */
const sizeLabel = (c: Cell) => `${c.w} / ${COLS} cols · ${c.h * ROW_H + (c.h - 1) * GAP}px`;

interface DashPrefs { layout: Record<WidgetId, Cell>; hidden: WidgetId[] }
const DASH_KEY = "mh-dashboard:v3";
const DASH_KEY_V2 = "mh-dashboard:v2";

// --- v2 → v3 ---------------------------------------------------------------
// v2 always wrote the layout back on load, so every browser holds one even if
// the user never arranged anything. A v2 layout that is exactly one of the
// defaults the app has shipped is therefore "never customized" and starts on
// the current default; anything else is the user's own arrangement and is
// carried over as-is (the old key is left untouched).
type V2Id = WidgetId | "kpis";
const V2_IDS: V2Id[] = ["kpis", "profit", "stages", "activity", "buyers", "followups", "tasks"];
const c4 = (x: number, y: number, w: number, h: number): Cell => ({ x, y, w, h });
const V2_DEFAULTS: Record<V2Id, Cell>[] = [
  { kpis: c4(0, 0, 12, 6), profit: c4(0, 6, 6, 9), stages: c4(6, 6, 6, 9), activity: c4(0, 15, 6, 8), buyers: c4(6, 15, 6, 8), followups: c4(0, 23, 12, 7), tasks: c4(0, 30, 12, 7) },
  { kpis: c4(0, 0, 12, 6), profit: c4(0, 6, 7, 9), stages: c4(7, 6, 5, 9), tasks: c4(0, 15, 4, 9), buyers: c4(4, 15, 4, 9), activity: c4(8, 15, 4, 9), followups: c4(0, 24, 12, 7) },
  { profit: c4(0, 0, 12, 9), kpis: c4(0, 9, 12, 4), stages: c4(0, 13, 7, 7), buyers: c4(7, 13, 5, 7), activity: c4(0, 20, 6, 9), tasks: c4(6, 20, 3, 9), followups: c4(9, 20, 3, 9) },
];
const isCell = (c: unknown): c is Cell =>
  !!c && typeof c === "object" && (["x", "y", "w", "h"] as const).every((k) => { const n = (c as Record<string, unknown>)[k]; return typeof n === "number" && isFinite(n); });
const sameCell = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function migrateV2(raw: string): DashPrefs {
  const p = JSON.parse(raw) as { layout?: Partial<Record<V2Id, Cell>>; hidden?: string[] };
  const saved: Partial<Record<V2Id, Cell>> = {};
  for (const id of V2_IDS) { const c = p.layout?.[id]; if (isCell(c)) saved[id] = { x: c.x, y: c.y, w: c.w, h: c.h }; }
  const hiddenV2 = (p.hidden ?? []).filter((id): id is V2Id => V2_IDS.includes(id as V2Id));
  // Never arranged: every saved cell sits where a shipped default put it.
  const untouched = hiddenV2.length === 0 && V2_DEFAULTS.some((def) => V2_IDS.every((id) => !saved[id] || sameCell(saved[id]!, def[id])));
  if (untouched) return { layout: { ...DEFAULT_LAYOUT }, hidden: [] };

  const layout = { ...DEFAULT_LAYOUT };
  for (const id of ALL_WIDGETS) if (saved[id]) layout[id] = saved[id]!;
  let hidden = hiddenV2.filter((id): id is WidgetId => id !== "kpis");
  // The key metrics now live inside the profit card. Where the old KPI row sat
  // flush against it (same column span), the card takes over that space; a
  // hidden profit card takes the visible KPI row's place.
  const k = saved.kpis, pr = layout.profit;
  if (k && !hiddenV2.includes("kpis")) {
    if (hidden.includes("profit")) { layout.profit = k; hidden = hidden.filter((id) => id !== "profit"); }
    else if (k.x === pr.x && k.w === pr.w && k.y === pr.y + pr.h) layout.profit = { ...pr, h: pr.h + k.h };
    else if (k.x === pr.x && k.w === pr.w && k.y + k.h === pr.y) layout.profit = { ...pr, y: k.y, h: pr.h + k.h };
  }
  return { layout, hidden };
}

function loadDashPrefs(): DashPrefs {
  try {
    const raw = localStorage.getItem(DASH_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<DashPrefs>;
      const layout = { ...DEFAULT_LAYOUT };
      for (const id of ALL_WIDGETS) {
        const c = p.layout?.[id];
        if (isCell(c)) layout[id] = { x: c.x, y: c.y, w: c.w, h: c.h };
      }
      return { layout, hidden: (p.hidden ?? []).filter((id): id is WidgetId => ALL_WIDGETS.includes(id as WidgetId)) };
    }
    const v2 = localStorage.getItem(DASH_KEY_V2);
    if (v2) return migrateV2(v2);
    // One-time migration from the v1 swap-grid prefs: carry over hidden widgets,
    // let positions start from the default canvas.
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
  // Teammates: the Tasks widget's filter/assignee lists, and matching the
  // actor at the start of an activity line.
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { api.get<{ id: string; name: string }[]>("/users").then(setUsers).catch(() => {}); }, []);
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
  // Chart view: each bucket on its own, or a running total across the window
  // (derived from the same loaded series).
  const [chartMode, setChartMode] = useState<"monthly" | "cumulative">("monthly");
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
            <div className="panel dash-note"><p className="muted" style={{ margin: 0 }}>Your role doesn't include the dashboard's business metrics. Ask an owner or admin for "View reports" access.</p></div>
          </div>
        ) : <Spinner />}
      </>
    );
  }

  // Stacked bars (design): projected sits on top of realized, and profit at
  // asking price (no-offer deals) on top of projected, so the y-scale is
  // driven by the tallest stack (the month total already shown above each
  // bar). In Cumulative view each bucket shows the running total through it.
  // The axis is DYNAMIC — its max sits just above the tallest stack in the
  // SELECTED range (rescales with the range) rather than on a fixed scale.
  let runR = 0, runP = 0, runA = 0;
  const shown = d.profitByMonth.map((m) => {
    const a = m.atAsk ?? 0;
    if (chartMode === "cumulative") { runR += m.profit; runP += m.projected; runA += a; return { r: runR, p: runP, a: runA }; }
    return { r: m.profit, p: m.projected, a };
  });
  const stackOf = (s: { r: number; p: number; a: number }) => Math.max(0, s.r) + Math.max(0, s.p) + Math.max(0, s.a);
  const maxProfit = Math.max(1, ...shown.map(stackOf));
  const { max: niceMax, ticks: axisTicks } = niceAxis(maxProfit);
  // Index of the bucket containing today (-1 when the window is in the past).
  const curIdx = d.profitByMonth.findIndex((m) => m.isCurrent);
  const nBuckets = d.profitByMonth.length;

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

  // Full-year outlook = realized profit (closed deals) + projected profit
  // (open deals); the split bar shows each one's share of that sum.
  const outlook = m.closedProfitYtd + m.projectedProfit;
  const splitOk = m.closedProfitYtd >= 0 && m.projectedProfit >= 0 && outlook > 0;
  const realizedPct = splitOk ? Math.round((m.closedProfitYtd / outlook) * 100) : 0;

  const pd = periodDisplay(m.periodLabel, customFrom, customTo);

  // Brand-new workspace: no active deals and nothing closed yet. Guide the
  // first steps instead of presenting a wall of zeros.
  const firstRun = d.metrics.activeDeals === 0 && d.metrics.closedProfitYtd === 0 && d.recentActivity.length === 0;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  // Time-of-day greeting (design): "Good evening, Adrian".
  const hour = new Date().getHours();
  const daypart = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] || "there";
  const light = isLightTheme(theme);

  // Recent activity grouped by local calendar day (newest first).
  const thisYear = new Date().getFullYear();
  const activityGroups: { key: string; label: string; rows: DashboardData["recentActivity"] }[] = [];
  for (const a of d.recentActivity.slice(0, 8)) {
    const at = new Date(a.createdAt);
    const key = at.toDateString();
    let g = activityGroups[activityGroups.length - 1];
    if (!g || g.key !== key) {
      g = {
        key, rows: [],
        label: at.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...(at.getFullYear() !== thisYear ? { year: "numeric" } : {}) }),
      };
      activityGroups.push(g);
    }
    g.rows.push(a);
  }

  // Key metrics: the strip along the bottom of the profit overview card (its
  // own 2-up tiles on phones).
  const kpiCells: { label: string; value: ReactNode; title: string }[] = [
    {
      label: "Under contract", value: fmtCompact(d.metrics.underContract ?? 0),
      title: "Total acquisition cost (Our Cost) of every active deal we're under contract with sellers for. Excludes closed and dead deals and owned mineral assets.",
    },
    {
      label: "Active deals", value: <>{d.metrics.activeDeals}<Delta pct={activeDelta} /></>,
      title: "Deals currently in the pipeline. Δ vs 8 weeks ago.",
    },
    {
      label: "Closed deals", value: <>{d.metrics.closedDealsCount}<Delta pct={closedCountDelta} /></>,
      title: "Deals moved to Closed within the selected range, by Contract Timeline Closed Date. Δ vs the previous equal-length period.",
    },
    {
      label: "Avg. profit per deal", value: <>{fmtCompact(d.metrics.avgProfitPerDeal)}<Delta pct={avgDelta} /></>,
      title: "Realized profit per closed deal in the selected range (Closed Date). Δ vs the previous equal-length period.",
    },
    {
      label: "Offers pending",
      value: <span className={d.metrics.offersPending === 0 ? "dash-zero" : undefined}>{d.metrics.offersPending}</span>,
      title: "Offers awaiting a decision.",
    },
  ];
  const stageTotal = d.stageCounts.reduce((sum, s) => sum + s.count, 0);

  // Activity line: the server sends one sentence. When it opens with a
  // teammate's name that becomes the avatar + emphasised actor, and the quoted
  // deal name links to the deal.
  const activityRow = (a: DashboardData["recentActivity"][number]) => {
    const actor = users.find((u) => u.name && a.summary.startsWith(`${u.name} `));
    const rest = actor ? a.summary.slice(actor.name.length + 1) : a.summary;
    // Trailing detail, as designed: the stage a deal moved to, or an expense's
    // amount (both read from the sentence; anything else shows as written).
    let text = rest;
    let side: ReactNode = null;
    const moved = rest.match(/^moved "[^"]+" to ([A-Za-z][A-Za-z ]*?)(?: \(.*\))?$/);
    const expense = rest.match(/^added a (\$[\d,]+(?:\.\d+)?) expense$/);
    if (moved) side = <StageBadge stage={moved[1].toUpperCase().replace(/ /g, "_")} />;
    else if (expense) { text = "added an expense"; side = <span className="dash-act-amt">{expense[1]}</span>; }
    const q = a.dealId ? text.match(/^([\s\S]*?)"([^"]+)"([\s\S]*)$/) : null;
    return (
      <div className="dash-act-row" key={a.id} title={fmtDateLocal(a.createdAt)}>
        <span className="dash-act-avatar" aria-hidden="true">
          {actor ? initialsOf(actor.name) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
          )}
        </span>
        <span className="dash-act-text">
          {actor && <><span className="dash-act-actor">{actor.name}</span>{" "}</>}
          {q ? <>{q[1]}<Link to={`/deals/${a.dealId}`} className="dash-act-link">{q[2]}</Link>{q[3]}</> : text}
        </span>
        {side}
      </div>
    );
  };

  const widgetNodes: Record<WidgetId, ReactNode> = {
    profit: (
      <>
      {phoneStack && <StatStrip className="dash-kpis-strip" min={190} cells={kpiCells} />}
      <div className="panel dash-card dash-ov">
        <div className="dash-ov-main">
          <div className="dash-ov-hero">
            <div className="dash-ov-top">
              <div className="dash-ov-label">Realized profit</div>
              <div className="dash-ov-valrow">
                <span className="dash-ov-value">{fmtCompact(m.closedProfitYtd)}</span>
                <Delta pct={closedDelta} />
              </div>
              <div className="dash-ov-period">{pd.long}</div>
            </div>
            <div className="dash-ov-bottom">
              <div className="dash-ov-rows">
                <div className="dash-ov-row" title="Accepted (else best) offer minus cost basis and closing costs across active deals with offers — the same series as the Projected bars.">
                  <span className="dash-ov-row-label">Projected profit</span>
                  <strong>{fmtCompact(m.projectedProfit)}</strong>
                </div>
                <div className="dash-ov-row" title="Active deals without an offer yet, if they sold at our asking price. Separate from realized and projected.">
                  <span className="dash-ov-row-label">Profit at asking price</span>
                  <strong>{fmtCompact(m.profitAtAsk ?? 0)}</strong>
                </div>
                <div className="dash-ov-row" title="Realized profit (closed deals) plus projected profit (open deals).">
                  <span className="dash-ov-row-label">Full-year outlook</span>
                  <strong>{fmtCompact(outlook)}</strong>
                </div>
              </div>
              <div className="dash-ov-split" aria-hidden="true">
                {splitOk ? (
                  <>
                    {m.closedProfitYtd > 0 && <span className="real" style={{ width: `${(m.closedProfitYtd / outlook) * 100}%` }} />}
                    {m.projectedProfit > 0 && <span className="proj" />}
                  </>
                ) : <span className="none" />}
              </div>
              {splitOk && (
                <div className="dash-ov-split-legend">
                  <span>{realizedPct}% realized</span>
                  <span>{100 - realizedPct}% projected</span>
                </div>
              )}
            </div>
          </div>

          <div className="dash-ov-chart">
            <div className="dash-chart-head">
              <div className="dash-chart-titles">
                <h3 className="dash-card-title">{chartMode === "cumulative" ? "Cumulative profit" : "Profit by month"}{pd.year ? `, ${pd.year}` : ""}</h3>
                <div className="dash-legend">
                  <span><span className="dash-swatch" style={{ background: "var(--success)" }} />Realized</span>
                  <span><span className="dash-swatch dash-swatch-proj" />Projected</span>
                  <span><span className="dash-swatch dash-swatch-atask" />At asking</span>
                </div>
              </div>
              <Segmented className="dash-mode-seg" ariaLabel="Chart view" value={chartMode}
                onChange={(v) => { setChartMode(v); setProfitHover(null); }}
                options={[{ value: "monthly", label: "Monthly" }, { value: "cumulative", label: "Cumulative" }]} />
            </div>
            {/* The chart spans the SELECTED reporting period (every month of it,
                yearly buckets for very long custom ranges). Buckets with no
                realized or projected profit show a faint zero stub instead of
                vanishing, so the x-axis spacing stays stable. Gridlines follow
                the $-labeled axis ticks; hovering shows the full breakdown;
                clicking a month opens a non-blocking details panel. */}
            <div className="dash-chart">
              <div className="dash-chart-body">
                <div className="dash-chart-axis" aria-hidden="true">
                  {axisTicks.map((tick) => <span key={tick} style={{ bottom: `${(tick / niceMax) * 100}%` }}>{fmtCompact(tick).replace(/\.0+(?=[KM]$)/, "")}</span>)}
                </div>
                <div className="dash-chart-plot">
                  {axisTicks.map((tick) => (
                    <div key={tick} className={`dash-chart-grid ${tick === 0 ? "base" : ""}`} style={{ bottom: `${(tick / niceMax) * 100}%` }} />
                  ))}
                  {curIdx >= 0 && (
                    <>
                      <div className="dash-chart-today" style={{ left: `${(curIdx / nBuckets) * 100}%` }} />
                      <div className="dash-chart-today-label" style={{ left: `${(curIdx / nBuckets) * 100}%` }}>Today</div>
                    </>
                  )}
                  {d.profitByMonth.every((b) => b.profit === 0 && b.projected === 0 && !b.atAsk) && (
                    <p className="dash-chart-empty">
                      No closed, projected or at-asking profit in this period — bars fill in as deals close (with a Closed Date), get an offer, or carry an ask and a closing date.
                    </p>
                  )}
                  <div className="dash-chart-cols">
                    {d.profitByMonth.map((b, i) => {
                      const s = shown[i];
                      const r = Math.max(0, s.r), p = Math.max(0, s.p), a = Math.max(0, s.a);
                      const stackPct = ((r + p + a) / niceMax) * 100;
                      const own = !(b.profit === 0 && b.projected === 0 && !b.atAsk);
                      const clickable = (b.deals?.length ?? 0) > 0;
                      const hovered = profitHover === i;
                      const frac = (i + 0.5) / nBuckets;
                      return (
                        <div
                          className={`dash-chart-col ${hovered ? "hover" : ""} ${clickable ? "clickable" : ""}`} key={b.month}
                          role={clickable ? "button" : undefined} tabIndex={clickable ? 0 : undefined}
                          aria-label={clickable ? `${b.month}: view ${b.deals!.length} deal${b.deals!.length === 1 ? "" : "s"}` : undefined}
                          onMouseEnter={() => setProfitHover(i)} onMouseLeave={() => setProfitHover((h) => (h === i ? null : h))}
                          onClick={clickable ? () => setProfitDrill(i) : undefined}
                          onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setProfitDrill(i); } } : undefined}
                        >
                          {/* The bucket's total (realized + projected + at
                              asking) floats above the stack; hidden while its
                              tooltip shows. */}
                          {own && !hovered && (
                            <span className={`dash-chart-val ${s.r > 0 ? "" : "dim"}`} style={{ bottom: `${stackPct}%` }}>{fmtCompact(s.r + s.p + s.a)}</span>
                          )}
                          {a > 0 && <div className="dash-chart-bar atask" style={{ height: `${(a / niceMax) * 100}%` }} />}
                          {p > 0 && <div className={`dash-chart-bar proj ${a > 0 ? "under" : ""}`} style={{ height: `${(p / niceMax) * 100}%` }} />}
                          {r > 0 && <div className={`dash-chart-bar real ${p + a > 0 ? "under" : ""}`} style={{ height: `${(r / niceMax) * 100}%` }} />}
                          {r + p + a === 0 && <div className="dash-chart-bar zero" />}
                          {hovered && (
                            <div className="dash-chart-tip" style={{
                              bottom: `calc(${Math.min(stackPct, 40)}% + 12px)`,
                              transform: `translateX(${frac < 0.17 ? "-25%" : frac > 0.83 ? "-80%" : "-50%"})`,
                            }}>
                              <div className="dash-chart-tip-title">{chartMode === "cumulative" ? `Through ${b.month}` : b.month}</div>
                              <div className="dash-chart-tip-row"><span><span className="dash-swatch" style={{ background: "var(--success)" }} />Realized</span><strong>{money(s.r)}</strong></div>
                              {s.p > 0 && <div className="dash-chart-tip-row"><span><span className="dash-swatch dash-swatch-proj" />Projected</span><strong>{money(s.p)}</strong></div>}
                              {s.a !== 0 && <div className="dash-chart-tip-row"><span><span className="dash-swatch dash-swatch-atask" />At asking</span><strong>{money(s.a)}</strong></div>}
                              <div className="dash-chart-tip-row total"><span>Total</span><strong>{money(s.r + s.p + s.a)}</strong></div>
                              {clickable && <div className="dash-chart-tip-hint">Click for {b.deals!.length} deal{b.deals!.length === 1 ? "" : "s"}</div>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="dash-chart-x">
                {d.profitByMonth.map((b) => <span key={b.month} className={b.isCurrent ? "current" : undefined}>{b.month}</span>)}
              </div>
            </div>
          </div>
        </div>
        {!phoneStack && (
          <div className="dash-ov-kpis">
            {kpiCells.map((k) => (
              <div className="dash-ov-kpi" key={k.label} title={k.title}>
                <div className="dash-ov-kpi-label">{k.label}</div>
                <div className="dash-ov-kpi-value">{k.value}</div>
              </div>
            ))}
          </div>
        )}
        {profitDrill != null && d.profitByMonth[profitDrill] && (() => {
          const m = d.profitByMonth[profitDrill];
          const closed = (m.deals ?? []).filter((x) => x.kind === "closed");
          const projected = (m.deals ?? []).filter((x) => x.kind === "projected");
          const atAsking = (m.deals ?? []).filter((x) => x.kind === "atAsk");
          const atAsk = m.atAsk ?? 0;
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
                    <span className={`drill-profit ${x.profit >= 0 ? "pos" : "neg"}`}>{money(x.profit)}</span>
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
                  <h3 className="drill-title">{m.month} — profit breakdown</h3>
                  <div className="drill-sub">{total} deal{total === 1 ? "" : "s"} this month</div>
                </div>
                <button className="icon-btn drill-x" onClick={() => setProfitDrill(null)} aria-label="Close"><X size={16} /></button>
              </div>
              <div className="drill-summary">
                <div className="drill-stat">
                  <span className="drill-stat-label"><span className="dash-swatch" style={{ background: "var(--success)" }} /> Realized</span>
                  <strong>{money(m.profit)}</strong>
                </div>
                {m.projected > 0 && (
                  <div className="drill-stat">
                    <span className="drill-stat-label"><span className="dash-swatch dash-swatch-proj" /> Projected</span>
                    <strong>{money(m.projected)}</strong>
                  </div>
                )}
                {atAsk !== 0 && (
                  <div className="drill-stat">
                    <span className="drill-stat-label"><span className="dash-swatch dash-swatch-atask" /> At asking</span>
                    <strong>{money(atAsk)}</strong>
                  </div>
                )}
                <div className="drill-stat">
                  <span className="drill-stat-label">Total</span>
                  <strong>{money(m.profit + m.projected + atAsk)}</strong>
                </div>
              </div>
              <div className="drill-body">
                {group("Closed this month", "Realized — keyed on the Contract Timeline's Closed Date; profit uses the accepted offer.", closed)}
                {group("Scheduled to close", "Projected — active deals with an offer whose anticipated closing lands in this month.", projected)}
                {group("At asking price", "Active deals with no offer yet — profit if sold at the asking price", atAsking)}
              </div>
            </aside>,
            document.body
          );
        })()}
      </div>
      </>
    ),
    stages: (
      <div className="panel dash-card">
        <div className="dash-card-head">
          <div className="dash-card-titles">
            <h3 className="dash-card-title">Pipeline</h3>
            <span className="dash-card-sub">{d.metrics.activeDeals} active deal{d.metrics.activeDeals === 1 ? "" : "s"}</span>
          </div>
          <Link to="/pipeline" className="dash-viewlink">View pipeline <Chevron /></Link>
        </div>
        {d.stageCounts.every((s) => s.count === 0) ? <p className="dash-empty">No active deals.</p> : (
          <>
            <div className="dash-pipe-bar" aria-hidden="true">
              {d.stageCounts.filter((s) => s.count > 0).map((s) => (
                <span key={s.stage} style={{ flex: s.count, background: stageColorOf(s.stage) }} />
              ))}
            </div>
            <div className="dash-pipe-grid">
              {d.stageCounts.map((s) => (
                <Link className="dash-pipe-cell" key={s.stage} to={`/pipeline?stage=${s.stage}`}>
                  <span className="dash-pipe-name">
                    <span className="dash-pipe-dot" style={s.count > 0 ? { background: stageColorOf(s.stage) } : undefined} />
                    <span className="dash-pipe-label">{stageLabel(s.stage)}</span>
                  </span>
                  <span className="dash-pipe-nums">
                    <span className={`dash-pipe-count ${s.count > 0 ? "" : "zero"}`}>{s.count}</span>
                    <span className="dash-pipe-share">{s.count > 0 ? `${Math.round((s.count / stageTotal) * 100)}%` : "—"}</span>
                  </span>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    ),
    activity: (
      <div className="panel dash-card">
        <div className="dash-card-head">
          <h3 className="dash-card-title">Recent activity</h3>
        </div>
        {d.recentActivity.length === 0 ? <p className="dash-empty">Nothing yet.</p> : activityGroups.map((g) => (
          <div className="dash-act-group" key={g.key}>
            <div className="dash-act-day">{g.label}</div>
            {g.rows.map(activityRow)}
          </div>
        ))}
      </div>
    ),
    buyers: (
      <div className="panel dash-card">
        <div className="dash-card-head">
          <div className="dash-card-titles">
            <h3 className="dash-card-title">Top buyers</h3>
            <span className="dash-card-sub">{m.periodLabel === "YTD" || !m.periodLabel ? "Year to date" : pd.long}</span>
          </div>
          <Link to="/buyers" className="dash-viewlink">View buyers <Chevron /></Link>
        </div>
        {d.topBuyers.length === 0 ? <p className="dash-empty">No closed volume yet.</p> : (() => {
          const topVol = Math.max(1, ...d.topBuyers.map((b) => b.volume));
          const totalVol = Math.max(1, d.topBuyers.reduce((s, b) => s + b.volume, 0));
          const BAR_COLORS = ["#3b82f6", "#8b5cf6", "#06b6d4", "#f59e0b", "#22c55e"];
          return d.topBuyers.map((b, i) => (
            <Link to={`/buyers/${b.id}`} className="dash-tb" key={b.id}>
              <span className="dash-tb-rank">{i + 1}</span>
              <span className="dash-tb-main">
                <span className="dash-tb-name">{b.companyName || b.name}</span>
                <span className="dash-tb-track"><span style={{ width: `${(b.volume / topVol) * 100}%`, background: BAR_COLORS[i % BAR_COLORS.length] }} /></span>
              </span>
              <span className="dash-tb-amt">{fmtCompact(b.volume)}</span>
              <span className="dash-tb-share">{Math.round((b.volume / totalVol) * 100)}%</span>
            </Link>
          ));
        })()}
      </div>
    ),
    followups: (
      <div className="panel dash-card">
        <div className="dash-card-head dash-fu-head">
          <h3 className="dash-card-title">Upcoming follow-ups</h3>
          <Link to="/contacts" className="dash-viewlink">Contacts →</Link>
        </div>
        {d.upcomingFollowUps.length === 0 ? (
          <div className="dash-empty-row">
            <span className="dash-empty-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2" /></svg>
            </span>
            <span className="dash-empty-line">No follow-ups scheduled.</span>
          </div>
        ) : d.upcomingFollowUps.map((f, i) => (
          <div className="dash-fu-row" key={i}>
            <span className="dash-fu-text"><span className="dash-fu-buyer">{f.buyerName}</span> · <Link to={`/deals/${f.dealId}`}>{f.dealName}</Link></span>
            <span className="dash-fu-date">{fmtDate(f.date)}</span>
          </div>
        ))}
      </div>
    ),
    tasks: <TasksWidget initial={d.tasks ?? []} users={users} refreshKey={taskRefresh} onOpenTask={openTask} onChanged={() => setTaskRefresh((n) => n + 1)} />,
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
  const restoreDefault = () => {
    setPrefs({ layout: { ...DEFAULT_LAYOUT }, hidden: [] });
    showToast("Default layout restored");
  };

  // Customize chrome above each widget: grip + name + size readout, and Hide.
  // Phones only hide/show (no arranging), so they get the name and Hide only.
  const czBar = (id: WidgetId, arrange: boolean) => (
    <div className="dash-cz-bar">
      <span className="dash-cz-name">
        {arrange && (
          <svg className="dash-cz-handle" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
          </svg>
        )}
        <span className="dash-cz-title">{WIDGET_LABELS[id]}</span>
        {arrange && <span className="dash-cz-size">{sizeLabel(prefs.layout[id])}</span>}
      </span>
      <button type="button" className="dash-cz-btn" onClick={() => hideWidget(id)} title="Hide widget">Hide</button>
    </div>
  );

  return (
    <div className="page dash-page">
      {taskModal}
      <div className="page-header dash-header">
        <div className="dash-greet">
          <div className="dash-eyebrow">{today}</div>
          <h1 className="dash-title">Good {daypart}, {firstName}</h1>
        </div>
        <div className="dash-actions">
          <Segmented accent className="dash-period" ariaLabel="Reporting period" value={period} onChange={setPeriod}
            options={DASH_PERIODS.map(([v, label]) => ({ value: v, label: v === "CUSTOM" ? <><CalendarGlyph size={13} />{label}</> : label }))} />
          {period === "CUSTOM" && (
            <div className="dash-range">
              <span>From</span>
              <div className="dash-range-field"><DateField value={customFrom} onChange={setCustomFrom} ariaLabel="Custom range from" placeholder="From" /></div>
              <span>to</span>
              <div className="dash-range-field"><DateField value={customTo} onChange={setCustomTo} ariaLabel="Custom range to" placeholder="To" /></div>
            </div>
          )}
          <button type="button" className={`dash-cz-toggle ${customizing ? "active" : ""}`} onClick={() => setCustomizing((c) => !c)} title="Customize dashboard layout">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" /></svg>
            <span>{customizing ? "Done" : "Customize"}</span>
          </button>
          <button type="button" className="dash-icon-btn" title={light ? "Switch to dark mode" : "Switch to light mode"} aria-label={light ? "Switch to dark mode" : "Switch to light mode"} onClick={toggleTheme}>
            {light ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            )}
          </button>
          {/* ?new=1 opens the New Deal modal directly (design's header CTA). */}
          <Link to="/deals/active?new=1" className="dash-newdeal">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            New deal
          </Link>
        </div>
      </div>

      {firstRun && (
        <div className="panel dash-card dash-start">
          <h3 className="dash-card-title">Get started</h3>
          <p className="dash-start-text">
            Welcome to Mineral Hub! These metrics fill in as you work — here's where most teams begin:
          </p>
          <div className="dash-start-links">
            {/* ?new=1 opens the New Deal modal immediately — one click, not two. */}
            <Link to="/deals/active?new=1" className="primary dash-start-link">1 · Create your first deal</Link>
            <Link to="/buyers" className="dash-start-link">2 · Add or import buyers</Link>
            <Link to="/valuation" className="dash-start-link">3 · Import well production data</Link>
          </div>
        </div>
      )}

      {customizing && (
        <div className="dash-cz-banner">
          <div className="dash-cz-banner-main">
            <span className="dash-cz-banner-text">
              <strong>Customizing dashboard.</strong>{" "}
              {phoneStack
                ? "Hide or show widgets here; arrange and resize them on a larger screen."
                : "Drag a widget by its bar to move it, drag the corner to resize, or hide it."}{" "}
              Changes save automatically.
            </span>
            {hiddenIds.length > 0 && (
              <div className="dash-cz-hidden">
                <span>Hidden:</span>
                {hiddenIds.map((id) => (
                  <button key={id} type="button" className="dash-cz-chip" onClick={() => showWidget(id)}>+ {WIDGET_LABELS[id]}</button>
                ))}
              </div>
            )}
          </div>
          <div className="dash-cz-banner-actions">
            <button type="button" className="small" disabled={isDefaultLayout} onClick={restoreDefault}>Restore default</button>
            <button type="button" className="small primary" onClick={() => setCustomizing(false)}>Done</button>
          </div>
        </div>
      )}

      {visibleIds.length === 0 && !customizing ? (
        <div className="panel dash-note"><p className="muted" style={{ margin: 0 }}>All widgets are hidden. Use <strong>Customize</strong> to bring them back.</p></div>
      ) : phoneStack ? (
        <div className={`dash-stack ${customizing ? "customizing" : ""}`}>
          {stackIds.map((id) => (
            <div key={id} className={`dash-w dash-w-${id} ${customizing ? "cz" : ""}`}>
              {customizing && czBar(id, false)}
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
            <div key={id} className={`dash-w dash-w-${id} ${customizing ? "cz" : ""}`}>
              {customizing && czBar(id, true)}
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
const TASK_PRIORITY_META: Record<string, { label: string; tone: "danger" | "warn" | "neutral"; dot: string }> = {
  HIGH: { label: "High", tone: "danger", dot: "var(--danger)" },
  MEDIUM: { label: "Medium", tone: "warn", dot: "var(--warn)" },
  LOW: { label: "Low", tone: "neutral", dot: "var(--ink-3)" },
};

/**
 * Whose tasks the widget lists: "me" (default — My Tasks), "all" users, or one
 * user's id. The list refetches as soon as the selection changes. Tasks can be
 * created here (for yourself or a teammate) and completed in place.
 */
function TasksWidget({ initial, users, refreshKey, onOpenTask, onChanged }: {
  initial: DashTask[]; users: { id: string; name: string }[]; refreshKey: number; onOpenTask: (id: string) => void; onChanged: () => void;
}) {
  const { user } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [whose, setWhose] = useState("me");
  const [tasks, setTasks] = useState<DashTask[]>(initial);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
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
    <div className="panel dash-card dash-tasks">
      <div className="dash-card-head dash-tasks-head">
        <div className="dash-card-titles">
          <h3 className="dash-card-title">Tasks</h3>
          {tasks.length > 0 && <Tag tone="warn">{tasks.length} due</Tag>}
        </div>
        <div className="dash-tasks-tools">
          <span className="dash-task-filter">
            <Select value={whose} onChange={(v) => setWhose(v || "me")} options={userOptions} searchable={userOptions.length > 8}
              width={116} ariaLabel="Show tasks for" />
          </span>
          <button type="button" className="dash-task-add" onClick={() => setCreating(true)} title="Create a task for yourself or a teammate" aria-label="New task">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      </div>
      {tasks.length === 0 ? (
        <div className="dash-empty-row">
          <span className="dash-empty-icon"><CheckIcon /></span>
          <span className="dash-empty-text">
            <strong>{loading ? "Loading tasks…" : whose === "me" ? "You're all caught up" : "All caught up"}</strong>
            {!loading && <span>{whose === "me" ? "You have no overdue or upcoming tasks" : whose === "all" ? "No overdue or upcoming tasks for anyone" : "No overdue or upcoming tasks for this user"}</span>}
          </span>
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
            {t.details && <span className="dash-task-sub">{t.details}</span>}
            {meta && <span className="dash-task-meta">{meta}</span>}
          </>
        );
        return (
          <div className="dash-trow" key={t.id}>
            {t.canComplete ? (
              <input type="checkbox" className="dash-tcheck" checked={false} disabled={busy === t.id} onChange={() => void complete(t)}
                title="Mark complete" aria-label={`Complete task: ${t.title}`} />
            ) : <span className="dash-tcheck-ph" aria-hidden="true" />}
            {t.contactId ? (
              <Link to={`/contacts/${t.contactId}?task=${t.id}`} className="dash-tmain" title="Open this task on the contact's workspace">{body}</Link>
            ) : (
              <button type="button" className="dash-tmain" onClick={() => onOpenTask(t.id)} title="Open this task">{body}</button>
            )}
            <span className="dash-tside">
              <Tag tone={pr.tone}>{pr.label}</Tag>
              <span className={`dash-task-due ${overdue ? "overdue" : dueToday ? "today" : ""}`}>
                {dayKey == null ? "—" : overdue ? `Overdue · ${fmtDate(t.dueDate!)}` : dueToday ? "Due today" : `Due ${fmtDate(t.dueDate!)}`}
              </span>
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
    <Modal title="New task" subtitle={<>For you or a teammate. Assigned teammates are notified.</>} onClose={onClose}
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
        <textarea rows={3} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Anything the assignee should know" />
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
        <Segmented accent className="dash-pri-seg" ariaLabel="Priority" value={priority} onChange={setPriority}
          options={PRIORITY_CHOICES.map((p) => ({ value: p.key, label: p.label, dot: TASK_PRIORITY_META[p.key].dot }))} />
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
            <div><div className="ddx-label">Priority</div><div className="ddx-val"><Tag tone={pr!.tone}>{pr!.label}</Tag></div></div>
            <div><div className="ddx-label">Assigned to</div><div className="ddx-val">{task.assignedTo?.name ?? "—"}</div></div>
            <div><div className="ddx-label">Created by</div><div className="ddx-val">{task.createdBy?.name ?? "—"}{task.createdAt ? ` · ${fmtDateLocal(task.createdAt)}` : ""}</div></div>
            {task.contactName && <div><div className="ddx-label">Contact</div><div className="ddx-val">{task.contactName}</div></div>}
          </div>
        </div>
      )}
    </Modal>
  );
}
