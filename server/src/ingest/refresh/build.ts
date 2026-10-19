/**
 * The offline RRC refresh builder: streams the raw RRC files (multi-GB,
 * gzipped / zipped — never inflated to disk), runs the pure assembly in
 * assemble.ts and returns the three bundled datasets plus the reconciliation.
 * Driven by scripts/buildRrcRefresh.ts; needs `unzip` on PATH (the county
 * layers and the PDQ dump are zips).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import zlib from "node:zlib";
import { normalizeStatus, rrcIsoDate, shiftYm, uicKind, type DerivedStatus, type PermitFacts, type UicFacts } from "../../domain/wellStatus.js";
import { foldRecord, DBF900_RECORD_SIZE, type WellboreFacts } from "../loaders/wellbore.js";
import { parsePermitApi, parsePermitRoot } from "../loaders/permits.js";
import {
  assembleBores, assembleWell, buildAbstracts, historyOf, leaseKey, lonLat,
  type AbstractBuildStats, type BottomRecord, type EwaRec, type LateralRecord, type LeaseProduction, type SurfaceRecord, type WellContext,
} from "./assemble.js";
import {
  ABSTRACTS_DATASET, PRODUCTION_DATASET, WELLS_DATASET,
  type AbstractsDataset, type CountyScope, type HistoryRow, type PermitRow, type ProductionDataset, type ProductionTuple, type SourceSnapshot, type WellRow, type WellsDataset,
} from "./dataset.js";
import { fitDatumShift, type DatumShift } from "./datum.js";
import { CsvSplitter, ewaRecord, parsePermitDetail, parsePermitRootFacts, parseUicRoot } from "./records.js";
import { readDbf, readShp } from "./shapefile.js";

export interface BuildOptions {
  dataDir: string;
  counties: CountyScope[];
  /** Evaluation date, YYYYMMDD (permit expiry / drilling window). */
  asOf: string;
  files: { ewa: string; permits: string; uic: string; dbf900: string; pdq: string };
  /** Pre-extracted PDQ county-lease TSV (pdqExtract format) — skips streaming the 3.8 GB zip. */
  pdqTsv?: string;
  /** Snapshot dates for files that carry none internally (RRC MFT "Last Modified"), YYYY-MM-DD. */
  asOfDates: { dbf900: string; uic: string };
  /** Production months bundled (newest N). */
  productionMonths?: number;
  /** Permit retention (years), matching the ingest loader's rolling window. */
  permitYears?: number;
  log?: (msg: string) => void;
}

