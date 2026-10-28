/**
 * The bundled Texas RRC refresh — the shapes the offline builder
 * (scripts/buildRrcRefresh.ts) writes and the boot-time loader
 * (services/rrcRefresh.ts) reads, with validation. Three gzipped JSON files
 * under server/data/rrc/, each loaded as its own versioned dataset:
 *
 *   tx-rrc-wells.json.gz       wells (surface locations), wellbores (bottom
 *                              holes + approximate paths), status history,
 *                              recent drilling permits, source snapshot dates
 *   tx-rrc-abstracts.json.gz   abstract/survey polygons rebuilt from RRC's
 *                              survey layer (NAD83, RRC-consistent)
 *   tx-rrc-production.json.gz  the newest 12 months of lease production
 *
 * Every attribute carries its source id (`sources`), and every source its
 * file and as-of date, so any value on screen can be traced to the RRC file
 * and snapshot it came from.
 */
import crypto from "node:crypto";
import { WELL_STATUSES, type WellStatus } from "../../domain/wellStatus.js";

export const RRC_DATA_DIR_REL = "../../../data/rrc";
export const WELLS_DATASET = { key: "rrc-tx-wells", file: "tx-rrc-wells.json.gz" } as const;
export const ABSTRACTS_DATASET = { key: "rrc-tx-abstracts", file: "tx-rrc-abstracts.json.gz" } as const;
export const PRODUCTION_DATASET = { key: "rrc-tx-production", file: "tx-rrc-production.json.gz" } as const;

export interface CountyScope { code: string; name: string }

export interface SourceSnapshot {
  /** Short id used in `sources` maps: "gis-wells", "wellbore-query", "permits"… */
  id: string;
  name: string;
  file: string;
  /** The RRC snapshot date of the file (YYYY-MM-DD). */
  asOf: string;
}

export type LonLat = [number, number];

export interface WellRow {
  fid: number;
  api8: string | null;
  api10: string | null;
  wellNo: string | null;
  wellId: string | null;
  county: string;
  district: string | null;
  leaseNo: string | null;
  leaseName: string | null;
  operator: string | null;
  operatorNo: string | null;
  fieldNo: string | null;
  fieldName: string | null;
  oilGas: string | null;
  type: string;
  profile: string;
  /** RRC map symbol of the wellbore (the bottom-hole symbol for horizontal/directional surface spots). */
  symbol: string | null;
  status: WellStatus;
  category: string;
  statusDetail: string | null;
  statusFlag: string | null;
  statusNote: string | null;
  statusSource: string;
  statusSince: string | null;
  adminStatus: string | null;
  permitNo: string | null;
  permitDate: string | null;
  permitExpires: string | null;
  spudDate: string | null;
  completionDate: string | null;
  plugDate: string | null;
  shutInDate: string | null;
  lastProd: string | null;
  cumOil: number | null;
  cumGas: number | null;
  injectionType: string | null;
  /** Lease / pooled-unit acres from the newest W-1 permit that reports them. */
  unitAcres: number | null;
  unitAcresSource: string | null;
  /** Acres RRC's proration schedule currently assigns the well (Oil/Gas Ledger) — may be a share of the unit. */
  assignedAcres: number | null;
  /** Ledger month those acres are from (YYYY-MM). */
  assignedAcresYm: string | null;
  locationFlag: string | null;
  locationNote: string | null;
  geomFlag: string | null;
  lon: number;
  lat: number;
  /** attribute → SourceSnapshot.id */
  sources: Record<string, string>;
}

