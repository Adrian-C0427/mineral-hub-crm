// Louisiana (SONRIS) wells on the map — client mirror of
// server/src/domain/sonrisWells.ts. Louisiana wells share the `wells` /
// `wellbores` tile layers with Texas RRC wells; their feature ids sit in their
// own block (2,000,000,000 + state serial), so a fid alone says which
// endpoint resolves it.

export const LA_FID_BASE = 2_000_000_000;
export const LA_FID_SPAN = 100_000_000;

/** True for a Louisiana map well id (never a Texas RRC id). */
export function isLaWellFid(fid: number | string | null | undefined): boolean {
  const n = Number(fid);
  return Number.isInteger(n) && n >= LA_FID_BASE && n < LA_FID_BASE + LA_FID_SPAN;
}

/** The unit (LUW) production block of /gis/wells/:fid for a Louisiana well. */
export interface LaUnit {
  luw: string;
  luwName: string | null;
  luwType: string | null;
  operator: string | null;
  /** Wells the unit reported in its latest month. */
  wellsReported: number | null;
  /** Wells on the map that carry this unit code. */
  mappedWells: number;
  window: { from: number; to: number };
  /** [YYYYMM, oil bbl (incl. condensate), gas mcf] */
  series: [number, number, number][];
  totals: { oil: number; gas: number; condensate: number };
  months: number;
  firstMonth: number | null;
  lastMonth: number | null;
  flaggedMonths: number;
}

/** /gis/wells/:fid for a Louisiana well (state "LA"). */
export interface LaWellDetail {
  state: "LA";
  fid: number; serial: number; api: string; name: string; wellNo: string | null;
  operator: string | null; operatorId: string | null; field: string | null; fieldId: string | null;
  statusCode: string; statusText: string; status: string; type: string; symbol: string;
  product: string | null; productLabel: string | null; classType: string | null;
  spudDate: string | null; permitDate: string | null; completionDate: string | null; statusDate: string | null;
  md: number | null; tvd: number | null;
  section: number | null; abstract: string | null; township: string | null; parish: string; location: string;
  lon: number; lat: number;
  locationQuality: "ok" | "flag"; locationNote: string | null;
  luw: string | null;
  bores: { fid: number; type: string; md: number | null; tvd: number | null; lengthFt: number }[];
  unit: LaUnit | null;
}

/** "2026-09" from 202609. */
export function ymLabel(ym: number | null | undefined): string {
  return ym ? `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, "0")}` : "—";
}

/**
 * The heading every Louisiana production figure sits under — always the
 * UNIT's, never implied to be the well's own:
 *   "Unit production — LUW 618433 (HA RA SU79;), reported for 4 wells"
 */
export function unitProductionTitle(u: Pick<LaUnit, "luw" | "luwName" | "wellsReported">): string {
  const name = u.luwName?.trim() ? ` (${u.luwName.trim()})` : "";
  const wells = u.wellsReported != null ? `, reported for ${u.wellsReported} well${u.wellsReported === 1 ? "" : "s"}` : "";
  return `Unit production — LUW ${u.luw}${name}${wells}`;
}

/** "Sec 4 · T14N R9W" (either part may be missing). */
export function sectionTownship(section: string | null | undefined, township: string | null | undefined): string | null {
  return [section, township].filter(Boolean).join(" · ") || null;
}

/** "Red River Co, TX" / "Red River Parish, LA" — a county line that names a parish as one. */
export function countyStateShort(county: string, state: string): string {
  return `${county} ${state === "LA" ? "Parish" : "Co"}, ${state}`;
}
