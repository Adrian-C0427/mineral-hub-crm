/**
 * Pure assembly steps of the RRC refresh — given already-parsed RRC records,
 * produce well rows, wellbore rows, status history and abstract polygons.
 * No IO (build.ts streams the files); unit-tested in refresh.test.ts.
 */
import {
  deriveProfile, deriveWellStatus, deriveWellType, rrcIsoDate, STATUS_CATEGORY, symbolInfo,
  type DerivedStatus, type PermitFacts, type UicFacts, type WellboreQueryRow, type WellStatus,
} from "../../domain/wellStatus.js";
import { distanceFt, type DatumShift } from "./datum.js";
import type { AbstractRow, BoreRow, CountyScope, HistoryRow, LonLat, WellRow } from "./dataset.js";
import type { EwaField } from "./records.js";
import { gasLedgerKey, oilLedgerKey, type AssignedAcres } from "./ledger.js";
import { ringsToMultiPolygon, type DbfRecord, type Pt, type Shape } from "./shapefile.js";

export type EwaRec = Record<EwaField, string>;

/** A wellbore at least this far (ft) from its surface spot is deviated (vertical holes differ by rounding, <10 ft). */
export const DEVIATED_MIN_FT = 50;
/** RRC NAD27 vs NAD83 coordinates further apart than this (after the datum shift) get a location flag. */
export const COORD_MISMATCH_FT = 50;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const lonLat = (lon: number, lat: number): LonLat => [round6(lon), round6(lat)];
const num = (s: string | undefined) => (s != null && s !== "" && Number.isFinite(Number(s)) ? Number(s) : null);
const api8Of = (s: string | undefined) => (/^\d{8}$/.test((s ?? "").trim()) ? (s ?? "").trim() : null);

/**
 * The Wellbore Query row that best describes the wellbore today: on the
 * schedule and producing, else on the schedule, else the most recent
 * completion. Its lease/operator/field become the well's.
 */
export function primaryEwaRow(rows: readonly EwaRec[]): EwaRec | null {
  const PROD = new Set(["PRODUCING", "SWR-10-WELL", "PROD FACTOR WELL"]);
  // Lexicographic: on schedule, then producing, then newest completion, then newest record id.
  const key = (r: EwaRec): string => [
    r.ON_SCHEDULE === "Y" ? "1" : "0",
    PROD.has(r.WELL_TYPE_NAME) ? "1" : "0",
    [r.COMPLETION_DATE, r.W2_G1_DATE].filter((d) => /^\d{8}$/.test(d)).sort().at(-1) ?? "00000000",
    r.OG_WELLBORE_EWA_ID.padStart(12, "0"),
  ].join("|");
  let best: EwaRec | null = null;
  for (const r of rows) if (!best || key(r) > key(best)) best = r;
  return best;
}

export interface LeaseProduction { lastYm: string; cumOil: number; cumGas: number }
export const leaseKey = (og: string, district: string, lease: string) => `${og}|${district.trim()}|${lease.trim().replace(/^0+(?=\d)/, "")}`;

/** Acreage one drilling permit reports (records.ts): lease/unit, per field, at the bottom hole. */
export interface PermitAcreage { permitNo: string; issued: string | null; surface: number | null; fields: Record<string, number>; bhl: number | null }

/**
 * A well's unit size: the newest permit that reports one — its acres for the
 * field the well produces from when the permit lists that field, else its
 * lease/pooled-unit acres, else any field's, else the bottom-hole lease's.
 * Every permit in RRC's file counts (not just the retained 6 years), which
 * is what puts a unit size on wells permitted before 2020.
 */
export function unitAcresOf(list: readonly PermitAcreage[] | undefined, fieldNo: string | null): { acres: number; permitNo: string; issued: string | null } | null {
  if (!list?.length) return null;
  const newestFirst = [...list].sort((a, b) => (b.issued ?? "").localeCompare(a.issued ?? "") || b.permitNo.localeCompare(a.permitNo));
  for (const p of newestFirst) {
    const acres = (fieldNo ? p.fields[fieldNo] : undefined) ?? p.surface ?? Object.values(p.fields)[0] ?? p.bhl;
    if (acres) return { acres, permitNo: p.permitNo, issued: p.issued };
  }
  return null;
}

