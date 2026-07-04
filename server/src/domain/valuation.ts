/**
 * Well production analysis & valuation engine.
 *
 * Pure functions only — the routes layer loads production rows and passes them
 * in, so every formula here is unit-testable. The engine covers:
 *
 *   1. Production history statistics (cumulatives, peaks, anomalies)
 *   2. Arps decline-curve analysis (exponential / hyperbolic / harmonic)
 *   3. Production forecasting to the economic limit
 *   4. Cash-flow economics (NPV, IRR, payout, break-even)
 *   5. Acquisition valuation & offer recommendation
 *   6. Commodity-price sensitivity scenarios
 *
 * Historical data and forecasts are kept strictly separate in the outputs, and
 * every derived number traces back to either reported production or an explicit
 * assumption in ValuationAssumptions.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One month of (merged) production. Volumes are month totals. */
export interface MonthVolumes {
  month: string; // "YYYY-MM"
  oilBbl: number;
  gasMcf: number;
  nglBbl: number;
  waterBbl: number;
}

export interface DeclineOverride {
  /** Arps b factor (0 = exponential, 1 = harmonic). */
  b?: number;
  /** Nominal annual initial decline rate, e.g. 0.35 = 35%/yr. */
  diAnnual?: number;
}

export interface ValuationAssumptions {
  // Commodity prices (flat deck unless escalation set)
  oilPrice: number; // $/bbl
  gasPrice: number; // $/mcf
  nglPrice: number; // $/bbl
  priceEscalationPct: number; // %/yr applied to all prices in the forecast

  // Ownership
  nri: number; // net revenue interest fraction (0–1]
  workingInterest: number; // fraction of costs borne; 0 for royalty-only

  // Costs & taxes
  opexPerMonth: number; // gross lease operating expense $/month (× WI)
  opexEscalationPct: number; // %/yr
  sevTaxOilPct: number; // severance tax as fraction of oil+NGL revenue
  sevTaxGasPct: number; // fraction of gas revenue
  adValoremPct: number; // fraction of total revenue

  // Investment
  askingPrice: number;
  closingCosts: number;

  // Targets
  discountRatePct: number; // annual, e.g. 10
  targetRoiPct: number | null; // desired total ROI on investment, e.g. 30
  targetProfitMarginPct: number | null; // resale margin target
  targetProfitAmount: number | null;
  resalePrice: number | null;

  // Forecast controls
  maxForecastMonths: number;
  /** Net cash flow floor ($/mo); below this the property is uneconomic. */
  economicLimitNetCashFlow: number;
  declineOverride: { oil?: DeclineOverride; gas?: DeclineOverride } | null;
}

export const DEFAULT_ASSUMPTIONS: ValuationAssumptions = {
  oilPrice: 75,
  gasPrice: 3.0,
  nglPrice: 25,
  priceEscalationPct: 0,
  // Ownership, operating cost and tax inputs were removed from the Well
  // Analysis UI: the tool evaluates full-stream (8/8ths) acquisition economics
  // and does not track ownership accounting or taxes. These defaults make the
  // engine compute on gross revenue (NRI 100%, no working-interest costs, no
  // opex, no severance/ad-valorem tax) while the fields remain in the schema
  // for backward compatibility with previously saved analyses.
  nri: 1,
  workingInterest: 0,
  opexPerMonth: 0,
  opexEscalationPct: 0,
  sevTaxOilPct: 0,
  sevTaxGasPct: 0,
  adValoremPct: 0,
  askingPrice: 0,
  closingCosts: 0,
  discountRatePct: 10,
  targetRoiPct: null,
  targetProfitMarginPct: null,
  targetProfitAmount: null,
  resalePrice: null,
  maxForecastMonths: 360,
  economicLimitNetCashFlow: 0,
  declineOverride: null,
};