export interface BuildResult {
  wells: WellsDataset;
  abstracts: AbstractsDataset;
  production: ProductionDataset;
  report: RefreshReport;
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function zipMember(zip: string, member: string): Buffer {
  return execFileSync("unzip", ["-p", zip, member], { maxBuffer: 1 << 30 });
}
/** "MM-DD-YYYY" of a zip member's timestamp → YYYY-MM-DD (newest across the members given). */
function zipDate(zip: string, members: readonly string[]): string {
  const out = execFileSync("unzip", ["-l", zip]).toString();
  let best = "";
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*\d+\s+(\d{2})-(\d{2})-(\d{4})\s+\d{2}:\d{2}\s+(\S+)$/);
    if (m && members.includes(m[4])) { const d = `${m[3]}-${m[1]}-${m[2]}`; if (d > best) best = d; }
  }
  if (!best) throw new Error(`no dated members in ${zip}`);
  return best;
}
function lineStream(file: string, encoding: BufferEncoding = "latin1"): readline.Interface {
  const raw = fs.createReadStream(file);
  const input = file.endsWith(".gz") ? raw.pipe(zlib.createGunzip()) : raw;
  input.setEncoding(encoding);
  return readline.createInterface({ input, crlfDelay: Infinity });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildRefresh(o: BuildOptions): Promise<BuildResult> {
  const log = o.log ?? (() => {});
  const codes = new Set(o.counties.map((c) => c.code));
  const countyByCode = new Map(o.counties.map((c) => [c.code, c]));
  const p = (f: string) => `${o.dataDir}/${f}`;

  // 1. County GIS layers: surface (s), bottom hole (b), lateral (l), survey polygons (p).
  log("county layers…");
  const surfaces = new Map<number, SurfaceRecord>();
  const bottoms = new Map<number, BottomRecord>();
  const laterals = new Map<number, LateralRecord>();
  const shiftByCounty = new Map<string, DatumShift>();
  const abstractRows: AbstractsDataset["abstracts"] = [];
  const abstractStats: Record<string, AbstractBuildStats> = {};
  const datumStats: Record<string, unknown> = {};
  let gisDate = "", survDate = "";
  for (const c of o.counties) {
    const z = p(`well${c.code}.zip`);
    gisDate = [gisDate, zipDate(z, [`well${c.code}s.dbf`, `well${c.code}b.dbf`, `well${c.code}l.dbf`])].sort().at(-1)!;
    const s = readDbf(zipMember(z, `well${c.code}s.dbf`));
    const shift = fitDatumShift(s.map((r) => ({ lon27: Number(r.LONG27), lat27: Number(r.LAT27), lon83: Number(r.LONG83), lat83: Number(r.LAT83) }))
      .filter((q) => [q.lon27, q.lat27, q.lon83, q.lat83].every((v) => Number.isFinite(v) && v !== 0)));
    shiftByCounty.set(c.code, shift);
    datumStats[c.name] = { controlPoints: shift.total, inliers: shift.inliers, residualFtP50: +shift.residualFt.p50.toFixed(2), residualFtP90: +shift.residualFt.p90.toFixed(2) };
    for (const r of s) {
      const fid = Number(r.SURFACE_ID);
      const lon = Number(r.LONG83), lat = Number(r.LAT83);
      if (!Number.isInteger(fid) || !Number.isFinite(lon) || !Number.isFinite(lat) || lon === 0) continue;
      surfaces.set(fid, { rec: r, county: c, lonLat83: lonLat(lon, lat) });
    }
    for (const r of readDbf(zipMember(z, `well${c.code}b.dbf`))) {
      const bid = Number(r.BOTTOM_ID);
      if (Number.isInteger(bid) && !bottoms.has(bid) && Number.isFinite(Number(r.LONG83)) && Number(r.LONG83) !== 0) bottoms.set(bid, { rec: r, county: c });
    }
    const lrecs = readDbf(zipMember(z, `well${c.code}l.dbf`));
    const lshp = readShp(zipMember(z, `well${c.code}l.shp`));
    lrecs.forEach((r, i) => {
      const sh = lshp[i];
      const bid = Number(r.BOTTOM_ID);
      if (!sh || sh.kind !== "polyline" || !Number.isInteger(bid) || laterals.has(bid)) return;
      const line27 = sh.parts.flat();
      if (line27.length >= 2) laterals.set(bid, { rec: r, county: c, line27, shift });
    });
    const sz = p(`surv${c.code}.zip`);
    survDate = [survDate, zipDate(sz, [`surv${c.code}p.dbf`, `surv${c.code}p.shp`])].sort().at(-1)!;
    const built = buildAbstracts(readDbf(zipMember(sz, `surv${c.code}p.dbf`)), readShp(zipMember(sz, `surv${c.code}p.shp`)), c, shift);
    abstractRows.push(...built.rows);
    abstractStats[c.name] = built.stats;
  }

  // Every API the refresh needs records for: the counties' own wells plus
  // wellbores whose surface sits outside them (bottom holes inside).
  const apis = new Set<string>();
  for (const s of surfaces.values()) if (/^\d{8}$/.test(s.rec.API)) apis.add(s.rec.API);
  for (const b of bottoms.values()) if (/^\d{8}$/.test(b.rec.API)) apis.add(b.rec.API);
  for (const l of laterals.values()) if (/^\d{8}$/.test(l.rec.API)) apis.add(l.rec.API);

  // 2. Wellbore Query (CSV, no header).
  log("wellbore query…");
  const ewa = new Map<string, EwaRec[]>();
  const ewaStats = { records: 0, malformed: 0, kept: 0 };
  {
    const splitter = new CsvSplitter();
    const onRec = (f: string[]) => {
      ewaStats.records++;
      const r = ewaRecord(f);
      if (!r) { ewaStats.malformed++; return; }
      if (!codes.has(r.COUNTY_CODE) && !apis.has(r.API_NO)) return;
      ewaStats.kept++;
      ewa.set(r.API_NO, [...(ewa.get(r.API_NO) ?? []), r]);
    };
    const stream = fs.createReadStream(p(o.files.ewa), { encoding: "latin1", highWaterMark: 1 << 20 });
    for await (const chunk of stream) splitter.push(chunk as string, onRec);
    splitter.end(onRec);
  }
  for (const a of ewa.keys()) if (codes.has(a.slice(0, 3))) apis.add(a);

  // 3. Drilling permits (daf802): status facts for every API, permit rows for the counties.
  log("drilling permits…");
  const permits = new Map<string, PermitFacts[]>();
  const permitRows = new Map<string, PermitRow>();
  const permitCutoff = `${Number(o.asOf.slice(0, 4)) - (o.permitYears ?? 6)}-${o.asOf.slice(4, 6)}-${o.asOf.slice(6, 8)}`;
  let permitsAsOf = "";
  {
    let root: ReturnType<typeof parsePermitRootFacts> = null;
    let legacyRoot: ReturnType<typeof parsePermitRoot> = null;
    for await (const line of lineStream(p(o.files.permits))) {
      if (line.startsWith("01")) { root = parsePermitRootFacts(line); legacyRoot = parsePermitRoot(line); continue; }
      if (!line.startsWith("02") || !root) continue;
      const d = parsePermitDetail(line);
      if (!d || d.key !== root.key) continue;
      if (d.issued && d.issued > permitsAsOf) permitsAsOf = d.issued;
      if (!apis.has(d.api8) && !codes.has(root.countyCode)) continue;
      if (root.appFlag && root.appFlag !== "A") continue; // only issued permits have status meaning
      const list = permits.get(d.api8) ?? [];
      if (!list.some((x) => x.permitNo === d.permitNo)) list.push(d);
      permits.set(d.api8, list);
      const c = countyByCode.get(root.countyCode);
      if (c && legacyRoot && legacyRoot.permitDate && legacyRoot.permitDate >= permitCutoff) {
        const loc = parsePermitApi(line);
        permitRows.set(`${root.key}|${d.api8}`, {
          statusNo: root.key, api8: d.api8, county: c.name, district: root.district || null,
          leaseName: root.leaseName || null, wellNo: d.wellNo || null,
          operator: root.operatorName || null, operatorNo: root.operatorNo || null,
          permitDate: legacyRoot.permitDate, issuedDate: rrcIsoDate(d.issued),
          acres: loc?.acres ?? null, survey: loc?.survey ?? null, abstract: loc?.abstract ?? null,
          spudDate: rrcIsoDate(d.spud), expiresDate: rrcIsoDate(d.expires),
          cancelledDate: rrcIsoDate(d.cancelled), horizontal: d.horizontal, appStatus: root.appFlag || null,
        });
      }
    }
  }

  // 4. UIC permits: disposal vs injection per API (active permit preferred, newest control number).
  log("UIC permits…");
  const uic = new Map<string, UicFacts>();
  {
    const best = new Map<string, { active: boolean; ctl: string; code: string }>();
    for await (const line of lineStream(p(o.files.uic))) {
      const r = parseUicRoot(line);
      if (!r || !apis.has(r.api8)) continue;
      const active = !r.cancelled;
      const cur = best.get(r.api8);
      if (!cur || (active && !cur.active) || (active === cur.active && r.controlNo > cur.ctl)) best.set(r.api8, { active, ctl: r.controlNo, code: r.injectionType });
    }
    for (const [api, b] of best) { const k = uicKind(b.code); if (k) uic.set(api, k); }
  }

  // 5. Wellbore master (dbf900, EBCDIC): formations, and a plug date where the Wellbore Query has none.
  log("wellbore master…");
  const formations = new Map<string, string[]>();
  const dbfPlug = new Map<string, string>();
  {
    const keep = (f: WellboreFacts | null) => {
      if (!f || !apis.has(f.api8)) return;
      if (f.formations.length) formations.set(f.api8, f.formations);
      if (f.plugDate) dbfPlug.set(f.api8, f.plugDate.replace(/-/g, ""));
    };
    let current: WellboreFacts | null = null;
    let carry: Buffer | null = null;
    const input = fs.createReadStream(p(o.files.dbf900), { highWaterMark: DBF900_RECORD_SIZE * 4096 }).pipe(zlib.createGunzip());
    for await (const chunk of input) {
      const buf: Buffer = carry ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
      let off = 0;
      for (; off + DBF900_RECORD_SIZE <= buf.length; off += DBF900_RECORD_SIZE) {
        const rec = buf.subarray(off, off + DBF900_RECORD_SIZE);
        // Skip whole out-of-scope wells cheaply: only roots and in-scope records fold.
        const { facts, isRoot } = foldRecord(rec, current);
        if (isRoot) { keep(current); current = facts && apis.has(facts.api8) ? facts : null; }
        else if (facts) current = facts;
      }
      carry = off < buf.length ? Buffer.from(buf.subarray(off)) : null;
    }
    keep(current);
  }

  // 6. Production (PDQ): per-lease last month + cumulative; newest N months bundled.
  log("production…");
  const leaseProd = new Map<string, LeaseProduction>();
  const prodRows = new Map<string, ProductionTuple>();
  let newestYm = 0;
  const allLines: { og: string; d: string; l: string; ym: number; cty: string; op: string; fld: string; gw: string; oil: number; gas: number; cond: number; csgd: number }[] = [];
  {
    const int = (s: string) => { const n = Number(s); return Number.isFinite(n) ? Math.trunc(n) : 0; };
    // Rows older than two calendar years can't fall in the bundled window; only their lease totals are needed.
    const keepFromYm = (Number(o.asOf.slice(0, 4)) - 2) * 100;
    const onLine = (og: string, d: string, l: string, ymS: string, cc: string, op: string, fld: string, gw: string, oilS: string, gasS: string, condS: string, csgdS: string) => {
      const c = countyByCode.get(cc);
      if (!c || (og !== "O" && og !== "G")) return;
      const ym = int(ymS);
      const [oil, gas, cond, csgd] = [int(oilS), int(gasS), int(condS), int(csgdS)];
      if (!ym || (oil === 0 && gas === 0 && cond === 0 && csgd === 0)) return;
      if (ym > newestYm) newestYm = ym;
      const k = leaseKey(og, d, l);
      const lp = leaseProd.get(k) ?? { lastYm: "", cumOil: 0, cumGas: 0 };
      if (String(ym) > lp.lastYm) lp.lastYm = String(ym);
      lp.cumOil += oil + cond; lp.cumGas += gas + csgd;
      leaseProd.set(k, lp);
      if (ym >= keepFromYm) allLines.push({ og, d: d.trim(), l: l.trim(), ym, cty: c.name, op: op.trim(), fld: fld.trim(), gw: gw.trim(), oil, gas, cond, csgd });
    };
    if (o.pdqTsv) {
      for await (const line of lineStream(o.pdqTsv)) {
        const f = line.split("\t");
        if (f.length >= 12) onLine(f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8], f[9], f[10], f[11]);
      }
    } else {
      const child = spawn("unzip", ["-p", p(o.files.pdq), "OG_COUNTY_LEASE_CYCLE_DATA_TABLE.dsv"], { stdio: ["ignore", "pipe", "inherit"] });
      child.stdout.setEncoding("latin1");
      for await (const line of readline.createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        const c = line.split("}");
        if (c.length >= 22) onLine(c[0], c[1], c[2], c[8], c[5], c[6], c[7], c[10], c[12], c[15], c[18], c[21]);
      }
    }
    const fromYm = Number(shiftYm(String(newestYm), -((o.productionMonths ?? 12) - 1)));
    for (const r of allLines) {
      if (r.ym < fromYm) continue;
      const k = `${r.og}|${r.d}|${r.l}|${r.gw}|${r.ym}`;
      const cur = prodRows.get(k);
      if (cur) { cur[8] += r.oil; cur[9] += r.gas; cur[10] += r.cond; cur[11] += r.csgd; }
      else prodRows.set(k, [r.og, r.d, r.l, r.ym, r.cty, r.op, r.fld, r.gw, r.oil, r.gas, r.cond, r.csgd]);
    }
  }
  const pdqDates = (() => {
    try {
      const t = zipMember(p(o.files.pdq), "GP_DATE_RANGE_CYCLE_DATA_TABLE.dsv").toString("latin1").trim().split(/\r?\n/)[1].split("}");
      const m = t[3].match(/^(\d{2})-([A-Z]{3})-(\d{2})$/);
      const mon = "JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC".indexOf(m?.[2] ?? "") / 3 + 1;
      return { extract: m ? `20${m[3]}-${String(mon).padStart(2, "0")}-${m[1]}` : null, newest: t[1] };
    } catch { return { extract: null, newest: String(newestYm) }; }
  })();

  // 7. Assemble wells, bores, history.
  log("assembling…");
  const ctx: WellContext = { ewa, permits, uic, formations, dbfPlug, production: leaseProd, prodNewestYm: String(newestYm), asOf: o.asOf };
  const bottomsBySurface = new Map<number, BottomRecord[]>();
  for (const b of bottoms.values()) {
    const sid = Number(b.rec.SURFACE_ID);
    bottomsBySurface.set(sid, [...(bottomsBySurface.get(sid) ?? []), b]);
  }
  const lateralsBySurface = new Map<number, LateralRecord[]>();
  for (const l of laterals.values()) {
    const sid = Number(l.rec.SURFACE_ID);
    lateralsBySurface.set(sid, [...(lateralsBySurface.get(sid) ?? []), l]);
  }
  const wellsByFid = new Map<number, { row: WellRow; derived: DerivedStatus }>();
  for (const [fid, s] of [...surfaces.entries()].sort((a, b) => a[0] - b[0])) {
    wellsByFid.set(fid, assembleWell(s, bottomsBySurface.get(fid) ?? [], lateralsBySurface.get(fid) ?? [], ctx, shiftByCounty.get(s.county.code)!));
  }
  const { bores, skippedNoSurface, verticalBottoms } = assembleBores(bottoms, laterals, surfaces, wellsByFid, ctx);
  const boreSurfaces = new Set(bores.map((b) => b.surfaceFid));
  for (const { row } of wellsByFid.values()) {
    if (row.profile !== "Vertical" && !boreSurfaces.has(row.fid)) row.geomFlag = "missing-bottom-hole";
  }
  const refreshDate = `${o.asOf.slice(0, 4)}-${o.asOf.slice(4, 6)}-${o.asOf.slice(6, 8)}`;
  const history: HistoryRow[] = [];
  for (const { row } of wellsByFid.values()) {
    history.push(...historyOf(row, row.api8 ? permits.get(row.api8) ?? [] : [], row.api8 ? ewa.get(row.api8) ?? [] : [], refreshDate, "rrc-refresh"));
  }

  const ewaDate = o.files.ewa.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  if (!ewaDate) throw new Error(`can't read the Wellbore Query snapshot date from ${o.files.ewa}`);
  const sources: SourceSnapshot[] = [
    { id: "gis-wells", name: "RRC Well Layers by County (surface, bottom-hole, lateral)", file: o.counties.map((c) => `well${c.code}.zip`).join(", "), asOf: gisDate },
    { id: "wellbore-query", name: "RRC Wellbore Query Data (EWA)", file: o.files.ewa, asOf: ewaDate },
    { id: "permits", name: "RRC Drilling Permit Master and Trailer (daf802)", file: o.files.permits, asOf: rrcIsoDate(permitsAsOf)! },
    { id: "uic", name: "RRC Underground Injection Control database (uif700)", file: o.files.uic, asOf: o.asOfDates.uic },
    { id: "wellbore-master", name: "RRC Full Wellbore (dbf900)", file: o.files.dbf900, asOf: o.asOfDates.dbf900 },
    { id: "production", name: `RRC Production Data Query dump (newest month ${pdqDates.newest})`, file: o.files.pdq, asOf: pdqDates.extract ?? refreshDate },
    { id: "gis-surveys", name: "RRC Survey Layers by County (abstract polygons)", file: o.counties.map((c) => `surv${c.code}.zip`).join(", "), asOf: survDate },
  ];

  const wells = [...wellsByFid.values()].map((w) => w.row);
  const report = reconcile({
    wells, derived: [...wellsByFid.values()].map((w) => w.derived), surfaces, bores, skippedNoSurface, verticalBottoms, ewa, permits, codes,
    abstractStats, datumStats, ewaStats, sources, counties: o.counties,
    permitRows: permitRows.size, productionRows: prodRows.size, uic: uic.size, asOf: o.asOf,
  });
  const builtAt = new Date().toISOString();
  const prodList = [...prodRows.values()].sort((a, b) => a[3] - b[3] || a.slice(0, 3).join().localeCompare(b.slice(0, 3).join()) || a[7].localeCompare(b[7]));
  return {
    wells: {
      key: WELLS_DATASET.key, version: "", builtAt, counties: o.counties, sources,
      wells, bores, history, permits: [...permitRows.values()].sort((a, b) => a.statusNo.localeCompare(b.statusNo) || a.api8.localeCompare(b.api8)),
      summary: report.summary,
    },
    abstracts: { key: ABSTRACTS_DATASET.key, version: "", builtAt, counties: o.counties, source: sources.find((s) => s.id === "gis-surveys")!, abstracts: abstractRows },
    production: {
      key: PRODUCTION_DATASET.key, version: "", builtAt, counties: o.counties, source: sources.find((s) => s.id === "production")!,
      fromYm: prodList.length ? prodList[0][3] : newestYm, toYm: newestYm, rows: prodList,
    },
    report,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** How the July 2026 import (tools/rrc/build_wells.py SYM table) labelled each RRC symbol. */
const PRE_REFRESH_STATUS: Record<number, string> = {
  2: "Permitted", 3: "Dry Hole", 4: "Producing", 5: "Producing", 6: "Producing", 7: "Plugged", 8: "Plugged", 9: "Canceled/Abandoned",
  10: "Plugged", 11: "Active", 19: "Shut-In", 20: "Shut-In", 21: "Active", 22: "Surface location", 23: "Active",
  74: "Active", 75: "Active", 76: "Active", 86: "Surface location", 87: "Surface location",
};

export interface RefreshReport {
  summary: Record<string, unknown>;
  /** Wells needing a human look (flag needs-investigation / no-recent-production / coordinate mismatch / missing bottom hole). */
  investigate: { fid: number; api8: string | null; county: string; status: string; flag: string; note: string }[];
  /** Wellbores RRC lists that have no map location (never fabricated). */
  missingLocation: { api8: string; county: string; status: string; detail: string | null; operator: string | null; lease: string | null }[];
  corrections: { fid: number; api8: string | null; county: string; before: string; after: string; detail: string | null; source: string }[];
}

function reconcile(i: {
  wells: WellRow[]; derived: DerivedStatus[]; surfaces: Map<number, SurfaceRecord>; bores: { fid: number; surfaceFid: number; bhSource: string; lineSource: string; geomFlag: string | null }[];
  skippedNoSurface: number; verticalBottoms: number; ewa: Map<string, EwaRec[]>; permits: Map<string, PermitFacts[]>; codes: Set<string>;
  abstractStats: Record<string, AbstractBuildStats>; datumStats: Record<string, unknown>; ewaStats: Record<string, number>; sources: SourceSnapshot[];
  counties: CountyScope[]; permitRows: number; productionRows: number; uic: number; asOf: string;
}): RefreshReport {
  const tally = (xs: readonly string[]) => Object.fromEntries([...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]));
  let matched = 0, corrected = 0, statusAdded = 0;
  const transitions: string[] = [];
  const corrections: RefreshReport["corrections"] = [];
  for (const w of i.wells) {
    const sym = Number(i.surfaces.get(w.fid)?.rec.SYMNUM);
    const before = PRE_REFRESH_STATUS[sym] ?? "Unknown";
    const beforeNorm = before === "Surface location" ? null : normalizeStatus(before);
    if (beforeNorm === null) { statusAdded++; transitions.push(`(no status: horizontal/directional surface spot) → ${w.status}`); }
    else if (beforeNorm === w.status) matched++;
    else {
      corrected++;
      transitions.push(`${before} → ${w.status}`);
      corrections.push({ fid: w.fid, api8: w.api8, county: w.county, before, after: w.status, detail: w.statusDetail, source: w.statusSource });
    }
  }
  const apisMapped = new Set(i.wells.map((w) => w.api8).filter(Boolean) as string[]);
  for (const b of i.bores as { api8?: string | null }[]) if (b.api8) apisMapped.add(b.api8);
  const missingLocation: RefreshReport["missingLocation"] = [];
  for (const [api, rows] of i.ewa) {
    if (!i.codes.has(api.slice(0, 3)) || apisMapped.has(api)) continue;
    const ctx = { onSchedule: rows.some((r) => r.ON_SCHEDULE === "Y") };
    const primary = rows.find((r) => r.ON_SCHEDULE === "Y") ?? rows[0];
    const plugged = rows.some((r) => /^\d{8}$/.test(r.PLUG_DATE) && !/^0+$/.test(r.PLUG_DATE));
    missingLocation.push({
      api8: api, county: i.counties.find((c) => c.code === api.slice(0, 3))!.name,
      status: ctx.onSchedule ? (primary.WELL_TYPE_NAME || "On schedule") : plugged ? "Plugged" : "Off schedule",
      detail: null, operator: primary.OPERATOR_NAME || null, lease: primary.LEASE_NAME || null,
    });
  }
  const permitNoMap = [...i.permits.entries()].filter(([api, ps]) => i.codes.has(api.slice(0, 3)) && !apisMapped.has(api) && !i.ewa.has(api) && ps.some((x) => (x.expires ?? "") >= i.asOf)).length;
  const investigate: RefreshReport["investigate"] = [];
  for (const w of i.wells) {
    for (const [flag, note] of [[w.statusFlag, w.statusNote], [w.locationFlag, w.locationNote], [w.geomFlag, w.geomFlag ? "Horizontal/directional well with no bottom-hole location in RRC's layers." : null]] as const) {
      if (flag && flag !== "map-only" && flag !== "unverified") investigate.push({ fid: w.fid, api8: w.api8, county: w.county, status: w.status, flag, note: note ?? "" });
    }
  }
  const flags = tally(i.wells.map((w) => w.statusFlag ?? "none"));
  const summary = {
    scope: i.counties.map((c) => `${c.name} (${c.code})`).join(", "),
    sources: i.sources,
    reviewed: { surfaceWells: i.wells.length, deviatedWellbores: i.bores.length, wellboreQueryRows: i.ewaStats.kept, permitsBundled: i.permitRows, uicPermitsMatched: i.uic, productionRowsBundled: i.productionRows },
    byCounty: Object.fromEntries(i.counties.map((c) => [c.name, tally(i.wells.filter((w) => w.county === c.name).map((w) => w.status))])),
    statuses: tally(i.wells.map((w) => w.status)),
    statusSources: tally(i.wells.map((w) => w.statusSource)),
    profiles: tally(i.wells.map((w) => w.profile)),
    matched, corrected, statusAddedForHorizontalSurfaceSpots: statusAdded,
    transitions: tally(transitions),
    flags,
    needsInvestigation: investigate.length,
    locationMismatches: i.wells.filter((w) => w.locationFlag).length,
    wellsWithoutApi: i.wells.filter((w) => !w.api8).length,
    geometry: {
      bores: i.bores.length,
      boresFromRrcLateralLine: i.bores.filter((b) => b.lineSource === "rrc-lateral").length,
      boresJoinedFromEndpoints: i.bores.filter((b) => b.lineSource === "endpoints").length,
      bottomHolesFromLateralEnd: i.bores.filter((b) => b.bhSource === "rrc-lateral-end").length,
      surfaceOutsideScope: i.bores.filter((b) => b.geomFlag === "surface-outside-scope").length,
      bottomHolesWithoutAnySurface: i.skippedNoSurface,
      verticalBottomHolesSkipped: i.verticalBottoms,
      horizontalWellsMissingBottomHole: i.wells.filter((w) => w.geomFlag === "missing-bottom-hole").length,
      allPathsApproximate: true,
    },
    missing: { wellboresWithoutMapLocation: missingLocation.length, activePermitsWithoutMapLocation: permitNoMap },
    duplicatesResolved: {
      wellboreQueryRowsCollapsedToWellbores: i.ewaStats.kept - i.ewa.size,
      malformedWellboreQueryRows: i.ewaStats.malformed,
    },
    abstracts: i.abstractStats,
    datumFit: i.datumStats,
  };
  return { summary, investigate, missingLocation, corrections };
}
