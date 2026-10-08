import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { Spinner, showToast, ChipList } from "../components/ui";
import { Select } from "../components/Select";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { Segmented } from "../components/kit";
import { Toggle } from "../components/Toggle";
import { dealSearchHaystack } from "../lib/dealSearch";
import { NewDealModal } from "../components/NewDealModal";
import { StageChangeModal } from "../components/StageChangeModal";
import { money, num, acres, fmtDate, daysBetween } from "../lib/format";
import { roundTo, sumMoney } from "../lib/money";
import { useAuth } from "../auth/AuthContext";
import { useStages, stageColor, isOpportunityPipeline, type PipelineInfo } from "../stages";
import { PipelineSettingsModal } from "../components/PipelineSettingsModal";
import { OpportunityBoard } from "../components/OpportunityBoard";
import { useBoardSync } from "../lib/useBoardSync";
import type { DealSummary, Stage } from "../types";

// The Pipeline shows only ACTIVE-lifecycle stages as columns. Closed and Dead
// remain valid workflow stages but act as transition points, not columns: the
// TRANSITIONS targets below accept drops (and Move Stage offers them), always
// behind a confirmation, after which the deal leaves the board for the Closed
// Deals / Archived Deals subpage.
const TRANSITIONS: { stage: Stage; label: string; hint: string }[] = [
  { stage: "CLOSED", label: "Closed", hint: "Drag a deal here to move it to Closed Deals" },
  { stage: "DEAD", label: "Dead", hint: "Drag a deal here to move it to Archived Deals" },
];

/** Stage-change response: the deal plus a short-lived token that undoes the move. */
type StageMoved = DealSummary & { undoToken?: string | null };

/** Fold a stage-change response into a board card. The response is the deal's
 *  detail shape (no package rollups / asset counts), so only what a move
 *  changes is taken from it; the rest of the card stays as listed. */
function withSavedStage(card: DealSummary, saved: DealSummary): DealSummary {
  return {
    ...card,
    stage: saved.stage,
    daysInStage: saved.daysInStage,
    isOverdue: saved.isOverdue,
    closedDate: saved.closedDate,
    publishedToPortal: saved.publishedToPortal,
    selectedBuyer: saved.selectedBuyer,
    selectedOfferId: saved.selectedOfferId,
  };
}

const apiErrorText = (err: unknown, fallback: string) => (err instanceof ApiError && err.message ? err.message : fallback);

// Distance (px) the pointer must travel before a press becomes a drag — below it
// the gesture is treated as a click (navigate to the deal).
const DRAG_THRESHOLD = 5;
// Touch: a card only picks up after a press-and-hold, so swiping across cards
// still scrolls the board and its columns. Moving further than the slop before
// the hold completes is treated as a scroll.
const TOUCH_HOLD_MS = 350;
const TOUCH_SLOP = 10;
// A find-buyer date this many days out (or fewer) shows an "In Nd" chip.
const DUE_SOON_DAYS = 7;


interface DragState { id: string; w: number; offX: number; offY: number; moved: boolean }

// ---------------------------------------------------------------------------
// Customize View — the buyer tailors what deal cards show + how dense they are.
// Persisted locally (per user/browser) like the rest of the app's view prefs.
// ---------------------------------------------------------------------------
type CardField = "location" | "nra" | "nma" | "priority" | "profit" | "ourPrice" | "buyerPrice" | "days" | "buyer" | "dates";
type CardSort = "priority" | "days" | "profit" | "nma" | "ourPrice" | "buyerPrice" | "name";
/** Which figure each column header totals. */
type ColumnTotal = "profit" | "ourPrice" | "buyerPrice" | "nra";
interface PipelinePrefs {
  density: "comfortable" | "compact"; fields: Record<CardField, boolean>; sort: CardSort;
  /** Show each stage's Under Contract total (acquisition cost of its deals) in the column header. */
  underContract: boolean;
  /** Column header total (added later; loadPrefs fills it in for older saved views). */
  total: ColumnTotal;
}
const CARD_FIELDS: [CardField, string][] = [
  ["location", "Location"], ["nra", "NRA"], ["nma", "NMA"], ["priority", "Priority"], ["profit", "Est. profit"],
  ["ourPrice", "Our price"], ["buyerPrice", "Buyer price"],
  ["days", "Days in stage"], ["buyer", "Selected buyer"], ["dates", "Key dates"],
];
// NMA / Our price / Buyer purchase price are opt-in so existing boards keep
// their current look (loadPrefs merges these defaults into saved prefs).
const DEFAULT_PREFS: PipelinePrefs = {
  density: "comfortable",
  fields: { location: true, nra: true, nma: false, priority: true, profit: true, ourPrice: false, buyerPrice: false, days: true, buyer: true, dates: true },
  sort: "priority",
  underContract: false,
  total: "profit",
};
const PREFS_KEY = "mh-pipeline-view:v1";
function loadPrefs(): PipelinePrefs {
  try { const raw = localStorage.getItem(PREFS_KEY); if (raw) { const p = JSON.parse(raw) as PipelinePrefs; return { ...DEFAULT_PREFS, ...p, fields: { ...DEFAULT_PREFS.fields, ...(p.fields ?? {}) } }; } } catch { /* ignore */ }
  return DEFAULT_PREFS;
}
// ---------------------------------------------------------------------------
// Filters — narrow the board to specific opportunities using existing deal
// attributes. Filtering never changes the pipeline structure: every stage
// column stays in place, only the cards inside are narrowed.
// ---------------------------------------------------------------------------
interface PipelineFilterState {
  q: string;
  priority: "" | "HIGH" | "MEDIUM" | "LOW";
  states: string[];
  counties: string[];
  buyerId: string;
  assigneeId: string;
  overdueOnly: boolean;
  // Acreage / price ranges (inclusive); empty string = unbounded.
  nraMin: string; nraMax: string;
  nmaMin: string; nmaMax: string;
  ourMin: string; ourMax: string;
  buyerMin: string; buyerMax: string;
}
const EMPTY_FILTERS: PipelineFilterState = {
  q: "", priority: "", states: [], counties: [], buyerId: "", assigneeId: "", overdueOnly: false,
  nraMin: "", nraMax: "", nmaMin: "", nmaMax: "", ourMin: "", ourMax: "", buyerMin: "", buyerMax: "",
};
// Package rollups (agg*) represent the card the user sees — display, sort, and filter on those.
const cardNra = (d: DealSummary) => d.aggNra ?? d.nra;
const cardNma = (d: DealSummary) => d.aggAcreageNma ?? d.acreageNma;
const cardOur = (d: DealSummary) => d.aggOurPrice ?? d.ourPrice;
const cardBuyer = (d: DealSummary) => d.buyerPurchasePrice ?? null;
const bound = (s: string): number | null => { const n = Number(s); return s.trim() !== "" && isFinite(n) ? n : null; };
/** Inclusive range test; deals without the metric are excluded once a bound is set. */
function inRange(v: number | null | undefined, min: number | null, max: number | null): boolean {
  if (min === null && max === null) return true;
  if (v == null) return false;
  return (min === null || v >= min) && (max === null || v <= max);
}
function activeFilterCount(f: PipelineFilterState): number {
  return (f.q.trim() ? 1 : 0) + (f.priority ? 1 : 0) + (f.states.length ? 1 : 0) +
    (f.counties.length ? 1 : 0) + (f.buyerId ? 1 : 0) + (f.assigneeId ? 1 : 0) + (f.overdueOnly ? 1 : 0) +
    (bound(f.nraMin) !== null || bound(f.nraMax) !== null ? 1 : 0) +
    (bound(f.nmaMin) !== null || bound(f.nmaMax) !== null ? 1 : 0) +
    (bound(f.ourMin) !== null || bound(f.ourMax) !== null ? 1 : 0) +
    (bound(f.buyerMin) !== null || bound(f.buyerMax) !== null ? 1 : 0);
}
function applyPipelineFilters(rows: DealSummary[], f: PipelineFilterState): DealSummary[] {
  const needle = f.q.trim().toLowerCase();
  return rows.filter((d) =>
    (!needle || dealSearchHaystack(d).includes(needle)) &&
    (!f.priority || d.priority === f.priority) &&
    (!f.states.length || d.states.some((s) => f.states.includes(s)) || (d.state != null && f.states.includes(d.state))) &&
    (!f.counties.length || d.counties.some((c) => f.counties.includes(c))) &&
    (!f.buyerId || d.selectedBuyer?.id === f.buyerId) &&
    (!f.assigneeId || d.assignees.some((a) => a.id === f.assigneeId) || d.relationshipOwner?.id === f.assigneeId) &&
    (!f.overdueOnly || d.isOverdue) &&
    inRange(cardNra(d), bound(f.nraMin), bound(f.nraMax)) &&
    inRange(cardNma(d), bound(f.nmaMin), bound(f.nmaMax)) &&
    inRange(cardOur(d), bound(f.ourMin), bound(f.ourMax)) &&
    inRange(cardBuyer(d), bound(f.buyerMin), bound(f.buyerMax)));
}

