/**
 * Louisiana (SONRIS / Office of Conservation) wells on the map — the pure
 * parts: feature-id namespace, status/type vocabulary mapping, and unit
 * production shaping. The data lives in the `sonris` schema, loaded at boot by
 * services/sonrisWells.ts; Texas wells stay in `rrc`.
 *
 * Feature ids. Louisiana wells and bores render in the SAME `wells` /
 * `wellbores` vector-tile layers as Texas, whose MapLibre promoteId is `fid`
 * (rrc.wells.fid = the RRC SURFACE_ID, rrc.wellbores.fid = BOTTOM_ID — both
 * RRC counters, ~0.3M–1.5M today). Louisiana ids therefore live in their own
 * block far above that:
 *     well fid = 2,000,000,000 + state well serial
 *     bore fid = 2,000,000,000 + SONRIS bottom-hole sequence
 * with serial/seq < 100,000,000, so every id stays below 2^31 − 1 (the
 * `integer` columns, MVT ints and MapLibre feature-state all take it) and can
 * never meet a Texas id. Wells and bores are separate source layers, so the
 * two Louisiana blocks may overlap each other.
 *
 * Mirrored client-side in client/src/lib/laWells.ts — keep the two in step.
 */

export const LA_FID_BASE = 2_000_000_000;
/** Exclusive ceiling on a serial / bore sequence (keeps fids < 2^31 − 1). */
export const LA_FID_SPAN = 100_000_000;

export const laWellFid = (serial: number): number => LA_FID_BASE + serial;
export const laBoreFid = (seq: number): number => LA_FID_BASE + seq;
/** True for a map feature id in the Louisiana block (never a Texas RRC id). */
export const isLaFid = (fid: number): boolean => Number.isInteger(fid) && fid >= LA_FID_BASE && fid < LA_FID_BASE + LA_FID_SPAN;
export const laSerialOfFid = (fid: number): number | null => (isLaFid(fid) ? fid - LA_FID_BASE : null);

// ---------------------------------------------------------------------------
// Status / type vocabulary
//
// The map's paint, legend, status/type filters and Well Analysis all speak the
// Texas RRC vocabulary (tools/rrc/build_wells.py SYM table):
//   status: Producing · Shut-In · Plugged · Permitted · Dry Hole · Active
//           (injection/disposal) · Canceled/Abandoned · Unknown
//   type:   Oil · Gas · Oil/Gas · Location · Dry Hole · Injection/Disposal · Unknown
// Louisiana's status codes map onto it below; the state's own wording is kept
// separately (status_text) for the popup.
// ---------------------------------------------------------------------------

export type MapStatus = "Producing" | "Shut-In" | "Plugged" | "Permitted" | "Dry Hole" | "Active" | "Canceled/Abandoned" | "Unknown";
export interface MapClass { status: MapStatus; type: string; symbol: string }

/** SONRIS product code → label ("00" = no product specified). */
export const LA_PRODUCT_LABEL: Record<string, string> = { "10": "Oil", "20": "Gas", "25": "Dry gas" };

/** Product → Texas well type (dry gas is gas). Null when the state recorded none. */
export function productType(product: string | null | undefined): "Oil" | "Gas" | null {
  if (product === "10") return "Oil";
  if (product === "20" || product === "25") return "Gas";
  return null;
}

/**
 * Louisiana status code → map status bucket. Codes seen in Red River Parish;
 * anything else falls back to the wording (classifyLaWell).
 *   01 Permitted                                   → Permitted
 *   03 Permit Expired                              → Canceled/Abandoned (Texas' expired/canceled location)
 *   09 Active - Injection (SWD, ER, remediation…)  → Active (Injection/Disposal)
 *   10 Active - Producing                          → Producing
 *   20 PA-35 Temporarily inactive                  → Shut-In
 *   22 Reverted to single completion               → Plugged (this completion is closed off)
 *   23 Act 404 Orphan well                         → Shut-In (unplugged, inactive — no operator)
 *   24 Reverted to lease operation / resident use  → Shut-In (no commercial production)
 *   26 Act 404 Orphan well - injection             → Shut-In (Injection/Disposal)
 *   28 Unable to locate - no P&A on record         → Shut-In (unplugged per the record, inactive)
 *   29 Dry and plugged                             → Dry Hole
 *   30 Plugged and abandoned                       → Plugged
 *   31 Shut-in dry hole - future utility           → Dry Hole
 *   33 / 34 Shut-in productive (future utility or not) → Shut-In
 *   37 Shut-in waiting on market                   → Shut-In
 *   80 Unknown                                     → Unknown
 */
