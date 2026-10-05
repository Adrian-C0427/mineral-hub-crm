import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  BarChart, ReferenceLine, Cell,
} from "recharts";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner, Modal, Spinner, ChipList, ConfirmDialog, showToast } from "../components/ui";
import { StatStrip, Tag, type StatCell } from "../components/kit";
import { Select } from "../components/Select";
import { WellImport } from "../components/WellImport";
import { money, prettyEnum, fmtDate, fmtDateTime, fmtDateLocal } from "../lib/format";
import { monthLabel, chartTooltip } from "../lib/charts";
import { formatAbstract } from "../lib/abstracts";

/**
 * Well Production Analysis & Valuation — the single comprehensive view of
 * everything the centralized well database knows about a well. Launch it from
 * the map ("Open in Well Analysis" auto-loads AND auto-runs the analysis) or
 * search here by any identifier (API, RRC lease no, well/lease name, operator,
 * county, survey, abstract…). Either path lands on the same fully-populated
 * record: the dossier (permits, completions, operators, lease, wellbore,
 * offsets) plus the decline-curve + economics engine over live production.
 */

// ---------------------------------------------------------------------------
// API types (mirroring server/src/domain/valuation.ts)
// ---------------------------------------------------------------------------

interface Assumptions {
  oilPrice: number; gasPrice: number; nglPrice: number; priceEscalationPct: number;
  nri: number; workingInterest: number;
  opexPerMonth: number; opexEscalationPct: number;
  sevTaxOilPct: number; sevTaxGasPct: number; adValoremPct: number;
  askingPrice: number; closingCosts: number;
  discountRatePct: number;
  targetRoiPct: number | null; targetProfitMarginPct: number | null;
  targetProfitAmount: number | null; resalePrice: number | null;
  maxForecastMonths: number; economicLimitNetCashFlow: number;
  declineOverride: { oil?: { b?: number; diAnnual?: number }; gas?: { b?: number; diAnnual?: number } } | null;
}

interface WellRow {
  id: string; apiNumber: string | null; name: string; operator: string | null; leaseName: string | null;
  fieldName: string | null; formation: string | null; state: string; county: string; status: string;
  trajectory: string; wellType: string | null;
  production: { firstMonth: string | null; lastMonth: string | null; months: number; cumOilBbl: number; cumGasMcf: number; cumNglBbl: number } | null;
}

interface MonthVolumes { month: string; oilBbl: number; gasMcf: number; nglBbl: number; waterBbl: number }

interface PhaseStats { cumulative: number; peak: { month: string; volume: number } | null; last12: number; lastMonthVolume: number; currentMonthlyRate: number }
interface ProductionSummary {
  firstMonth: string | null; lastMonth: string | null; monthsOfHistory: number; producingMonths: number;
  oil: PhaseStats; gas: PhaseStats; ngl: PhaseStats; waterCum: number; cumBoe: number;
  annual: { year: string; oilBbl: number; gasMcf: number; nglBbl: number; boe: number }[];
  anomalies: { month: string; kind: string; detail: string }[];
}

interface DeclineFit {
  model: string; b: number; diAnnualNominal: number; diAnnualEffective: number; qiMonthly: number;
  currentRate: number; r2: number; fitStartMonth: string; fitMonths: number; confidence: "high" | "medium" | "low"; manual: boolean;
}

interface ForecastMonth {
  month: string; oilBbl: number; gasMcf: number; nglBbl: number;
  oilRevenue: number; gasRevenue: number; nglRevenue: number;
  grossRevenue: number; severanceTax: number; adValorem: number; opex: number;
  netRevenue: number; netCashFlow: number; cumNetCashFlow: number; discountedCashFlow: number;
}

interface ForecastResult {
  months: ForecastMonth[]; endReason: string; remainingMonths: number; remainingYears: number;
  economicLimitMonth: string | null;
  remaining: { oilBbl: number; gasMcf: number; nglBbl: number; boe: number };
  eur: { oilBbl: number; gasMcf: number; nglBbl: number; boe: number };
  confidence: "high" | "medium" | "low";
}

interface Economics {
  investment: number; grossRevenueTotal: number; netRevenueTotal: number; totalTaxes: number; totalOpex: number;
  netCashFlowTotal: number; presentValue: number; pv10: number; npv: number; irrAnnualPct: number | null;
  paybackMonths: number | null; roiPct: number | null; breakEvenPriceFactor: number | null;
  breakEvenOilPrice: number | null; monthlyCashFlowFirstYearAvg: number;
}

interface ValuationSection {
  fairMarketValue: number; pv10: number; maxPurchasePrice: number; recommendedOffer: number;
  offerVsAskingPct: number | null; askingPriceAssessment: string | null;
  expectedGrossProfit: number | null; expectedNetProfit: number | null;
  resaleRoiPct: number | null; resaleMarginPct: number | null;
  atAsking: { npv: number; roiPct: number | null; paybackMonths: number | null } | null;
}

interface SensitivityRow {
  label: string; priceFactor: number; oilPrice: number; gasPrice: number; presentValue: number;
  npv: number; roiPct: number | null; irrAnnualPct: number | null; paybackMonths: number | null;
}

interface ValuationResult {
  assumptions: Assumptions;
  production: ProductionSummary;
  history: MonthVolumes[];
  decline: { oil: DeclineFit | null; gas: DeclineFit | null; ngl: DeclineFit | null };
  forecast: ForecastResult;
  economics: Economics;
  valuation: ValuationSection;
  sensitivity: SensitivityRow[];
  warnings: string[];
  runAt: string;
}

interface AnalyzeResponse { wells: WellRow[]; result: ValuationResult }
interface Paged<T> { total: number; page: number; pageSize: number; rows: T[] }

interface SavedAnalysisRow {
  id: string; name: string; wellIds: string[]; wellNames: string[]; notes: string | null;
  updatedAt: string; createdAt: string;
  /** Oil $/bbl and gas $/mcf the saved snapshot was run at. Optional: an older API omits it. */
  priceDeck?: { oilPrice: number | null; gasPrice: number | null };
  headline: { fairMarketValue: number | null; recommendedOffer: number | null; npv: number | null; irrAnnualPct: number | null; roiPct: number | null } | null;
}