/** A drilling permit's status facts plus who filed it (daf802 01 + 02 records). */
export interface PermitFiling extends PermitFacts {
  wellNo?: string;
  operator?: string | null;
  operatorNo?: string | null;
  leaseName?: string | null;
  district?: string | null;
}

export interface WellContext {
  /** Acres assigned per well from the Oil/Gas Ledgers (ledger.ts keys). */
  assigned?: { gas: Map<string, AssignedAcres>; oil: Map<string, AssignedAcres> };
  ewa: Map<string, EwaRec[]>;
  permits: Map<string, PermitFiling[]>;
  acreage: Map<string, PermitAcreage[]>;
  uic: Map<string, UicFacts>;
  formations: Map<string, string[]>;
  dbfPlug: Map<string, string>;
  production: Map<string, LeaseProduction>;
  prodNewestYm: string;
  asOf: string;
}

/** Latest permit of an API (by issue date, then permit number). */
export function latestPermit<T extends PermitFacts>(list: readonly T[] | undefined): T | null {
  if (!list?.length) return null;
  return list.reduce((a, b) => ((b.issued ?? "") > (a.issued ?? "") || ((b.issued ?? "") === (a.issued ?? "") && b.permitNo > a.permitNo) ? b : a));
}

/** Status + type of one wellbore API in context (shared by surface wells and bores). */
export function statusOf(api8: string | null, symbol: number | null, ctx: WellContext): { derived: DerivedStatus; type: string; ewa: EwaRec[]; rows: WellboreQueryRow[] } {
  const ewa = api8 ? ctx.ewa.get(api8) ?? [] : [];
  const rows = ewa.map(toRow);
  const on = rows.filter((r) => r.onSchedule);
  const last = on
    .map((r) => ctx.production.get(leaseKey(r.oilGas, r.district, r.leaseNo))?.lastYm ?? null)
    .reduce<string | null>((m, v) => (v && (!m || v > m) ? v : m), null);
  const derived = deriveWellStatus({
    symbol, hasApi: !!api8, ewa: rows,
    permit: api8 ? latestPermit(ctx.permits.get(api8)) : null,
    uic: api8 ? ctx.uic.get(api8) ?? null : null,
    lastProdYm: last, prodNewestYm: ctx.prodNewestYm, asOf: ctx.asOf,
  });
  const completed = rows.some((r) => r.completionDate || r.w2g1Date);
  return { derived, type: deriveWellType({ status: derived.status, ewa: rows, symbol, completed }), ewa, rows };
}

// Wellbore Query record → status-input row (records.toWellboreQueryRow, kept
// local to avoid a cycle with records.ts' type import).
function toRow(r: EwaRec): WellboreQueryRow {
  const d8 = (s: string) => (/^\d{8}$/.test(s) && !/^0+$/.test(s) ? s : null);
  return {
    onSchedule: r.ON_SCHEDULE === "Y", wellType: r.WELL_TYPE_NAME,
    oilGas: r.OIL_GAS_CODE === "O" || r.OIL_GAS_CODE === "G" ? r.OIL_GAS_CODE : "",
    district: r.DISTRICT, leaseNo: r.LEASE_NUMBER,
    wbShutIn: /^\d{6}$/.test(r.WB_SHUT_IN_DATE) && !/^0+$/.test(r.WB_SHUT_IN_DATE) ? r.WB_SHUT_IN_DATE : null,
    b14b2: r.WB_14B2_FLAG === "Y",
    plugDate: d8(r.PLUG_DATE), completionDate: d8(r.COMPLETION_DATE), w2g1Date: d8(r.W2_G1_DATE),
  };
}

export interface SurfaceRecord { rec: DbfRecord; county: CountyScope; lonLat83: LonLat }
export interface BottomRecord { rec: DbfRecord; county: CountyScope }
export interface LateralRecord { rec: DbfRecord; county: CountyScope; line27: Pt[]; shift: DatumShift }

