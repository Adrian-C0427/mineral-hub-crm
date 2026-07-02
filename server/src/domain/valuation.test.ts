import { describe, expect, it } from "vitest";
import {
  addMonths, arpsRate, buildForecast, computeEconomics, computeValuation, fitDecline,
  irrAnnualPct, mergeMonthly, monthDiff, normalizeAssumptions, presentValue, runValuation,
  summarizeProduction, type ForecastMonth, type ForecastResult, type MonthVolumes,
} from "./valuation.js";

// ---------------------------------------------------------------------------
// Helpers to build synthetic production series
// ---------------------------------------------------------------------------

function series(start: string, vols: Partial<Omit<MonthVolumes, "month">>[]): MonthVolumes[] {
  return vols.map((v, i) => ({
    month: addMonths(start, i),
    oilBbl: v.oilBbl ?? 0,
    gasMcf: v.gasMcf ?? 0,
    nglBbl: v.nglBbl ?? 0,
    waterBbl: v.waterBbl ?? 0,
  }));
}

/** Exponential decline oil well: qi bbl/mo, nominal annual decline di. */
function expWell(start: string, months: number, qi: number, diAnnual: number): MonthVolumes[] {
  const diM = diAnnual / 12;
  return series(start, Array.from({ length: months }, (_, t) => ({ oilBbl: qi * Math.exp(-diM * t) })));
}

// ---------------------------------------------------------------------------
// Month math
// ---------------------------------------------------------------------------

describe("month helpers", () => {
  it("adds months across year boundaries", () => {
    expect(addMonths("2023-11", 3)).toBe("2024-02");
    expect(addMonths("2024-01", -1)).toBe("2023-12");
  });
  it("computes month diffs", () => {
    expect(monthDiff("2023-01", "2024-03")).toBe(14);
    expect(monthDiff("2024-03", "2024-03")).toBe(0);
  });
});