/** Merge a partial user payload over the defaults (nulls kept where allowed). */
export function normalizeAssumptions(a: Partial<ValuationAssumptions> | undefined): ValuationAssumptions {
  const n: ValuationAssumptions = { ...DEFAULT_ASSUMPTIONS, ...(a ?? {}) };
  n.nri = clamp(n.nri, 0, 1);
  n.workingInterest = clamp(n.workingInterest, 0, 1);
  n.maxForecastMonths = Math.min(Math.max(Math.round(n.maxForecastMonths), 12), 720);
  return n;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

// ---------------------------------------------------------------------------
// Month helpers
// ---------------------------------------------------------------------------

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthDiff(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * Merge per-well monthly rows into one continuous series (missing interior
 * months filled with zeros so downtime is visible and time indexing is exact).
 */
export function mergeMonthly(rows: { month: string; oilBbl: number; gasMcf: number; nglBbl: number; waterBbl: number }[]): MonthVolumes[] {
  if (!rows.length) return [];
  const byMonth = new Map<string, MonthVolumes>();
  for (const r of rows) {
    const cur = byMonth.get(r.month) ?? { month: r.month, oilBbl: 0, gasMcf: 0, nglBbl: 0, waterBbl: 0 };
    cur.oilBbl += r.oilBbl;
    cur.gasMcf += r.gasMcf;
    cur.nglBbl += r.nglBbl;
    cur.waterBbl += r.waterBbl;
    byMonth.set(r.month, cur);
  }
  const keys = [...byMonth.keys()].sort();
  const out: MonthVolumes[] = [];
  for (let ym = keys[0]; ym <= keys[keys.length - 1]; ym = addMonths(ym, 1)) {
    out.push(byMonth.get(ym) ?? { month: ym, oilBbl: 0, gasMcf: 0, nglBbl: 0, waterBbl: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Production history statistics
// ---------------------------------------------------------------------------

export type Phase = "oil" | "gas" | "ngl";
const PHASE_KEY: Record<Phase, keyof MonthVolumes> = { oil: "oilBbl", gas: "gasMcf", ngl: "nglBbl" };

export interface PhaseStats {
  cumulative: number;
  peak: { month: string; volume: number } | null;
  last12: number;
  lastMonthVolume: number;
  /** Average of the last up-to-3 producing months (volume > 0). */
  currentMonthlyRate: number;
}

export interface Anomaly {
  month: string;
  kind: "DOWNTIME" | "SHARP_DROP" | "SPIKE";
  detail: string;
}

export interface ProductionSummary {
  firstMonth: string | null;
  lastMonth: string | null;
  monthsOfHistory: number;
  producingMonths: number;
  oil: PhaseStats;
  gas: PhaseStats;
  ngl: PhaseStats;
  waterCum: number;
  cumBoe: number; // 6 mcf = 1 boe
  annual: { year: string; oilBbl: number; gasMcf: number; nglBbl: number; boe: number }[];
  anomalies: Anomaly[];
}

function phaseStats(series: MonthVolumes[], phase: Phase): PhaseStats {
  const key = PHASE_KEY[phase];
  let cum = 0;
  let peak: { month: string; volume: number } | null = null;
  for (const m of series) {
    const v = m[key] as number;
    cum += v;
    if (v > 0 && (!peak || v > peak.volume)) peak = { month: m.month, volume: v };
  }
  const last12 = series.slice(-12).reduce((s, m) => s + (m[key] as number), 0);
  const producing = series.filter((m) => (m[key] as number) > 0);
  const recent = producing.slice(-3);
  return {
    cumulative: cum,
    peak,
    last12,
    lastMonthVolume: series.length ? (series[series.length - 1][key] as number) : 0,
    currentMonthlyRate: recent.length ? recent.reduce((s, m) => s + (m[key] as number), 0) / recent.length : 0,
  };
}

const boeOf = (m: { oilBbl: number; gasMcf: number; nglBbl: number }) => m.oilBbl + m.nglBbl + m.gasMcf / 6;

function detectAnomalies(series: MonthVolumes[]): Anomaly[] {
  const out: Anomaly[] = [];
  for (let i = 1; i < series.length; i++) {
    const cur = boeOf(series[i]);
    // Trailing 3-month average of *producing* months before i.
    const prior = series.slice(Math.max(0, i - 3), i).map(boeOf).filter((v) => v > 0);
    if (!prior.length) continue;
    const avg = prior.reduce((s, v) => s + v, 0) / prior.length;
    if (avg <= 0) continue;
    if (cur === 0) {
      out.push({ month: series[i].month, kind: "DOWNTIME", detail: "No reported production (well likely offline or report gap)." });
    } else if (cur < avg * 0.45) {
      out.push({ month: series[i].month, kind: "SHARP_DROP", detail: `Production fell ${Math.round((1 - cur / avg) * 100)}% below the trailing average.` });
    } else if (cur > avg * 2.2 && i > 3) {
      out.push({ month: series[i].month, kind: "SPIKE", detail: `Production ${Math.round((cur / avg - 1) * 100)}% above the trailing average (recompletion, workover or catch-up reporting).` });
    }
  }
  return out.slice(0, 24);
}

export function summarizeProduction(series: MonthVolumes[]): ProductionSummary {
  const annualMap = new Map<string, { oilBbl: number; gasMcf: number; nglBbl: number }>();
  let waterCum = 0;
  for (const m of series) {
    const y = m.month.slice(0, 4);
    const a = annualMap.get(y) ?? { oilBbl: 0, gasMcf: 0, nglBbl: 0 };
    a.oilBbl += m.oilBbl;
    a.gasMcf += m.gasMcf;
    a.nglBbl += m.nglBbl;
    annualMap.set(y, a);
    waterCum += m.waterBbl;
  }
  const oil = phaseStats(series, "oil");
  const gas = phaseStats(series, "gas");
  const ngl = phaseStats(series, "ngl");
  return {
    firstMonth: series[0]?.month ?? null,
    lastMonth: series[series.length - 1]?.month ?? null,
    monthsOfHistory: series.length,
    producingMonths: series.filter((m) => boeOf(m) > 0).length,
    oil,
    gas,
    ngl,
    waterCum,
    cumBoe: oil.cumulative + ngl.cumulative + gas.cumulative / 6,
    annual: [...annualMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([year, v]) => ({ year, ...v, boe: boeOf(v) })),
    anomalies: detectAnomalies(series),
  };
}

// ---------------------------------------------------------------------------
// Arps decline-curve analysis
// ---------------------------------------------------------------------------

export type DeclineModel = "exponential" | "hyperbolic" | "harmonic";
export type Confidence = "high" | "medium" | "low";

export interface DeclineFit {
  model: DeclineModel;
  b: number;
  /** Nominal annual initial decline (Arps Di, per-year basis). */
  diAnnualNominal: number;
  /** Effective annual decline: 1 − q(12mo)/q(0). */
  diAnnualEffective: number;
  /** Fitted initial rate (volume/month) at the start of the fit window. */
  qiMonthly: number;
  /** Model rate (volume/month) at the last month of history. */
  currentRate: number;
  r2: number;
  fitStartMonth: string;
  fitMonths: number;
  confidence: Confidence;
  manual: boolean;
}

/** Arps rate at time t (months from fit start), Di in per-month nominal terms. */
export function arpsRate(qi: number, diMonthly: number, b: number, t: number): number {
  if (diMonthly <= 0) return qi;
  if (b < 1e-6) return qi * Math.exp(-diMonthly * t);
  return qi / Math.pow(1 + b * diMonthly * t, 1 / b);
}

function confidenceOf(r2: number, fitMonths: number): Confidence {
  if (r2 >= 0.8 && fitMonths >= 12) return "high";
  if (r2 >= 0.55 && fitMonths >= 6) return "medium";
  return "low";
}

/**
 * Fit an Arps decline to a monthly series (volumes as monthly rates).
 *
 * The fit window runs from the peak producing month to the end of history;
 * zero months inside the window (downtime) are excluded from the regression
 * but keep their calendar position, so decline timing stays honest.
 *
 * Strategy: grid-search b ∈ [0, 1.4] and nominal Di; for each (b, Di) the
 * optimal qi has a closed least-squares form. Robust, dependency-free, and
 * more than accurate enough for monthly public production data.
 */
export function fitDecline(series: MonthVolumes[], phase: Phase, override?: DeclineOverride): DeclineFit | null {
  const key = PHASE_KEY[phase];
  const vols = series.map((m) => m[key] as number);
  if (!vols.some((v) => v > 0)) return null;

  // Fit from the peak month forward.
  let peakIdx = 0;
  for (let i = 0; i < vols.length; i++) if (vols[i] > vols[peakIdx]) peakIdx = i;
  const window = vols.slice(peakIdx);
  const points: { t: number; q: number }[] = [];
  for (let t = 0; t < window.length; t++) if (window[t] > 0) points.push({ t, q: window[t] });
  if (points.length < 3) return null;

  const fitStartMonth = series[peakIdx].month;
  const lastT = window.length - 1;

  // Manual override: qi chosen so the curve passes through recent production.
  if (override && (override.diAnnual != null || override.b != null)) {
    const b = clamp(override.b ?? 0.5, 0, 2);
    const diAnnual = clamp(override.diAnnual ?? 0.3, 0.01, 5);
    const diM = diAnnual / 12;
    // Least-squares qi against the observed points for this fixed shape.
    let num = 0, den = 0;
    for (const p of points) {
      const f = arpsRate(1, diM, b, p.t);
      num += p.q * f;
      den += f * f;
    }
    const qi = den > 0 ? num / den : points[0].q;
    const r2 = r2Of(points, (t) => arpsRate(qi, diM, b, t));
    return {
      model: b < 1e-6 ? "exponential" : b >= 0.999 && b <= 1.001 ? "harmonic" : "hyperbolic",
      b,
      diAnnualNominal: diAnnual,
      diAnnualEffective: 1 - arpsRate(1, diM, b, 12),
      qiMonthly: qi,
      currentRate: arpsRate(qi, diM, b, lastT),
      r2,
      fitStartMonth,
      fitMonths: points.length,
      confidence: confidenceOf(r2, points.length),
      manual: true,
    };
  }

  let best: { b: number; diM: number; qi: number; sse: number } | null = null;
  const bGrid: number[] = [];
  for (let b = 0; b <= 1.401; b += 0.1) bGrid.push(Math.round(b * 10) / 10);
  // Nominal annual Di from 2% to 300%, log-spaced.
  const diGrid: number[] = [];
  for (let i = 0; i <= 60; i++) diGrid.push(0.02 * Math.pow(150, i / 60));

  for (const b of bGrid) {
    for (const diA of diGrid) {
      const diM = diA / 12;
      let num = 0, den = 0;
      for (const p of points) {
        const f = arpsRate(1, diM, b, p.t);
        num += p.q * f;
        den += f * f;
      }
      if (den <= 0) continue;
      const qi = num / den;
      if (!Number.isFinite(qi) || qi <= 0) continue;
      let sse = 0;
      for (const p of points) {
        const e = p.q - arpsRate(qi, diM, b, p.t);
        sse += e * e;
      }
      if (!best || sse < best.sse) best = { b, diM, qi, sse };
    }
  }
  if (!best) return null;

  const { b, diM, qi } = best;
  const r2 = r2Of(points, (t) => arpsRate(qi, diM, b, t));
  return {
    model: b < 0.05 ? "exponential" : b > 0.95 && b < 1.05 ? "harmonic" : "hyperbolic",
    b,
    diAnnualNominal: diM * 12,
    diAnnualEffective: 1 - arpsRate(1, diM, b, 12),
    qiMonthly: qi,
    currentRate: arpsRate(qi, diM, b, lastT),
    r2,
    fitStartMonth,
    fitMonths: points.length,
    confidence: confidenceOf(r2, points.length),
    manual: false,
  };
}

function r2Of(points: { t: number; q: number }[], model: (t: number) => number): number {
  const mean = points.reduce((s, p) => s + p.q, 0) / points.length;
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    ssTot += (p.q - mean) ** 2;
    ssRes += (p.q - model(p.t)) ** 2;
  }
  return ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
}

// ---------------------------------------------------------------------------
// Forecast + economics (computed together: the economic limit is financial)
// ---------------------------------------------------------------------------

export interface ForecastMonth {
  month: string;
  oilBbl: number;
  gasMcf: number;
  nglBbl: number;
  oilRevenue: number; // gross, before NRI
  gasRevenue: number;
  nglRevenue: number;
  grossRevenue: number;
  severanceTax: number;
  adValorem: number;
  opex: number;
  /** Net revenue to the evaluated interest (after NRI, before costs). */
  netRevenue: number;
  netCashFlow: number;
  cumNetCashFlow: number;
  discountedCashFlow: number;
}

export interface ForecastResult {
  months: ForecastMonth[];
  /** Why the forecast stopped where it did. */
  endReason: "ECONOMIC_LIMIT" | "MAX_MONTHS" | "NO_DECLINE_FIT";
  remainingMonths: number;
  remainingYears: number;
  economicLimitMonth: string | null;
  remaining: { oilBbl: number; gasMcf: number; nglBbl: number; boe: number };
  /** EUR = produced-to-date + forecast remaining. */
  eur: { oilBbl: number; gasMcf: number; nglBbl: number; boe: number };
  confidence: Confidence;
}

export interface EconomicsResult {
  investment: number; // asking price + closing costs (user assumptions)
  grossRevenueTotal: number;
  netRevenueTotal: number;
  totalTaxes: number;
  totalOpex: number;
  netCashFlowTotal: number;
  /** PV of forecast net cash flows at the assumption discount rate. */
  presentValue: number;
  pv10: number;
  npv: number; // presentValue − investment
  irrAnnualPct: number | null;
  paybackMonths: number | null;
  roiPct: number | null; // (total net CF − investment) / investment
  /** Multiplier on the whole price deck at which NPV = 0 (null if never). */
  breakEvenPriceFactor: number | null;
  breakEvenOilPrice: number | null;
  monthlyCashFlowFirstYearAvg: number;
}

interface PhaseFits { oil: DeclineFit | null; gas: DeclineFit | null; ngl: DeclineFit | null }

/**
 * Project each phase from the end of history using its decline fit, price the
 * volumes, and stop at the economic limit (net cash flow below the floor) or
 * the max-months cap. NGL rides oil's decline shape when it lacks its own fit
 * (it is a processing byproduct); phases with no fit and no history are zero.
 */
export function buildForecast(series: MonthVolumes[], fits: PhaseFits, a: ValuationAssumptions): ForecastResult {
  const summary = summarizeProduction(series);
  const lastMonth = summary.lastMonth;
  const anyFit = fits.oil || fits.gas || fits.ngl;
  const discM = Math.pow(1 + a.discountRatePct / 100, 1 / 12) - 1;

  const months: ForecastMonth[] = [];
  let endReason: ForecastResult["endReason"] = anyFit ? "MAX_MONTHS" : "NO_DECLINE_FIT";
  let cum = 0;

  if (lastMonth && anyFit) {
    // Rate functions per phase, t = months after the last history month.
    const rateFor = (fit: DeclineFit | null): ((t: number) => number) => {
      if (!fit) return () => 0;
      const diM = fit.diAnnualNominal / 12;
      const offset = monthDiff(fit.fitStartMonth, lastMonth);
      return (t: number) => arpsRate(fit.qiMonthly, diM, fit.b, offset + t);
    };
    const oilRate = rateFor(fits.oil);
    const gasRate = rateFor(fits.gas);
    // NGL byproduct: scale current NGL rate by the oil (then gas) decline shape.
    const nglRate = fits.ngl
      ? rateFor(fits.ngl)
      : (() => {
          const base = fits.oil ?? fits.gas;
          const baseRate = rateFor(base);
          const cur = summary.ngl.currentMonthlyRate;
          if (!base || cur <= 0) return () => 0;
          const at0 = baseRate(0);
          return (t: number) => (at0 > 0 ? (cur * baseRate(t)) / at0 : 0);
        })();

    for (let k = 1; k <= a.maxForecastMonths; k++) {
      const ym = addMonths(lastMonth, k);
      const esc = Math.pow(1 + a.priceEscalationPct / 100, (k - 1) / 12);
      const opexEsc = Math.pow(1 + a.opexEscalationPct / 100, (k - 1) / 12);
      const oil = oilRate(k);
      const gas = gasRate(k);
      const ngl = nglRate(k);

      const revOil = oil * a.oilPrice * esc;
      const revGas = gas * a.gasPrice * esc;
      const revNgl = ngl * a.nglPrice * esc;
      const grossRevenue = revOil + revGas + revNgl;
      const netBeforeTax = grossRevenue * a.nri;
      const severanceTax = ((revOil + revNgl) * (a.sevTaxOilPct / 100) + revGas * (a.sevTaxGasPct / 100)) * a.nri;
      const adValorem = netBeforeTax * (a.adValoremPct / 100);
      const opex = a.opexPerMonth * opexEsc * a.workingInterest;
      const netRevenue = netBeforeTax;
      const netCashFlow = netBeforeTax - severanceTax - adValorem - opex;

      // Economic limit: sustained sub-floor cash flow ends the well's life.
      if (netCashFlow <= a.economicLimitNetCashFlow || grossRevenue < 1) {
        endReason = "ECONOMIC_LIMIT";
        break;
      }

      cum += netCashFlow;
      months.push({
        month: ym,
        oilBbl: oil,
        gasMcf: gas,
        nglBbl: ngl,
        oilRevenue: revOil,
        gasRevenue: revGas,
        nglRevenue: revNgl,
        grossRevenue,
        severanceTax,
        adValorem,
        opex,
        netRevenue,
        netCashFlow,
        cumNetCashFlow: cum,
        discountedCashFlow: netCashFlow / Math.pow(1 + discM, k),
      });
    }
  }

  const remaining = {
    oilBbl: months.reduce((s, m) => s + m.oilBbl, 0),
    gasMcf: months.reduce((s, m) => s + m.gasMcf, 0),
    nglBbl: months.reduce((s, m) => s + m.nglBbl, 0),
    boe: 0,
  };
  remaining.boe = remaining.oilBbl + remaining.nglBbl + remaining.gasMcf / 6;

  // Forecast confidence = weakest fit among phases that matter (revenue-weighted would
  // be overkill; the dominant phase dominates the risk anyway).
  const fitsUsed = [fits.oil, fits.gas, fits.ngl].filter((f): f is DeclineFit => !!f);
  const rank: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };
  const confidence: Confidence = fitsUsed.length
    ? fitsUsed.reduce<Confidence>((worst, f) => (rank[f.confidence] < rank[worst] ? f.confidence : worst), "high")
    : "low";

  return {
    months,
    endReason,
    remainingMonths: months.length,
    remainingYears: Math.round((months.length / 12) * 10) / 10,
    economicLimitMonth: endReason === "ECONOMIC_LIMIT" && months.length ? months[months.length - 1].month : null,
    remaining,
    eur: {
      oilBbl: summary.oil.cumulative + remaining.oilBbl,
      gasMcf: summary.gas.cumulative + remaining.gasMcf,
      nglBbl: summary.ngl.cumulative + remaining.nglBbl,
      boe: summary.cumBoe + remaining.boe,
    },
    confidence,
  };
}

/** Monthly IRR via bisection, annualized. cash[0] is the (negative) investment. */
export function irrAnnualPct(cash: number[]): number | null {
  if (cash.length < 2 || cash[0] >= 0) return null;
  // A stream that never returns the investment has no meaningful IRR.
  if (cash.reduce((s, c) => s + c, 0) <= 0) return null;
  const npvAt = (r: number) => cash.reduce((s, c, i) => s + c / Math.pow(1 + r, i), 0);
  let lo = -0.99, hi = 5;
  if (npvAt(lo) < 0 || npvAt(hi) > 0) return null; // no sign change in range
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (npvAt(mid) > 0) lo = mid;
    else hi = mid;
  }
  const monthly = (lo + hi) / 2;
  return (Math.pow(1 + monthly, 12) - 1) * 100;
}

export function presentValue(months: ForecastMonth[], annualRatePct: number): number {
  const discM = Math.pow(1 + annualRatePct / 100, 1 / 12) - 1;
  return months.reduce((s, m, i) => s + m.netCashFlow / Math.pow(1 + discM, i + 1), 0);
}

export function computeEconomics(forecast: ForecastResult, a: ValuationAssumptions): EconomicsResult {
  const months = forecast.months;
  const investment = a.askingPrice + a.closingCosts;
  const grossRevenueTotal = months.reduce((s, m) => s + m.grossRevenue, 0);
  const netRevenueTotal = months.reduce((s, m) => s + m.netRevenue, 0);
  const totalTaxes = months.reduce((s, m) => s + m.severanceTax + m.adValorem, 0);
  const totalOpex = months.reduce((s, m) => s + m.opex, 0);
  const netCashFlowTotal = months.reduce((s, m) => s + m.netCashFlow, 0);
  const pv = presentValue(months, a.discountRatePct);
  const pv10 = presentValue(months, 10);

  let paybackMonths: number | null = null;
  if (investment > 0) {
    const idx = months.findIndex((m) => m.cumNetCashFlow >= investment);
    paybackMonths = idx === -1 ? null : idx + 1;
  }

  return {
    investment,
    grossRevenueTotal,
    netRevenueTotal,
    totalTaxes,
    totalOpex,
    netCashFlowTotal,
    presentValue: pv,
    pv10,
    npv: pv - investment,
    irrAnnualPct: investment > 0 ? irrAnnualPct([-investment, ...months.map((m) => m.netCashFlow)]) : null,
    paybackMonths,
    roiPct: investment > 0 ? ((netCashFlowTotal - investment) / investment) * 100 : null,
    breakEvenPriceFactor: investment > 0 && pv > 0 ? investment / pv : null,
    breakEvenOilPrice: investment > 0 && pv > 0 ? a.oilPrice * (investment / pv) : null,
    monthlyCashFlowFirstYearAvg: months.slice(0, 12).reduce((s, m) => s + m.netCashFlow, 0) / Math.max(1, Math.min(12, months.length)),
  };
}

// ---------------------------------------------------------------------------
// Acquisition valuation & offer recommendation
// ---------------------------------------------------------------------------

export interface ValuationSection {
  /** PV of forecast cash flows at the user's discount rate — FMV proxy. */
  fairMarketValue: number;
  pv10: number;
  /** Highest price that still meets the buyer's return targets. */
  maxPurchasePrice: number;
  recommendedOffer: number;
  offerVsAskingPct: number | null; // negative = below asking
  askingPriceAssessment: "BELOW_VALUE" | "NEAR_VALUE" | "ABOVE_VALUE" | null;
  expectedGrossProfit: number | null; // resale scenario
  expectedNetProfit: number | null;
  resaleRoiPct: number | null;
  resaleMarginPct: number | null;
  /** Economics evaluated at the asking price, for comparison. */
  atAsking: { npv: number; roiPct: number | null; paybackMonths: number | null } | null;
}

export function computeValuation(forecast: ForecastResult, econ: EconomicsResult, a: ValuationAssumptions): ValuationSection {
  const months = forecast.months;
  const fmv = econ.presentValue;
  const totalNetCF = econ.netCashFlowTotal;

  // Max price satisfying each configured constraint; the binding (lowest) wins.
  const candidates: number[] = [fmv]; // NPV ≥ 0 at the discount rate
  if (a.targetRoiPct != null && a.targetRoiPct > -100) {
    // ROI target: (totalNetCF − P − closing) / (P + closing) ≥ target
    candidates.push(totalNetCF / (1 + a.targetRoiPct / 100) - a.closingCosts);
  }
  if (a.targetProfitAmount != null) {
    candidates.push(totalNetCF - a.targetProfitAmount - a.closingCosts);
  }
  if (a.resalePrice != null && a.targetProfitMarginPct != null) {
    // Resale margin target: (resale − P − closing) / resale ≥ margin
    candidates.push(a.resalePrice * (1 - a.targetProfitMarginPct / 100) - a.closingCosts);
  }
  const maxPurchase = Math.max(0, Math.min(...candidates));

  // Recommend the max defensible price, but never above asking when the seller
  // is already asking less than what the target allows.
  const recommended = a.askingPrice > 0 ? Math.min(maxPurchase, a.askingPrice) : maxPurchase;

  let askingAssessment: ValuationSection["askingPriceAssessment"] = null;
  if (a.askingPrice > 0 && fmv > 0) {
    const ratio = a.askingPrice / fmv;
    askingAssessment = ratio < 0.9 ? "BELOW_VALUE" : ratio <= 1.1 ? "NEAR_VALUE" : "ABOVE_VALUE";
  }

  // Resale scenario at the recommended offer.
  let expectedGrossProfit: number | null = null;
  let expectedNetProfit: number | null = null;
  let resaleRoiPct: number | null = null;
  let resaleMarginPct: number | null = null;
  if (a.resalePrice != null && a.resalePrice > 0) {
    const basis = recommended + a.closingCosts;
    expectedGrossProfit = a.resalePrice - recommended;
    expectedNetProfit = a.resalePrice - basis;
    resaleRoiPct = basis > 0 ? (expectedNetProfit / basis) * 100 : null;
    resaleMarginPct = (expectedNetProfit / a.resalePrice) * 100;
  }

  let atAsking: ValuationSection["atAsking"] = null;
  if (a.askingPrice > 0) {
    const inv = a.askingPrice + a.closingCosts;
    const idx = months.findIndex((m) => m.cumNetCashFlow >= inv);
    atAsking = {
      npv: fmv - inv,
      roiPct: inv > 0 ? ((totalNetCF - inv) / inv) * 100 : null,
      paybackMonths: idx === -1 ? null : idx + 1,
    };
  }

  return {
    fairMarketValue: fmv,
    pv10: econ.pv10,
    maxPurchasePrice: maxPurchase,
    recommendedOffer: Math.max(0, recommended),
    offerVsAskingPct: a.askingPrice > 0 ? ((recommended - a.askingPrice) / a.askingPrice) * 100 : null,
    askingPriceAssessment: askingAssessment,
    expectedGrossProfit,
    expectedNetProfit,
    resaleRoiPct,
    resaleMarginPct,
    atAsking,
  };
}

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

export interface SensitivityRow {
  label: string;
  priceFactor: number;
  oilPrice: number;
  gasPrice: number;
  presentValue: number;
  npv: number;
  roiPct: number | null;
  irrAnnualPct: number | null;
  paybackMonths: number | null;
}

const SENSITIVITY_FACTORS = [0.7, 0.85, 1, 1.15, 1.3];

export function computeSensitivity(series: MonthVolumes[], fits: PhaseFits, a: ValuationAssumptions): SensitivityRow[] {
  return SENSITIVITY_FACTORS.map((f) => {
    const scenario: ValuationAssumptions = {
      ...a,
      oilPrice: a.oilPrice * f,
      gasPrice: a.gasPrice * f,
      nglPrice: a.nglPrice * f,
    };
    const fc = buildForecast(series, fits, scenario);
    const econ = computeEconomics(fc, scenario);
    return {
      label: f === 1 ? "Base case" : `${f > 1 ? "+" : ""}${Math.round((f - 1) * 100)}% prices`,
      priceFactor: f,
      oilPrice: scenario.oilPrice,
      gasPrice: scenario.gasPrice,
      presentValue: econ.presentValue,
      npv: econ.npv,
      roiPct: econ.roiPct,
      irrAnnualPct: econ.irrAnnualPct,
      paybackMonths: econ.paybackMonths,
    };
  });
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export interface ValuationResult {
  assumptions: ValuationAssumptions;
  production: ProductionSummary;
  history: MonthVolumes[];
  decline: PhaseFits;
  forecast: ForecastResult;
  economics: EconomicsResult;
  valuation: ValuationSection;
  sensitivity: SensitivityRow[];
  warnings: string[];
  runAt: string;
}

export function runValuation(rows: MonthVolumes[], input?: Partial<ValuationAssumptions>): ValuationResult {
  const a = normalizeAssumptions(input);
  const series = mergeMonthly(rows);
  const production = summarizeProduction(series);

  const fits: PhaseFits = {
    oil: fitDecline(series, "oil", a.declineOverride?.oil),
    gas: fitDecline(series, "gas", a.declineOverride?.gas),
    ngl: fitDecline(series, "ngl"),
  };

  const forecast = buildForecast(series, fits, a);
  const economics = computeEconomics(forecast, a);
  const valuation = computeValuation(forecast, economics, a);
  const sensitivity = computeSensitivity(series, fits, a);

  const warnings: string[] = [];
  if (!series.length) warnings.push("No production history found for the selected wells — the analysis has nothing to forecast from.");
  if (series.length > 0 && series.length < 12) warnings.push(`Only ${series.length} months of production history; decline fits and forecasts are low-confidence.`);
  if (fits.oil && fits.oil.confidence === "low" && production.oil.cumulative > 0) warnings.push("Oil decline fit is low-confidence (noisy or short history).");
  if (fits.gas && fits.gas.confidence === "low" && production.gas.cumulative > 0) warnings.push("Gas decline fit is low-confidence (noisy or short history).");
  if (!fits.oil && production.oil.cumulative > 0) warnings.push("Not enough post-peak oil data to fit a decline curve — oil is excluded from the forecast.");
  if (!fits.gas && production.gas.cumulative > 0) warnings.push("Not enough post-peak gas data to fit a decline curve — gas is excluded from the forecast.");
  if (forecast.endReason === "MAX_MONTHS") warnings.push(`Forecast capped at ${a.maxForecastMonths} months before reaching the economic limit.`);
  if (a.askingPrice > 0 && valuation.maxPurchasePrice < a.askingPrice) warnings.push("Asking price exceeds the maximum purchase price that meets your return targets.");
  if (production.anomalies.some((x) => x.kind === "DOWNTIME")) warnings.push("History contains zero-production months; verify whether these are shut-ins or reporting gaps.");

  return {
    assumptions: a,
    production,
    history: series,
    decline: fits,
    forecast,
    economics,
    valuation,
    sensitivity,
    warnings,
    runAt: new Date().toISOString(),
  };
}