/** One surface location → its well row (status from its primary wellbore API). */
export function assembleWell(
  s: SurfaceRecord, bottoms: readonly BottomRecord[], laterals: readonly LateralRecord[], ctx: WellContext, shift: DatumShift,
): { row: WellRow; derived: DerivedStatus } {
  const r = s.rec;
  const fid = Number(r.SURFACE_ID);
  const api8 = api8Of(r.API);
  const surfSym = num(r.SYMNUM);
  // The surface spot of a horizontal/directional well (86/87) carries no
  // status; its own wellbore's bottom-hole record does.
  const own = bottoms.find((b) => api8 && b.rec.API === api8) ?? bottoms[0] ?? null;
  const symbol = surfSym === 86 || surfSym === 87 ? num(own?.rec.SYMNUM) : surfSym;
  const { derived, type, ewa } = statusOf(api8, symbol, ctx);
  const primary = primaryEwaRow(ewa);
  const permits = api8 ? ctx.permits.get(api8) ?? [] : [];
  const permit = latestPermit(permits);
  const stcodes = [...bottoms.map((b) => b.rec.STCODE ?? ""), ...laterals.map((l) => l.rec.STCODE ?? "")];
  const profile = deriveProfile(surfSym, stcodes, !!permit?.horizontal);
  const prod = primary ? ctx.production.get(leaseKey(primary.OIL_GAS_CODE, primary.DISTRICT, primary.LEASE_NUMBER)) : undefined;
  const maxDate = (k: EwaField) => ewa.map((e) => e[k]).filter((d) => /^\d{8}$/.test(d) && !/^0+$/.test(d)).sort().at(-1) ?? null;
  const shutIn = ewa.filter((e) => e.ON_SCHEDULE === "Y").map((e) => e.WB_SHUT_IN_DATE).filter((d) => /^\d{6}$/.test(d) && !/^0+$/.test(d)).sort().at(-1) ?? null;
  // A plug date belongs on the well only when the well IS plugged: a re-entered
  // or plugged-back wellbore keeps its earlier completion's W-3 in history.
  const plug = derived.status === "Plugged" ? maxDate("PLUG_DATE") ?? (api8 ? ctx.dbfPlug.get(api8) ?? null : null) : null;

  // Location accuracy: RRC's NAD27 and NAD83 pairs should differ by exactly the datum shift.
  const ctl = { lon27: Number(r.LONG27), lat27: Number(r.LAT27), lon83: Number(r.LONG83), lat83: Number(r.LAT83) };
  const mismatch = shift.mismatchFt(ctl);
  const symText = symbolInfo(symbol)?.label ?? symbolInfo(surfSym)?.label ?? null;
  const unit = api8 ? unitAcresOf(ctx.acreage.get(api8), primary?.FIELD_NUMBER || null) : null;
  // Only a well on the schedule has current proration acreage.
  const assigned = primary && primary.ON_SCHEDULE === "Y" && ctx.assigned
    ? (primary.OIL_GAS_CODE === "G"
      ? ctx.assigned.gas.get(gasLedgerKey(primary.DISTRICT, primary.LEASE_NUMBER))
      : ctx.assigned.oil.get(oilLedgerKey(primary.DISTRICT, primary.LEASE_NUMBER, primary.WELL_NO))) ?? null
    : null;

  const src: Record<string, string> = { geom: "gis-wells", symbol: "gis-wells", profile: "gis-wells" };
  if (derived.source === "wellbore-query") src.status = "wellbore-query";
  else if (derived.source === "uic") src.status = "uic";
  else if (derived.source === "permit") src.status = "permits";
  else src.status = "gis-wells";
  if (primary) for (const k of ["operator", "lease", "field", "oilGas", "wellNo", "completionDate", "plugDate", "shutInDate"]) src[k] = "wellbore-query";
  // No completion on the Wellbore Query (permitted, drilling, never drilled —
  // RRC often lists such an API with an empty row): the newest permit names
  // the operator and lease, as RRC's map popup does.
  const filing = primary?.OPERATOR_NAME ? null : permit;
  if (filing?.operator) src.operator = src.lease = "permits";
  if (permit) { src.permit = "permits"; src.spudDate = "permits"; }
  if (unit) src.unitAcres = "permits";
  if (assigned) src.assignedAcres = "proration-ledger";
  if (prod) src.lastProd = src.cum = "production";
  if (api8 && ctx.formations.get(api8)?.length) src.formations = "wellbore-master";
  if (derived.status === "Injection" || derived.status === "Disposal") src.injectionType = derived.source === "uic" ? "uic" : "wellbore-query";

  const row: WellRow = {
    fid, api8, api10: api8 ? `42${api8}` : null,
    wellNo: primary?.WELL_NO || own?.rec.CWELLNUM || filing?.wellNo || null,
    wellId: r.WELLID || null,
    county: s.county.name,
    district: primary?.DISTRICT || filing?.district || null,
    leaseNo: primary?.LEASE_NUMBER || null,
    leaseName: primary?.LEASE_NAME || filing?.leaseName || null,
    operator: primary?.OPERATOR_NAME || filing?.operator || null,
    operatorNo: primary?.OPERATOR_NUMBER || filing?.operatorNo || null,
    fieldNo: primary?.FIELD_NUMBER || null,
    fieldName: primary?.FIELD_NAME || null,
    oilGas: primary?.OIL_GAS_CODE === "O" ? "Oil" : primary?.OIL_GAS_CODE === "G" ? "Gas" : null,
    type, profile, symbol: symText,
    status: derived.status, category: STATUS_CATEGORY[derived.status],
    statusDetail: derived.detail, statusFlag: derived.flag, statusNote: derived.note,
    statusSource: derived.source, statusSince: derived.since, adminStatus: derived.adminStatus,
    permitNo: permit?.permitNo ?? null,
    permitDate: rrcIsoDate(permit?.issued),
    permitExpires: rrcIsoDate(permit?.expires),
    spudDate: rrcIsoDate(permits.map((p) => p.spud).filter(Boolean).sort().at(-1)),
    completionDate: rrcIsoDate(maxDate("COMPLETION_DATE") ?? maxDate("W2_G1_DATE")),
    plugDate: rrcIsoDate(plug),
    shutInDate: rrcIsoDate(shutIn),
    lastProd: prod ? `${prod.lastYm.slice(0, 4)}-${prod.lastYm.slice(4, 6)}` : null,
    cumOil: prod ? prod.cumOil : null,
    cumGas: prod ? prod.cumGas : null,
    formations: (api8 && ctx.formations.get(api8)) || null,
    injectionType: derived.status === "Injection" || derived.status === "Disposal" ? derived.detail : null,
    unitAcres: unit?.acres ?? null,
    unitAcresSource: unit ? `W-1 permit ${unit.permitNo}${unit.issued ? ` (${rrcIsoDate(unit.issued)})` : ""}` : null,
    assignedAcres: assigned ? Math.round(assigned.acres * 1000) / 1000 : null,
    assignedAcresYm: assigned ? `${assigned.ym.slice(0, 4)}-${assigned.ym.slice(4, 6)}` : null,
    locationFlag: mismatch > COORD_MISMATCH_FT ? "coordinate-mismatch" : null,
    locationNote: mismatch > COORD_MISMATCH_FT ? `RRC's NAD27 and NAD83 coordinates for this well disagree by ${Math.round(mismatch)} ft; the map uses RRC's NAD83 point.` : null,
    geomFlag: null,
    lon: s.lonLat83[0], lat: s.lonLat83[1],
    sources: src,
  };
  return { row, derived };
}

