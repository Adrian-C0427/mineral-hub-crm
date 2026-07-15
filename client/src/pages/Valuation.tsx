import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  BarChart, ReferenceLine, Cell,
} from "recharts";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner, MetricCard, Modal, Spinner } from "../components/ui";
import { WellImport } from "../components/WellImport";
import { money, num, prettyEnum, fmtDate, fmtDateTime, fmtDateLocal } from "../lib/format";
import { monthLabel, chartTooltip } from "../lib/charts";

/**
 * Well Production Analysis & Valuation — an intentionally launched research
 * tool (never triggered from the map): pick wells, set assumptions, run the
 * decline-curve + economics engine, review a report-grade result set, save and
 * compare analyses, and export a PDF.
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type PageTab = "workspace" | "saved" | "data";
type ResultTab = "production" | "forecast" | "cashflow" | "valuation" | "sensitivity" | "report";

export function Valuation() {
  const { can, user } = useAuth();
  const canManage = can("manageWellAnalysis");
  const [pageTab, setPageTab] = useState<PageTab>("workspace");

  // Workspace state
  const [selected, setSelected] = useState<WellRow[]>([]);
  const [assumptions, setAssumptions] = useState<Assumptions | null>(null); // fetched defaults
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [resultTab, setResultTab] = useState<ResultTab>("production");
  const [openAnalysisId, setOpenAnalysisId] = useState<string | null>(null);
  const [openAnalysisName, setOpenAnalysisName] = useState<string>("");
  const [saveOpen, setSaveOpen] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<Assumptions>("/wells/assumptions/defaults").then(setAssumptions).catch(() => {});
  }, []);

  // Deep-link from the map's well panel ("Open in Well Analysis"):
  // ?fid=<rrc well id>&well=<API#>. The well is linked into the centralized
  // dataset and its production is read live from rrc.production, so the user
  // lands ready to run with the full history — no manual search or re-import.
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
          setSelected([imported.well]); setPageTab("workspace"); return;
        }
        const found = await api.get<Paged<WellRow>>(`/wells?q=${encodeURIComponent(w!)}&pageSize=1`);
        if (found.rows[0]?.production?.months) { setSelected([found.rows[0]]); setPageTab("workspace"); return; }
        const imported = await api.post<{ well: WellRow }>(`/wells/import-rrc`, { api: w });
        setSelected([imported.well]);
        setPageTab("workspace");
      } catch {
        // Not in the org list or the RRC data — leave the workspace open.
      }
    })();
  }, []);

  const runAnalysis = useCallback(async (wells: WellRow[], a: Assumptions) => {
    setRunning(true); setError("");
    try {
      const resp = await api.post<AnalyzeResponse>("/wells/analyze", { wellIds: wells.map((w) => w.id), assumptions: a });
      setAnalysis(resp);
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


  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 style={{ margin: 0 }}>Well Analysis &amp; Valuation</h2>
          <span className="muted">Production forecasting, decline curves and acquisition economics — run on demand, never from the map.</span>
        </div>
        <div className="row">
          {analysis && (
            <>
              <button className="small" onClick={() => setSaveOpen(true)}>{openAnalysisId ? "Save / Save as…" : "Save analysis…"}</button>
            </>
          )}
          <button className="primary small" onClick={newAnalysis}>+ New analysis</button>
        </div>
      </div>

      <div className="tab-row">
        <button className={`tab ${pageTab === "workspace" ? "active" : ""}`} onClick={() => setPageTab("workspace")}>Analysis Workspace</button>
        <button className={`tab ${pageTab === "saved" ? "active" : ""}`} onClick={() => setPageTab("saved")}>Saved Analyses</button>
        <button className={`tab ${pageTab === "data" ? "active" : ""}`} onClick={() => setPageTab("data")}>Well Data{canManage ? " & Imports" : ""}</button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {pageTab === "workspace" && assumptions && (
        <Workspace
          selected={selected}
          setSelected={setSelected}
          assumptions={assumptions}
          setAssumptions={setAssumptions as (a: Assumptions) => void}
          analysis={analysis}
          running={running}
          onRun={() => runAnalysis(selected, assumptions)}
          resultTab={resultTab}
          setResultTab={setResultTab}
          openAnalysisName={openAnalysisName}
          reportRef={reportRef}
        />
      )}
      {pageTab === "workspace" && !assumptions && <Spinner label="Loading…" />}

      {pageTab === "saved" && <SavedAnalyses onOpen={openSaved} />}

      {pageTab === "data" && <WellData canManage={canManage} />}

      {saveOpen && analysis && assumptions && (
        <SaveModal
          existingId={openAnalysisId}
          existingName={openAnalysisName}
          wellIds={selected.map((w) => w.id)}
          assumptions={assumptions}
          result={analysis.result}
          onClose={() => setSaveOpen(false)}
          onSaved={(id, name) => { setOpenAnalysisId(id); setOpenAnalysisName(name); setSaveOpen(false); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace: well picker + assumptions + results
// ---------------------------------------------------------------------------

function Workspace(props: {
  selected: WellRow[];
  setSelected: (w: WellRow[]) => void;
  assumptions: Assumptions;
  setAssumptions: (a: Assumptions) => void;
  analysis: AnalyzeResponse | null;
  running: boolean;
  onRun: () => void;
  resultTab: ResultTab;
  setResultTab: (t: ResultTab) => void;
  openAnalysisName: string;
  reportRef: React.RefObject<HTMLDivElement>;
}) {
  const { selected, setSelected, assumptions, setAssumptions, analysis, running, onRun, resultTab, setResultTab, openAnalysisName, reportRef } = props;
  const [setupOpen, setSetupOpen] = useState(true);
  const hasResult = analysis != null;

  return (
    <div>
      <div className="panel va-step">
        <div className="va-step-head" onClick={() => setSetupOpen((o) => !o)}>
          <div className="va-step-title">
            <span className="va-step-num">1</span>
            <span>Wells &amp; Assumptions{openAnalysisName && <span className="muted" style={{ fontWeight: 400 }}> — {openAnalysisName}</span>}</span>
          </div>
          <span className="va-step-toggle">{setupOpen ? "Hide" : `${selected.length} wells selected · Show`} <span className={`va-chev ${setupOpen ? "" : "down"}`}>⌃</span></span>
        </div>
        {setupOpen && (
          <div className="va-body">
            <WellPicker selected={selected} setSelected={setSelected} />
            <SelectedWellPermits wells={selected} />
            <AssumptionsForm a={assumptions} onChange={setAssumptions} />
            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" disabled={running || selected.length === 0} onClick={onRun}>
                {running ? "Running analysis…" : hasResult ? "Re-run with current assumptions" : "Run analysis"}
              </button>
              {selected.length === 0 && <span className="muted">Select at least one well to run.</span>}
              {hasResult && <span className="muted">Adjust any assumption and re-run to see the impact immediately.</span>}
            </div>
          </div>
        )}
      </div>

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

// --- Well picker -----------------------------------------------------------

interface RrcCandidate { fid: number; api: string | null; name: string; operator: string | null; county: string; type: string | null; status: string | null; hasProduction: boolean }

function WellPicker({ selected, setSelected }: { selected: WellRow[]; setSelected: (w: WellRow[]) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<WellRow[]>([]);
  const [rrc, setRrc] = useState<RrcCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearching(true);
      // Search the org's analysis wells AND the imported RRC dataset (all
      // counties from the B5 pipeline) in one pass — every imported well is
      // reachable here without any separate import step.
      Promise.all([
        api.get<Paged<WellRow>>(`/wells?q=${encodeURIComponent(q)}&pageSize=8`),
        q.trim().length >= 2 ? api.get<RrcCandidate[]>(`/wells/rrc-search?q=${encodeURIComponent(q)}`).catch(() => [] as RrcCandidate[]) : Promise.resolve([] as RrcCandidate[]),
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
      if (!selected.some((s) => s.id === d.well.id)) setSelected([...selected, d.well]);
      setQ("");
    } catch { /* surfaced by empty state */ }
    finally { setImporting(null); }
  }

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const selectedIds = new Set(selected.map((w) => w.id));
  const addable = results.filter((r) => !selectedIds.has(r.id));

  return (
    <div className="field" style={{ marginBottom: 14 }}>
      <label className="va-microlabel">Wells to analyze</label>
      <div className="msel" ref={boxRef}>
        <div className="msel-box" onClick={() => setOpen(true)}>
          {selected.map((w) => (
            <span className="msel-chip" key={w.id} title={`${w.county} Co, ${w.state} · ${w.operator ?? "unknown operator"}`}>
              {w.name}
              <button type="button" onClick={(e) => { e.stopPropagation(); setSelected(selected.filter((s) => s.id !== w.id)); }}>×</button>
            </span>
          ))}
          <input
            className="msel-input"
            value={q}
            placeholder={selected.length === 0 ? "Search by well/lease name, API, operator, county, formation, status…" : ""}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
          />
        </div>
        {open && (
          <div className="msel-menu">
            {searching && <div className="msel-empty">Searching…</div>}
            {!searching && addable.length === 0 && rrc.length === 0 && <div className="msel-empty">{total === 0 ? "No wells found in your list or the imported RRC data." : "All matching wells already selected."}</div>}
            {!searching && addable.map((w) => (
              <div className="msel-opt" key={w.id} onClick={() => { setSelected([...selected, w]); setQ(""); }}>
                <strong>{w.name}</strong>{w.apiNumber && <span className="muted"> · API {w.apiNumber}</span>}
                <div className="muted" style={{ fontSize: 12 }}>
                  {w.operator ?? "Unknown operator"} · {w.county} Co, {w.state}
                  {w.production && w.production.months > 0 && <> · {w.production.months} months of production {w.production.firstMonth && <>({w.production.firstMonth} → {w.production.lastMonth})</>}</>}
                  {(!w.production || w.production.months === 0) && <> · no production data</>}
                </div>
              </div>
            ))}
            {!searching && rrc.length > 0 && (
              <>
                <div className="msel-empty" style={{ padding: "6px 10px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  From imported RRC data · auto-syncs on open
                </div>
                {rrc.map((c) => (
                  <div className="msel-opt" key={c.fid} onClick={() => void addRrc(c)}>
                    <strong>{c.name}</strong>{c.api && <span className="muted"> · API {c.api}</span>}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {c.operator ?? "Unknown operator"} · {c.county} Co, TX · {c.type ?? "—"}
                      {c.hasProduction ? " · production history available" : " · no production on file"}
                      {importing === c.fid && " · importing…"}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Permit history for the selected wells (live from rrc.permits) ----------

interface PermitRow { statusNo: string; permitDate: string | null; operator: string | null; leaseName: string | null; wellNo: string | null }

function SelectedWellPermits({ wells }: { wells: WellRow[] }) {
  const [permits, setPermits] = useState<{ well: string; rows: PermitRow[] }[]>([]);
  useEffect(() => {
    let live = true;
    // Only worth fetching for a small selection — permit context is per-well.
    const targets = wells.filter((w) => w.apiNumber).slice(0, 3);
    if (!targets.length) { setPermits([]); return; }
    Promise.all(targets.map((w) => api.get<PermitRow[]>(`/wells/${w.id}/permits`).then((rows) => ({ well: w.name, rows })).catch(() => ({ well: w.name, rows: [] as PermitRow[] }))))
      .then((all) => { if (live) setPermits(all.filter((p) => p.rows.length)); });
    return () => { live = false; };
  }, [wells]);
  if (!permits.length) return null;
  return (
    <div style={{ margin: "0 0 14px" }}>
      <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 4 }}>Permit history (RRC W-1)</div>
      {permits.map((p) => (
        <div key={p.well} style={{ fontSize: 13, marginBottom: 4 }}>
          <strong>{p.well}</strong>
          {p.rows.slice(0, 4).map((r) => (
            <span key={r.statusNo} className="muted"> · {r.permitDate ? fmtDate(r.permitDate) : "—"} {r.operator ?? ""} (#{r.statusNo})</span>
          ))}
        </div>
      ))}
    </div>
  );
}

// --- Assumptions form ------------------------------------------------------

function NumField({ label, value, onChange, step = 1, prefix, suffix, width = 150, allowNull, hint }: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  prefix?: string;
  suffix?: string;
  width?: number;
  allowNull?: boolean;
  hint?: string;
}) {
  return (
    <div className="va-num" style={{ width }}>
      <label title={hint}>{label}</label>
      <div className="va-num-box">
        {prefix && <span className="va-num-affix va-num-prefix">{prefix}</span>}
        <input
          type="number"
          step={step}
          value={value ?? ""}
          placeholder={allowNull ? "—" : undefined}
          onChange={(e) => {
            const s = e.target.value;
            if (s === "") { onChange(allowNull ? null : 0); return; }
            const n = Number(s);
            if (Number.isFinite(n)) onChange(n);
          }}
        />
        {suffix && <span className="va-num-affix va-num-suffix">{suffix}</span>}
      </div>
    </div>
  );
}

function AssumptionsForm({ a, onChange }: { a: Assumptions; onChange: (a: Assumptions) => void }) {
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
    <div>
      <div className="assumption-groups">
        <div className="assumption-group">
          <div className="assumption-group-title"><span className="va-dot" style={{ background: "#22c55e" }} />Commodity prices</div>
          <div className="assumption-grid">
            <NumField label="Oil ($/bbl)" value={a.oilPrice} onChange={(v) => set("oilPrice", v ?? 0)} step={1} />
            <NumField label="Gas ($/mcf)" value={a.gasPrice} onChange={(v) => set("gasPrice", v ?? 0)} step={0.1} />
            <NumField label="NGL ($/bbl)" value={a.nglPrice} onChange={(v) => set("nglPrice", v ?? 0)} step={1} />
            <NumField label="Price escalation" value={a.priceEscalationPct} onChange={(v) => set("priceEscalationPct", v ?? 0)} step={0.5} suffix="%/yr" />
          </div>
        </div>
        <div className="assumption-group">
          <div className="assumption-group-title"><span className="va-dot" style={{ background: "#3b82f6" }} />Acquisition</div>
          <div className="assumption-grid">
            <NumField label="Asking price" value={a.askingPrice} onChange={(v) => set("askingPrice", v ?? 0)} step={1000} prefix="$" />
            <NumField label="Closing costs" value={a.closingCosts} onChange={(v) => set("closingCosts", v ?? 0)} step={500} prefix="$" />
          </div>
        </div>
        <div className="assumption-group">
          <div className="assumption-group-title"><span className="va-dot" style={{ background: "#f59e0b" }} />Return targets</div>
          <div className="assumption-grid">
            <NumField label="Discount rate" value={a.discountRatePct} onChange={(v) => set("discountRatePct", v ?? 10)} step={0.5} suffix="%" />
            <NumField label="Target ROI" value={a.targetRoiPct} onChange={(v) => set("targetRoiPct", v)} step={5} suffix="%" allowNull hint="Total return on investment over the property's life (blank = no constraint)" />
            <NumField label="Target profit ($)" value={a.targetProfitAmount} onChange={(v) => set("targetProfitAmount", v)} step={5000} prefix="$" allowNull />
            <NumField label="Resale price" value={a.resalePrice} onChange={(v) => set("resalePrice", v)} step={5000} prefix="$" allowNull hint="Expected flip/resale price (optional)" />
            <NumField label="Resale margin target" value={a.targetProfitMarginPct} onChange={(v) => set("targetProfitMarginPct", v)} step={1} suffix="%" allowNull hint="Desired profit as % of resale price" />
          </div>
        </div>
      </div>

      <details style={{ marginTop: 10 }}>
        <summary className="muted" style={{ cursor: "pointer" }}>Advanced: forecast controls &amp; manual decline override</summary>
        <div className="assumption-grid" style={{ marginTop: 10 }}>
          <NumField label="Max forecast" value={a.maxForecastMonths} onChange={(v) => set("maxForecastMonths", v ?? 360)} step={12} suffix="mo" />
          <NumField label="Economic limit" value={a.economicLimitNetCashFlow} onChange={(v) => set("economicLimitNetCashFlow", v ?? 0)} step={50} prefix="$" suffix="/mo" hint="Stop the forecast when monthly net cash flow falls below this" />
          <NumField label="Oil decline (Di)" value={a.declineOverride?.oil?.diAnnual != null ? round4(a.declineOverride.oil.diAnnual * 100) : null} onChange={(v) => setOverride("oil", "diAnnual", v == null ? null : v / 100)} step={5} suffix="%/yr" allowNull hint="Manual nominal annual decline (blank = fit from data)" />
          <NumField label="Oil b-factor" value={a.declineOverride?.oil?.b ?? null} onChange={(v) => setOverride("oil", "b", v)} step={0.1} allowNull hint="0 = exponential, 1 = harmonic" />
          <NumField label="Gas decline (Di)" value={a.declineOverride?.gas?.diAnnual != null ? round4(a.declineOverride.gas.diAnnual * 100) : null} onChange={(v) => setOverride("gas", "diAnnual", v == null ? null : v / 100)} step={5} suffix="%/yr" allowNull />
          <NumField label="Gas b-factor" value={a.declineOverride?.gas?.b ?? null} onChange={(v) => setOverride("gas", "b", v)} step={0.1} allowNull />
        </div>
      </details>
    </div>
  );
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

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

  return (
    <div>
      <div className="panel va-step">
        <div className="va-step-head" style={{ cursor: "default" }}>
          <div className="va-step-title">
            <span className="va-step-num">2</span>
            <span>Results</span>
          </div>
          <span className="muted">
            Run {fmtDateTime(r.runAt)} · forecast <ConfBadge c={r.forecast.confidence} />
          </span>
        </div>

        <div className="va-body">
        {r.warnings.length > 0 && (
          <Banner kind="warn">
            <ul style={{ margin: 0, paddingLeft: 18 }}>{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </Banner>
        )}

        <div className="metrics-row">
          <MetricCard label="Fair market value" value={fmtMoneyC(v.fairMarketValue)} hint={`PV @ ${r.assumptions.discountRatePct}% · PV10 ${fmtMoneyC(v.pv10)}`} />
          <MetricCard label="Recommended offer" value={fmtMoneyC(v.recommendedOffer)} hint={v.offerVsAskingPct != null ? `${v.offerVsAskingPct >= 0 ? "+" : ""}${v.offerVsAskingPct.toFixed(0)}% vs asking` : "No asking price set"} />
          <MetricCard label="NPV at asking" value={v.atAsking ? fmtMoneyC(v.atAsking.npv) : "—"} hint={e.investment > 0 ? `Investment ${fmtMoneyC(e.investment)}` : "Set an asking price"} />
          <MetricCard label="IRR / ROI" value={`${fmtPct1(e.irrAnnualPct)} / ${e.roiPct != null ? fmtPct1(e.roiPct) : "—"}`} hint={e.paybackMonths != null ? `Payout in ${fmtMonths(e.paybackMonths)}` : "Payout beyond forecast"} />
          <MetricCard label="Remaining life" value={r.forecast.remainingMonths > 0 ? fmtMonths(r.forecast.remainingMonths) : "—"} hint={`${fmtVol(r.forecast.remaining.boe)} boe remaining`} />
        </div>

        <div className="tab-row" style={{ marginBottom: 0 }}>
          <button className={`tab ${tab === "production" ? "active" : ""}`} onClick={() => setTab("production")}>Production History</button>
          <button className={`tab ${tab === "forecast" ? "active" : ""}`} onClick={() => setTab("forecast")}>Decline &amp; Forecast</button>
          <button className={`tab ${tab === "cashflow" ? "active" : ""}`} onClick={() => setTab("cashflow")}>Financials</button>
          <button className={`tab ${tab === "valuation" ? "active" : ""}`} onClick={() => setTab("valuation")}>Valuation &amp; Offer</button>
          <button className={`tab ${tab === "sensitivity" ? "active" : ""}`} onClick={() => setTab("sensitivity")}>Sensitivity</button>
          <button className={`tab ${tab === "report" ? "active" : ""}`} onClick={() => setTab("report")}>Full Report</button>
        </div>
        </div>
      </div>

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
  );
}

function ConfBadge({ c }: { c: "high" | "medium" | "low" }) {
  const cls = c === "high" ? "resp-offer" : c === "medium" ? "resp-interested" : "resp-passed";
  return <span className={`badge ${cls}`}>{CONF_LABEL[c]}</span>;
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


// --- Production tab ---------------------------------------------------------

function ProductionTab({ r }: { r: ValuationResult }) {
  const p = r.production;
  const data = useMemo(() => r.history.map((m, i) => {
    let cum = 0;
    for (let k = 0; k <= i; k++) cum += r.history[k].oilBbl + r.history[k].nglBbl + r.history[k].gasMcf / 6;
    return { ...m, cumBoe: cum };
  }), [r.history]);

  if (!r.history.length) return <div className="panel"><p className="muted">No production history for the selected wells.</p></div>;

  return (
    <div>
      <div className="metrics-row">
        <MetricCard label="History" value={`${p.monthsOfHistory} mo`} hint={`${p.firstMonth} → ${p.lastMonth} · ${p.producingMonths} producing`} />
        <MetricCard label="Cumulative oil" value={fmtVol(p.oil.cumulative, " bbl")} hint={p.oil.peak ? `Peak ${fmtVol(p.oil.peak.volume)} bbl in ${p.oil.peak.month}` : undefined} />
        <MetricCard label="Cumulative gas" value={fmtVol(p.gas.cumulative, " mcf")} hint={p.gas.peak ? `Peak ${fmtVol(p.gas.peak.volume)} mcf in ${p.gas.peak.month}` : undefined} />
        <MetricCard label="Cumulative NGL" value={fmtVol(p.ngl.cumulative, " bbl")} />
        <MetricCard label="Total (BOE)" value={fmtVol(p.cumBoe)} hint="6 mcf = 1 boe" />
      </div>

      <div className="chart-grid">
        <div className="panel">
          <div className="panel-title"><h3>Monthly Production <HistTag /></h3></div>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 11 }} minTickGap={28} />
              <YAxis yAxisId="l" tick={{ fontSize: 11 }} label={{ value: "bbl / month", angle: -90, position: "insideLeft", fontSize: 11 }} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11 }} label={{ value: "mcf / month", angle: 90, position: "insideRight", fontSize: 11 }} />
              <Tooltip {...chartTooltip} labelFormatter={monthLabel} formatter={(val: number) => Math.round(val).toLocaleString()} />
              <Legend />
              <Line yAxisId="l" dataKey="oilBbl" name="Oil (bbl)" stroke={COLOR_OIL} dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line yAxisId="r" dataKey="gasMcf" name="Gas (mcf)" stroke={COLOR_GAS} dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line yAxisId="l" dataKey="nglBbl" name="NGL (bbl)" stroke={COLOR_NGL} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="panel">
          <div className="panel-title"><h3>Cumulative Production (BOE) <HistTag /></h3></div>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 11 }} minTickGap={28} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
              <Tooltip {...chartTooltip} labelFormatter={monthLabel} formatter={(val: number) => Math.round(val).toLocaleString()} />
              <Line dataKey="cumBoe" name="Cumulative BOE" stroke={COLOR_CUM} dot={false} strokeWidth={2} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="chart-grid">
        <div className="panel">
          <div className="panel-title"><h3>Annual Production <HistTag /></h3></div>
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Year</th><th className="right">Oil (bbl)</th><th className="right">Gas (mcf)</th><th className="right">NGL (bbl)</th><th className="right">BOE</th></tr></thead>
            <tbody>
              {p.annual.map((a) => (
                <tr key={a.year}><td>{a.year}</td><td className="right">{fmtVol(a.oilBbl)}</td><td className="right">{fmtVol(a.gasMcf)}</td><td className="right">{fmtVol(a.nglBbl)}</td><td className="right">{fmtVol(a.boe)}</td></tr>
              ))}
            </tbody>
          </table></div>
        </div>
        <div className="panel">
          <div className="panel-title"><h3>Anomalies &amp; Notable Events</h3></div>
          {p.anomalies.length === 0 ? <p className="muted">No significant anomalies detected — a clean, steady producer.</p> : (
            <ul className="anomaly-list">
              {p.anomalies.map((x, i) => (
                <li key={i}>
                  <span className={`badge ${x.kind === "DOWNTIME" ? "resp-passed" : x.kind === "SHARP_DROP" ? "priority-high" : "resp-interested"}`}>{prettyEnum(x.kind)}</span>
                  <strong style={{ margin: "0 6px" }}>{x.month}</strong>
                  <span className="muted">{x.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

const HistTag = () => <span className="badge resp-pending" style={{ marginLeft: 8, fontWeight: 500 }}>Historical</span>;
const FcTag = () => <span className="badge resp-interested" style={{ marginLeft: 8, fontWeight: 500 }}>Forecast</span>;

// --- Forecast tab -----------------------------------------------------------

function DeclineFitCard({ phase, unit, fit }: { phase: string; unit: string; fit: DeclineFit | null }) {
  if (!fit) return (
    <div className="fit-card">
      <div className="fit-title">{phase}</div>
      <p className="muted" style={{ margin: 0 }}>No decline fit (insufficient or no production).</p>
    </div>
  );
  return (
    <div className="fit-card">
      <div className="fit-title">{phase} — {prettyEnum(fit.model)}{fit.manual ? " (manual)" : ""} <ConfBadge c={fit.confidence} /></div>
      <div className="fit-grid">
        <div className="kv"><span className="k">Effective decline</span><span className="v">{(fit.diAnnualEffective * 100).toFixed(1)}%/yr</span></div>
        <div className="kv"><span className="k">Nominal Di</span><span className="v">{(fit.diAnnualNominal * 100).toFixed(1)}%/yr</span></div>
        <div className="kv"><span className="k">b-factor</span><span className="v">{fit.b.toFixed(2)}</span></div>
        <div className="kv"><span className="k">Fit R²</span><span className="v">{fit.r2.toFixed(3)}</span></div>
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
    <div>
      <div className="metrics-row">
        <MetricCard label="Remaining life" value={fc.remainingMonths > 0 ? fmtMonths(fc.remainingMonths) : "—"} hint={fc.endReason === "ECONOMIC_LIMIT" ? `Economic limit ${fc.economicLimitMonth}` : fc.endReason === "MAX_MONTHS" ? "Capped at max forecast length" : "No decline fit"} />
        <MetricCard label="Remaining oil" value={fmtVol(fc.remaining.oilBbl, " bbl")} hint="Forecast recoverable" />
        <MetricCard label="Remaining gas" value={fmtVol(fc.remaining.gasMcf, " mcf")} hint="Forecast recoverable" />
        <MetricCard label="Remaining BOE" value={fmtVol(fc.remaining.boe)} hint={`EUR ${fmtVol(fc.eur.boe)} boe total`} />
        <MetricCard label="Confidence" value={CONF_LABEL[fc.confidence].split(" ")[0]} hint="Based on fit quality & history length" />
      </div>

      <div className="panel">
        <div className="panel-title">
          <h3>Production: History &amp; Forecast <HistTag /><FcTag /></h3>
          <label className="dm-chk"><input type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} /> Semi-log (decline-curve view)</label>
        </div>
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={logSafe}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 11 }} minTickGap={28} />
            <YAxis
              yAxisId="l" tick={{ fontSize: 11 }} scale={logScale ? "log" : "auto"} domain={logScale ? ["auto", "auto"] : [0, "auto"]}
              allowDataOverflow label={{ value: "bbl / month", angle: -90, position: "insideLeft", fontSize: 11 }}
            />
            <YAxis
              yAxisId="r" orientation="right" tick={{ fontSize: 11 }} scale={logScale ? "log" : "auto"} domain={logScale ? ["auto", "auto"] : [0, "auto"]}
              allowDataOverflow label={{ value: "mcf / month", angle: 90, position: "insideRight", fontSize: 11 }}
            />
            <Tooltip {...chartTooltip} labelFormatter={monthLabel} formatter={(val: number) => Math.round(val).toLocaleString()} />
            <Legend />
            <Line yAxisId="l" dataKey="histOil" name="Oil (actual)" stroke={COLOR_OIL} dot={false} strokeWidth={2} isAnimationActive={false} />
            <Line yAxisId="l" dataKey="fcOil" name="Oil (forecast)" stroke={COLOR_OIL} dot={false} strokeWidth={2} strokeDasharray="6 4" isAnimationActive={false} />
            <Line yAxisId="r" dataKey="histGas" name="Gas (actual)" stroke={COLOR_GAS} dot={false} strokeWidth={2} isAnimationActive={false} />
            <Line yAxisId="r" dataKey="fcGas" name="Gas (forecast)" stroke={COLOR_GAS} dot={false} strokeWidth={2} strokeDasharray="6 4" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Solid lines are reported production; dashed lines are the Arps decline forecast under current assumptions.
          {fc.economicLimitMonth && <> Forecast ends at the economic limit in <strong>{fc.economicLimitMonth}</strong>.</>}
        </p>
      </div>

      <div className="chart-grid">
        <div className="panel">
          <div className="panel-title"><h3>Cumulative BOE: History &amp; Forecast <HistTag /><FcTag /></h3></div>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 11 }} minTickGap={28} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
              <Tooltip {...chartTooltip} labelFormatter={monthLabel} formatter={(val: number) => Math.round(val).toLocaleString()} />
              <Line dataKey="cumBoe" name="Cumulative (actual)" stroke={COLOR_CUM} dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line dataKey="fcCumBoe" name="Cumulative (forecast)" stroke={COLOR_CUM} dot={false} strokeWidth={2} strokeDasharray="6 4" isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="panel">
          <div className="panel-title"><h3>Decline Curve Fits</h3></div>
          <DeclineFitCard phase="Oil" unit="bbl" fit={r.decline.oil} />
          <DeclineFitCard phase="Gas" unit="mcf" fit={r.decline.gas} />
          <DeclineFitCard phase="NGL" unit="bbl" fit={r.decline.ngl} />
        </div>
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

  if (!r.forecast.months.length) return <div className="panel"><p className="muted">No forecast months — nothing to project financially.</p></div>;

  return (
    <div>
      <div className="metrics-row">
        <MetricCard label="Gross revenue" value={fmtMoneyC(e.grossRevenueTotal)} hint="8/8ths, life of forecast" />
        <MetricCard label="Net cash flow" value={fmtMoneyC(e.netCashFlowTotal)} hint="Undiscounted, life of forecast" />
        <MetricCard label={`PV @ ${r.assumptions.discountRatePct}%`} value={fmtMoneyC(e.presentValue)} hint={`PV10 ${fmtMoneyC(e.pv10)}`} />
        <MetricCard label="Avg cash flow (yr 1)" value={`${fmtMoneyC(e.monthlyCashFlowFirstYearAvg)}/mo`} />
      </div>

      <div className="chart-grid">
        <div className="panel">
          <div className="panel-title"><h3>Annual Net Cash Flow <FcTag /></h3></div>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(val: number) => fmtMoneyC(val)} width={70} />
              <Tooltip {...chartTooltip} formatter={(val: number) => money(val)} />
              <Legend />
              <Bar dataKey="netCashFlow" name="Net cash flow" fill={COLOR_CASH} isAnimationActive={false} />
              <Line dataKey="cumNetCashFlow" name="Cumulative" stroke={COLOR_CUM} dot={false} strokeWidth={2} isAnimationActive={false} />
              {e.investment > 0 && <ReferenceLine y={e.investment} stroke="var(--red)" strokeDasharray="4 4" label={{ value: "Investment", fontSize: 11, fill: "var(--red)" }} />}
            </ComposedChart>
          </ResponsiveContainer>
          {paybackYear && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Cumulative cash flow crosses the investment in <strong>{paybackYear}</strong> ({fmtMonths(e.paybackMonths)}).</p>}
        </div>
        <div className="panel">
          <div className="panel-title"><h3>Annual Revenue by Commodity <FcTag /></h3></div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(val: number) => fmtMoneyC(val)} width={70} />
              <Tooltip {...chartTooltip} formatter={(val: number) => money(val)} />
              <Legend />
              <Bar dataKey="oilRevenue" name="Oil" stackId="rev" fill={COLOR_OIL} isAnimationActive={false} />
              <Bar dataKey="gasRevenue" name="Gas" stackId="rev" fill={COLOR_GAS} isAnimationActive={false} />
              <Bar dataKey="nglRevenue" name="NGL" stackId="rev" fill={COLOR_NGL} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Gross (8/8ths) revenue at assumed prices before interest, taxes and costs.</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title"><h3>Annual Cash Flow Detail <FcTag /></h3></div>
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>Year</th><th className="right">Gross Revenue</th><th className="right">Net Cash Flow</th><th className="right">Cumulative</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.year}>
                <td>{row.year}</td>
                <td className="right">{money(row.grossRevenue)}</td>
                <td className="right">{money(row.netCashFlow)}</td>
                <td className="right">{money(row.cumNetCashFlow)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}

// --- Valuation tab ----------------------------------------------------------

function ValuationTab({ r }: { r: ValuationResult }) {
  const v = r.valuation;
  const e = r.economics;
  const a = r.assumptions;

  return (
    <div>
      <div className="chart-grid">
        <div className="panel">
          <div className="panel-title"><h3>Acquisition Valuation</h3></div>
          <table className="data-table" style={{ minWidth: 0 }}>
            <tbody>
              <ValRow label="Fair market value" value={money(v.fairMarketValue)} hint={`PV of forecast cash flows @ ${a.discountRatePct}%`} calc />
              <ValRow label="PV10 (reference)" value={money(v.pv10)} hint="Industry-standard 10% discount" calc />
              <ValRow label="Undiscounted net cash flow" value={money(e.netCashFlowTotal)} calc />
              <ValRow label="Seller's asking price" value={a.askingPrice > 0 ? money(a.askingPrice) : "—"} hint="Your input" />
              <ValRow label="Closing costs" value={a.closingCosts > 0 ? money(a.closingCosts) : "—"} hint="Your input" />
              <ValRow label="Maximum purchase price" value={money(v.maxPurchasePrice)} hint="Highest price meeting all your targets" calc strong />
              <ValRow label="Recommended offer" value={money(v.recommendedOffer)} hint={v.offerVsAskingPct != null ? `${v.offerVsAskingPct >= 0 ? "+" : ""}${v.offerVsAskingPct.toFixed(1)}% vs asking` : undefined} calc strong accent />
            </tbody>
          </table>
          {v.askingPriceAssessment && (
            <Banner kind={v.askingPriceAssessment === "ABOVE_VALUE" ? "warn" : "info"}>
              {v.askingPriceAssessment === "ABOVE_VALUE" && <>The asking price is <strong>above</strong> the estimated fair market value — negotiate down or pass.</>}
              {v.askingPriceAssessment === "NEAR_VALUE" && <>The asking price is <strong>near</strong> the estimated fair market value.</>}
              {v.askingPriceAssessment === "BELOW_VALUE" && <>The asking price is <strong>below</strong> the estimated fair market value — potentially attractive.</>}
            </Banner>
          )}
        </div>

        <div className="panel">
          <div className="panel-title"><h3>Returns &amp; Margin Analysis</h3></div>
          <table className="data-table" style={{ minWidth: 0 }}>
            <tbody>
              <ValRow label="NPV at asking price" value={v.atAsking ? money(v.atAsking.npv) : "—"} calc />
              <ValRow label="ROI at asking price" value={v.atAsking?.roiPct != null ? fmtPct1(v.atAsking.roiPct) : "—"} calc />
              <ValRow label="Payout at asking price" value={v.atAsking ? fmtMonths(v.atAsking.paybackMonths) : "—"} calc />
              <ValRow label="IRR (annualized)" value={fmtPct1(e.irrAnnualPct)} calc />
              <ValRow label="Break-even price deck" value={e.breakEvenPriceFactor != null ? `${(e.breakEvenPriceFactor * 100).toFixed(0)}% of assumed prices` : "—"} hint={e.breakEvenOilPrice != null ? `≈ ${money(e.breakEvenOilPrice)}/bbl oil` : undefined} calc />
            </tbody>
          </table>

          {a.resalePrice != null && a.resalePrice > 0 ? (
            <>
              <h4 style={{ margin: "14px 0 6px" }}>Resale scenario (at {money(a.resalePrice)})</h4>
              <table className="data-table" style={{ minWidth: 0 }}>
                <tbody>
                  <ValRow label="Expected gross profit" value={v.expectedGrossProfit != null ? money(v.expectedGrossProfit) : "—"} calc />
                  <ValRow label="Expected net profit" value={v.expectedNetProfit != null ? money(v.expectedNetProfit) : "—"} hint="After closing costs" calc strong />
                  <ValRow label="Projected ROI at resale" value={fmtPct1(v.resaleRoiPct)} calc />
                  <ValRow label="Profit margin" value={fmtPct1(v.resaleMarginPct)} hint={a.targetProfitMarginPct != null ? `Target ${a.targetProfitMarginPct}%` : undefined} calc />
                </tbody>
              </table>
            </>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>Set a resale price in the assumptions to model a wholesale flip (profit, margin and buyer ROI).</p>
          )}
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        <span className="badge resp-pending" style={{ fontWeight: 500 }}>Input</span> values come from your assumptions;{" "}
        <span className="badge resp-offer" style={{ fontWeight: 500 }}>Calculated</span> values are derived from the production forecast.
      </p>
    </div>
  );
}

function ValRow({ label, value, hint, calc, strong, accent }: { label: string; value: string; hint?: string; calc?: boolean; strong?: boolean; accent?: boolean }) {
  return (
    <tr>
      <td>
        {label} <span className={`badge ${calc ? "resp-offer" : "resp-pending"}`} style={{ fontWeight: 500, fontSize: 10 }}>{calc ? "Calculated" : "Input"}</span>
        {hint && <div className="muted" style={{ fontSize: 11 }}>{hint}</div>}
      </td>
      <td className="right" style={{ fontWeight: strong ? 700 : 500, fontSize: strong ? 16 : 14, color: accent ? "var(--accent)" : undefined }}>{value}</td>
    </tr>
  );
}

// --- Sensitivity tab ---------------------------------------------------------

function SensitivityTab({ r }: { r: ValuationResult }) {
  return (
    <div className="chart-grid">
      <div className="panel">
        <div className="panel-title"><h3>NPV by Price Scenario</h3></div>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={r.sensitivity}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(val: number) => fmtMoneyC(val)} width={70} />
            <Tooltip {...chartTooltip} formatter={(val: number) => money(val)} />
            <ReferenceLine y={0} stroke="var(--text-dim)" />
            <Bar dataKey="npv" name="NPV" isAnimationActive={false}>
              {r.sensitivity.map((s, i) => <Cell key={i} fill={s.npv >= 0 ? COLOR_OIL : COLOR_GAS} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>All commodity prices scaled together; every scenario re-runs the full forecast, so remaining life shifts too.</p>
      </div>
      <div className="panel">
        <div className="panel-title"><h3>Scenario Detail</h3></div>
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>Scenario</th><th className="right">Oil</th><th className="right">Gas</th><th className="right">PV</th><th className="right">NPV</th><th className="right">IRR</th><th className="right">Payout</th></tr></thead>
          <tbody>
            {r.sensitivity.map((s) => (
              <tr key={s.label} className={s.priceFactor === 1 ? "row-base" : undefined}>
                <td>{s.label}</td>
                <td className="right">${s.oilPrice.toFixed(0)}</td>
                <td className="right">${s.gasPrice.toFixed(2)}</td>
                <td className="right">{fmtMoneyC(s.presentValue)}</td>
                <td className="right" style={{ color: s.npv >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoneyC(s.npv)}</td>
                <td className="right">{fmtPct1(s.irrAnnualPct)}</td>
                <td className="right">{s.paybackMonths != null ? fmtMonths(s.paybackMonths) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
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
    <div>
      <div className="panel report-header">
        <h2 style={{ margin: 0 }}>Well Production &amp; Valuation Report{analysisName ? ` — ${analysisName}` : ""}</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          Generated {fmtDateTime(r.runAt)} · Forecast confidence: {CONF_LABEL[r.forecast.confidence]} ·
          Historical data and forecast estimates are labeled throughout.
        </p>
      </div>

      <div className="panel">
        <h3>Executive Summary</h3>
        <p style={{ marginBottom: 0 }}>{execSummary}</p>
        {r.warnings.length > 0 && (
          <>
            <h4 style={{ marginBottom: 4 }}>Caveats</h4>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{r.warnings.map((w, i) => <li key={i} className="muted">{w}</li>)}</ul>
          </>
        )}
      </div>

      <div className="panel">
        <h3>Property Overview</h3>
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>Well</th><th>API</th><th>Operator</th><th>County</th><th>Type</th><th>Status</th><th className="right">Months</th><th className="right">Cum Oil</th><th className="right">Cum Gas</th></tr></thead>
          <tbody>
            {analysis.wells.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td><td>{w.apiNumber ?? "—"}</td><td>{w.operator ?? "—"}</td>
                <td>{w.county}, {w.state}</td><td>{w.wellType ?? "—"}</td><td>{prettyEnum(w.status)}</td>
                <td className="right">{w.production?.months ?? 0}</td>
                <td className="right">{fmtVol(w.production?.cumOilBbl)}</td>
                <td className="right">{fmtVol(w.production?.cumGasMcf)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      <ProductionTab r={r} />
      <ForecastTab r={r} />
      <CashFlowTab r={r} />
      <ValuationTab r={r} />
      <SensitivityTab r={r} />

      <div className="panel">
        <h3>Assumptions Used</h3>
        <div className="dd-grid">
          <div className="kv"><span className="k">Oil price</span><span className="v">{money(a.oilPrice)}/bbl</span></div>
          <div className="kv"><span className="k">Gas price</span><span className="v">${a.gasPrice.toFixed(2)}/mcf</span></div>
          <div className="kv"><span className="k">NGL price</span><span className="v">{money(a.nglPrice)}/bbl</span></div>
          <div className="kv"><span className="k">Price escalation</span><span className="v">{a.priceEscalationPct}%/yr</span></div>
          <div className="kv"><span className="k">Discount rate</span><span className="v">{a.discountRatePct}%</span></div>
          <div className="kv"><span className="k">Asking price</span><span className="v">{a.askingPrice > 0 ? money(a.askingPrice) : "—"}</span></div>
          <div className="kv"><span className="k">Closing costs</span><span className="v">{a.closingCosts > 0 ? money(a.closingCosts) : "—"}</span></div>
          <div className="kv"><span className="k">Target ROI</span><span className="v">{a.targetRoiPct != null ? `${a.targetRoiPct}%` : "—"}</span></div>
          <div className="kv"><span className="k">Resale price</span><span className="v">{a.resalePrice != null ? money(a.resalePrice) : "—"}</span></div>
          <div className="kv"><span className="k">Resale margin target</span><span className="v">{a.targetProfitMarginPct != null ? `${a.targetProfitMarginPct}%` : "—"}</span></div>
          <div className="kv"><span className="k">Max forecast</span><span className="v">{a.maxForecastMonths} months</span></div>
          <div className="kv"><span className="k">Economic limit</span><span className="v">{money(a.economicLimitNetCashFlow)}/mo net</span></div>
          <div className="kv"><span className="k">Decline override</span><span className="v">{a.declineOverride ? "Manual" : "Fit from data"}</span></div>
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0, marginTop: 12 }}>
          Forecasts are estimates from Arps decline-curve analysis of reported production and the assumptions above; they are not a guarantee of future performance.
          Historical figures come from reported production data as imported.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved analyses tab
// ---------------------------------------------------------------------------

function SavedAnalyses({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<SavedAnalysisRow[] | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [compare, setCompare] = useState<SavedAnalysisDetail[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { api.get<SavedAnalysisRow[]>("/wells/analyses").then(setRows).catch(() => setRows([])); }, []);
  useEffect(load, [load]);

  async function del(id: string) {
    if (!window.confirm("Delete this saved analysis?")) return;
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
    <div className="panel">
      <div className="panel-title">
        <h3 style={{ margin: 0 }}>Saved Analyses</h3>
        <button className="small" disabled={sel.length < 2 || busy} onClick={openCompare}>
          {busy ? "Loading…" : `Compare selected (${sel.length})`}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No saved analyses yet. Run an analysis in the workspace and save it to build a library you can revisit and compare.</p>
      ) : (
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th style={{ width: 30 }}></th><th>Name</th><th>Wells</th><th>Updated</th><th className="right">FMV</th><th className="right">Rec. Offer</th><th className="right">NPV</th><th className="right">IRR</th><th style={{ width: 130 }}></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" checked={sel.includes(r.id)} disabled={!sel.includes(r.id) && sel.length >= 4} onChange={(e) => setSel((s) => e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id))} /></td>
                <td><strong>{r.name}</strong>{r.notes && <div className="muted" style={{ fontSize: 12 }}>{r.notes}</div>}</td>
                <td className="wrap" style={{ maxWidth: 260 }}>{r.wellNames.join(", ")}</td>
                <td>{fmtDateLocal(r.updatedAt)}</td>
                <td className="right">{fmtMoneyC(r.headline?.fairMarketValue)}</td>
                <td className="right">{fmtMoneyC(r.headline?.recommendedOffer)}</td>
                <td className="right">{fmtMoneyC(r.headline?.npv)}</td>
                <td className="right">{fmtPct1(r.headline?.irrAnnualPct)}</td>
                <td className="right">
                  <button className="link-btn" onClick={() => onOpen(r.id)}>Open</button>
                  <button className="link-btn" style={{ color: "var(--red)" }} onClick={() => del(r.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      {compare && <CompareModal analyses={compare} onClose={() => setCompare(null)} />}
    </div>
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
    <Modal title="Compare Analyses" onClose={onClose} wide>
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>Metric</th>{analyses.map((d) => <th key={d.id} className="right">{d.name}</th>)}</tr></thead>
        <tbody>
          {rows.map(([label, vals]) => (
            <tr key={label}><td>{label}</td>{vals.map((val, i) => <td key={i} className="right">{val}</td>)}</tr>
          ))}
        </tbody>
      </table></div>
      <p className="muted" style={{ fontSize: 12 }}>Values come from each analysis's saved snapshot (assumptions at the time it was run).</p>
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
      title={existingId ? "Save Analysis" : "Save New Analysis"}
      onClose={onClose}
      footer={
        <>
          <button className="small" onClick={onClose}>Cancel</button>
          {existingId && <button className="small" disabled={busy} onClick={() => save(true)}>Save as new</button>}
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
      <p className="muted" style={{ fontSize: 12 }}>The current assumptions and computed results are snapshotted so this analysis stays stable even as new production data is imported.</p>
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
  const [data, setData] = useState<Paged<WellRow> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      api.get<Paged<WellRow>>(`/wells?q=${encodeURIComponent(q)}&page=${page}&pageSize=25`).then(setData).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q, page, reloadKey]);

  async function del(w: WellRow) {
    if (!window.confirm(`Delete ${w.name} and all its production data?`)) return;
    await api.del(`/wells/${w.id}`);
    setReloadKey((k) => k + 1);
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <div className="panel">
        <div className="panel-title">
          <h3 style={{ margin: 0 }}>Wells ({data?.total ?? "…"})</h3>
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search wells…" style={{ width: 260 }} />
        </div>
        {!data ? <Spinner /> : (
          <>
            <div className="table-scroll"><table className="data-table">
              <thead><tr><th>Well</th><th>API</th><th>Operator</th><th>County</th><th>Status</th><th className="right">Months</th><th className="right">Last Month</th><th className="right">Cum Oil (bbl)</th><th className="right">Cum Gas (mcf)</th>{canManage && <th></th>}</tr></thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={canManage ? 10 : 9} className="empty-cell">No wells yet. {canManage ? "Import production data below to get started." : "Ask an administrator to import production data."}</td></tr>}
                {data.rows.map((w) => (
                  <tr key={w.id}>
                    <td><strong>{w.name}</strong>{w.leaseName && <div className="muted" style={{ fontSize: 11 }}>{w.leaseName}</div>}</td>
                    <td>{w.apiNumber ?? "—"}</td>
                    <td>{w.operator ?? "—"}</td>
                    <td>{w.county}, {w.state}</td>
                    <td>{prettyEnum(w.status)}</td>
                    <td className="right">{w.production?.months ?? 0}</td>
                    <td className="right">{w.production?.lastMonth ?? "—"}</td>
                    <td className="right">{fmtVol(w.production?.cumOilBbl)}</td>
                    <td className="right">{fmtVol(w.production?.cumGasMcf)}</td>
                    {canManage && <td className="right"><button className="link-btn" style={{ color: "var(--red)" }} onClick={() => del(w)}>Delete</button></td>}
                  </tr>
                ))}
              </tbody>
            </table></div>
            {pages > 1 && (
              <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
                <button className="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
                <span className="muted">Page {page} of {pages}</span>
                <button className="small" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
              </div>
            )}
          </>
        )}
      </div>

      {canManage && <WellImport onDataChanged={() => setReloadKey((k) => k + 1)} />}
    </div>
  );
}