export interface BoreRow {
  /** RRC BOTTOM_ID (unique per wellbore). */
  fid: number;
  surfaceFid: number;
  api8: string | null;
  api10: string | null;
  stcode: string | null;
  profile: "Horizontal" | "Directional";
  county: string;
  status: WellStatus | null;
  statusDetail: string | null;
  /** Bottom-hole location (NAD83). */
  bh: LonLat;
  /** "rrc-bottom-hole" (RRC's bottom-hole record) or "rrc-lateral-end" (end of RRC's lateral line — the record sits in an adjacent county's file). */
  bhSource: string;
  /** The well isn't completed yet: RRC's bottom hole is the PERMITTED target, not a drilled location. */
  planned: boolean;
  /** Surface → bottom hole. Straight: no directional-survey trajectory exists in RRC's bulk data, so every path is approximate. */
  path: LonLat[];
  /** "rrc-lateral" (RRC drew the line) or "endpoints" (joined from RRC's surface and bottom-hole points). */
  lineSource: string;
  approximate: boolean;
  /** "surface-outside-scope" when the surface location is in a county outside the refresh. */
  geomFlag: string | null;
}

export interface HistoryRow {
  fid: number;
  api8: string | null;
  /** YYYY-MM-DD, or null when RRC records no date for the event. */
  date: string | null;
  event: "permit-issued" | "spud" | "completed" | "shut-in" | "plugged" | "status-refresh";
  status: WellStatus | null;
  detail: string | null;
  source: string;
}

export interface PermitRow {
  statusNo: string;
  api8: string;
  county: string;
  district: string | null;
  leaseName: string | null;
  wellNo: string | null;
  operator: string | null;
  operatorNo: string | null;
  permitDate: string | null;
  issuedDate: string | null;
  acres: number | null;
  survey: string | null;
  abstract: string | null;
  spudDate: string | null;
  expiresDate: string | null;
  cancelledDate: string | null;
  horizontal: boolean;
  appStatus: string | null;
}

export interface WellsDataset {
  key: string;
  version: string;
  builtAt: string;
  counties: CountyScope[];
  sources: SourceSnapshot[];
  wells: WellRow[];
  bores: BoreRow[];
  history: HistoryRow[];
  permits: PermitRow[];
  /** The reconciliation the builder computed (also written to docs/reports). */
  summary: Record<string, unknown>;
}

export interface AbstractRow {
  id: string;
  county: string;
  countyFips: string;
  /** The label exactly as RRC records it ("A-281", "A-?5" for an unnumbered tract); null when RRC has none. */
  abstract: string | null;
  survey: string | null;
  area: number;
  /** GeoJSON MultiPolygon coordinates, NAD83. */
  geom: LonLat[][][];
  /** Source polygons merged into this abstract (a survey split into pieces). */
  pieces: number;
}
export interface AbstractsDataset { key: string; version: string; builtAt: string; counties: CountyScope[]; source: SourceSnapshot; abstracts: AbstractRow[] }

/** [og, district, lease_no, cycle_ym, county, operator_no, field_no, gas_well_no, oil, gas, cond, csgd] */
export type ProductionTuple = [string, string, string, number, string, string, string, string, number, number, number, number];
export interface ProductionDataset { key: string; version: string; builtAt: string; counties: CountyScope[]; source: SourceSnapshot; fromYm: number; toYm: number; rows: ProductionTuple[] }

// ---------------------------------------------------------------------------
// Parse + validate (boot loader). Throws on anything malformed: a bad bundle
// must never half-load.
// ---------------------------------------------------------------------------

const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
const isLonLat = (p: unknown): p is LonLat =>
  Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v)) && Math.abs(p[0] as number) <= 180 && Math.abs(p[1] as number) <= 90;
/** Texas well fids are RRC counters; Louisiana's block starts at 2e9 (domain/sonrisWells). */
const isTxFid = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) < 2_000_000_000;