/**
 * Deviated wellbores (horizontal / directional / sidetrack) of the refresh.
 * Each path joins RRC's surface location to RRC's bottom-hole location —
 * exactly the line RRC's own map draws (its lateral lines are these same two
 * points; measured against the live map: within ~3 ft on 1,298 of 1,300).
 * RRC's bulk data holds no points between the two (directional surveys are
 * scanned images), so no curve is invented:
 *  - every bottom-hole record ("b" layer) at least DEVIATED_MIN_FT from its
 *    surface spot, or flagged H1…/D1… codes by RRC;
 *  - plus RRC lateral lines ("l" layer) whose bottom-hole record lives in a
 *    county outside the refresh — the line's end IS RRC's bottom hole there
 *    (measured: 0 ft apart wherever both exist), so it stands in, flagged.
 * Every path is the straight surface → bottom-hole segment (RRC's own lines
 * are exactly that) and is marked approximate: RRC publishes directional
 * surveys only as scanned images, so no true trajectory exists in its data.
 */
export function assembleBores(
  bottoms: ReadonlyMap<number, BottomRecord>,
  laterals: ReadonlyMap<number, LateralRecord>,
  surfaces: ReadonlyMap<number, SurfaceRecord>,
  wellsByFid: ReadonlyMap<number, { row: WellRow; derived: DerivedStatus }>,
  ctx: WellContext,
): { bores: BoreRow[]; skippedNoSurface: number; verticalBottoms: number } {
  const bores: BoreRow[] = [];
  let skippedNoSurface = 0, verticalBottoms = 0;
  const statusFor = (api8: string | null, symbol: number | null, surfaceFid: number): { status: WellStatus | null; detail: string | null } => {
    const w = wellsByFid.get(surfaceFid);
    if (w && (!api8 || api8 === w.row.api8)) return { status: w.row.status, detail: w.row.statusDetail };
    if (!api8 && symbol == null) return { status: null, detail: null };
    const { derived } = statusOf(api8, symbol, ctx);
    return { status: derived.status, detail: derived.detail };
  };
  const profileOf = (stcode: string, surfaceFid: number, offsetFt: number): "Horizontal" | "Directional" => {
    if (stcode.startsWith("H")) return "Horizontal";
    if (stcode.startsWith("D")) return "Directional";
    const sym = num(surfaces.get(surfaceFid)?.rec.SYMNUM);
    if (sym === 86) return "Horizontal";
    if (sym === 87) return "Directional";
    return offsetFt >= 1500 ? "Horizontal" : "Directional";
  };

  for (const [bid, b] of bottoms) {
    const sid = Number(b.rec.SURFACE_ID);
    const surf = surfaces.get(sid);
    const line = laterals.get(bid);
    const surface: LonLat | null = surf ? surf.lonLat83 : line ? lonLat(...line.shift.apply(...line.line27[0])) : null;
    if (!surface) { skippedNoSurface++; continue; }
    const bh = lonLat(Number(b.rec.LONG83), Number(b.rec.LAT83));
    const stcode = b.rec.STCODE ?? "";
    const offset = distanceFt(surface, bh);
    if (!/^[HD]/.test(stcode) && offset < DEVIATED_MIN_FT) { verticalBottoms++; continue; }
    const api8 = api8Of(b.rec.API);
    const st = statusFor(api8, num(b.rec.SYMNUM), sid);
    bores.push({
      fid: bid, surfaceFid: sid, api8, api10: b.rec.API10 || null, stcode: stcode || null,
      profile: profileOf(stcode, sid, offset), county: b.county.name,
      status: st.status, statusDetail: st.detail,
      bh, bhSource: "rrc-bottom-hole",
      // RRC spots a permitted location's bottom hole from the W-1 plat; it moves
      // to the as-drilled point when the completion is filed.
      planned: num(b.rec.SYMNUM) === 2 || st.status === "Permitted" || st.status === "Drilling",
      path: [surface, bh], lineSource: line ? "rrc-lateral" : "endpoints", approximate: true,
      geomFlag: surf ? null : "surface-outside-scope",
    });
  }
  for (const [bid, l] of laterals) {
    if (bottoms.has(bid)) continue;
    const sid = Number(l.rec.SURFACE_ID);
    const surf = surfaces.get(sid);
    const surface = surf ? surf.lonLat83 : lonLat(...l.shift.apply(...l.line27[0]));
    const end = l.line27[l.line27.length - 1];
    const bh = lonLat(...l.shift.apply(end[0], end[1]));
    const api8 = api8Of(l.rec.API);
    const st = statusFor(api8, null, sid);
    const stcode = l.rec.STCODE ?? "";
    bores.push({
      fid: bid, surfaceFid: sid, api8, api10: l.rec.API10 || null, stcode: stcode || null,
      profile: profileOf(stcode, sid, distanceFt(surface, bh)), county: l.county.name,
      status: st.status, statusDetail: st.detail,
      bh, bhSource: "rrc-lateral-end",
      planned: st.status === "Permitted" || st.status === "Drilling",
      path: [surface, bh], lineSource: "rrc-lateral", approximate: true,
      geomFlag: surf ? null : "surface-outside-scope",
    });
  }
  bores.sort((a, b) => a.fid - b.fid);
  return { bores, skippedNoSurface, verticalBottoms };
}