describe("mergeMonthly", () => {
  it("sums overlapping months across wells and fills interior gaps with zeros", () => {
    const merged = mergeMonthly([
      { month: "2024-01", oilBbl: 100, gasMcf: 0, nglBbl: 0, waterBbl: 0 },
      { month: "2024-01", oilBbl: 50, gasMcf: 300, nglBbl: 0, waterBbl: 0 },
      { month: "2024-04", oilBbl: 80, gasMcf: 0, nglBbl: 0, waterBbl: 0 },
    ]);
    expect(merged).toHaveLength(4); // Jan..Apr
    expect(merged[0].oilBbl).toBe(150);
    expect(merged[0].gasMcf).toBe(300);
    expect(merged[1].oilBbl).toBe(0); // gap month filled
    expect(merged[3].oilBbl).toBe(80);
  });
  it("returns empty for no rows", () => {
    expect(mergeMonthly([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Production summary
// ---------------------------------------------------------------------------

describe("summarizeProduction", () => {
  it("computes cumulatives, peak and annual rollups", () => {
    const s = series("2023-11", [
      { oilBbl: 1000, gasMcf: 6000 },
      { oilBbl: 900 },
      { oilBbl: 800 },
      { oilBbl: 700 },
    ]);
    const sum = summarizeProduction(s);
    expect(sum.oil.cumulative).toBe(3400);
    expect(sum.oil.peak).toEqual({ month: "2023-11", volume: 1000 });
    expect(sum.cumBoe).toBe(3400 + 1000); // 6000 mcf = 1000 boe
    expect(sum.annual).toHaveLength(2);
    expect(sum.annual[0]).toMatchObject({ year: "2023", oilBbl: 1900 });
    expect(sum.annual[1]).toMatchObject({ year: "2024", oilBbl: 1500 });
  });

  it("flags downtime and sharp drops as anomalies", () => {
    const s = series("2024-01", [
      { oilBbl: 1000 }, { oilBbl: 950 }, { oilBbl: 900 },
      { oilBbl: 0 }, // downtime
      { oilBbl: 300 }, // sharp drop vs trailing average
      { oilBbl: 850 },
    ]);
    const sum = summarizeProduction(s);
    const kinds = sum.anomalies.map((a) => a.kind);
    expect(kinds).toContain("DOWNTIME");
    expect(kinds).toContain("SHARP_DROP");
  });
});

// ---------------------------------------------------------------------------
// Decline fitting
// ---------------------------------------------------------------------------

describe("fitDecline", () => {
  it("recovers an exponential decline", () => {
    const fit = fitDecline(expWell("2022-01", 36, 10000, 0.6), "oil");
    expect(fit).not.toBeNull();
    expect(fit!.b).toBeLessThanOrEqual(0.1);
    expect(fit!.diAnnualNominal).toBeGreaterThan(0.5);
    expect(fit!.diAnnualNominal).toBeLessThan(0.72);
    expect(fit!.r2).toBeGreaterThan(0.98);
    expect(fit!.confidence).toBe("high");
    expect(fit!.model).toBe("exponential");
  });

  it("recovers a hyperbolic decline", () => {
    const diM = 1.2 / 12;
    const b = 0.8;
    const s = series("2022-01", Array.from({ length: 48 }, (_, t) => ({ oilBbl: arpsRate(8000, diM, b, t) })));
    const fit = fitDecline(s, "oil")!;
    expect(fit.b).toBeGreaterThan(0.5);
    expect(fit.b).toBeLessThan(1.1);
    expect(fit.diAnnualNominal).toBeGreaterThan(0.8);
    expect(fit.diAnnualNominal).toBeLessThan(1.7);
    expect(fit.r2).toBeGreaterThan(0.98);
  });

  it("fits from the peak month, ignoring ramp-up", () => {
    const ramp = series("2021-10", [{ oilBbl: 200 }, { oilBbl: 600 }]);
    const s = [...ramp, ...expWell("2021-12", 24, 5000, 0.5)];
    const fit = fitDecline(s, "oil")!;
    expect(fit.fitStartMonth).toBe("2021-12");
    expect(fit.r2).toBeGreaterThan(0.98);
  });

  it("skips zero months (downtime) without breaking the time axis", () => {
    const s = expWell("2022-01", 24, 5000, 0.5);
    s[10] = { ...s[10], oilBbl: 0 };
    const fit = fitDecline(s, "oil")!;
    expect(fit.diAnnualNominal).toBeGreaterThan(0.4);
    expect(fit.diAnnualNominal).toBeLessThan(0.6);
  });

  it("returns null with insufficient data", () => {
    expect(fitDecline(series("2024-01", [{ oilBbl: 100 }, { oilBbl: 90 }]), "oil")).toBeNull();
    expect(fitDecline(series("2024-01", [{ gasMcf: 100 }]), "oil")).toBeNull();
  });

  it("honors manual overrides", () => {
    const s = expWell("2022-01", 24, 5000, 0.5);
    const fit = fitDecline(s, "oil", { b: 1, diAnnual: 0.9 })!;
    expect(fit.manual).toBe(true);
    expect(fit.b).toBe(1);
    expect(fit.diAnnualNominal).toBe(0.9);
    expect(fit.model).toBe("harmonic");
  });
});

// ---------------------------------------------------------------------------
// Forecast + economics
// ---------------------------------------------------------------------------

function baseCase() {
  const s = expWell("2022-01", 36, 3000, 0.5); // oil-only well
  const a = normalizeAssumptions({
    oilPrice: 80, gasPrice: 3, nglPrice: 25,
    nri: 0.75, workingInterest: 0, opexPerMonth: 0,
    sevTaxOilPct: 4.6, sevTaxGasPct: 7.5, adValoremPct: 2,
    askingPrice: 1_000_000, closingCosts: 25_000,
    discountRatePct: 10, maxForecastMonths: 240,
  });
  return { s, a };
}

describe("buildForecast", () => {
  it("declines monotonically from the end of history", () => {
    const { s, a } = baseCase();
    const fits = { oil: fitDecline(s, "oil"), gas: null, ngl: null };
    const fc = buildForecast(s, fits, a);
    expect(fc.months.length).toBeGreaterThan(24);
    expect(fc.months[0].month).toBe(addMonths(s[s.length - 1].month, 1));
    for (let i = 1; i < fc.months.length; i++) {
      expect(fc.months[i].oilBbl).toBeLessThanOrEqual(fc.months[i - 1].oilBbl);
    }
    // First forecast month continues the historical decline (small tolerance:
    // the Di grid is discrete, so the fitted curve can sit ~1% off the data).
    const lastHist = s[s.length - 1].oilBbl;
    expect(fc.months[0].oilBbl).toBeLessThan(lastHist * 1.05);
    expect(fc.months[0].oilBbl).toBeGreaterThan(lastHist * 0.8);
  });

  it("stops at the economic limit when opex is material", () => {
    const { s } = baseCase();
    const a = normalizeAssumptions({
      oilPrice: 80, nri: 0.8, workingInterest: 1, opexPerMonth: 4000,
      askingPrice: 0, maxForecastMonths: 600,
    });
    const fits = { oil: fitDecline(s, "oil"), gas: null, ngl: null };
    const fc = buildForecast(s, fits, a);
    expect(fc.endReason).toBe("ECONOMIC_LIMIT");
    expect(fc.economicLimitMonth).toBe(fc.months[fc.months.length - 1].month);
    // Every kept month clears the opex floor.
    for (const m of fc.months) expect(m.netCashFlow).toBeGreaterThan(0);
  });

  it("EUR = cumulative + remaining", () => {
    const { s, a } = baseCase();
    const fits = { oil: fitDecline(s, "oil"), gas: null, ngl: null };
    const fc = buildForecast(s, fits, a);
    const sum = summarizeProduction(s);
    expect(fc.eur.oilBbl).toBeCloseTo(sum.oil.cumulative + fc.remaining.oilBbl, 6);
  });

  it("forecasts NGL as a byproduct riding the oil decline", () => {
    const s = expWell("2022-01", 24, 3000, 0.5).map((m) => ({ ...m, nglBbl: m.oilBbl * 0.1 }));
    // NGL has its own fit here, but strip it to force byproduct mode:
    const fits = { oil: fitDecline(s, "oil"), gas: null, ngl: null };
    const a = normalizeAssumptions({ maxForecastMonths: 60 });
    const fc = buildForecast(s, fits, a);
    expect(fc.months[0].nglBbl).toBeGreaterThan(0);
    expect(fc.months[0].nglBbl / fc.months[0].oilBbl).toBeCloseTo(0.1, 1);
  });

  it("returns an empty forecast with no fits", () => {
    const fc = buildForecast([], { oil: null, gas: null, ngl: null }, normalizeAssumptions({}));
    expect(fc.months).toHaveLength(0);
    expect(fc.endReason).toBe("NO_DECLINE_FIT");
  });
});

describe("economics", () => {
  it("computes IRR on a known annuity", () => {
    // -1000 then 100 × 12 → monthly IRR ≈ 2.92%, annual ≈ 41%.
    const irr = irrAnnualPct([-1000, ...Array(12).fill(100)]);
    expect(irr).not.toBeNull();
    expect(irr!).toBeGreaterThan(38);
    expect(irr!).toBeLessThan(45);
  });

  it("returns null IRR when cash flows never repay", () => {
    expect(irrAnnualPct([-1000, 10, 10])).toBeNull();
  });

  it("discount: PV at 0% equals the undiscounted total", () => {
    const months = [500, 400, 300].map((cf, i) => ({ netCashFlow: cf, month: `2025-0${i + 1}` })) as unknown as ForecastMonth[];
    expect(presentValue(months, 0)).toBeCloseTo(1200, 6);
    expect(presentValue(months, 10)).toBeLessThan(1200);
  });

  it("ties the metrics together (NPV, ROI, payback)", () => {
    const { s, a } = baseCase();
    const fits = { oil: fitDecline(s, "oil"), gas: null, ngl: null };
    const fc = buildForecast(s, fits, a);
    const econ = computeEconomics(fc, a);
    expect(econ.investment).toBe(1_025_000);
    expect(econ.npv).toBeCloseTo(econ.presentValue - econ.investment, 6);
    expect(econ.grossRevenueTotal).toBeGreaterThan(econ.netRevenueTotal); // NRI < 1
    if (econ.paybackMonths != null) {
      expect(fc.months[econ.paybackMonths - 1].cumNetCashFlow).toBeGreaterThanOrEqual(econ.investment);
    }
    expect(econ.breakEvenOilPrice).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Valuation & offer
// ---------------------------------------------------------------------------

describe("computeValuation", () => {
  function fakeForecast(totalCF: number, months = 24): ForecastResult {
    const cf = totalCF / months;
    let cum = 0;
    const rows = Array.from({ length: months }, (_, i) => {
      cum += cf;
      return {
        month: addMonths("2025-01", i), oilBbl: 0, gasMcf: 0, nglBbl: 0,
        oilRevenue: cf, gasRevenue: 0, nglRevenue: 0,
        grossRevenue: cf, severanceTax: 0, adValorem: 0, opex: 0,
        netRevenue: cf, netCashFlow: cf, cumNetCashFlow: cum, discountedCashFlow: cf,
      };
    });
    return {
      months: rows, endReason: "ECONOMIC_LIMIT", remainingMonths: months, remainingYears: months / 12,
      economicLimitMonth: rows[rows.length - 1].month,
      remaining: { oilBbl: 0, gasMcf: 0, nglBbl: 0, boe: 0 },
      eur: { oilBbl: 0, gasMcf: 0, nglBbl: 0, boe: 0 },
      confidence: "high",
    };
  }

  it("caps the max purchase price by the ROI target", () => {
    const a = normalizeAssumptions({
      askingPrice: 1_200_000, closingCosts: 50_000, targetRoiPct: 30, discountRatePct: 0,
    });
    const fc = fakeForecast(1_300_000);
    const econ = computeEconomics(fc, a);
    const v = computeValuation(fc, econ, a);
    // ROI constraint: 1.3M / 1.3 − 50k = 950k, tighter than FMV (1.3M at 0%).
    expect(v.maxPurchasePrice).toBeCloseTo(950_000, 0);
    expect(v.recommendedOffer).toBeCloseTo(950_000, 0); // below asking
    expect(v.offerVsAskingPct).toBeLessThan(0);
  });

  it("never recommends above asking when asking is already below targets", () => {
    const a = normalizeAssumptions({ askingPrice: 500_000, targetRoiPct: 20, discountRatePct: 0 });
    const fc = fakeForecast(1_200_000);
    const econ = computeEconomics(fc, a);
    const v = computeValuation(fc, econ, a);
    expect(v.recommendedOffer).toBe(500_000);
    expect(v.askingPriceAssessment).toBe("BELOW_VALUE");
  });

  it("computes resale profit and margin", () => {
    const a = normalizeAssumptions({
      askingPrice: 800_000, closingCosts: 20_000, resalePrice: 1_000_000,
      targetProfitMarginPct: 20, discountRatePct: 0,
    });
    const fc = fakeForecast(1_500_000);
    const econ = computeEconomics(fc, a);
    const v = computeValuation(fc, econ, a);
    // Margin constraint: 1M × 0.8 − 20k = 780k.
    expect(v.maxPurchasePrice).toBeCloseTo(780_000, 0);
    expect(v.expectedNetProfit).toBeCloseTo(1_000_000 - 780_000 - 20_000, 0);
    expect(v.resaleMarginPct).toBeCloseTo(20, 5);
  });
});

// ---------------------------------------------------------------------------
// End-to-end
// ---------------------------------------------------------------------------

describe("runValuation", () => {
  it("produces a full result on a realistic well", () => {
    const s = expWell("2021-06", 42, 4500, 0.55).map((m, i) => ({
      ...m,
      gasMcf: m.oilBbl * 2.5,
      nglBbl: m.oilBbl * 0.08,
      waterBbl: m.oilBbl * 1.4,
      // Small noise so the fit isn't perfect (deterministic pseudo-noise).
      oilBbl: m.oilBbl * (1 + 0.06 * Math.sin(i * 2.399)),
    }));
    const r = runValuation(s, {
      oilPrice: 78, gasPrice: 2.8, nglPrice: 24, nri: 0.8,
      askingPrice: 2_000_000, closingCosts: 40_000, discountRatePct: 10, targetRoiPct: 25,
    });
    expect(r.production.monthsOfHistory).toBe(42);
    expect(r.decline.oil).not.toBeNull();
    expect(r.decline.oil!.r2).toBeGreaterThan(0.85);
    expect(r.forecast.remainingMonths).toBeGreaterThan(12);
    expect(r.economics.presentValue).toBeGreaterThan(0);
    expect(r.valuation.recommendedOffer).toBeGreaterThan(0);
    expect(r.valuation.recommendedOffer).toBeLessThanOrEqual(r.valuation.maxPurchasePrice + 1e-6);
    expect(r.sensitivity).toHaveLength(5);
    // Sensitivity PV rises with prices.
    for (let i = 1; i < r.sensitivity.length; i++) {
      expect(r.sensitivity[i].presentValue).toBeGreaterThan(r.sensitivity[i - 1].presentValue);
    }
  });

  it("warns on empty and short histories", () => {
    expect(runValuation([]).warnings.join(" ")).toMatch(/No production history/);
    const short = runValuation(expWell("2025-01", 5, 1000, 0.5));
    expect(short.warnings.join(" ")).toMatch(/months of production history/);
  });
});