export function parseWellsDataset(json: Buffer | string): WellsDataset {
  const text = typeof json === "string" ? json : json.toString("utf8");
  const ds = JSON.parse(text) as WellsDataset;
  if (ds.key !== WELLS_DATASET.key) throw new Error(`rrc wells dataset: unexpected key ${String(ds.key)}`);
  if (!Array.isArray(ds.wells) || !ds.wells.length) throw new Error("rrc wells dataset: no wells");
  const counties = new Set(ds.counties.map((c) => c.name));
  const fids = new Set<number>();
  for (const w of ds.wells) {
    if (!isTxFid(w.fid)) throw new Error(`rrc wells dataset: bad fid ${String(w.fid)}`);
    if (fids.has(w.fid)) throw new Error(`rrc wells dataset: duplicate fid ${w.fid}`);
    fids.add(w.fid);
    if (!counties.has(w.county)) throw new Error(`rrc wells dataset: well ${w.fid} outside the dataset's counties (${w.county})`);
    if (!(WELL_STATUSES as readonly string[]).includes(w.status)) throw new Error(`rrc wells dataset: well ${w.fid} has status ${w.status}`);
    if (!isLonLat([w.lon, w.lat])) throw new Error(`rrc wells dataset: well ${w.fid} has no valid location`);
  }
  const bfids = new Set<number>();
  for (const b of ds.bores) {
    if (!isTxFid(b.fid) || bfids.has(b.fid)) throw new Error(`rrc wells dataset: bad/duplicate bore ${String(b.fid)}`);
    bfids.add(b.fid);
    if (!isLonLat(b.bh) || !Array.isArray(b.path) || b.path.length < 2 || !b.path.every(isLonLat)) throw new Error(`rrc wells dataset: bore ${b.fid} has bad geometry`);
    if (!counties.has(b.county)) throw new Error(`rrc wells dataset: bore ${b.fid} outside the dataset's counties`);
  }
  for (const h of ds.history) if (!fids.has(h.fid)) throw new Error(`rrc wells dataset: history for unknown well ${h.fid}`);
  return { ...ds, version: hash(text) };
}

export function parseAbstractsDataset(json: Buffer | string): AbstractsDataset {
  const text = typeof json === "string" ? json : json.toString("utf8");
  const ds = JSON.parse(text) as AbstractsDataset;
  if (ds.key !== ABSTRACTS_DATASET.key) throw new Error(`rrc abstracts dataset: unexpected key ${String(ds.key)}`);
  const counties = new Map(ds.counties.map((c) => [c.name, c.code]));
  const ids = new Set<string>();
  for (const a of ds.abstracts) {
    if (!/^TX-\S+$/.test(a.id) || ids.has(a.id)) throw new Error(`rrc abstracts dataset: bad/duplicate id ${a.id}`);
    ids.add(a.id);
    if (counties.get(a.county) !== a.countyFips) throw new Error(`rrc abstracts dataset: ${a.id} county ${a.county}/${a.countyFips} outside scope`);
    if (!Array.isArray(a.geom) || !a.geom.length || !a.geom.every((poly) => poly.every((ring) => ring.length >= 4 && ring.every(isLonLat)))) {
      throw new Error(`rrc abstracts dataset: ${a.id} has bad geometry`);
    }
  }
  return { ...ds, version: hash(text) };
}

export function parseProductionDataset(json: Buffer | string): ProductionDataset {
  const text = typeof json === "string" ? json : json.toString("utf8");
  const ds = JSON.parse(text) as ProductionDataset;
  if (ds.key !== PRODUCTION_DATASET.key) throw new Error(`rrc production dataset: unexpected key ${String(ds.key)}`);
  const counties = new Set(ds.counties.map((c) => c.name));
  const keys = new Set<string>();
  for (const r of ds.rows) {
    if (r.length !== 12 || (r[0] !== "O" && r[0] !== "G") || !Number.isInteger(r[3]) || r[3] < ds.fromYm || r[3] > ds.toYm || !counties.has(r[4])) {
      throw new Error(`rrc production dataset: bad row ${JSON.stringify(r)}`);
    }
    const k = `${r[0]}|${r[1]}|${r[2]}|${r[7]}|${r[3]}`;
    if (keys.has(k)) throw new Error(`rrc production dataset: duplicate key ${k}`);
    keys.add(k);
  }
  return { ...ds, version: hash(text) };
}