/** Dated events RRC records for a well's API, oldest first, plus this refresh's status. */
export function historyOf(well: WellRow, permits: readonly PermitFacts[], ewa: readonly EwaRec[], refreshDate: string, refreshSource: string): HistoryRow[] {
  const out: HistoryRow[] = [];
  const base = { fid: well.fid, api8: well.api8 };
  for (const p of permits) {
    if (p.issued) out.push({ ...base, date: rrcIsoDate(p.issued), event: "permit-issued", status: "Permitted", detail: `Permit ${p.permitNo}${p.horizontal ? " (horizontal)" : ""}`, source: "permits" });
    if (p.spud) out.push({ ...base, date: rrcIsoDate(p.spud), event: "spud", status: "Drilling", detail: `Spudded under permit ${p.permitNo}`, source: "permits" });
  }
  const seen = new Set<string>();
  for (const e of ewa) {
    const c = rrcIsoDate(e.COMPLETION_DATE) ?? rrcIsoDate(e.W2_G1_DATE);
    if (c && !seen.has(`c${c}${e.LEASE_NUMBER}`)) {
      seen.add(`c${c}${e.LEASE_NUMBER}`);
      out.push({ ...base, date: c, event: "completed", status: null, detail: `Completed${e.FIELD_NAME ? ` in ${e.FIELD_NAME}` : ""}${e.LEASE_NUMBER ? ` (${e.OIL_GAS_CODE === "G" ? "gas ID" : "lease"} ${e.LEASE_NUMBER})` : ""}`, source: "wellbore-query" });
    }
    const si = /^\d{6}$/.test(e.WB_SHUT_IN_DATE) && !/^0+$/.test(e.WB_SHUT_IN_DATE) ? rrcIsoDate(e.WB_SHUT_IN_DATE) : null;
    if (si && e.ON_SCHEDULE === "Y" && !seen.has(`s${si}`)) {
      seen.add(`s${si}`);
      out.push({ ...base, date: si, event: "shut-in", status: "Shut-In", detail: "Inactive per RRC (wellbore shut-in date)", source: "wellbore-query" });
    }
    const pl = rrcIsoDate(e.PLUG_DATE);
    if (pl && !seen.has(`p${pl}`)) {
      seen.add(`p${pl}`);
      out.push({ ...base, date: pl, event: "plugged", status: "Plugged", detail: `Plugged (W-3)${e.LEASE_NUMBER ? ` — ${e.OIL_GAS_CODE === "G" ? "gas ID" : "lease"} ${e.LEASE_NUMBER}` : ""}`, source: "wellbore-query" });
    }
  }
  out.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  out.push({ ...base, date: refreshDate, event: "status-refresh", status: well.status, detail: well.statusDetail, source: refreshSource });
  return out;
}