export const LA_STATUS_BUCKET: Record<string, MapStatus> = {
  "01": "Permitted",
  "03": "Canceled/Abandoned",
  "09": "Active",
  "10": "Producing",
  "20": "Shut-In",
  "22": "Plugged",
  "23": "Shut-In",
  "24": "Shut-In",
  "26": "Shut-In",
  "28": "Shut-In",
  "29": "Dry Hole",
  "30": "Plugged",
  "31": "Dry Hole",
  "33": "Shut-In",
  "34": "Shut-In",
  "37": "Shut-In",
  "80": "Unknown",
};

/** Bucket from the state's wording, for a code not in the table. Order matters. */
export function bucketFromWording(text: string): MapStatus {
  const t = text.toLowerCase();
  if (/\bdry\b/.test(t)) return "Dry Hole";
  if (/plugged and abandoned|\bp\s*&\s*a\b/.test(t) && !/\bno plugged\b/.test(t)) return "Plugged";
  if (/inject|disposal|\bswd\b/.test(t) && /\bactive\b/.test(t)) return "Active";
  if (/shut-?\s?in|inactive|orphan|unable to locate|revert/.test(t)) return "Shut-In";
  if (/producing/.test(t)) return "Producing";
  if (/expired|cancel|revoked/.test(t)) return "Canceled/Abandoned";
  if (/permit/.test(t)) return "Permitted";
  return "Unknown";
}

/** True when the state's wording describes an injection / disposal well. */
const isInjection = (code: string, text: string): boolean => code === "09" || code === "26" || /inject|disposal|\bswd\b/i.test(text);

/**
 * The map classification (status bucket, type, symbol) of one Louisiana well,
 * in the Texas vocabulary. Type follows the product where the state recorded
 * one; otherwise the bucket decides (a location, a dry hole, an injection
 * well) and an unrecorded product reads "Unknown" — never a guessed oil/gas.
 */
export function classifyLaWell(statusCode: string, statusText: string, product: string | null | undefined): MapClass {
  const status = LA_STATUS_BUCKET[statusCode] ?? bucketFromWording(statusText);
  const prod = productType(product);
  if (status === "Permitted") return { status, type: "Location", symbol: "Permitted Location" };
  if (status === "Canceled/Abandoned") return { status, type: "Location", symbol: "Canceled/Abandoned Location" };
  if (status === "Dry Hole") return { status, type: "Dry Hole", symbol: "Dry Hole" };
  if (isInjection(statusCode, statusText)) return { status, type: "Injection/Disposal", symbol: "Injection/Disposal" };
  const type = prod ?? "Unknown";
  switch (status) {
    case "Producing": return { status, type, symbol: prod ?? "Well" };
    case "Shut-In": return { status, type, symbol: prod ? `Shut-In (${prod})` : "Well" };
    case "Plugged": return { status, type, symbol: prod ? `Plugged ${prod}` : "Well" };
    default: return { status, type, symbol: "Well" };
  }
}

/** "Sec 12" (matches gis.abstracts' Louisiana section labels); null when unrecorded (0). */
export function sectionLabelOf(section: number | null | undefined): string | null {
  return section != null && Number.isInteger(section) && section > 0 ? `Sec ${section}` : null;
}

// ---------------------------------------------------------------------------
// Wellbores — Louisiana publishes straight surface → bottom-hole lines only
// ---------------------------------------------------------------------------