interface SavedAnalysisDetail {
  id: string; name: string; wellIds: string[]; assumptions: Partial<Assumptions>;
  results: ValuationResult | null; notes: string | null; createdAt: string; updatedAt: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const fmtVol = (v: number | null | undefined, unit = ""): string => (v == null ? "—" : Math.round(v).toLocaleString("en-US") + unit);
const fmtPct1 = (v: number | null | undefined): string => (v == null ? "—" : `${v.toFixed(1)}%`);
const fmtMoneyC = (v: number | null | undefined): string => {
  if (v == null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${v < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${v < 0 ? "-" : ""}$${(abs / 1_000).toFixed(0)}K`;
  return money(v);
};
const fmtMonths = (m: number | null | undefined): string => {
  if (m == null) return "Beyond forecast";
  if (m < 24) return `${m} months`;
  return `${(m / 12).toFixed(1)} years`;
};

const COLOR_OIL = "#22c55e";
const COLOR_GAS = "#ef4444";
const COLOR_NGL = "#8b5cf6";
const COLOR_CASH = "#3b82f6";
const COLOR_CUM = "#f59e0b";

const CONF_LABEL: Record<string, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
const CONF_TONE = { high: "success", medium: "warn", low: "danger" } as const;

/** Shared recharts axis / grid / legend styling (design chart frame). */
const AXIS_TICK = { fontSize: 11, fill: "var(--ink-4)" };
const AXIS_LABEL = { fontSize: 11, fill: "var(--ink-4)" };
const LEGEND_PROPS = { iconSize: 12, wrapperStyle: { fontSize: 12, color: "var(--ink-2)", paddingTop: 6 } };
const Grid = () => <CartesianGrid vertical={false} stroke="var(--line-faint)" />;
const FC_DASH = "5 4";

/** Well status (WellRow enum) → tag tone. */
const statusTone = (s: string): "success" | "warn" | "danger" | "neutral" =>
  s === "PRODUCING" ? "success" : s === "SHUT_IN" ? "warn" : "neutral";
/** RRC free-text status (nearby wells) → text tone class. */
const rrcStatusClass = (s: string | null): string => {
  const v = (s ?? "").toLowerCase();
  if (v.includes("produc")) return "ok";
  if (v.includes("shut")) return "warn";
  if (v.includes("cancel") || v.includes("abandon")) return "bad";
  return "";
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type PageTab = "workspace" | "saved" | "data";
type ResultTab = "production" | "forecast" | "cashflow" | "valuation" | "sensitivity" | "report";

/** What a run was computed from — compared with the current inputs to flag stale results. */
const runKey = (wells: WellRow[], a: Assumptions | null) => JSON.stringify({ ids: wells.map((w) => w.id), a });

export function Valuation() {
  const { can } = useAuth();
  const canManage = can("manageWellAnalysis");
  const [pageTab, setPageTab] = useState<PageTab>("workspace");

  // Workspace state
  const [selected, setSelected] = useState<WellRow[]>([]);
  const [assumptions, setAssumptions] = useState<Assumptions | null>(null); // fetched defaults
  const [defaults, setDefaults] = useState<Assumptions | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [resultTab, setResultTab] = useState<ResultTab>("production");
  const [openAnalysisId, setOpenAnalysisId] = useState<string | null>(null);
  const [openAnalysisName, setOpenAnalysisName] = useState<string>("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [lastRunKey, setLastRunKey] = useState<string | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<Assumptions>("/wells/assumptions/defaults").then((d) => { setAssumptions(d); setDefaults(d); }).catch(() => {});
  }, []);

  // Deep-link from the map's well panel ("Open in Well Analysis"):
  // ?fid=<rrc well id>&well=<API#>. The well is linked into the centralized
  // dataset, its production is read live from rrc.production, and the analysis
  // RUNS IMMEDIATELY with default assumptions — the user lands on a finished,
  // fully-populated result with no search, import or extra click.
  const [autoRunPending, setAutoRunPending] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fid = params.get("fid");
    const w = params.get("well");
    if (!fid && !w) return;
    (async () => {
      try {
        // fid is exact — upsert-link the rrc well so analyze reads it live.
        if (fid) {
          const imported = await api.post<{ well: WellRow }>(`/wells/import-rrc`, { fid: Number(fid) });
          setSelected([imported.well]); setPageTab("workspace"); setAutoRunPending(true); return;
        }
        const found = await api.get<Paged<WellRow>>(`/wells?q=${encodeURIComponent(w!)}&pageSize=1`);
        if (found.rows[0]?.production?.months) { setSelected([found.rows[0]]); setPageTab("workspace"); setAutoRunPending(true); return; }
        const imported = await api.post<{ well: WellRow }>(`/wells/import-rrc`, { api: w });
        setSelected([imported.well]);
        setPageTab("workspace");
        setAutoRunPending(true);
      } catch {
        // Not in the org list or the RRC data — leave the workspace open.
      }
    })();
  }, []);

  // Fire the deep-linked analysis as soon as the well and the default
  // assumptions are both in hand (they load concurrently).
  useEffect(() => {
    if (!autoRunPending || !assumptions || selected.length === 0) return;
    setAutoRunPending(false);
    void runAnalysis(selected, assumptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunPending, assumptions, selected]);

  const runAnalysis = useCallback(async (wells: WellRow[], a: Assumptions) => {
    setRunning(true); setError("");
    try {
      const resp = await api.post<AnalyzeResponse>("/wells/analyze", { wellIds: wells.map((w) => w.id), assumptions: a });
      setAnalysis(resp);
      setLastRunKey(runKey(wells, a));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setRunning(false);
    }
  }, []);

  async function openSaved(id: string) {
    setError("");
    try {
      const d = await api.get<SavedAnalysisDetail>(`/wells/analyses/${id}`);
      const wells = await api.get<Paged<WellRow>>(`/wells?ids=${d.wellIds.join(",")}&pageSize=100`);
      setSelected(wells.rows);
      setAssumptions((prev) => ({ ...(prev as Assumptions), ...d.assumptions }));
      setAnalysis(d.results ? { wells: wells.rows, result: d.results } : null);
      // The saved snapshot counts as "up to date" for these wells and assumptions.
      setLastRunKey(runKey(wells.rows, { ...(assumptions as Assumptions), ...d.assumptions }));
      setOpenAnalysisId(d.id);
      setOpenAnalysisName(d.name);
      setPageTab("workspace");
      setResultTab("production");
      if (wells.rows.length !== d.wellIds.length) {
        setError("Some wells in this saved analysis no longer exist; results shown are the saved snapshot.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the analysis");
    }
  }

  function newAnalysis() {
    setSelected([]);
    setAnalysis(null);
    setOpenAnalysisId(null);
    setOpenAnalysisName("");
    setError("");
    setPageTab("workspace");
  }

  const dirty = analysis != null && lastRunKey != null && runKey(selected, assumptions) !== lastRunKey;

  return (
    <div className="page va-page">
      <div className="page-header">
        <div className="va-title">
          <h1>Well analysis &amp; valuation</h1>
          <div className="page-sub">Everything known about a well in one place: the full RRC record, production forecasting, decline curves and acquisition economics.</div>
        </div>
        <div className="va-head-actions">
          {analysis && (
            <>
              {/* Saving writes a WellAnalysis row, so it follows the same
                  manageWellAnalysis gate the server enforces — a read-only
                  VIEWER can run and read analyses but not persist them. */}
              {canManage && <button onClick={() => setSaveOpen(true)}>{openAnalysisId ? "Save / Save as…" : "Save analysis…"}</button>}
            </>
          )}
          <button className="primary" onClick={newAnalysis}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New analysis
          </button>
        </div>
      </div>

      <div className="tab-row va-tabs" role="tablist">
        <button role="tab" aria-selected={pageTab === "workspace"} className={`tab ${pageTab === "workspace" ? "active" : ""}`} onClick={() => setPageTab("workspace")}>Analysis workspace</button>
        <button role="tab" aria-selected={pageTab === "saved"} className={`tab ${pageTab === "saved" ? "active" : ""}`} onClick={() => setPageTab("saved")}>Saved analyses</button>
        <button role="tab" aria-selected={pageTab === "data"} className={`tab ${pageTab === "data" ? "active" : ""}`} onClick={() => setPageTab("data")}>Well data{canManage ? " & imports" : ""}</button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {pageTab === "workspace" && assumptions && (
        <Workspace
          selected={selected}
          setSelected={setSelected}
          assumptions={assumptions}
          setAssumptions={setAssumptions as (a: Assumptions) => void}
          onResetAssumptions={defaults ? () => setAssumptions(defaults) : undefined}
          analysis={analysis}
          running={running}
          dirty={dirty}
          onRun={() => runAnalysis(selected, assumptions)}
          resultTab={resultTab}
          setResultTab={setResultTab}
          openAnalysisName={openAnalysisName}
          reportRef={reportRef}
        />
      )}
      {pageTab === "workspace" && !assumptions && <Spinner label="Loading…" />}

      {pageTab === "saved" && <SavedAnalyses onOpen={openSaved} canManage={canManage} />}

      {pageTab === "data" && <WellData canManage={canManage} />}

      {saveOpen && analysis && assumptions && (
        <SaveModal
          existingId={openAnalysisId}
          existingName={openAnalysisName}
          wellIds={selected.map((w) => w.id)}
          assumptions={assumptions}
          result={analysis.result}
          onClose={() => setSaveOpen(false)}
          onSaved={(id, name) => { setOpenAnalysisId(id); setOpenAnalysisName(name); setSaveOpen(false); showToast("Analysis saved"); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace: wells card + assumptions card + results card
// ---------------------------------------------------------------------------

function Workspace(props: {
  selected: WellRow[];
  setSelected: (w: WellRow[]) => void;
  assumptions: Assumptions;
  setAssumptions: (a: Assumptions) => void;
  onResetAssumptions?: () => void;
  analysis: AnalyzeResponse | null;
  running: boolean;
  dirty: boolean;
  onRun: () => void;
  resultTab: ResultTab;
  setResultTab: (t: ResultTab) => void;
  openAnalysisName: string;
  reportRef: React.RefObject<HTMLDivElement>;
}) {
  const { selected, setSelected, assumptions, setAssumptions, onResetAssumptions, analysis, running, dirty, onRun, resultTab, setResultTab, openAnalysisName, reportRef } = props;
  const hasResult = analysis != null;

  return (
    <div className="va-workspace">
      <WellsCard selected={selected} setSelected={setSelected} openAnalysisName={openAnalysisName} />

      <section className="va-card va-assume">
        <div className="va-card-head">
          <h3>Assumptions</h3>
          {onResetAssumptions && <button type="button" className="link-btn va-reset" onClick={onResetAssumptions}>Reset defaults</button>}
        </div>
        <AssumptionsForm a={assumptions} onChange={setAssumptions} />
        <div className="va-run">
          <button className={`primary ${hasResult && !dirty && !running ? "va-run-clean" : ""}`} disabled={running || selected.length === 0} onClick={onRun}>
            {running ? "Running analysis…" : !hasResult ? "Run analysis" : dirty ? "Re-run with current assumptions" : "Re-run analysis"}
          </button>
          {selected.length === 0 && <span className="va-run-hint">Select at least one well to run.</span>}
          {selected.length > 0 && hasResult && (dirty
            ? <span className="va-run-hint warn">Wells or assumptions changed since the last run.</span>
            : <span className="va-run-hint">Adjust any assumption and re-run to see the impact immediately.</span>)}
        </div>
      </section>

      {running && <Spinner label="Fitting decline curves and running economics…" />}

      {analysis && !running && (
        <Results
          analysis={analysis}
          tab={resultTab}
          setTab={setResultTab}
          reportRef={reportRef}
          analysisName={openAnalysisName}
        />
      )}
    </div>
  );
}

/** "Wells in this analysis": chip row + Add well search popover + the selected well's full record. */
function WellsCard({ selected, setSelected, openAnalysisName }: { selected: WellRow[]; setSelected: (w: WellRow[]) => void; openAnalysisName: string }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recOpen, setRecOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const active = selected.find((w) => w.id === activeId) ?? selected[0] ?? null;

  useEffect(() => {
    if (!adding) return;
    const onDoc = (e: MouseEvent) => { if (addRef.current && !addRef.current.contains(e.target as Node)) setAdding(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAdding(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [adding]);

  return (
    <section className="va-card va-wells">
      <div className="va-chips">
        <span className="va-chips-label">Wells in this analysis{openAnalysisName && <span className="va-open-name"> · {openAnalysisName}</span>}</span>
        {selected.map((w) => (
          <span key={w.id} className={`va-chip ${active?.id === w.id ? "on" : ""}`} title={`${w.county} Co, ${w.state} · ${w.operator ?? "unknown operator"}`}>
            <button type="button" className="va-chip-name" onClick={() => { setActiveId(w.id); setRecOpen(true); }} aria-pressed={active?.id === w.id}>{w.name}</button>
            <button type="button" className="va-chip-x" aria-label={`Remove ${w.name}`} onClick={() => setSelected(selected.filter((s) => s.id !== w.id))}>×</button>
          </span>
        ))}
        <div className="va-add" ref={addRef}>
          <button type="button" className="va-add-btn" onClick={() => setAdding((o) => !o)} aria-expanded={adding}>+ Add well</button>
          {adding && (
            <WellPicker
              selected={selected}
              onAdd={(w) => { setSelected([...selected, w]); setActiveId(w.id); setRecOpen(true); setAdding(false); }}
              onClose={() => setAdding(false)}
            />
          )}
        </div>
      </div>

      {!active ? (
        <div className="va-wells-empty">No wells yet. Use <b>Add well</b> to search by API, RRC lease no, well/lease name, operator, county, survey or abstract.</div>
      ) : (
        <>
          <div className="va-rec-head" role="button" tabIndex={0} aria-expanded={recOpen}
            onClick={() => setRecOpen((o) => !o)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setRecOpen((o) => !o); } }}>
            <div className="va-rec-id">
              <span className="va-rec-name">{active.name}</span>
              <span className="va-rec-loc">{active.apiNumber && <>API {active.apiNumber} · </>}{active.county} Co, {active.state}</span>
              <Tag tone={statusTone(active.status)} dot>{prettyEnum(active.status)}</Tag>
            </div>
            <span className="va-rec-toggle">{recOpen ? "Hide record" : "Show full record"}</span>
          </div>
          {recOpen && <WellRecord key={active.id} well={active} />}
        </>
      )}
    </section>
  );
}

// --- Well picker (inside the Add well popover) --------------------------------

interface RrcCandidate { fid: number; api: string | null; name: string; operator: string | null; county: string; type: string | null; status: string | null; hasProduction: boolean }

function WellPicker({ selected, onAdd, onClose }: { selected: WellRow[]; onAdd: (w: WellRow) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<WellRow[]>([]);
  const [rrc, setRrc] = useState<RrcCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearching(true);
      // Search the org's analysis wells AND the imported RRC dataset (all
      // counties from the B5 pipeline) in one pass — every imported well is
      // reachable here without any separate import step.
      Promise.all([
        api.get<Paged<WellRow>>(`/wells?q=${encodeURIComponent(q)}&pageSize=8`),
        // 3 is the server's minimum (routes/wells.ts): below one full trigram
        // the search can't use its indexes, so shorter terms are not sent.
        q.trim().length >= 3 ? api.get<RrcCandidate[]>(`/wells/rrc-search?q=${encodeURIComponent(q)}`).catch(() => [] as RrcCandidate[]) : Promise.resolve([] as RrcCandidate[]),
      ])
        .then(([r, rr]) => {
          setResults(r.rows); setTotal(r.total);
          // Hide RRC candidates already present as org analysis wells.
          const apis = new Set(r.rows.map((x) => (x.apiNumber ?? "").replace(/\D/g, "")));
          setRrc(rr.filter((c) => !c.api || !apis.has(c.api.replace(/\D/g, ""))));
        })
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function addRrc(c: RrcCandidate) {
    setImporting(c.fid);
    try {
      const d = await api.post<{ well: WellRow }>(`/wells/import-rrc`, { fid: c.fid });
      // Selection made — the popover closes, like every dropdown in the app.
      if (!selected.some((s) => s.id === d.well.id)) onAdd(d.well);
      else onClose();
    } catch { /* surfaced by empty state */ }
    finally { setImporting(null); }
  }

  const selectedIds = new Set(selected.map((w) => w.id));
  const addable = results.filter((r) => !selectedIds.has(r.id));

  return (
    <div className="va-add-pop" role="dialog" aria-label="Add a well">
      <div className="va-add-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
        <input
          autoFocus
          value={q}
          placeholder="Search by API, RRC lease no, well/lease name, operator, county, survey, abstract…"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search wells"
        />
      </div>
      <div className="va-add-list">
        {searching && <div className="va-add-empty">Searching…</div>}
        {!searching && addable.length === 0 && rrc.length === 0 && <div className="va-add-empty">{total === 0 ? "No wells found in your list or the imported RRC data." : "All matching wells already selected."}</div>}
        {!searching && addable.map((w) => (
          <button type="button" className="va-add-opt" key={w.id} onClick={() => onAdd(w)}>
            <span className="va-add-name">{w.name}{w.apiNumber && <span className="va-add-api"> · API {w.apiNumber}</span>}</span>
            <span className="va-add-sub">
              {w.operator ?? "Unknown operator"} · {w.county} Co, {w.state}
              {w.production && w.production.months > 0 && <> · {w.production.months} months of production {w.production.firstMonth && <>({w.production.firstMonth} → {w.production.lastMonth})</>}</>}
              {(!w.production || w.production.months === 0) && <> · no production data</>}
            </span>
          </button>
        ))}
        {!searching && rrc.length > 0 && (
          <>
            <div className="va-add-section">From imported RRC data · auto-syncs on open</div>
            {rrc.map((c) => (
              <button type="button" className="va-add-opt" key={c.fid} onClick={() => void addRrc(c)}>
                <span className="va-add-name">{c.name}{c.api && <span className="va-add-api"> · API {c.api}</span>}</span>
                <span className="va-add-sub">
                  {c.operator ?? "Unknown operator"} · {c.county} Co, TX · {c.type ?? "—"}
                  {c.hasProduction ? " · production history available" : " · no production on file"}
                  {importing === c.fid && " · importing…"}
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// --- Well record: the full centralized record for the selected well ----------

interface Dossier {
  wellId: string;
  linked: boolean;
  identity: { api8: string | null; api10: string | null; wellNo: string | null; rrcWellId: string | null; fid: number | null; name: string; county: string; district: string | null; state: string; abstract: string | null; survey: string | null; latitude: number | null; longitude: number | null };
  status: { symbol: string | null; type: string | null; status: string | null; category: string | null; oilGas: string | null; spudDate: string | null; plugDate: string | null; lastProd: string | null };
  formations: string[];
  field: { fieldNo: string | null; fieldName: string | null; reservoirs: { district: string; fieldNo: string; name: string; type: string | null }[] };
  lease: { leaseNo: string; leaseName: string | null; district: string | null; ogCode: string; wellsOnLease: number; production: { months: number; firstMonth: string | null; lastMonth: string | null; cumOilBbl: number; cumGasMcf: number } | null } | null;
  operators: { current: { operatorNo: string | null; name: string | null }; history: { operatorNo: string | null; name: string | null; source: "production" | "permit"; from: string | null; to: string | null }[] };
  permits: { statusNo: string; permitDate: string | null; operator: string | null; operatorNo: string | null; leaseName: string | null; wellNo: string | null; district: string | null }[];
  completions: { trackingNo: string; filingType: string | null; status: string | null; filedDate: string | null; completionDate: string | null; operatorNo: string | null; fieldName: string | null; wellName: string | null; wellNo: string | null; survey: string | null }[];
  wellbore: { laterals: { fid: number; type: string | null; lengthFt: number }[]; totalLateralFt: number };
  cumulative: { oilBbl: number | null; gasMcf: number | null } | null;
  nearby: { fid: number; api: string | null; name: string; operator: string | null; status: string | null; type: string | null; distanceFt: number }[];
  offsetOperators: string[];
  links: { rrcWellboreQuery: string; rrcGisViewer: string; rrcDrillingPermits: string } | null;
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (value == null || value === "" || value === "—") ? null : (
    <div className="va-fact"><span className="va-fact-l">{label}</span><span className="va-fact-v">{value}</span></div>
  );
}

/** A record sub-section: small heading + a bordered, scrollable table. */
function RecTable({ title, head, children }: { title: ReactNode; head: ReactNode; children: ReactNode }) {
  return (
    <div className="va-rec-sec">
      <span className="va-rec-sec-t">{title}</span>
      <div className="dossier-table-wrap">
        <table className="dossier-table">
          <thead><tr>{head}</tr></thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The complete centralized record for one well — identity, status, lease,
 * operators, permits, completions, wellbore, nearby/offset wells — loaded
 * lazily the first time it is shown, no separate import.
 */
function WellRecord({ well }: { well: WellRow }) {
  const [d, setD] = useState<Dossier | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (d || loading) return;
    setLoading(true);
    api.get<Dossier>(`/wells/${well.id}/dossier`).then(setD).catch(() => {}).finally(() => setLoading(false));
  }, [d, loading, well.id]);

  return (
    <div className="va-rec-body">
      {loading && <Spinner label="Loading full well record…" />}
      {!loading && d && (
        <>
          <div className="va-facts">
            <Kv label="API (10)" value={d.identity.api10} />
            <Kv label="API (8)" value={d.identity.api8} />
            <Kv label="RRC lease no" value={d.lease?.leaseNo} />
            <Kv label="Well no" value={d.identity.wellNo} />
            <Kv label="District" value={d.identity.district} />
            <Kv label="County" value={`${d.identity.county}, ${d.identity.state}`} />
            <Kv label="Abstract" value={d.identity.abstract ? formatAbstract({ abstract: d.identity.abstract, survey: d.identity.survey, county: d.identity.county, state: d.identity.state }) : null} />
            <Kv label="Survey" value={d.identity.survey} />
            <Kv label="Surface location" value={d.identity.latitude != null ? `${d.identity.latitude.toFixed(5)}, ${d.identity.longitude?.toFixed(5)}` : null} />
            <Kv label="Well type" value={[d.status.oilGas, d.status.type].filter(Boolean).join(" · ") || null} />
            <Kv label="Status" value={d.status.status} />
            <Kv label="Spud date" value={d.status.spudDate && fmtDate(d.status.spudDate)} />
            <Kv label="Plug date" value={d.status.plugDate && fmtDate(d.status.plugDate)} />
            <Kv label="Last production" value={d.status.lastProd} />
            <Kv label="Field" value={d.field.fieldName && `${d.field.fieldName}${d.field.fieldNo ? ` (#${d.field.fieldNo})` : ""}`} />
            <Kv label="Reservoir(s)" value={d.field.reservoirs.length ? <ChipList items={d.field.reservoirs.map((r) => `${r.name}${r.type ? ` (${r.type})` : ""}`)} /> : null} />
            <Kv label="Operator (current)" value={d.operators.current.name && `${d.operators.current.name}${d.operators.current.operatorNo ? ` · P-5 #${d.operators.current.operatorNo}` : ""}`} />
            <Kv label="Wellbore" value={d.wellbore.laterals.length ? `${d.wellbore.laterals.length} lateral${d.wellbore.laterals.length > 1 ? "s" : ""} · ${fmtVol(d.wellbore.totalLateralFt)} ft mapped` : null} />
            <Kv label="RRC cumulative" value={d.cumulative ? `${fmtVol(d.cumulative.oilBbl)} bbl oil · ${fmtVol(d.cumulative.gasMcf)} mcf gas` : null} />
          </div>

          {(d.formations.length > 0 || d.links) && (
            <div className="va-rec-meta">
              {d.formations.length > 0 && (
                <div className="va-rec-sec">
                  <span className="va-rec-sec-t">Formations</span>
                  <div className="va-formations">{d.formations.map((f, i) => <span key={`${f}-${i}`} className="va-formation">{f}</span>)}</div>
                </div>
              )}
              {d.links && (
                <div className="va-rec-sec">
                  <span className="va-rec-sec-t">Railroad Commission</span>
                  <div className="va-rrc-links">
                    <a href={d.links.rrcWellboreQuery} target="_blank" rel="noreferrer">Wellbore query ↗</a>
                    <a href={d.links.rrcDrillingPermits} target="_blank" rel="noreferrer">Drilling permits ↗</a>
                    <a href={d.links.rrcGisViewer} target="_blank" rel="noreferrer">GIS viewer ↗</a>
                  </div>
                </div>
              )}
            </div>
          )}

          {d.lease && (
            <div className="va-rec-sec">
              <span className="va-rec-sec-t">Lease</span>
              <span className="va-rec-text">
                {d.lease.leaseName ?? "Lease"} · #{d.lease.leaseNo} ({d.lease.ogCode === "G" ? "gas" : "oil"}, District {d.lease.district}) · {d.lease.wellsOnLease} well{d.lease.wellsOnLease === 1 ? "" : "s"} on lease
                {d.lease.production && <> · {d.lease.production.months} months of production ({d.lease.production.firstMonth} → {d.lease.production.lastMonth}) · cum {fmtVol(d.lease.production.cumOilBbl)} bbl / {fmtVol(d.lease.production.cumGasMcf)} mcf</>}
              </span>
            </div>
          )}

          {d.nearby.length > 0 && (
            <div className="va-rec-sec">
              <RecTable title="Nearby wells · within 1 mile" head={<><th>Well</th><th>API</th><th>Operator</th><th>Status</th><th className="right">Distance</th></>}>
                {d.nearby.map((n) => (
                  <tr key={n.fid}><td className="strong">{n.name}</td><td className="dim">{n.api ?? "—"}</td><td>{n.operator ?? "—"}</td><td><span className={`va-rrc-status ${rrcStatusClass(n.status)}`}>{n.status ?? "—"}</span></td><td className="right">{fmtVol(n.distanceFt)} ft</td></tr>
                ))}
              </RecTable>
              {d.offsetOperators.length > 0 && (
                <div className="va-offsets"><span className="va-rec-sec-t">Offset operators</span><ChipList items={d.offsetOperators} max={6} /></div>
              )}
            </div>
          )}

          {d.operators.history.length > 0 && (
            <RecTable title="Operator history" head={<><th>Operator</th><th>P-5 #</th><th>Source</th><th>From</th><th>To</th></>}>
              {d.operators.history.map((o, i) => (
                <tr key={i}><td>{o.name ?? "—"}</td><td>{o.operatorNo ?? "—"}</td><td>{o.source === "production" ? "Production era" : "At permit"}</td><td>{o.from ?? "—"}</td><td>{o.to ?? (o.source === "production" ? "—" : "")}</td></tr>
              ))}
            </RecTable>
          )}

          {d.permits.length > 0 && (
            <RecTable title={`Drilling permits (${d.permits.length})`} head={<><th>Date</th><th>Permit #</th><th>Operator</th><th>Lease</th><th>Well</th></>}>
              {d.permits.map((p) => (
                <tr key={p.statusNo}><td>{p.permitDate ? fmtDate(p.permitDate) : "—"}</td><td>{p.statusNo}</td><td>{p.operator ?? "—"}</td><td>{p.leaseName ?? "—"}</td><td>{p.wellNo ?? "—"}</td></tr>
              ))}
            </RecTable>
          )}

          {d.completions.length > 0 && (
            <RecTable title={`Completion filings (${d.completions.length})`} head={<><th>Completed</th><th>Filed</th><th>Form</th><th>Status</th><th>Field</th><th>Survey</th></>}>
              {d.completions.map((c) => (
                <tr key={c.trackingNo}><td>{c.completionDate ? fmtDate(c.completionDate) : "—"}</td><td>{c.filedDate ? fmtDate(c.filedDate) : "—"}</td><td>{c.filingType ?? "—"}</td><td>{c.status ?? "—"}</td><td>{c.fieldName ?? "—"}</td><td>{c.survey ?? "—"}</td></tr>
              ))}
            </RecTable>
          )}

          {!d.linked && (
            <div className="va-rec-note">
              This well isn't linked to the centralized RRC dataset (no matching API) — showing the attributes on file.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- Assumptions form ------------------------------------------------------

function NumField({ label, value, onChange, step = 1, prefix, suffix, allowNull, hint }: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  prefix?: string;
  suffix?: string;
  allowNull?: boolean;
  hint?: string;
}) {
  // Units sit inside the field: a "$" prefix on the left, or the unit on the right.
  const unit = suffix ? `${prefix ?? ""}${suffix}` : null;
  const pre = !suffix && prefix ? prefix : null;
  return (
    <div className="va-num">
      <label title={hint}>{label}</label>
      <div className={`va-affix ${pre ? "has-pre" : ""} ${unit ? "has-suf" : ""}`} title={hint}>
        {pre && <span className="va-pre" aria-hidden="true">{pre}</span>}
        <input
          type="number"
          step={step}
          value={value ?? ""}
          placeholder={allowNull ? "—" : undefined}
          aria-label={label}
          onChange={(e) => {
            const s = e.target.value;
            if (s === "") { onChange(allowNull ? null : 0); return; }
            const n = Number(s);
            if (Number.isFinite(n)) onChange(n);
          }}
        />
        {unit && <span className="va-suf" aria-hidden="true">{unit}</span>}
      </div>
    </div>
  );
}

function AssumptionsForm({ a, onChange }: { a: Assumptions; onChange: (a: Assumptions) => void }) {
  const [advOpen, setAdvOpen] = useState(false);
  const set = <K extends keyof Assumptions>(k: K, v: Assumptions[K]) => onChange({ ...a, [k]: v });
  const setOverride = (phase: "oil" | "gas", key: "b" | "diAnnual", v: number | null) => {
    const cur = a.declineOverride ?? {};
    const phaseCur = { ...(cur[phase] ?? {}) };
    if (v == null) delete phaseCur[key];
    else phaseCur[key] = v;
    const next = { ...cur, [phase]: Object.keys(phaseCur).length ? phaseCur : undefined };
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, val]) => val !== undefined));
    onChange({ ...a, declineOverride: Object.keys(cleaned).length ? cleaned : null });
  };

  return (
    <>
      <div className="assumption-groups">
        <div className="assumption-group">
          <div className="assumption-group-title">Commodity prices</div>
          <div className="assumption-grid">
            <NumField label="Oil" value={a.oilPrice} onChange={(v) => set("oilPrice", v ?? 0)} step={1} suffix="$/bbl" />
            <NumField label="Gas" value={a.gasPrice} onChange={(v) => set("gasPrice", v ?? 0)} step={0.1} suffix="$/mcf" />
            <NumField label="NGL" value={a.nglPrice} onChange={(v) => set("nglPrice", v ?? 0)} step={1} suffix="$/bbl" />
            <NumField label="Price escalation" value={a.priceEscalationPct} onChange={(v) => set("priceEscalationPct", v ?? 0)} step={0.5} suffix="%/yr" />
          </div>
        </div>
        <div className="assumption-group">
          <div className="assumption-group-title">Acquisition &amp; returns</div>
          <div className="assumption-grid">
            <NumField label="Asking price" value={a.askingPrice} onChange={(v) => set("askingPrice", v ?? 0)} step={1000} prefix="$" />
            <NumField label="Closing costs" value={a.closingCosts} onChange={(v) => set("closingCosts", v ?? 0)} step={500} prefix="$" />
            <NumField label="Discount rate" value={a.discountRatePct} onChange={(v) => set("discountRatePct", v ?? 10)} step={0.5} suffix="%" />
            <NumField label="Target ROI" value={a.targetRoiPct} onChange={(v) => set("targetRoiPct", v)} step={5} suffix="%" allowNull hint="Total return on investment over the property's life (blank = no constraint)" />
            <NumField label="Target profit" value={a.targetProfitAmount} onChange={(v) => set("targetProfitAmount", v)} step={5000} prefix="$" allowNull />
            <NumField label="Resale price" value={a.resalePrice} onChange={(v) => set("resalePrice", v)} step={5000} prefix="$" allowNull hint="Expected flip/resale price (optional)" />
            <NumField label="Resale margin target" value={a.targetProfitMarginPct} onChange={(v) => set("targetProfitMarginPct", v)} step={1} suffix="%" allowNull hint="Desired profit as % of resale price" />
          </div>
        </div>
      </div>

      <button type="button" className="va-adv-toggle" aria-expanded={advOpen} onClick={() => setAdvOpen((o) => !o)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: advOpen ? "rotate(90deg)" : undefined }}><path d="M9 6l6 6-6 6" /></svg>
        Forecast controls &amp; manual decline override
      </button>
      {advOpen && (
        <div className="va-adv">
          <div className="assumption-group-title">Forecast</div>
          <div className="assumption-grid">
            <NumField label="Max forecast" value={a.maxForecastMonths} onChange={(v) => set("maxForecastMonths", v ?? 360)} step={12} suffix="mo" />
            <NumField label="Economic limit" value={a.economicLimitNetCashFlow} onChange={(v) => set("economicLimitNetCashFlow", v ?? 0)} step={50} prefix="$" suffix="/mo" hint="Stop the forecast when monthly net cash flow falls below this" />
            <NumField label="Oil decline (Di)" value={a.declineOverride?.oil?.diAnnual != null ? round4(a.declineOverride.oil.diAnnual * 100) : null} onChange={(v) => setOverride("oil", "diAnnual", v == null ? null : v / 100)} step={5} suffix="%/yr" allowNull hint="Manual nominal annual decline (blank = fit from data)" />
            <NumField label="Oil b-factor" value={a.declineOverride?.oil?.b ?? null} onChange={(v) => setOverride("oil", "b", v)} step={0.1} allowNull hint="0 = exponential, 1 = harmonic" />
            <NumField label="Gas decline (Di)" value={a.declineOverride?.gas?.diAnnual != null ? round4(a.declineOverride.gas.diAnnual * 100) : null} onChange={(v) => setOverride("gas", "diAnnual", v == null ? null : v / 100)} step={5} suffix="%/yr" allowNull />
            <NumField label="Gas b-factor" value={a.declineOverride?.gas?.b ?? null} onChange={(v) => setOverride("gas", "b", v)} step={0.1} allowNull />
          </div>
        </div>
      )}
    </>
  );
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const RESULT_TABS: [ResultTab, string][] = [
  ["production", "Production history"], ["forecast", "Decline & forecast"], ["cashflow", "Financials"],
  ["valuation", "Valuation & offer"], ["sensitivity", "Sensitivity"], ["report", "Full report"],
];

function Results({ analysis, tab, setTab, reportRef, analysisName }: {
  analysis: AnalyzeResponse;
  tab: ResultTab;
  setTab: (t: ResultTab) => void;
  reportRef: React.RefObject<HTMLDivElement>;
  analysisName: string;
}) {
  const r = analysis.result;
  const v = r.valuation;
  const e = r.economics;

  const headline: StatCell[] = [
    { label: "Fair market value", value: fmtMoneyC(v.fairMarketValue), sub: `PV @ ${r.assumptions.discountRatePct}% · PV10 ${fmtMoneyC(v.pv10)}` },
    { label: "Recommended offer", value: fmtMoneyC(v.recommendedOffer), tone: "success", sub: v.offerVsAskingPct != null ? `${v.offerVsAskingPct >= 0 ? "+" : ""}${v.offerVsAskingPct.toFixed(0)}% vs asking` : "No asking price set" },
    {
      label: "NPV at asking", value: v.atAsking ? fmtMoneyC(v.atAsking.npv) : "—",
      tone: v.atAsking ? (v.atAsking.npv >= 0 ? "success" : "danger") : undefined,
      sub: e.investment > 0 ? `Investment ${fmtMoneyC(e.investment)}` : "Set an asking price",
    },
    { label: "IRR / ROI", value: `${fmtPct1(e.irrAnnualPct)} / ${e.roiPct != null ? fmtPct1(e.roiPct) : "—"}`, sub: e.paybackMonths != null ? `Payout in ${fmtMonths(e.paybackMonths)}` : "Payout beyond forecast" },
    { label: "Remaining life", value: r.forecast.remainingMonths > 0 ? fmtMonths(r.forecast.remainingMonths) : "—", sub: `${fmtVol(r.forecast.remaining.boe)} boe remaining` },
  ];

  return (
    <section className="va-card va-results">
      <div className="va-card-head va-results-head">
        <h3>Results</h3>
        <span className="va-run-at">Run {fmtDateTime(r.runAt)} · forecast <ConfBadge c={r.forecast.confidence} /></span>
      </div>
      <div className="va-results-top">
        {r.warnings.map((w, i) => (
          <div className="va-caveat" key={i}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
            <span>{w}</span>
          </div>
        ))}
        <StatStrip min={170} cells={headline} />
      </div>
      <div className="va-rtabs-wrap">
        <div className="tab-row va-tabs" role="tablist">
          {RESULT_TABS.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="va-results-body">
        {tab === "production" && <ProductionTab r={r} />}
        {tab === "forecast" && <ForecastTab r={r} />}
        {tab === "cashflow" && <CashFlowTab r={r} />}
        {tab === "valuation" && <ValuationTab r={r} />}
        {tab === "sensitivity" && <SensitivityTab r={r} />}
        {tab === "report" && (
          <div ref={reportRef} className="report-capture">
            <FullReport analysis={analysis} analysisName={analysisName} />
          </div>
        )}
      </div>
    </section>
  );
}

function ConfBadge({ c }: { c: "high" | "medium" | "low" }) {
  // Tinted capsule per the forecast confidence (green/amber/red).
  return <Tag tone={CONF_TONE[c]}>{CONF_LABEL[c]}</Tag>;
}

/** Chart / table card: title with optional Historical / Forecast tags, right-side control, footnote. */
function ChartCard({ title, hist, fc, right, note, children, className = "" }: {
  title: ReactNode; hist?: boolean; fc?: boolean; right?: ReactNode; note?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`va-chart ${className}`}>
      <div className="va-chart-head">
        <h4>{title}</h4>
        {hist && <span className="va-tag-hist">Historical</span>}
        {fc && <span className="va-tag-fc">Forecast</span>}
        {right && <span className="va-chart-right">{right}</span>}
      </div>
      {children}
      {note && <p className="va-note">{note}</p>}
    </section>
  );
}

// --- Chart data builders ----------------------------------------------------

interface SeriesPoint {
  month: string;
  histOil?: number; histGas?: number; histNgl?: number;
  fcOil?: number; fcGas?: number; fcNgl?: number;
  cumBoe?: number; fcCumBoe?: number;
}

function buildSeries(r: ValuationResult): SeriesPoint[] {
  const pts: SeriesPoint[] = [];
  let cum = 0;
  for (const m of r.history) {
    cum += m.oilBbl + m.nglBbl + m.gasMcf / 6;
    pts.push({ month: m.month, histOil: m.oilBbl, histGas: m.gasMcf, histNgl: m.nglBbl, cumBoe: cum });
  }
  // Bridge point so forecast lines connect to the last history point.
  if (pts.length && r.forecast.months.length) {
    const last = pts[pts.length - 1];
    last.fcOil = last.histOil; last.fcGas = last.histGas; last.fcNgl = last.histNgl; last.fcCumBoe = cum;
  }
  for (const m of r.forecast.months) {
    cum += m.oilBbl + m.nglBbl + m.gasMcf / 6;
    pts.push({ month: m.month, fcOil: m.oilBbl, fcGas: m.gasMcf, fcNgl: m.nglBbl, fcCumBoe: cum });
  }
  return pts;
}

interface AnnualCashRow { year: string; netCashFlow: number; cumNetCashFlow: number; grossRevenue: number; oilRevenue: number; gasRevenue: number; nglRevenue: number; taxes: number; opex: number }

function annualCash(r: ValuationResult): AnnualCashRow[] {
  const by = new Map<string, AnnualCashRow>();
  let cum = 0;
  for (const m of r.forecast.months) {
    const y = m.month.slice(0, 4);
    const row = by.get(y) ?? { year: y, netCashFlow: 0, cumNetCashFlow: 0, grossRevenue: 0, oilRevenue: 0, gasRevenue: 0, nglRevenue: 0, taxes: 0, opex: 0 };
    row.netCashFlow += m.netCashFlow;
    row.grossRevenue += m.grossRevenue;
    row.oilRevenue += m.oilRevenue;
    row.gasRevenue += m.gasRevenue;
    row.nglRevenue += m.nglRevenue;
    row.taxes += m.severanceTax + m.adValorem;
    row.opex += m.opex;
    cum += m.netCashFlow;
    row.cumNetCashFlow = cum;
    by.set(y, row);
  }
  return [...by.values()];
}

/** Vertical marker at the last reported (historical) month on history + forecast charts. */
function lastReportedLine(r: ValuationResult, yAxisId?: string) {
  const last = r.history.length ? r.history[r.history.length - 1].month : null;
  if (!last || !r.forecast.months.length) return null;
  return (
    <ReferenceLine x={last} {...(yAxisId ? { yAxisId } : {})} stroke="var(--line-hover-strong)" strokeDasharray="3 3"
      label={{ value: "Last reported", position: "insideTopLeft", fontSize: 10.5, fill: "var(--ink-3)" }} />
  );
}

// --- Production tab ---------------------------------------------------------

function ProductionTab({ r }: { r: ValuationResult }) {
  const p = r.production;
  const data = useMemo(() => r.history.map((m, i) => {
    let cum = 0;
    for (let k = 0; k <= i; k++) cum += r.history[k].oilBbl + r.history[k].nglBbl + r.history[k].gasMcf / 6;
    return { ...m, cumBoe: cum };
  }), [r.history]);

  if (!r.history.length) return <div className="va-empty">No production history for the selected wells.</div>;

  return (
    <div className="va-tab">
      <StatStrip min={170} cells={[
        { label: "History", value: `${p.monthsOfHistory} mo`, sub: `${p.firstMonth} → ${p.lastMonth} · ${p.producingMonths} producing` },
        { label: "Cumulative oil", value: fmtVol(p.oil.cumulative, " bbl"), sub: p.oil.peak ? `Peak ${fmtVol(p.oil.peak.volume)} bbl in ${p.oil.peak.month}` : undefined },
        { label: "Cumulative gas", value: fmtVol(p.gas.cumulative, " mcf"), sub: p.gas.peak ? `Peak ${fmtVol(p.gas.peak.volume)} mcf in ${p.gas.peak.month}` : undefined },
        { label: "Cumulative NGL", value: fmtVol(p.ngl.cumulative, " bbl") },
        { label: "Total (BOE)", value: fmtVol(p.cumBoe), sub: "6 mcf = 1 boe" },
      ]} />

      <div className="va-two">
        <ChartCard title="Monthly production" hist>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={data}>
              <Grid />
              <XAxis dataKey="month" tickFormatter={monthLabel} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={28} />
              <YAxis yAxisId="l" tick={AXIS_TICK} axisLine={false} tickLine={false} label={{ value: "bbl / month", angle: -90, position: "insideLeft", ...AXIS_LABEL }} />
              <YAxis yAxisId="r" orientation="right" tick={AXIS_TICK} axisLine={false} tickLine={false} label={{ value: "mcf / month", angle: 90, position: "insideRight", ...AXIS_LABEL }} />
              <Tooltip {...chartTooltip} labelFormatter={monthLabel} formatter={(val: number) => Math.round(val).toLocaleString()} />
              <Legend {...LEGEND_PROPS} />
              <Line yAxisId="l" dataKey="oilBbl" name="Oil (bbl)" stroke={COLOR_OIL} dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line yAxisId="r" dataKey="gasMcf" name="Gas (mcf)" stroke={COLOR_GAS} dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line yAxisId="l" dataKey="nglBbl" name="NGL (bbl)" stroke={COLOR_NGL} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Cumulative production (BOE)" hist>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={data}>
              <Grid />
              <XAxis dataKey="month" tickFormatter={monthLabel} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={28} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
              <Tooltip {...chartTooltip} labelFormatter={monthLabel} formatter={(val: number) => Math.round(val).toLocaleString()} />
              <Line dataKey="cumBoe" name="Cumulative BOE" stroke={COLOR_CUM} dot={false} strokeWidth={2} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="va-two">
        <ChartCard title="Annual production" hist>
          <div className="table-scroll va-table"><table className="data-table">
            <thead><tr><th>Year</th><th className="right">Oil (bbl)</th><th className="right">Gas (mcf)</th><th className="right">NGL (bbl)</th><th className="right">BOE</th></tr></thead>
            <tbody>
              {p.annual.map((a) => (
                <tr key={a.year}><td>{a.year}</td><td className="right">{fmtVol(a.oilBbl)}</td><td className="right">{fmtVol(a.gasMcf)}</td><td className="right">{fmtVol(a.nglBbl)}</td><td className="right">{fmtVol(a.boe)}</td></tr>
              ))}
            </tbody>
          </table></div>
        </ChartCard>
        <ChartCard title="Anomalies & notable events">
          {p.anomalies.length === 0 ? (
            <div className="va-clean"><i aria-hidden="true" />No significant anomalies detected — a clean, steady producer.</div>
          ) : (
            <ul className="anomaly-list va-anomalies">
              {p.anomalies.map((x, i) => (
                <li key={i}>
                  <Tag tone={x.kind === "DOWNTIME" ? "neutral" : x.kind === "SHARP_DROP" ? "danger" : "warn"}>{prettyEnum(x.kind)}</Tag>
                  <strong>{x.month}</strong>
                  <span className="va-anom-detail">{x.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </ChartCard>
      </div>
    </div>
  );
}

// --- Forecast tab -----------------------------------------------------------

function DeclineFitCard({ phase, unit, color, fit }: { phase: string; unit: string; color: string; fit: DeclineFit | null }) {
  if (!fit) return (
    <div className="fit-card">
      <div className="fit-title"><i className="va-phase-dot" style={{ background: color }} />{phase}</div>
      <p className="va-fit-none">No decline fit (insufficient or no production).</p>
    </div>
  );
  return (
    <div className="fit-card">
      <div className="fit-title"><i className="va-phase-dot" style={{ background: color }} />{phase} · {prettyEnum(fit.model)}{fit.manual ? " (manual)" : ""} <ConfBadge c={fit.confidence} /></div>
      <div className="fit-grid">
        <div className="kv"><span className="k">Nominal Di</span><span className="v">{(fit.diAnnualNominal * 100).toFixed(1)}%/yr</span></div>
        <div className="kv"><span className="k">b-factor</span><span className="v">{fit.b.toFixed(2)}</span></div>
        <div className="kv"><span className="k">Fit R²</span><span className="v">{fit.r2.toFixed(3)}</span></div>
        <div className="kv"><span className="k">Effective decline</span><span className="v">{(fit.diAnnualEffective * 100).toFixed(1)}%/yr</span></div>
        <div className="kv"><span className="k">Fit window</span><span className="v">{fit.fitStartMonth} → now ({fit.fitMonths} pts)</span></div>
        <div className="kv"><span className="k">Current rate</span><span className="v">{fmtVol(fit.currentRate)} {unit}/mo</span></div>
      </div>
    </div>
  );
}

function ForecastTab({ r }: { r: ValuationResult }) {
  const [logScale, setLogScale] = useState(false);
  const data = useMemo(() => buildSeries(r), [r]);
  const logSafe = useMemo(
    () => logScale ? data.map((d) => ({
      ...d,
      histOil: d.histOil && d.histOil > 0 ? d.histOil : undefined,
      histGas: d.histGas && d.histGas > 0 ? d.histGas : undefined,
      fcOil: d.fcOil && d.fcOil > 0 ? d.fcOil : undefined,
      fcGas: d.fcGas && d.fcGas > 0 ? d.fcGas : undefined,
    })) : data,
    [data, logScale],
  );
  const fc = r.forecast;

  return (
    <div className="va-tab">
      <StatStrip min={170} cells={[
        { label: "Remaining life", value: fc.remainingMonths > 0 ? fmtMonths(fc.remainingMonths) : "—", sub: fc.endReason === "ECONOMIC_LIMIT" ? `Economic limit ${fc.economicLimitMonth}` : fc.endReason === "MAX_MONTHS" ? "Capped at max forecast length" : "No decline fit" },
        { label: "Remaining oil", value: fmtVol(fc.remaining.oilBbl, " bbl"), sub: "Forecast recoverable" },
        { label: "Remaining gas", value: fmtVol(fc.remaining.gasMcf, " mcf"), sub: "Forecast recoverable" },
        { label: "Remaining BOE", value: fmtVol(fc.remaining.boe), sub: `EUR ${fmtVol(fc.eur.boe)} boe total` },
        { label: "Confidence", value: CONF_LABEL[fc.confidence].split(" ")[0], tone: CONF_TONE[fc.confidence], sub: "Based on fit quality & history length" },
      ]} />

      <ChartCard
        title="Production: history & forecast" hist fc
        right={
          <button type="button" className={`va-semilog ${logScale ? "on" : ""}`} aria-pressed={logScale} onClick={() => setLogScale((s) => !s)} title="Decline-curve view">
            <span className="va-mini-tgl" aria-hidden="true"><i /></span>Semi-log
          </button>
        }
        note={<>
          Solid lines are reported production; dashed lines are the Arps decline forecast under current assumptions.
          {fc.economicLimitMonth && <> Forecast ends at the economic limit in <strong>{fc.economicLimitMonth}</strong>.</>}
        </>}
      >
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={logSafe}>
            <Grid />
            <XAxis dataKey="month" tickFormatter={monthLabel} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={28} />
            <YAxis
              yAxisId="l" tick={AXIS_TICK} axisLine={false} tickLine={false} scale={logScale ? "log" : "auto"} domain={logScale ? ["auto", "auto"] : [0, "auto"]}
              allowDataOverflow label={{ value: "bbl / month", angle: -90, position: "insideLeft", ...AXIS_LABEL }}
            />
            <YAxis
              yAxisId="r" orientation="right" tick={AXIS_TICK} axisLine={false} tickLine={false} scale={logScale ? "log" : "auto"} domain={logScale ? ["auto", "auto"] : [0, "auto"]}
              allowDataOverflow label={{ value: "mcf / month", angle: 90, position: "insideRight", ...AXIS_LABEL }}
            />
            <Tooltip {...chartTooltip} labelFormatter={monthLabel} formatter={(val: number) => Math.round(val).toLocaleString()} />
            <Legend {...LEGEND_PROPS} />
            {lastReportedLine(r, "l")}
            <Line yAxisId="l" dataKey="histOil" name="Oil (actual)" stroke={COLOR_OIL} dot={false} strokeWidth={2} isAnimationActive={false} />
            <Line yAxisId="l" dataKey="fcOil" name="Oil (forecast)" stroke={COLOR_OIL} dot={false} strokeWidth={2} strokeDasharray={FC_DASH} isAnimationActive={false} />
            <Line yAxisId="r" dataKey="histGas" name="Gas (actual)" stroke={COLOR_GAS} dot={false} strokeWidth={2} isAnimationActive={false} />
            <Line yAxisId="r" dataKey="fcGas" name="Gas (forecast)" stroke={COLOR_GAS} dot={false} strokeWidth={2} strokeDasharray={FC_DASH} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="va-two">
        <ChartCard title="Cumulative BOE: history & forecast" hist fc>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={data}>
              <Grid />
              <XAxis dataKey="month" tickFormatter={monthLabel} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={28} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
              <Tooltip {...chartTooltip} labelFormatter={monthLabel} formatter={(val: number) => Math.round(val).toLocaleString()} />
              <Legend {...LEGEND_PROPS} />
              {lastReportedLine(r)}
              <Line dataKey="cumBoe" name="Cumulative (actual)" stroke={COLOR_CUM} dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line dataKey="fcCumBoe" name="Cumulative (forecast)" stroke={COLOR_CUM} dot={false} strokeWidth={2} strokeDasharray={FC_DASH} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Decline curve fits">
          <div className="va-fits">
            <DeclineFitCard phase="Oil" unit="bbl" color={COLOR_OIL} fit={r.decline.oil} />
            <DeclineFitCard phase="Gas" unit="mcf" color={COLOR_GAS} fit={r.decline.gas} />
            <DeclineFitCard phase="NGL" unit="bbl" color={COLOR_NGL} fit={r.decline.ngl} />
          </div>
        </ChartCard>
      </div>
    </div>
  );
}

// --- Cash flow tab ----------------------------------------------------------

function CashFlowTab({ r }: { r: ValuationResult }) {
  const e = r.economics;
  const rows = useMemo(() => annualCash(r), [r]);
  const paybackYear = useMemo(() => {
    if (e.paybackMonths == null || !r.forecast.months.length) return null;
    return r.forecast.months[Math.min(e.paybackMonths - 1, r.forecast.months.length - 1)].month.slice(0, 4);
  }, [e.paybackMonths, r.forecast.months]);

  if (!r.forecast.months.length) return <div className="va-empty">No forecast months — nothing to project financially.</div>;

  return (
    <div className="va-tab">
      <StatStrip min={170} cells={[
        { label: "Gross revenue", value: fmtMoneyC(e.grossRevenueTotal), sub: "8/8ths, life of forecast" },
        { label: "Net cash flow", value: fmtMoneyC(e.netCashFlowTotal), tone: e.netCashFlowTotal < 0 ? "danger" : undefined, sub: "Undiscounted, life of forecast" },
        { label: `PV @ ${r.assumptions.discountRatePct}%`, value: fmtMoneyC(e.presentValue), sub: `PV10 ${fmtMoneyC(e.pv10)}` },
        { label: "Avg cash flow (yr 1)", value: `${fmtMoneyC(e.monthlyCashFlowFirstYearAvg)}/mo` },
      ]} />

      <div className="va-two">
        <ChartCard title="Annual net cash flow" fc
          note={paybackYear ? <>Cumulative cash flow crosses the investment in <strong>{paybackYear}</strong> ({fmtMonths(e.paybackMonths)}).</> : undefined}>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={rows}>
              <Grid />
              <XAxis dataKey="year" tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={(val: number) => fmtMoneyC(val)} width={70} />
              <Tooltip {...chartTooltip} formatter={(val: number) => money(val)} />
              <Legend {...LEGEND_PROPS} />
              <Bar dataKey="netCashFlow" name="Net cash flow" fill={COLOR_CASH} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Line dataKey="cumNetCashFlow" name="Cumulative" stroke={COLOR_CUM} dot={false} strokeWidth={2} isAnimationActive={false} />
              {e.investment > 0 && <ReferenceLine y={e.investment} stroke="var(--danger)" strokeDasharray="4 4" label={{ value: "Investment", fontSize: 11, fill: "var(--danger-ink)" }} />}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Annual revenue by commodity" fc note="Gross (8/8ths) revenue at assumed prices before interest, taxes and costs.">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={rows}>
              <Grid />
              <XAxis dataKey="year" tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={(val: number) => fmtMoneyC(val)} width={70} />
              <Tooltip {...chartTooltip} formatter={(val: number) => money(val)} />
              <Legend {...LEGEND_PROPS} />
              <Bar dataKey="oilRevenue" name="Oil" stackId="rev" fill={COLOR_OIL} isAnimationActive={false} />
              <Bar dataKey="gasRevenue" name="Gas" stackId="rev" fill={COLOR_GAS} isAnimationActive={false} />
              <Bar dataKey="nglRevenue" name="NGL" stackId="rev" fill={COLOR_NGL} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Annual cash flow detail" fc>
        <div className="table-scroll va-table va-table-tall"><table className="data-table">
          <thead><tr><th>Year</th><th className="right">Gross revenue</th><th className="right">Net cash flow</th><th className="right">Cumulative</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.year}>
                <td>{row.year}</td>
                <td className="right">{money(row.grossRevenue)}</td>
                <td className={`right ${row.netCashFlow < 0 ? "va-neg" : ""}`}>{money(row.netCashFlow)}</td>
                <td className={`right ${row.cumNetCashFlow < 0 ? "va-neg" : ""}`}>{money(row.cumNetCashFlow)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </ChartCard>
    </div>
  );
}

// --- Valuation tab ----------------------------------------------------------

function ValuationTab({ r }: { r: ValuationResult }) {
  const v = r.valuation;
  const e = r.economics;
  const a = r.assumptions;

  return (
    <div className="va-tab">
      <div className="va-two">
        <ChartCard title="Acquisition valuation">
          <div className="va-vrows">
            <ValRow label="Fair market value" value={money(v.fairMarketValue)} hint={`PV of forecast cash flows @ ${a.discountRatePct}%`} calc />
            <ValRow label="PV10 (reference)" value={money(v.pv10)} hint="Industry-standard 10% discount" calc />
            <ValRow label="Undiscounted net cash flow" value={money(e.netCashFlowTotal)} calc />
            <ValRow label="Seller's asking price" value={a.askingPrice > 0 ? money(a.askingPrice) : "—"} hint="Your input" />
            <ValRow label="Closing costs" value={a.closingCosts > 0 ? money(a.closingCosts) : "—"} hint="Your input" />
            <ValRow label="Maximum purchase price" value={money(v.maxPurchasePrice)} hint="Highest price meeting all your targets" calc strong />
          </div>
          <div className="va-offerbox">
            <div className="va-offerbox-label">Recommended offer</div>
            <div className="va-offerbox-value">{money(v.recommendedOffer)}</div>
            <div className="va-offerbox-sub">
              {money(Math.max(0, v.fairMarketValue - v.recommendedOffer))} margin of safety vs fair value
              {v.offerVsAskingPct != null && <> · {v.offerVsAskingPct >= 0 ? "+" : ""}{v.offerVsAskingPct.toFixed(1)}% vs asking</>}
            </div>
          </div>
          {v.askingPriceAssessment && (
            <Banner kind={v.askingPriceAssessment === "ABOVE_VALUE" ? "warn" : "info"}>
              {v.askingPriceAssessment === "ABOVE_VALUE" && <>The asking price is <strong>above</strong> the estimated fair market value — negotiate down or pass.</>}
              {v.askingPriceAssessment === "NEAR_VALUE" && <>The asking price is <strong>near</strong> the estimated fair market value.</>}
              {v.askingPriceAssessment === "BELOW_VALUE" && <>The asking price is <strong>below</strong> the estimated fair market value — potentially attractive.</>}
            </Banner>
          )}
        </ChartCard>

        <ChartCard title="Returns & margin">
          <div className="va-vrows">
            <ValRow label="NPV at asking price" value={v.atAsking ? money(v.atAsking.npv) : "—"} calc />
            <ValRow label="ROI at asking price" value={v.atAsking?.roiPct != null ? fmtPct1(v.atAsking.roiPct) : "—"} calc />
            <ValRow label="Payout at asking price" value={v.atAsking ? fmtMonths(v.atAsking.paybackMonths) : "—"} calc />
            <ValRow label="IRR (annualized)" value={fmtPct1(e.irrAnnualPct)} calc />
            <ValRow label="Break-even price deck" value={e.breakEvenPriceFactor != null ? `${(e.breakEvenPriceFactor * 100).toFixed(0)}% of assumed prices` : "—"} hint={e.breakEvenOilPrice != null ? `≈ ${money(e.breakEvenOilPrice)}/bbl oil` : undefined} calc />
          </div>

          {a.resalePrice != null && a.resalePrice > 0 ? (
            <>
              <div className="va-sub-title">Resale scenario (at {money(a.resalePrice)})</div>
              <div className="va-vrows">
                <ValRow label="Expected gross profit" value={v.expectedGrossProfit != null ? money(v.expectedGrossProfit) : "—"} calc />
                <ValRow label="Expected net profit" value={v.expectedNetProfit != null ? money(v.expectedNetProfit) : "—"} hint="After closing costs" calc strong />
                <ValRow label="Projected ROI at resale" value={fmtPct1(v.resaleRoiPct)} calc />
                <ValRow label="Profit margin" value={fmtPct1(v.resaleMarginPct)} hint={a.targetProfitMarginPct != null ? `Target ${a.targetProfitMarginPct}%` : undefined} calc />
              </div>
            </>
          ) : (
            <p className="va-note">Set a resale price in the assumptions to model a wholesale flip (profit, margin and buyer ROI).</p>
          )}
        </ChartCard>
      </div>
      <p className="va-note va-legend-line">
        <span className="va-vtag input">Input</span> values come from your assumptions;{" "}
        <span className="va-vtag calc">Calculated</span> values are derived from the production forecast.
      </p>
    </div>
  );
}

function ValRow({ label, value, hint, calc, strong }: { label: string; value: string; hint?: string; calc?: boolean; strong?: boolean }) {
  return (
    <div className={`va-vrow ${strong ? "strong" : ""}`}>
      <div className="va-vrow-l">
        <span className="va-vrow-label">{label} <span className={`va-vtag ${calc ? "calc" : "input"}`}>{calc ? "Calculated" : "Input"}</span></span>
        {hint && <span className="va-vrow-hint">{hint}</span>}
      </div>
      <span className="va-vrow-v">{value}</span>
    </div>
  );
}

// --- Sensitivity tab ---------------------------------------------------------

function SensitivityTab({ r }: { r: ValuationResult }) {
  return (
    <div className="va-tab">
      <div className="va-two">
        <ChartCard title="NPV by price scenario" note="All commodity prices scaled together; every scenario re-runs the full forecast, so remaining life shifts too.">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={r.sensitivity}>
              <Grid />
              <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={(val: number) => fmtMoneyC(val)} width={70} />
              <Tooltip {...chartTooltip} formatter={(val: number) => money(val)} />
              <ReferenceLine y={0} stroke="var(--line-hover)" />
              <Bar dataKey="npv" name="NPV" radius={[3, 3, 0, 0]} maxBarSize={56} isAnimationActive={false}>
                {r.sensitivity.map((s, i) => <Cell key={i} fill={s.npv >= 0 ? COLOR_OIL : COLOR_GAS} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Scenario detail">
          <div className="table-scroll va-table"><table className="data-table">
            <thead><tr><th>Scenario</th><th className="right">Oil</th><th className="right">Gas</th><th className="right">PV</th><th className="right">NPV</th><th className="right">IRR</th><th className="right">Payout</th></tr></thead>
            <tbody>
              {r.sensitivity.map((s) => (
                <tr key={s.label} className={s.priceFactor === 1 ? "row-base" : undefined}>
                  <td>{s.label}</td>
                  <td className="right">${s.oilPrice.toFixed(0)}</td>
                  <td className="right">${s.gasPrice.toFixed(2)}</td>
                  <td className="right">{fmtMoneyC(s.presentValue)}</td>
                  <td className={`right ${s.npv >= 0 ? "va-pos" : "va-neg"}`}>{fmtMoneyC(s.npv)}</td>
                  <td className="right">{fmtPct1(s.irrAnnualPct)}</td>
                  <td className="right">{s.paybackMonths != null ? fmtMonths(s.paybackMonths) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </ChartCard>
      </div>
    </div>
  );
}

// --- Full report --------------------------------------------------------------

function FullReport({ analysis, analysisName }: { analysis: AnalyzeResponse; analysisName: string }) {
  const r = analysis.result;
  const v = r.valuation;
  const e = r.economics;
  const a = r.assumptions;
  const p = r.production;

  const execSummary = useMemo(() => {
    const parts: string[] = [];
    parts.push(
      `This analysis covers ${analysis.wells.length} well${analysis.wells.length === 1 ? "" : "s"} with ${p.monthsOfHistory} months of production history (${p.firstMonth ?? "—"} through ${p.lastMonth ?? "—"}), totaling ${fmtVol(p.cumBoe)} BOE produced to date.`,
    );
    if (r.forecast.remainingMonths > 0) {
      parts.push(
        `Decline-curve analysis projects ${fmtVol(r.forecast.remaining.boe)} BOE of remaining recovery over ${fmtMonths(r.forecast.remainingMonths)}${r.forecast.economicLimitMonth ? `, reaching the economic limit in ${r.forecast.economicLimitMonth}` : ""}.`,
      );
      parts.push(
        `At the assumed price deck (oil ${money(a.oilPrice)}/bbl, gas $${a.gasPrice.toFixed(2)}/mcf) the interest generates ${money(e.netCashFlowTotal)} in undiscounted net cash flow, worth ${money(e.presentValue)} at a ${a.discountRatePct}% discount rate.`,
      );
    }
    if (a.askingPrice > 0) {
      parts.push(
        `Against the ${money(a.askingPrice)} asking price, the recommended offer is ${money(v.recommendedOffer)} (maximum defensible price ${money(v.maxPurchasePrice)}); at asking, NPV is ${money(v.atAsking?.npv ?? 0)}${e.irrAnnualPct != null ? ` with an IRR of ${fmtPct1(e.irrAnnualPct)}` : ""}${e.paybackMonths != null ? ` and payout in ${fmtMonths(e.paybackMonths)}` : ""}.`,
      );
    } else {
      parts.push(`Estimated fair market value is ${money(v.fairMarketValue)} (PV10 ${money(v.pv10)}).`);
    }
    return parts.join(" ");
  }, [analysis, r, v, e, a, p]);

  return (
    <div className="va-report">
      <section className="va-chart va-report-head">
        <h2>Well production &amp; valuation report{analysisName ? ` · ${analysisName}` : ""}</h2>
        <p className="va-report-sub">
          Generated {fmtDateTime(r.runAt)} · Forecast confidence: {CONF_LABEL[r.forecast.confidence]} ·
          Historical data and forecast estimates are labeled throughout.
        </p>
        <div className="va-report-label">Executive summary</div>
        <p className="va-report-summary">{execSummary}</p>
        {r.warnings.length > 0 && (
          <>
            <div className="va-report-label">Caveats</div>
            <ul className="va-report-caveats">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </>
        )}
      </section>

      <ChartCard title="Property overview">
        <div className="table-scroll va-table"><table className="data-table">
          <thead><tr><th>Well</th><th>API</th><th>Operator</th><th>County</th><th>Type</th><th>Status</th><th className="right">Months</th><th className="right">Cum oil</th><th className="right">Cum gas</th></tr></thead>
          <tbody>
            {analysis.wells.map((w) => (
              <tr key={w.id}>
                <td className="strong">{w.name}</td><td className="va-mono">{w.apiNumber ?? "—"}</td><td>{w.operator ?? "—"}</td>
                <td>{w.county}, {w.state}</td><td>{w.wellType ?? "—"}</td><td><Tag tone={statusTone(w.status)} dot>{prettyEnum(w.status)}</Tag></td>
                <td className="right">{w.production?.months ?? 0}</td>
                <td className="right">{fmtVol(w.production?.cumOilBbl)}</td>
                <td className="right">{fmtVol(w.production?.cumGasMcf)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </ChartCard>

      <div className="va-report-sec">Production history</div>
      <ProductionTab r={r} />
      <div className="va-report-sec">Decline &amp; forecast</div>
      <ForecastTab r={r} />
      <div className="va-report-sec">Financials</div>
      <CashFlowTab r={r} />
      <div className="va-report-sec">Valuation &amp; offer</div>
      <ValuationTab r={r} />
      <div className="va-report-sec">Sensitivity</div>
      <SensitivityTab r={r} />

      <ChartCard title="Assumptions used"
        note={<>Forecasts are estimates from Arps decline-curve analysis of reported production and the assumptions above; they are not a guarantee of future performance.
          Historical figures come from reported production data as imported.</>}>
        <div className="va-facts va-facts-report">
          <div className="va-fact"><span className="va-fact-l">Oil price</span><span className="va-fact-v">{money(a.oilPrice)}/bbl</span></div>
          <div className="va-fact"><span className="va-fact-l">Gas price</span><span className="va-fact-v">${a.gasPrice.toFixed(2)}/mcf</span></div>
          <div className="va-fact"><span className="va-fact-l">NGL price</span><span className="va-fact-v">{money(a.nglPrice)}/bbl</span></div>
          <div className="va-fact"><span className="va-fact-l">Price escalation</span><span className="va-fact-v">{a.priceEscalationPct}%/yr</span></div>
          <div className="va-fact"><span className="va-fact-l">Discount rate</span><span className="va-fact-v">{a.discountRatePct}%</span></div>
          <div className="va-fact"><span className="va-fact-l">Asking price</span><span className="va-fact-v">{a.askingPrice > 0 ? money(a.askingPrice) : "—"}</span></div>
          <div className="va-fact"><span className="va-fact-l">Closing costs</span><span className="va-fact-v">{a.closingCosts > 0 ? money(a.closingCosts) : "—"}</span></div>
          <div className="va-fact"><span className="va-fact-l">Target ROI</span><span className="va-fact-v">{a.targetRoiPct != null ? `${a.targetRoiPct}%` : "—"}</span></div>
          <div className="va-fact"><span className="va-fact-l">Resale price</span><span className="va-fact-v">{a.resalePrice != null ? money(a.resalePrice) : "—"}</span></div>
          <div className="va-fact"><span className="va-fact-l">Resale margin target</span><span className="va-fact-v">{a.targetProfitMarginPct != null ? `${a.targetProfitMarginPct}%` : "—"}</span></div>
          <div className="va-fact"><span className="va-fact-l">Max forecast</span><span className="va-fact-v">{a.maxForecastMonths} months</span></div>
          <div className="va-fact"><span className="va-fact-l">Economic limit</span><span className="va-fact-v">{money(a.economicLimitNetCashFlow)}/mo net</span></div>
          <div className="va-fact"><span className="va-fact-l">Decline override</span><span className="va-fact-v">{a.declineOverride ? "Manual" : "Fit from data"}</span></div>
        </div>
      </ChartCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved analyses tab
// ---------------------------------------------------------------------------

/** "$75 / $3.00" — oil $/bbl / gas $/mcf as stored on the saved analysis. */
function fmtDeck(d: SavedAnalysisRow["priceDeck"]): string {
  if (!d || (d.oilPrice == null && d.gasPrice == null)) return "—";
  const oil = d.oilPrice == null ? "—" : `$${Number(d.oilPrice.toFixed(2))}`;
  const gas = d.gasPrice == null ? "—" : `$${d.gasPrice.toFixed(2)}`;
  return `${oil} / ${gas}`;
}

function SavedAnalyses({ onOpen, canManage }: { onOpen: (id: string) => void; canManage: boolean }) {
  const [rows, setRows] = useState<SavedAnalysisRow[] | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [compare, setCompare] = useState<SavedAnalysisDetail[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SavedAnalysisRow | null>(null);

  const load = useCallback(() => { api.get<SavedAnalysisRow[]>("/wells/analyses").then(setRows).catch(() => setRows([])); }, []);
  useEffect(load, [load]);

  async function del(id: string) {
    await api.del(`/wells/analyses/${id}`);
    setSel((s) => s.filter((x) => x !== id));
    load();
  }

  async function openCompare() {
    setBusy(true);
    try {
      const details = await Promise.all(sel.map((id) => api.get<SavedAnalysisDetail>(`/wells/analyses/${id}`)));
      setCompare(details);
    } finally {
      setBusy(false);
    }
  }

  if (rows == null) return <Spinner label="Loading saved analyses…" />;

  return (
    <section className="va-card va-saved">
      <div className="va-card-head">
        <h3>Saved analyses</h3>
        <button disabled={sel.length < 2 || busy} onClick={openCompare} title="Select 2–4 analyses to compare">
          {busy ? "Loading…" : `Compare selected (${sel.length})`}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="va-saved-empty">No saved analyses yet. Run an analysis in the workspace and save it to build a library you can revisit and compare.</p>
      ) : (
        <div className="va-saved-list">
          {rows.map((r) => (
            <div key={r.id} className={`va-saved-row ${sel.includes(r.id) ? "selected" : ""}`} role="button" tabIndex={0}
              onClick={() => onOpen(r.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(r.id); }}>
              <span className="va-saved-cb" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" aria-label={`Select ${r.name} to compare`} checked={sel.includes(r.id)} disabled={!sel.includes(r.id) && sel.length >= 4}
                  onChange={(e) => setSel((s) => e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id))} />
              </span>
              <span className="va-saved-main">
                <span className="va-saved-name">{r.name}</span>
                <span className="va-saved-wells">{r.wellNames.join(", ")}</span>
                {r.notes && <span className="va-saved-notes">{r.notes}</span>}
              </span>
              <span className="va-saved-m"><span>FMV</span><b>{fmtMoneyC(r.headline?.fairMarketValue)}</b></span>
              <span className="va-saved-m"><span>Rec. offer</span><b className="va-pos">{fmtMoneyC(r.headline?.recommendedOffer)}</b></span>
              <span className="va-saved-m"><span>NPV</span><b>{fmtMoneyC(r.headline?.npv)}</b></span>
              <span className="va-saved-m"><span>IRR</span><b>{fmtPct1(r.headline?.irrAnnualPct)}</b></span>
              <span className="va-saved-m va-saved-deck" title="Oil $/bbl / gas $/mcf"><span>Price deck</span><b>{fmtDeck(r.priceDeck)}</b></span>
              <span className="va-saved-date" title="Last updated">{fmtDateLocal(r.updatedAt)}</span>
              <span className="va-saved-actions" onClick={(e) => e.stopPropagation()}>
                <button className="link-btn" onClick={() => onOpen(r.id)}>Open</button>
                {canManage && <button className="link-btn va-del" onClick={() => setPendingDelete(r)}>Delete</button>}
              </span>
            </div>
          ))}
        </div>
      )}

      {compare && <CompareModal analyses={compare} onClose={() => setCompare(null)} />}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete saved analysis"
          message={<>Delete this saved analysis? <strong>{pendingDelete.name}</strong></>}
          confirmLabel="Delete"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => { const id = pendingDelete.id; setPendingDelete(null); void del(id); }}
        />
      )}
    </section>
  );
}

function CompareModal({ analyses, onClose }: { analyses: SavedAnalysisDetail[]; onClose: () => void }) {
  const metric = (fn: (r: ValuationResult) => string): string[] => analyses.map((d) => (d.results ? fn(d.results) : "—"));
  const rows: [string, string[]][] = [
    ["Wells", analyses.map((d) => String(d.wellIds.length))],
    ["Months of history", metric((r) => String(r.production.monthsOfHistory))],
    ["Cum production (BOE)", metric((r) => fmtVol(r.production.cumBoe))],
    ["Remaining (BOE)", metric((r) => fmtVol(r.forecast.remaining.boe))],
    ["Remaining life", metric((r) => fmtMonths(r.forecast.remainingMonths))],
    ["Fair market value", metric((r) => fmtMoneyC(r.valuation.fairMarketValue))],
    ["Recommended offer", metric((r) => fmtMoneyC(r.valuation.recommendedOffer))],
    ["Asking price", metric((r) => (r.assumptions.askingPrice > 0 ? fmtMoneyC(r.assumptions.askingPrice) : "—"))],
    ["NPV", metric((r) => fmtMoneyC(r.economics.npv))],
    ["IRR", metric((r) => fmtPct1(r.economics.irrAnnualPct))],
    ["ROI", metric((r) => fmtPct1(r.economics.roiPct))],
    ["Payout", metric((r) => fmtMonths(r.economics.paybackMonths))],
    ["Oil price", metric((r) => `$${r.assumptions.oilPrice}/bbl`)],
    ["Discount rate", metric((r) => `${r.assumptions.discountRatePct}%`)],
  ];
  return (
    <Modal title="Compare analyses" subtitle="Values come from each analysis's saved snapshot (assumptions at the time it was run)." onClose={onClose} wide>
      <div className="table-scroll va-table"><table className="data-table">
        <thead><tr><th>Metric</th>{analyses.map((d) => <th key={d.id} className="right">{d.name}</th>)}</tr></thead>
        <tbody>
          {rows.map(([label, vals]) => (
            <tr key={label}><td className="va-cmp-label">{label}</td>{vals.map((val, i) => <td key={i} className="right">{val}</td>)}</tr>
          ))}
        </tbody>
      </table></div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Save modal
// ---------------------------------------------------------------------------

function SaveModal({ existingId, existingName, wellIds, assumptions, result, onClose, onSaved }: {
  existingId: string | null;
  existingName: string;
  wellIds: string[];
  assumptions: Assumptions;
  result: ValuationResult;
  onClose: () => void;
  onSaved: (id: string, name: string) => void;
}) {
  const [name, setName] = useState(existingName || "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(asNew: boolean) {
    if (!name.trim()) { setError("Give the analysis a name."); return; }
    setBusy(true); setError("");
    try {
      if (!asNew && existingId) {
        await api.patch(`/wells/analyses/${existingId}`, { name: name.trim(), wellIds, assumptions, results: result, ...(notes.trim() ? { notes: notes.trim() } : {}) });
        onSaved(existingId, name.trim());
      } else {
        const r = await api.post<{ id: string }>("/wells/analyses", { name: name.trim(), wellIds, assumptions, results: result, ...(notes.trim() ? { notes: notes.trim() } : {}) });
        onSaved(r.id, name.trim());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={existingId ? "Save analysis" : "Save new analysis"}
      subtitle="The current assumptions and computed results are snapshotted so this analysis stays stable even as new production data is imported."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          {existingId && <button disabled={busy} onClick={() => save(true)}>Save as new</button>}
          <button className="primary" disabled={busy} onClick={() => save(false)}>{existingId ? "Update" : "Save"}</button>
        </>
      }
    >
      <div className="field"><label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Smith 1H acquisition — base case" autoFocus />
      </div>
      <div className="field"><label>Notes (optional)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Context, seller conversation, data caveats…" />
      </div>
      {error && <Banner kind="error">{error}</Banner>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Well data tab
// ---------------------------------------------------------------------------

function WellData({ canManage }: { canManage: boolean }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState<Paged<WellRow> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<WellRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api.get<Paged<WellRow>>(`/wells?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`).then(setData).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q, page, pageSize, reloadKey]);

  async function del(w: WellRow) {
    await api.del(`/wells/${w.id}`);
    setReloadKey((k) => k + 1);
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="va-workspace">
      <section className="va-card va-wells-data">
        <div className="va-card-head">
          <div className="va-card-title">
            <h3>Wells</h3>
            <span className="va-count">{data ? `${data.total.toLocaleString()} wells` : "…"}</span>
          </div>
          <div className="va-data-tools">
            <div className="va-data-search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
              <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search wells, API, operator…" aria-label="Search wells" />
            </div>
            <span className="ct-rpp" title="Records per page"><Select value={String(pageSize)} onChange={(v) => { setPageSize(Number(v)); setPage(1); }} options={["20", "50", "100", "200"]} width={68} ariaLabel="Records per page" /></span>
          </div>
        </div>
        {!data ? <Spinner /> : (
          <>
            <div className="table-scroll va-table va-wells-table"><table className="data-table">
              <thead><tr><th>Well</th><th>API</th><th>Operator</th><th>County</th><th>Status</th><th className="right">Months</th><th className="right">Last month</th><th className="right">Cum oil (bbl)</th><th className="right">Cum gas (mcf)</th>{canManage && <th aria-label="Actions"></th>}</tr></thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={canManage ? 10 : 9} className="empty-cell">No wells yet. {canManage ? "Import production data below to get started." : "Ask an administrator to import production data."}</td></tr>}
                {data.rows.map((w) => (
                  <tr key={w.id}>
                    <td><span className="va-well-name">{w.name}</span>{w.leaseName && <div className="va-well-lease">{w.leaseName}</div>}</td>
                    <td className="va-mono">{w.apiNumber ?? "—"}</td>
                    <td>{w.operator ?? "—"}</td>
                    <td className="va-dim">{w.county}, {w.state}</td>
                    <td><Tag tone={statusTone(w.status)} dot>{prettyEnum(w.status)}</Tag></td>
                    <td className="right va-num-cell">{w.production?.months ?? 0}</td>
                    <td className="right va-num-cell">{w.production?.lastMonth ?? "—"}</td>
                    <td className="right va-num-cell">{fmtVol(w.production?.cumOilBbl)}</td>
                    <td className="right va-num-cell">{fmtVol(w.production?.cumGasMcf)}</td>
                    {canManage && (
                      <td className="right">
                        <button className="va-icon-del" aria-label={`Delete ${w.name}`} title="Delete well" onClick={() => setPendingDelete(w)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table></div>
            <div className="va-data-foot">
              <span>Showing {data.rows.length.toLocaleString()} of {data.total.toLocaleString()} wells</span>
              {pages > 1 && (
                <span className="va-pager">
                  <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
                  <span>Page {page} of {pages}</span>
                  <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
                </span>
              )}
            </div>
          </>
        )}
      </section>

      {canManage && <WellImport onDataChanged={() => setReloadKey((k) => k + 1)} />}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete well"
          message={<>Delete <strong>{pendingDelete.name}</strong> and all its production data?</>}
          confirmLabel="Delete"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => { const w = pendingDelete; setPendingDelete(null); void del(w); }}
        />
      )}
    </div>
  );
}