// ---------------------------------------------------------------------------
// Abstracts (RRC survey polygons, surv{fips}p)
// ---------------------------------------------------------------------------

function ringAreaM2(ring: readonly LonLat[]): number {
  if (ring.length < 4) return 0;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][0] * 111_320 * k, y1 = ring[i][1] * 110_540;
    const x2 = ring[i + 1][0] * 111_320 * k, y2 = ring[i + 1][1] * 110_540;
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}
const polyAreaM2 = (poly: readonly LonLat[][]) => ringAreaM2(poly[0]) - poly.slice(1).reduce((s, r) => s + ringAreaM2(r), 0);

export interface AbstractBuildStats { polygons: number; abstracts: number; mergedPieces: number; otherCountyPolygons: number; unnumbered: number; splitBySurvey: number; questionLabels: number }

/**
 * RRC survey polygons → one row per abstract/survey combination:
 *  - pieces sharing an ABSTRACT_N, label and survey are ONE abstract split
 *    by a line (a road, a county line) → merged into a MultiPolygon (the old
 *    import kept the first piece and silently dropped the rest);
 *  - the same ABSTRACT_N under a different survey keeps its own row, id
 *    "TX-<N>~<k>", so it lists separately;
 *  - "?" labels ("A-?5") are RRC's unnumbered tracts (state land, school
 *    file land) — distinct from the numbered A-5, kept verbatim;
 *  - polygons with no ABSTRACT_N get a stable id from their survey and
 *    location ("TX-<fips>-NA-<hash>");
 *  - a polygon numbered in another county (ABSTRACT_N prefix ≠ this county)
 *    belongs to that county's abstract set and is left to it.
 * Coordinates go NAD27 → NAD83 with the county's well-derived shift.
 */