/** Great-circle distance in feet between two [lon, lat] points. */
export function distanceFt(a: readonly [number, number], b: readonly [number, number]): number {
  const R = 20_902_231; // mean earth radius, ft
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * "Horizontal" / "Directional" for the wellbores layer's color. A lateral
 * shows as measured depth well past true vertical depth (≥ 1,500 ft); without
 * both depths, a surface → bottom-hole offset of ≥ 1,500 ft reads as one.
 */
export function classifyLaBore(md: number | null, tvd: number | null, path: readonly (readonly [number, number])[]): "Horizontal" | "Directional" {
  if (md != null && tvd != null) return md - tvd >= 1500 ? "Horizontal" : "Directional";
  return distanceFt(path[0], path[path.length - 1]) >= 1500 ? "Horizontal" : "Directional";
}

// ---------------------------------------------------------------------------
// Unit (LUW) production
//
// Louisiana reports production per Lease/Unit/Well (LUW) code — a unit, not a
// well. Several wells can share one unit, so these volumes are ALWAYS labeled
// as unit production. `oil` is the state's oil figure, which already includes
// condensate (condensate is reported as a subset of it, never on top).
// ---------------------------------------------------------------------------

export interface UnitProductionRow { ym: number; line: string; oil: number; condensate: number; gas: number; wells: number; luwName: string | null; luwType: string | null; operator: string | null; stateFlag: string | null }

/** YYYYMM shifted by n months. */
export function ymShift(ym: number, n: number): number {
  const total = Math.floor(ym / 100) * 12 + (ym % 100) - 1 + n;
  return Math.floor(total / 12) * 100 + (total % 12) + 1;
}

export interface UnitProduction {
  /** Monthly [YYYYMM, oil bbl (incl. condensate), gas mcf], ascending, reported months only. */
  series: [number, number, number][];
  totals: { oil: number; gas: number; condensate: number };
  months: number;
  firstMonth: number | null;
  lastMonth: number | null;
  /** Wells the unit reported in its latest month (max across report lines — an operator change files two). */
  wellsReported: number | null;
  luwName: string | null;
  luwType: string | null;
  operator: string | null;
  /** Months the state itself flagged (delinquent report, zero wells with volume…). */
  flaggedMonths: number;
}

/**
 * Collapse a unit's report lines into one monthly series over the window
 * (from − to inclusive, YYYYMM). Lines in the same month are summed (an
 * operator change mid-month files one line per operator); the name, type and
 * operator come from the most recent line that carries them.
 */
export function shapeUnitProduction(rows: readonly UnitProductionRow[], from: number, to: number): UnitProduction {
  const inWin = rows.filter((r) => r.ym >= from && r.ym <= to).slice().sort((a, b) => a.ym - b.ym || a.line.localeCompare(b.line, undefined, { numeric: true }));
  const byMonth = new Map<number, { oil: number; gas: number; condensate: number; wells: number; flagged: boolean }>();
  for (const r of inWin) {
    const m = byMonth.get(r.ym) ?? { oil: 0, gas: 0, condensate: 0, wells: 0, flagged: false };
    m.oil += r.oil; m.gas += r.gas; m.condensate += r.condensate;
    m.wells = Math.max(m.wells, r.wells);
    m.flagged ||= !!r.stateFlag;
    byMonth.set(r.ym, m);
  }
  const series = [...byMonth.entries()].map(([ym, m]) => [ym, m.oil, m.gas] as [number, number, number]);
  const latest = <K extends "luwName" | "luwType" | "operator">(k: K) => {
    for (let i = inWin.length - 1; i >= 0; i--) if (inWin[i][k]) return inWin[i][k];
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i][k]) return rows[i][k];
    return null;
  };
  const last = series.length ? series[series.length - 1][0] : null;
  return {
    series,
    totals: {
      oil: series.reduce((s, p) => s + p[1], 0),
      gas: series.reduce((s, p) => s + p[2], 0),
      condensate: [...byMonth.values()].reduce((s, m) => s + m.condensate, 0),
    },
    months: series.length,
    firstMonth: series.length ? series[0][0] : null,
    lastMonth: last,
    wellsReported: last != null ? byMonth.get(last)!.wells : null,
    luwName: latest("luwName"),
    luwType: latest("luwType"),
    operator: latest("operator"),
    flaggedMonths: [...byMonth.values()].filter((m) => m.flagged).length,
  };
}

/** "Red River Parish, LA" — the location line for a Louisiana well. */
export const laParishLabel = (parish: string): string => `${parish} Parish, LA`;