/** Filter option lists — drawn from the deals actually on the board. */
function filterOptions(deals: DealSummary[]) {
  const states = [...new Set(deals.flatMap((d) => [...d.states, ...(d.state ? [d.state] : [])]))].sort();
  const counties = [...new Set(deals.flatMap((d) => d.counties))].sort();
  const buyers = [...new Map(deals.flatMap((d) => (d.selectedBuyer ? [[d.selectedBuyer.id, d.selectedBuyer.name] as const] : []))).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const people = [...new Map(deals.flatMap((d) => [
    ...d.assignees.map((a) => [a.id, a.name] as const),
    ...(d.relationshipOwner ? [[d.relationshipOwner.id, d.relationshipOwner.name] as const] : []),
  ])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return { states, counties, buyers, people };
}

const PRIORITY_LABEL: Record<string, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };

/** One removable tag per active filter (same dimensions activeFilterCount counts). */
function filterTags(f: PipelineFilterState, deals: DealSummary[]): { key: string; label: string; clear: Partial<PipelineFilterState> }[] {
  const { buyers, people } = filterOptions(deals);
  const range = (name: string, lo: string, hi: string, fmt: (n: number) => string) => {
    const a = bound(lo), b = bound(hi);
    if (a !== null && b !== null) return `${name} ${fmt(a)}–${fmt(b)}`;
    if (a !== null) return `${name} ≥ ${fmt(a)}`;
    if (b !== null) return `${name} ≤ ${fmt(b)}`;
    return null;
  };
  const tags: { key: string; label: string | null; clear: Partial<PipelineFilterState> }[] = [
    { key: "q", label: f.q.trim() ? `“${f.q.trim()}”` : null, clear: { q: "" } },
    { key: "priority", label: f.priority ? `Priority: ${PRIORITY_LABEL[f.priority]}` : null, clear: { priority: "" } },
    { key: "states", label: f.states.length ? `State: ${f.states.join(", ")}` : null, clear: { states: [] } },
    { key: "counties", label: f.counties.length ? `County: ${f.counties.join(", ")}` : null, clear: { counties: [] } },
    { key: "buyer", label: f.buyerId ? `Buyer: ${buyers.find(([id]) => id === f.buyerId)?.[1] ?? "Selected buyer"}` : null, clear: { buyerId: "" } },
    { key: "team", label: f.assigneeId ? `Team member: ${people.find(([id]) => id === f.assigneeId)?.[1] ?? "Selected"}` : null, clear: { assigneeId: "" } },
    { key: "nra", label: range("NRA", f.nraMin, f.nraMax, (n) => num(n)), clear: { nraMin: "", nraMax: "" } },
    { key: "nma", label: range("NMA", f.nmaMin, f.nmaMax, (n) => num(n)), clear: { nmaMin: "", nmaMax: "" } },
    { key: "our", label: range("Our price", f.ourMin, f.ourMax, (n) => money(n)), clear: { ourMin: "", ourMax: "" } },
    { key: "buyerPrice", label: range("Buyer price", f.buyerMin, f.buyerMax, (n) => money(n)), clear: { buyerMin: "", buyerMax: "" } },
    { key: "overdue", label: f.overdueOnly ? "Overdue only" : null, clear: { overdueOnly: false } },
  ];
  return tags.filter((t): t is { key: string; label: string; clear: Partial<PipelineFilterState> } => t.label !== null);
}

const PRIORITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
/** Largest first; deals without the value sink to the bottom. */
const byDesc = (pick: (d: DealSummary) => number | null | undefined) => (a: DealSummary, b: DealSummary) => {
  const x = pick(a), y = pick(b);
  if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
  return y - x;
};
function sortDeals(rows: DealSummary[], sort: CardSort): DealSummary[] {
  const cmp: Record<CardSort, (a: DealSummary, b: DealSummary) => number> = {
    priority: (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || b.daysInStage - a.daysInStage,
    days: (a, b) => b.daysInStage - a.daysInStage,
    profit: (a, b) => (b.profitEst ?? 0) - (a.profitEst ?? 0),
    nma: byDesc(cardNma),
    ourPrice: byDesc(cardOur),
    buyerPrice: byDesc(cardBuyer),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return [...rows].sort(cmp[sort]);
}

/** Column header totals: the label shown beside the figure, and its sum. */
const COLUMN_TOTALS: Record<ColumnTotal, { option: string; label: string; sum: (rows: DealSummary[]) => number; fmt: (n: number) => string }> = {
  profit: { option: "Est. profit", label: "est. profit", sum: (rows) => sumMoney(rows.map((d) => d.profitEst)), fmt: (n) => money(n) },
  // Our price = what we owe sellers (owned assets for sale have no seller contract).
  ourPrice: { option: "Our price", label: "our price", sum: (rows) => sumMoney(rows.filter((d) => d.recordType !== "OWNED_ASSET").map(cardOur)), fmt: (n) => money(n) },
  buyerPrice: { option: "Buyer price", label: "buyer price", sum: (rows) => sumMoney(rows.map(cardBuyer)), fmt: (n) => money(n) },
  nra: { option: "NRA", label: "NRA", sum: (rows) => roundTo(rows.reduce((s, d) => s + (cardNra(d) ?? 0), 0), 4), fmt: (n) => acres(n) },
};

/** Status chip for the find-buyer date. "Overdue" follows the server's rule
 *  (deal.isOverdue: no selected buyer and the date has passed). */
function dueStatus(d: DealSummary): { text: string; tone: "danger" | "warn" | "neutral" } | null {
  const days = daysBetween(d.findBuyerByDate);
  if (days == null) return null;
  if (d.isOverdue) return { text: days < 0 ? `Overdue ${-days}d` : "Overdue", tone: "danger" };
  if (d.selectedBuyer) return null;
  if (days === 0) return { text: "Due today", tone: "warn" };
  if (days > 0 && days <= DUE_SOON_DAYS) return { text: `In ${days}d`, tone: "neutral" };
  return null;
}

// --- Icons (inline, stroke = currentColor) ---------------------------------
const Svg = ({ size = 14, sw = 1.7, children }: { size?: number; sw?: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const ChevronIcon = () => <Svg sw={2}><path d="M6 9l6 6 6-6" /></Svg>;
const CheckIcon = ({ size = 13 }: { size?: number }) => <Svg size={size} sw={2.8}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
const CloseIcon = ({ size = 10, sw = 2.6 }: { size?: number; sw?: number }) => <Svg size={size} sw={sw}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
const SlidersIcon = () => <Svg><path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" /></Svg>;
const FunnelIcon = () => <Svg><path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5z" /></Svg>;
const GridIcon = () => <Svg><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></Svg>;
const PlusIcon = () => <Svg sw={2}><path d="M12 5v14M5 12h14" /></Svg>;
const SearchIcon = () => <Svg sw={1.8}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Svg>;
const PinIcon = () => <Svg size={12} sw={1.8}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></Svg>;
const ClockIcon = () => <Svg size={12} sw={1.9}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>;
const ArrowIcon = () => <Svg size={11} sw={2}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
const TrayIcon = () => <Svg size={18}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Svg>;

/** Popover open state that closes on an outside press or Escape. Presses inside
 *  a body-portaled dropdown menu (the popover's own Select fields) don't count
 *  as outside. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest?.(".msel-menu")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return { open, setOpen, ref };
}

export function Pipeline() {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [overCol, setOverCol] = useState<Stage | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [pending, setPending] = useState<{ deal: DealSummary; toStage: Stage } | null>(null);
  // Explicit per-card move (no drag needed): opens the stage modal on the
  // deal's current stage so any destination — including Closed/Dead — is a click away.
  const [moving, setMoving] = useState<DealSummary | null>(null);
  // Card view preferences (density, visible fields, in-column sort).
  const [prefs, setPrefs] = useState<PipelinePrefs>(loadPrefs);
  const [filters, setFilters] = useState<PipelineFilterState>(EMPTY_FILTERS);
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } }, [prefs]);
  const nav = useNavigate();
  const { can } = useAuth();
  const { stages: allStages, active: activeStages, reload: reloadStages, label, pipelines, selected, selectedId, setSelectedId } = useStages();
  const [showStages, setShowStages] = useState(false);
  // Viewers can browse the board but not create deals or change stages —
  // hiding the affordances beats letting them click into a 403.
  const canCreate = can("createDeals");
  const canMove = can("editDeals");
  const canCustomizeStages = can("manageOrgSettings");

  // Latest state for the window pointer handlers (which are bound once per drag).
  const dragRef = useRef<DragState | null>(null);
  const overRef = useRef<Stage | null>(null);
  // Live pointer position + the floating clone element — updated directly during
  // a drag so the board doesn't re-render on every pointermove (the lag source).
  const posRef = useRef({ x: 0, y: 0 });
  const cloneRef = useRef<HTMLDivElement>(null);
  dragRef.current = drag;
  overRef.current = overCol;

  // The pipeline is the acquisition board — opportunities only. Owned mineral
  // assets are managed in their own module and never appear here. The board's
  // rows, optimistic moves and refreshes run through useBoardSync (see
  // lib/boardSync.ts for the ordering rules that stop cards jumping back).
  const board = useBoardSync<DealSummary>({
    scope: "deals",
    fetchRows: () => api.get<DealSummary[]>("/deals?recordType=OPPORTUNITY"),
    enabled: !isOpportunityPipeline(selected),
    paused: drag != null,
    onFetchError: (_err, initial) => { if (initial) showToast("Could not load the pipeline.", "error"); },
  });
  const deals = board.rows;
  const load = board.reload;

  // While dragging, a rAF loop auto-scrolls whichever column body the pointer
  // hovers (near its top/bottom edge) and the board horizontally (near its
  // left/right edge) — the columns scroll themselves now, not the page.
  const autoScrollTimer = useRef<number | null>(null);
  function autoScrollTick() {
    const d = dragRef.current;
    if (d?.moved) {
      const { x, y } = posRef.current;
      const EDGE = 70, MAX = 16;
      const under = document.elementFromPoint(x, y) as HTMLElement | null;
      const body = under?.closest(".kanban-col")?.querySelector(".kanban-col-body") as HTMLElement | null;
      if (body) {
        const r = body.getBoundingClientRect();
        if (y < r.top + EDGE) body.scrollTop -= MAX * ((r.top + EDGE - y) / EDGE);
        else if (y > r.bottom - EDGE) body.scrollTop += MAX * ((y - (r.bottom - EDGE)) / EDGE);
      }
      const board = document.querySelector(".pl2-page .kanban") as HTMLElement | null;
      if (board) {
        const r = board.getBoundingClientRect();
        if (x < r.left + EDGE) board.scrollLeft -= MAX * ((r.left + EDGE - x) / EDGE);
        else if (x > r.right - EDGE) board.scrollLeft += MAX * ((x - (r.right - EDGE)) / EDGE);
      }
    }
  }

  // ------ pointer-based drag: the card follows the cursor with no native-DnD lag
  function startDrag(e: React.PointerEvent, deal: DealSummary) {
    if (!canMove || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".dc-move")) return; // the ⋯ menu button
    const card = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offX = e.clientX - card.left, offY = e.clientY - card.top;
    const start = { x: e.clientX, y: e.clientY };
    posRef.current = start;
    setDrag({ id: deal.id, w: card.width, offX, offY, moved: false });
    if (autoScrollTimer.current == null) autoScrollTimer.current = window.setInterval(autoScrollTick, 16);

    const touch = e.pointerType === "touch";
    // Mouse/pen drags are live immediately; touch waits for the hold.
    let armed = !touch;
    let holdTimer: number | null = null;
    const promote = () => {
      document.body.classList.add("pipeline-dragging");
      setDrag((prev) => (prev ? { ...prev, moved: true } : prev));
    };
    // Once a touch drag is armed, stop the page from scrolling under the finger.
    const blockScroll = (ev: TouchEvent) => { if (armed) ev.preventDefault(); };
    if (touch) {
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        armed = true;
        const el = cloneRef.current;
        if (el) { el.style.left = `${posRef.current.x - offX}px`; el.style.top = `${posRef.current.y - offY}px`; }
        promote();
      }, TOUCH_HOLD_MS);
      window.addEventListener("touchmove", blockScroll, { passive: false });
    }

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("touchmove", blockScroll);
      if (holdTimer != null) { window.clearTimeout(holdTimer); holdTimer = null; }
      if (autoScrollTimer.current != null) { window.clearInterval(autoScrollTimer.current); autoScrollTimer.current = null; }
      document.body.classList.remove("pipeline-dragging");
    };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      posRef.current = { x: ev.clientX, y: ev.clientY };
      const dist = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
      // An un-armed touch that travels is a scroll/swipe — let it go.
      if (!armed) {
        if (dist > TOUCH_SLOP) { cleanup(); setDrag(null); setOverCol(null); }
        return;
      }
      // Move the floating clone directly — no React re-render of the board.
      const el = cloneRef.current;
      if (el) { el.style.left = `${ev.clientX - d.offX}px`; el.style.top = `${ev.clientY - d.offY}px`; }
      // Promote press → drag once, past the threshold (one state update, then none).
      if (!d.moved && dist > DRAG_THRESHOLD) promote();
      // Re-render only when the hovered column/transition actually changes.
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const stage = (under?.closest("[data-stage]")?.getAttribute("data-stage") as Stage | null) ?? null;
      if (stage !== overRef.current) setOverCol(stage);
    };
    // The browser took the gesture (native scroll) — abandon without opening.
    const onCancel = () => { cleanup(); setDrag(null); setOverCol(null); };
    const onUp = () => {
      cleanup();
      window.getSelection()?.removeAllRanges(); // clear any stray text selection from the drag
      const d = dragRef.current;
      const target = overRef.current;
      setDrag(null); setOverCol(null);
      if (!d) return;
      if (!d.moved) { nav(`/deals/${deal.id}`); return; } // press without drag = open
      if (target && target !== deal.stage) commitMove(deal, target);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  /** "Moved to X · Undo" toast. Undo redeems the server's short-lived token,
   *  which restores the deal exactly as it was — stage, days in stage and, for
   *  Closed/Dead, everything that move switched off. Without a token an
   *  ordinary move falls back to moving the card back; Closed/Dead get no Undo.
   *  Undo is itself a board move (instant, sequenced with any other move of
   *  the card, reverted with an error if the server refuses). */
  function offerUndo(deal: DealSummary, toStage: Stage, undoToken?: string | null) {
    const fromStage = deal.stage;
    const terminal = toStage === "CLOSED" || toStage === "DEAD";
    let used = false; // one redemption per toast
    const undo = () => {
      if (used) return;
      used = true;
      const send = () => (undoToken
        ? api.post<DealSummary>(`/deals/${deal.id}/stage/undo`, { undoToken })
        : api.post<DealSummary>(`/deals/${deal.id}/stage`, { toStage: fromStage }));
      // (Closed/Dead deals stay in the board's list, just outside the columns,
      // so a terminal move's undo moves the card straight back in.)
      void board.move(deal.id, fromStage, send, withSavedStage).then((r) => {
        if (r.status === "saved" && r.latest) showToast(`Moved back to ${label(fromStage)}.`);
        // Expired, or the deal changed since: say why; the card is back where the server has it.
        if (r.status === "failed" && r.latest) {
          showToast(r.error instanceof ApiError && (r.error.status === 409 || r.error.status === 410 || r.error.status === 403) ? r.error.message : "Could not undo the move.", "error");
          load();
        }
      });
    };
    showToast(
      <span>
        <strong>{deal.name}</strong> moved to {label(toStage)}.
        {(undoToken || !terminal) && <>{" "}<button className="link-btn" onClick={undo}>Undo</button></>}
      </span>,
      "success",
      // Long enough to notice a mistaken Closed/Dead move and reach Undo.
      undoToken || !terminal ? 10000 : undefined,
    );
  }

  async function commitMove(deal: DealSummary, col: Stage) {
    // Terminal stages carry downstream effects — confirm first (their move runs
    // through the modal; cancelling it leaves the card where it was). Normal
    // stage moves are immediate + optimistic, with an Undo in the toast: an
    // accidental 20px drag shouldn't silently rewrite stage history.
    if (col === "CLOSED" || col === "DEAD") { setPending({ deal, toStage: col }); return; }
    const r = await board.move(deal.id, col, () => api.post<StageMoved>(`/deals/${deal.id}/stage`, { toStage: col }), withSavedStage);
    // Only the card's newest move speaks: a superseded one is already moot.
    if (r.status === "saved" && r.latest) offerUndo(deal, col, r.result.undoToken);
    if (r.status === "failed" && r.latest) {
      showToast(<span>Could not move <strong>{deal.name}</strong> to {label(col)} — {apiErrorText(r.error, "the change was not saved")}. The card was moved back.</span>, "error");
    }
  }

  /** A stage modal saved a move: show the saved card (no wait for a refetch), then refresh. */
  function afterModalMove(before: DealSummary, saved: DealSummary) {
    board.upsert(saved, withSavedStage);
    load();
    offerUndo(before, saved.stage, (saved as StageMoved).undoToken);
  }

  // OPPORTUNITIES-kind pipelines render their own board (same look, Opportunity
  // records instead of Deals). Everything below is the deals board, unchanged.
  if (isOpportunityPipeline(selected)) {
    return (
      <OpportunityBoard
        key={selected.id}
        pipeline={selected}
        pipelines={pipelines}
        switcher={<PipelineSwitcher pipelines={pipelines} selectedId={selectedId} onSelect={(id) => id && setSelectedId(id)} onManage={canCustomizeStages ? () => setShowStages(true) : undefined} />}
        showSettings={showStages}
        onOpenSettings={() => setShowStages(true)}
        onCloseSettings={() => { setShowStages(false); reloadStages(); }}
        onSettingsChanged={reloadStages}
        onSelectPipeline={(id) => { reloadStages(); setSelectedId(id); }}
      />
    );
  }

  if (!deals) return <Spinner />;
  const dragDeal = drag ? deals.find((d) => d.id === drag.id) ?? null : null;
  // Board shows ONLY the selected pipeline's deals. A null pipelineId means the
  // org's default pipeline (legacy rows and the common case).
  const pipelineDeals = deals.filter((d) => (selected.isDefault ? !d.pipelineId || d.pipelineId === selected.id : d.pipelineId === selected.id));
  const boardDeals = applyPipelineFilters(pipelineDeals, filters);
  const filtersActive = activeFilterCount(filters) > 0;
  // Header summary: deals currently on the board + their combined est. profit.
  const activeKeys = new Set(activeStages.map((s) => s.key));
  const activeBoardDeals = boardDeals.filter((d) => activeKeys.has(d.stage));
  const boardTotal = sumMoney(activeBoardDeals.map((d) => d.profitEst));
  const tags = filtersActive ? filterTags(filters, pipelineDeals) : [];
  const total = COLUMN_TOTALS[prefs.total] ?? COLUMN_TOTALS.profit;
  // Per-pipeline, per-stage opportunity counts for the settings stage editor.
  const stageCount = (pipelineId: string, stageKey: string) => {
    const p = pipelines.find((x) => x.id === pipelineId);
    if (isOpportunityPipeline(p)) return null; // opportunity counts live on that board
    return deals.filter((d) => d.stage === stageKey && (p?.isDefault ? !d.pipelineId || d.pipelineId === pipelineId : d.pipelineId === pipelineId)).length;
  };

  return (
    <div className="page pl2-page">
      <div className="page-header pl-head">
        <div className="pl-head-main">
          <h1>Pipeline</h1>
          {/* Pipeline selector — switch boards; each pipeline has its own stages. */}
          <PipelineSwitcher
            pipelines={pipelines}
            selectedId={selectedId}
            onSelect={(id) => id && setSelectedId(id)}
            onManage={canCustomizeStages ? () => setShowStages(true) : undefined}
          />
          <div className="pl-stats">
            <span><b>{activeBoardDeals.length}</b> active deal{activeBoardDeals.length === 1 ? "" : "s"}</span>
            <span className="pl-stats-dot" aria-hidden="true" />
            <span><b className={boardTotal < 0 ? "neg" : "pos"}>{money(boardTotal)}</b> est. profit in pipeline</span>
          </div>
        </div>
        <div className="pl-toolbar">
          <PipelineFilters deals={pipelineDeals} filters={filters} onChange={setFilters} shown={boardDeals.length} />
          <PipelineCustomize prefs={prefs} onChange={setPrefs} />
          {canCustomizeStages && (
            <button type="button" className="pl-btn" title="Create, rename, reorder, and delete pipelines; configure stages and colors" onClick={() => setShowStages(true)}>
              <SlidersIcon /><span>Pipeline settings</span>
            </button>
          )}
          {canCreate && <button type="button" className="primary pl-new" onClick={() => setShowNew(true)}><PlusIcon /><span>New deal</span></button>}
        </div>
      </div>

      {filtersActive && (
        <div className="pl-tags">
          <span className="pl-tags-count">Showing <b>{boardDeals.length}</b> of {pipelineDeals.length}</span>
          {tags.map((t) => (
            <span key={t.key} className="pl-tag">
              <span>{t.label}</span>
              <button type="button" aria-label={`Remove filter ${t.label}`} onClick={() => setFilters({ ...filters, ...t.clear })}><CloseIcon /></button>
            </span>
          ))}
          <button type="button" className="pl-link" onClick={() => setFilters(EMPTY_FILTERS)}>Clear all</button>
        </div>
      )}

      <div className={`kanban ${prefs.density === "compact" ? "compact" : ""} ${drag ? "dragging" : ""}`}>
        {activeStages.length === 0 && (
          <div className="pl-nostages">
            <span className="pl-nostages-title">{selected.name} has no stages yet</span>
            <span className="pl-nostages-sub">Closed and Dead are included automatically.</span>
            {canCustomizeStages && <button type="button" className="primary" onClick={() => setShowStages(true)}>Add stages</button>}
          </div>
        )}
        {activeStages.map((stage) => {
          const col = stage.key;
          const color = stageColor(allStages, col);
          const colDeals = sortDeals(boardDeals.filter((d) => d.stage === col), prefs.sort);
          const colTotal = total.sum(colDeals);
          // Under Contract for THIS stage only: what we owe sellers for its
          // deals (owned assets for sale have no seller contract).
          const colUnderContract = COLUMN_TOTALS.ourPrice.sum(colDeals);
          const hiddenByFilters = filtersActive && pipelineDeals.some((d) => d.stage === col);
          return (
            <div
              key={col} data-stage={col}
              className={`kanban-col pl-col ${drag && overCol === col && dragDeal?.stage !== col ? "drop-target" : ""}`}
              style={{ "--stage": color } as CSSProperties}
            >
              <div className="pl-col-head">
                <div className="pl-col-title">
                  <span className="pl-col-dot" aria-hidden="true" />
                  <span className="pl-col-name" title={stage.label}>{stage.label}</span>
                  <span className="pl-col-count">{colDeals.length}</span>
                </div>
                <div className="pl-col-total">
                  <span className={`pl-col-sum ${colTotal > 0 ? (prefs.total === "profit" ? "pos" : "on") : ""}`}>{total.fmt(colTotal)}</span>
                  <span className="pl-col-metric">{total.label}</span>
                </div>
                {prefs.underContract && (
                  <div className="pl-col-uc" title={`Acquisition cost of the deals in ${stage.label}`}>
                    <span>Under contract</span> {money(colUnderContract)}
                  </div>
                )}
              </div>
              <div className="kanban-col-body pl-col-body">
                {colDeals.map((d) => (
                  <Card key={d.id} deal={d} canMove={canMove} fields={prefs.fields} dragging={drag?.id === d.id && drag.moved}
                    onPointerDown={(e) => startDrag(e, d)} onMove={() => setMoving(d)} />
                ))}
                {colDeals.length === 0 && (
                  <div className="pl-empty">
                    <TrayIcon />
                    <span>{hiddenByFilters ? "No deals match filters" : "Drop deals here"}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Permanent Closed/Dead resolution zones — fixed at the BOTTOM of the
          board, side by side, always visible regardless of stage count or
          scroll position. Same data-stage drop mechanics as the columns. */}
      {canMove && (
        <div className={`pl-zones ${drag?.moved ? "dragging" : ""}`}>
          {TRANSITIONS.map((t) => (
            <div
              key={t.stage} data-stage={t.stage}
              className={`pl-zone ${t.stage === "DEAD" ? "dead" : "closed"} ${drag && overCol === t.stage ? "drop-target" : ""}`}
            >
              <span className="pl-zone-main">
                <span className="pl-zone-ico" aria-hidden="true">
                  {t.stage === "DEAD" ? <CloseIcon size={14} sw={2.4} /> : <CheckIcon size={14} />}
                </span>
                <span className="pl-zone-name">{t.label}</span>
              </span>
              <span className="pl-zone-hint">{t.hint}</span>
            </div>
          ))}
        </div>
      )}

      {/* Floating clone follows the cursor for a natural, lag-free drag. Its
          position is updated imperatively (cloneRef) during the drag. */}
      {drag && drag.moved && dragDeal && (
        <div ref={cloneRef} className={`deal-card pl-card drag-clone ${prefs.density === "compact" ? "compact" : ""}`} style={{ position: "fixed", left: posRef.current.x - drag.offX, top: posRef.current.y - drag.offY, width: drag.w, pointerEvents: "none", zIndex: 1000 }}>
          <CardBody deal={dragDeal} fields={prefs.fields} />
        </div>
      )}

      {showStages && (
        <PipelineSettingsModal
          pipelines={pipelines}
          initialId={selected.id}
          stageCount={stageCount}
          onClose={() => { setShowStages(false); reloadStages(); load(); }}
          onChanged={() => { reloadStages(); load(); }}
        />
      )}
      {showNew && <NewDealModal pipelineId={selected.id || undefined} onClose={() => setShowNew(false)} onCreated={(d) => { setShowNew(false); nav(`/deals/${d.id}`); }} />}
      {pending && (
        <StageChangeModal
          deal={pending.deal}
          initialStage={pending.toStage}
          directTerminal
          onClose={() => setPending(null)}
          onChanged={(d) => { setPending(null); afterModalMove(pending.deal, d); }}
        />
      )}
      {moving && (
        <StageChangeModal
          deal={moving}
          onClose={() => setMoving(null)}
          onChanged={(d) => { setMoving(null); afterModalMove(moving, d); }}
        />
      )}
    </div>
  );
}

/** Pipeline switcher: the selected pipeline's name opens a menu of every
 *  pipeline (default badged) plus "Manage pipelines" for admins. */
function PipelineSwitcher({ pipelines, selectedId, onSelect, onManage }: {
  pipelines: PipelineInfo[]; selectedId: string; onSelect: (id: string) => void; onManage?: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const current = pipelines.find((p) => p.id === selectedId) ?? pipelines[0];
  return (
    <div className="pl-switch" ref={ref}>
      <button type="button" className={`pl-switch-btn ${open ? "open" : ""}`} aria-label="Pipeline" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{current?.name}</span><ChevronIcon />
      </button>
      {open && (
        <div className="pl-menu" role="menu">
          <div className="pl-menu-label">Pipelines</div>
          {pipelines.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === selectedId}
              className={`pl-menu-item ${p.id === selectedId ? "on" : ""}`}
              onClick={() => { setOpen(false); onSelect(p.id); }}>
              <span className="pl-menu-name">{p.name}</span>
              <span className={`pl-badge pl-kind ${isOpportunityPipeline(p) ? "opp" : ""}`}>{isOpportunityPipeline(p) ? "Opportunities" : "Deals"}</span>
              {p.isDefault && <span className="pl-badge">Default</span>}
              <span className="pl-menu-check"><CheckIcon /></span>
            </button>
          ))}
          {onManage && (
            <>
              <div className="pl-menu-sep" />
              <button type="button" role="menuitem" className="pl-menu-item pl-menu-manage" onClick={() => { setOpen(false); onManage(); }}>
                <SlidersIcon /><span>Manage pipelines</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Card({ deal, canMove, fields, dragging, onPointerDown, onMove }: {
  deal: DealSummary; canMove: boolean; fields: Record<CardField, boolean>; dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void; onMove: () => void;
}) {
  const isDead = deal.stage === "DEAD";
  return (
    <div
      className={`deal-card pl-card ${isDead ? "dead" : ""} ${dragging ? "drag-source" : ""} ${canMove ? "draggable" : ""}`}
      onPointerDown={canMove ? onPointerDown : undefined}
    >
      <CardBody deal={deal} fields={fields} action={canMove ? (
        <button
          type="button"
          className="dc-move"
          title="Move to another stage"
          aria-label={`Move ${deal.name} to another stage`}
          onClick={(e) => { e.stopPropagation(); onMove(); }}
          onPointerDown={(e) => e.stopPropagation()}
        >⋯</button>
      ) : null} />
    </div>
  );
}

/** Card content shared by the board card and the drag clone. Which facts appear
 *  is driven by the user's Customize View field preferences. */
function CardBody({ deal, fields, action }: { deal: DealSummary; fields: Record<CardField, boolean>; action?: ReactNode }) {
  const isClosing = deal.stage === "CLOSING";
  const isDead = deal.stage === "DEAD";
  // Short uppercase tag for the head chip (e.g. Minerals → MI), reference-style.
  const typeTag = deal.assetTypes?.[0] ? deal.assetTypes[0].slice(0, 2).toUpperCase() : null;
  const metrics: { label: string; value: string; pos?: boolean; title?: string }[] = [];
  if (fields.nra) metrics.push({ label: "NRA", value: num(cardNra(deal)) });
  if (fields.nma) metrics.push({ label: "NMA", value: num(cardNma(deal)) });
  if (fields.ourPrice) metrics.push({ label: "Our price", value: money(cardOur(deal)), title: "Our price (acquisition cost)" });
  if (fields.buyerPrice) metrics.push({ label: "Buyer price", value: money(cardBuyer(deal)), title: "Buyer purchase price — accepted offer, else best offer" });
  if (fields.profit) metrics.push({ label: "Est. profit", value: money(deal.profitEst), pos: deal.profitEst != null });
  const due = !isClosing && !isDead ? dueStatus(deal) : null;
  return (
    <>
      <div className="pl-card-top">
        <span className="pl-card-name" title={deal.name}>
          {deal.name}{deal.assetCount ? <span className="pl-card-assets"> · {deal.assetCount} asset{deal.assetCount > 1 ? "s" : ""}</span> : null}
        </span>
        {fields.priority && (
          <span className={`pl-chip pl-pri pri-${deal.priority.toLowerCase()}`}><i />{PRIORITY_LABEL[deal.priority] ?? deal.priority}</span>
        )}
        {typeTag && <span className="pl-type" title={deal.assetTypes.join(", ")}>{typeTag}</span>}
        {action}
      </div>
      {(fields.location || fields.days) && (
        <div className="pl-card-sub">
          {fields.location ? <span className="pl-card-loc"><PinIcon /><ChipList items={[...deal.counties, deal.state]} max={3} /></span> : <span />}
          {fields.days && (
            <span className="pl-card-days"><ClockIcon />{deal.daysInStage === 0 ? "Moved today" : `${deal.daysInStage}d in stage`}</span>
          )}
        </div>
      )}
      {metrics.length > 0 && (
        <div className="pl-metrics">
          {metrics.map((m) => (
            <div key={m.label} className="pl-metric" title={m.title}>
              <span className="pl-metric-label">{m.label}</span>
              <span className={`pl-metric-value ${m.value === "—" ? "dim" : m.pos ? "pos" : ""}`}>{m.value}</span>
            </div>
          ))}
        </div>
      )}
      {fields.dates && (isClosing || !isDead) && (
        <div className="pl-dates">
          {isClosing ? (
            <>
              <span className="pl-date"><span>Closing</span><b>{fmtDate(deal.originalClosingDate)}</b></span>
              <span className="pl-date"><span>Extended closing</span><b>{fmtDate(deal.finalClosingDate)}</b></span>
            </>
          ) : (
            <span className="pl-date">
              <span>Find buyer by</span><b>{fmtDate(deal.findBuyerByDate)}</b>
              {due && <span className={`pl-due ${due.tone}`}>{due.text}</span>}
            </span>
          )}
        </div>
      )}
      {fields.buyer && isClosing && deal.selectedBuyer && (
        <span className="pl-chip pl-buyer" title={deal.selectedBuyer.name}><ArrowIcon /><span>{deal.selectedBuyer.name}</span></span>
      )}
    </>
  );
}

/** Labelled field inside a board popover. */
function PopField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="pl-field"><label>{label}</label>{children}</div>;
}

/** Filters popover for the Pipeline board — same design language as Customize View. */
function PipelineFilters({ deals, filters, onChange, shown }: {
  deals: DealSummary[]; filters: PipelineFilterState; onChange: (f: PipelineFilterState) => void; shown: number;
}) {
  const { open, setOpen, ref } = usePopover();
  // Option lists come from the deals actually on the board.
  const { states, counties, buyers, people } = filterOptions(deals);
  const n = activeFilterCount(filters);

  return (
    <div className="cv-wrap" ref={ref}>
      <button type="button" className={`pl-btn cv-btn ${open || n > 0 ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title="Filter the board" aria-expanded={open}>
        <FunnelIcon /><span>Filters</span>
        {n > 0 && <span className="pl-btn-badge">{n}</span>}
      </button>
      {open && (
        <div className="cv-menu pl-pop pl-pop-filters" role="dialog" aria-label="Filter board">
          <div className="pl-pop-head">
            <span className="pl-pop-title">Filters</span>
            <button type="button" className="pl-link" disabled={n === 0} onClick={() => onChange(EMPTY_FILTERS)}>Clear all</button>
          </div>
          <div className="pl-pop-body">
            <PopField label="Search">
              <div className="pl-search">
                <SearchIcon />
                <input value={filters.q} onChange={(e) => onChange({ ...filters, q: e.target.value })} placeholder="Deal, seller, abstract, survey" aria-label="Search pipeline deals" />
              </div>
            </PopField>
            <PopField label="Priority">
              <div className="pl-pri-chips" role="radiogroup" aria-label="Filter by priority">
                {(["HIGH", "MEDIUM", "LOW"] as const).map((p) => {
                  const on = filters.priority === p;
                  return (
                    <button key={p} type="button" role="radio" aria-checked={on} className={`pl-pri-chip pri-${p.toLowerCase()} ${on ? "on" : ""}`}
                      onClick={() => onChange({ ...filters, priority: on ? "" : p })}>
                      <i />{PRIORITY_LABEL[p]}
                    </button>
                  );
                })}
              </div>
            </PopField>
            <div className="pl-grid2">
              <PopField label="State">
                <SearchableMultiSelect options={states} value={filters.states} onChange={(v) => onChange({ ...filters, states: v })} placeholder="Any state" />
              </PopField>
              <PopField label="County">
                <SearchableMultiSelect options={counties} value={filters.counties} onChange={(v) => onChange({ ...filters, counties: v })} placeholder="Any county" />
              </PopField>
            </div>
            <PopField label="Selected buyer">
              <Select value={filters.buyerId} onChange={(v) => onChange({ ...filters, buyerId: v })} clearable searchable placeholder="Any buyer" ariaLabel="Filter by buyer"
                options={buyers.map(([value, label]) => ({ value, label }))} />
            </PopField>
            <PopField label="Team member">
              <Select value={filters.assigneeId} onChange={(v) => onChange({ ...filters, assigneeId: v })} clearable searchable placeholder="Anyone" ariaLabel="Filter by team member"
                options={people.map(([value, label]) => ({ value, label }))} />
            </PopField>
            <div className="pl-divider" />
            <RangeFilter label="NRA" min={filters.nraMin} max={filters.nraMax} onChange={(nraMin, nraMax) => onChange({ ...filters, nraMin, nraMax })} />
            <RangeFilter label="NMA" min={filters.nmaMin} max={filters.nmaMax} onChange={(nmaMin, nmaMax) => onChange({ ...filters, nmaMin, nmaMax })} />
            <RangeFilter label="Our price" money min={filters.ourMin} max={filters.ourMax} onChange={(ourMin, ourMax) => onChange({ ...filters, ourMin, ourMax })} />
            <RangeFilter label="Buyer purchase price" money min={filters.buyerMin} max={filters.buyerMax} onChange={(buyerMin, buyerMax) => onChange({ ...filters, buyerMin, buyerMax })} />
            <div className="pl-divider" />
            <div className="pl-switch-row">
              <div className="pl-switch-text">
                <span className="pl-switch-title">Overdue only</span>
                <span className="pl-switch-sub">Find-buyer date has passed and no buyer is selected</span>
              </div>
              <Toggle checked={filters.overdueOnly} onChange={() => onChange({ ...filters, overdueOnly: !filters.overdueOnly })} ariaLabel="Overdue only" />
            </div>
          </div>
          <div className="pl-pop-foot">
            <span>{shown} of {deals.length} deals match</span>
            <button type="button" className="primary" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Min/Max range on one line; money ranges carry a "$" adornment. */
function RangeFilter({ label, min, max, money: isMoney, onChange }: { label: string; min: string; max: string; money?: boolean; onChange: (min: string, max: string) => void }) {
  return (
    <PopField label={label}>
      <div className="pl-range">
        <span className={`pl-range-input ${isMoney ? "money" : ""}`}>
          {isMoney && <span className="pl-range-cur" aria-hidden="true">$</span>}
          <input type="number" min={0} value={min} onChange={(e) => onChange(e.target.value, max)} placeholder="Min" aria-label={`Minimum ${label}`} />
        </span>
        <span className="pl-range-sep">–</span>
        <span className={`pl-range-input ${isMoney ? "money" : ""}`}>
          {isMoney && <span className="pl-range-cur" aria-hidden="true">$</span>}
          <input type="number" min={0} value={max} onChange={(e) => onChange(min, e.target.value)} placeholder="Max" aria-label={`Maximum ${label}`} />
        </span>
      </div>
    </PopField>
  );
}

/** Customize View popover for the Pipeline board (density, fields, totals, sort). */
function PipelineCustomize({ prefs, onChange }: { prefs: PipelinePrefs; onChange: (p: PipelinePrefs) => void }) {
  const { open, setOpen, ref } = usePopover();
  const toggleField = (k: CardField) => onChange({ ...prefs, fields: { ...prefs.fields, [k]: !prefs.fields[k] } });

  return (
    <div className="cv-wrap" ref={ref}>
      <button type="button" className={`pl-btn cv-btn ${open ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title="Customize the board" aria-expanded={open}>
        <GridIcon /><span>Customize view</span>
      </button>
      {open && (
        <div className="cv-menu pl-pop pl-pop-custom" role="dialog" aria-label="Customize board">
          <div className="pl-pop-head">
            <span className="pl-pop-title">Customize view</span>
            <button type="button" className="pl-link muted" onClick={() => onChange(DEFAULT_PREFS)}>Restore defaults</button>
          </div>
          <div className="pl-pop-body">
            <PopField label="Card density">
              <Segmented accent className="pl-seg" ariaLabel="Card density" value={prefs.density} onChange={(density) => onChange({ ...prefs, density })}
                options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
            </PopField>
            <PopField label="Card fields">
              <div className="pl-checks">
                {CARD_FIELDS.map(([k, label]) => (
                  <label key={k} className="pl-check">
                    <input type="checkbox" checked={prefs.fields[k]} onChange={() => toggleField(k)} /> <span>{label}</span>
                  </label>
                ))}
              </div>
            </PopField>
            <div className="pl-divider" />
            <PopField label="Column totals">
              <Select value={prefs.total} onChange={(v) => onChange({ ...prefs, total: v as ColumnTotal })} ariaLabel="Column totals"
                options={(Object.keys(COLUMN_TOTALS) as ColumnTotal[]).map((k) => ({ value: k, label: COLUMN_TOTALS[k].option }))} />
              <label className="pl-check" title="Each stage's own total acquisition cost (Our Cost) — never the company-wide figure">
                <input type="checkbox" checked={prefs.underContract} onChange={() => onChange({ ...prefs, underContract: !prefs.underContract })} /> <span>Also show under contract</span>
              </label>
            </PopField>
            <PopField label="Sort within a stage">
              <Select value={prefs.sort} onChange={(v) => onChange({ ...prefs, sort: v as CardSort })} ariaLabel="Sort cards by"
                options={[
                  { value: "priority", label: "Priority" },
                  { value: "days", label: "Days in stage" },
                  { value: "profit", label: "Est. profit" },
                  { value: "nma", label: "NMA" },
                  { value: "ourPrice", label: "Our price" },
                  { value: "buyerPrice", label: "Buyer purchase price" },
                  { value: "name", label: "Name A–Z" },
                ]} />
            </PopField>
          </div>
        </div>
      )}
    </div>
  );
}