export function buildAbstracts(recs: readonly DbfRecord[], shapes: readonly Shape[], county: CountyScope, shift: DatumShift): { rows: AbstractRow[]; stats: AbstractBuildStats } {
  const stats: AbstractBuildStats = { polygons: 0, abstracts: 0, mergedPieces: 0, otherCountyPolygons: 0, unnumbered: 0, splitBySurvey: 0, questionLabels: 0 };
  type Piece = { n: string; label: string | null; survey: string | null; polys: LonLat[][][] };
  const groups = new Map<string, Piece[]>();
  recs.forEach((r, i) => {
    const sh = shapes[i];
    if (!sh || sh.kind !== "polygon") return;
    stats.polygons++;
    const n = (r.ABSTRACT_N ?? "").trim();
    if (n && !n.startsWith(county.code)) { stats.otherCountyPolygons++; return; }
    const polys = ringsToMultiPolygon(sh.rings).map((poly) => poly.map((ring) => ring.map(([x, y]) => lonLat(...shift.apply(x, y)))));
    if (!polys.length) return;
    const piece: Piece = { n, label: (r.ABSTRACT_L ?? "").trim() || null, survey: (r.LEVEL1_SUR ?? "").trim() || null, polys };
    const g = n || `NA|${piece.survey ?? ""}|${i}`;
    groups.set(g, [...(groups.get(g) ?? []), piece]);
  });

  const rows: AbstractRow[] = [];
  for (const pieces of groups.values()) {
    // Sub-group by (label, survey): one row each.
    const combos = new Map<string, Piece[]>();
    for (const p of pieces) combos.set(`${p.label ?? ""}|${p.survey ?? ""}`, [...(combos.get(`${p.label ?? ""}|${p.survey ?? ""}`) ?? []), p]);
    const ordered = [...combos.values()].map((ps) => ({ ps, area: ps.reduce((s, p) => s + p.polys.reduce((t, poly) => t + polyAreaM2(poly), 0), 0) }))
      .sort((a, b) => b.area - a.area || (a.ps[0].survey ?? "").localeCompare(b.ps[0].survey ?? ""));
    if (ordered.length > 1) stats.splitBySurvey += ordered.length - 1;
    ordered.forEach(({ ps, area }, k) => {
      const first = ps[0];
      let id: string;
      if (first.n) id = k === 0 ? `TX-${first.n}` : `TX-${first.n}~${k + 1}`;
      else {
        stats.unnumbered++;
        const c = first.polys[0][0][0];
        id = `TX-${county.code}-NA-${stableHash(`${first.survey ?? ""}|${c[0].toFixed(4)}|${c[1].toFixed(4)}`)}`;
      }
      if (ps.length > 1) stats.mergedPieces += ps.length - 1;
      if (first.label?.includes("?")) stats.questionLabels++;
      rows.push({
        id, county: county.name, countyFips: county.code, abstract: first.label, survey: first.survey,
        area: Math.round(area * 100) / 100, geom: ps.flatMap((p) => p.polys), pieces: ps.length,
      });
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  stats.abstracts = rows.length;
  return { rows, stats };
}

/** 8 hex chars of FNV-1a — a stable, collision-tolerant id suffix. */
export function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

