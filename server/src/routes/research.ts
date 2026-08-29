import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { Prisma, ResearchDocClass, ResearchDocType, ResearchPermitStatus, WellTrajectory } from "@prisma/client";
import { prisma, withDbRetry } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import {
  autoGranularity, bucketKey, bucketRange, detectHotspot, historyWindows,
  normalizeEntity, rollingAverage, surgeSeverity, trend, type Trend,
} from "../domain/research.js";
import { MAX_CSV_CHARS } from "../config.js";
import { fieldsFor, guessMapping, sourceFor } from "../domain/researchSources.js";
// Recorded-document / permit ingest core — shared verbatim with the headless
// CLI importer (scripts/importRecords.ts) so both paths dedup and normalize
// identically. See domain/researchIngest.ts.
import { ingestResearchCsv, parseCsv, resolveCategory } from "../domain/researchIngest.js";
import {
  buildResearchBuyer, classifyMatch, mergePlan, summaryFor,
  type ExistingBuyerLite, type ResearchDocLite,
} from "../domain/researchBuyers.js";
import {
  aggregateRelationships, aggregateGroupRelationships, coBuyerPartnerships, classifyEntities,
  buildChains, chainTableRows, expandDocToEdges, ENTITY_CLASS_LABEL, type TxEdge,
} from "../domain/researchGraph.js";
import { normalizeCompany } from "../serializers.js";

/**
 * Research & Market Intelligence API.
 *
 * Analytics endpoints load lightweight rows (dates + grouping keys only) and
 * aggregate in process via the pure helpers in domain/research.ts. At CSV-
 * import scale (county-level datasets) this is fast and keeps every formula
 * unit-testable; when automated statewide feeds land, the same endpoints can
 * switch to SQL rollups without changing their contracts.
 */
export const researchRouter = Router();
researchRouter.use(requireAuth, requireOrg);

/**
 * This was the last router with no replay ceiling — import, contacts' import
 * paths, wells, gis, ai, integrations' POSTs and the whole portal all carry one.
 *
 * Two exposures here. The analytics endpoints load the org's ENTIRE
 * `TRANSACTION` corpus per request and expand it to a per-party-pair edge list
 * in process (see loadTxEdges → expandDocToEdges, and the chain/co-buyer
 * aggregations built on top of it) — all behind `viewResearch`, a READ
 * permission, so a read-only member could loop any of them and saturate the
 * pool. And `/ingest/analyze` is a full CSV parse that writes nothing, which
 * makes it free for the caller to repeat; its 50,000-row cap bounds one call,
 * not the rate of calls.
 *
 * Keyed on the authenticated user, not req.ip: requireAuth + requireOrg run
 * above so the caller is always known, and an IP bucket would let one account
 * rotate egress addresses to keep going. Mirrors aiRouter and twoFactorLimiter.
 *
 * Sized like the wells and gis routers, whose read endpoints have the same
 * shape: the Research workspace fires several requests per page load and its
 * filters re-query on change, so the ceiling has to clear real interactive use
 * while still bounding a script to roughly one heavy query a second.
 */
researchRouter.use(rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user?.id ?? req.ip ?? "unknown",
  message: { error: "Too many research requests. Wait a moment and try again." },
}));

const DAY = 86400000;

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/**
 * Ceiling on the number of values accepted for ONE filter. Every list parsed
 * here becomes a Prisma `IN (…)` (or, for the RRC path, an `ANY($n::text[])`),
 * so an uncapped list is an uncapped query: repeated params (`?survey=a&survey=b…`)
 * let one request build a predicate with tens of thousands of bound values, which
 * costs planning time on every table it touches and eventually trips Postgres's
 * 65,535-parameter limit — a 500 out of a read endpoint. gis.ts already slices
 * its equivalent filter lists at the same bound (see /options and planExtentQuery);
 * this brings the research filters in line. 500 is far above any real selection —
 * Texas has 254 counties.
 */
export const MAX_FILTER_VALUES = 500;

const arr = (v: unknown): string[] =>
  (v == null ? [] : Array.isArray(v) ? v.map(String).filter(Boolean) : [String(v)].filter(Boolean))
    .slice(0, MAX_FILTER_VALUES);

/** Parse YYYY-MM-DD (or ISO) as UTC midnight. */
export function parseDay(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (isNaN(d.getTime())) return null;
  // Reject implausible years. A typo like "0202-07-09" parses to a valid Date,
  // but once a comparison/history window is extrapolated backwards it yields a
  // negative (BCE) year that Prisma can't serialize (PrismaClientUnknownRequest-
  // Error on findMany). All research data is 20th/21st century, so anything
  // outside [1900, 2100] is malformed — fall back to the caller's default window.
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2100) return null;
  return d;
}

export interface ResearchFilters {
  states: string[];
  counties: string[];
  docClass?: ResearchDocClass;
  docTypes: string[];
  buyers: string[];   // granteeNorm keys
  sellers: string[];  // grantorNorm keys
  operators: string[]; // operatorNorm keys
  surveys: string[];
  abstractIds: string[];
  statuses: string[];
  trajectories: string[];
}

interface Window { from: Date; to: Date } // [from, to] inclusive days

export function parseFilters(q: Record<string, unknown>): ResearchFilters {
  return {
    states: arr(q.state),
    counties: arr(q.county),
    docClass: q.docClass === "TRANSACTION" || q.docClass === "LEASE" ? (q.docClass as ResearchDocClass) : undefined,
    docTypes: arr(q.docType),
    buyers: arr(q.buyer),
    sellers: arr(q.seller),
    operators: arr(q.operator),
    surveys: arr(q.survey),
    // Both spellings are accepted (?abstractId=…&abstractId=… and ?abstract=…)
    // — different callers grew up on different sides of a merge. Re-sliced after
    // the merge so the two spellings together can't double the cap.
    abstractIds: [...arr(q.abstractId), ...arr(q.abstract)].slice(0, MAX_FILTER_VALUES),
    statuses: arr(q.permitStatus),
    trajectories: arr(q.trajectory),
  };
}

/** Current window from ?from/&to (defaults to the last 90 days). */
export function parseWindow(q: Record<string, unknown>): Window {
  const to = parseDay(q.to as string | undefined) ?? new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const from = parseDay(q.from as string | undefined) ?? new Date(to.getTime() - 89 * DAY);
  return { from, to };
}

/** Optional compare window; defaults to the same-length period immediately before. */
export function parseCompare(q: Record<string, unknown>, win: Window): Window {
  const from = parseDay(q.compareFrom as string | undefined);
  const to = parseDay(q.compareTo as string | undefined);
  if (from && to) return { from, to };
  const len = win.to.getTime() - win.from.getTime() + DAY;
  return { from: new Date(win.from.getTime() - len), to: new Date(win.from.getTime() - DAY) };
}

// ---------------------------------------------------------------------------
// Row loading (lightweight projections)
// ---------------------------------------------------------------------------

interface DocRow {
  recordingDate: Date; docClass: ResearchDocClass; docType: ResearchDocType;
  state: string; county: string; abstractId: string | null; survey: string | null;
  grantee: string | null; granteeNorm: string | null; grantor: string | null; grantorNorm: string | null;
  acreage: number | null;
}
interface PermitRow {
  activityDate: Date; state: string; county: string;
  operator: string; operatorNorm: string; status: ResearchPermitStatus; trajectory: WellTrajectory;
  abstractId: string | null; survey: string | null;
}

function docWhere(org: string, f: ResearchFilters, win?: Window): Prisma.ResearchDocumentWhereInput {
  const w: Prisma.ResearchDocumentWhereInput = { organizationId: org };
  if (win) w.recordingDate = { gte: win.from, lt: new Date(win.to.getTime() + DAY) };
  if (f.states.length) w.state = { in: f.states };
  if (f.counties.length) w.county = { in: f.counties };
  if (f.docClass) w.docClass = f.docClass;
  if (f.docTypes.length) w.docType = { in: f.docTypes as ResearchDocType[] };
  if (f.buyers.length) w.granteeNorm = { in: f.buyers };
  if (f.sellers.length) w.grantorNorm = { in: f.sellers };
  if (f.surveys.length) w.survey = { in: f.surveys };
  if (f.abstractIds.length) w.abstractId = { in: f.abstractIds };
  return w;
}

function permitWhere(org: string, f: ResearchFilters, win?: Window): Prisma.ResearchPermitWhereInput {
  const w: Prisma.ResearchPermitWhereInput = { organizationId: org };
  if (win) w.activityDate = { gte: win.from, lt: new Date(win.to.getTime() + DAY) };
  if (f.states.length) w.state = { in: f.states };
  if (f.counties.length) w.county = { in: f.counties };
  if (f.operators.length) w.operatorNorm = { in: f.operators };
  if (f.surveys.length) w.survey = { in: f.surveys };
  if (f.abstractIds.length) w.abstractId = { in: f.abstractIds };
  if (f.statuses.length) w.status = { in: f.statuses as ResearchPermitStatus[] };
  if (f.trajectories.length) w.trajectory = { in: f.trajectories as WellTrajectory[] };
  return w;
}

async function loadDocs(org: string, f: ResearchFilters, win: Window): Promise<DocRow[]> {
  return withDbRetry(() =>
    prisma.researchDocument.findMany({
      where: docWhere(org, f, win),
      select: {
        recordingDate: true, docClass: true, docType: true, state: true, county: true,
        abstractId: true, survey: true, grantee: true, granteeNorm: true, grantor: true,
        grantorNorm: true, acreage: true,
      },
    }),
  );
}

async function loadPermits(org: string, f: ResearchFilters, win: Window): Promise<PermitRow[]> {
  const [orgRows, rrcRows] = await withDbRetry(() => Promise.all([
    prisma.researchPermit.findMany({
      where: permitWhere(org, f, win),
      select: {
        activityDate: true, state: true, county: true, operator: true, operatorNorm: true,
        status: true, trajectory: true, abstractId: true, survey: true, apiNumber: true,
      },
    }),
    loadRrcPermits(f, win),
  ]));
  // The platform's imported RRC drilling permits (B3, rrc.permits) participate
  // in every research analytic automatically — no manual Research-page import.
  // Dedupe by 8-digit API so a CSV-imported permit isn't double counted.
  const seen = new Set(orgRows.map((r) => (r.apiNumber ?? "").replace(/\D/g, "").replace(/^42/, "").slice(0, 8)).filter((s) => s.length === 8));
  return [
    ...orgRows.map(({ apiNumber: _a, ...r }) => r),
    ...rrcRows.filter((r) => !r.api8 || !seen.has(r.api8)).map(({ api8: _b, ...r }) => r),
  ];
}

interface RrcPermitRow extends PermitRow { api8: string | null }

/**
 * RRC drilling permits already in the database (B3 import) surfaced as research
 * rows. Live query — a fresh permit import shows up in Research immediately.
 * Trajectory is inferred from the well number ("...H" = horizontal), covering
 * the horizontal-permit analytics without a separate dataset.
 */
async function loadRrcPermits(f: ResearchFilters, win: Window): Promise<RrcPermitRow[]> {
  // RRC permits are Texas-only; skip when a state filter is set that excludes TX.
  if (f.states.length && !f.states.includes("TX")) return [];
  // Permit-status filter maps only to APPROVED for issued RRC permits.
  if (f.statuses.length && !f.statuses.includes("APPROVED")) return [];
  const conds: string[] = [`p.permit_date >= $1`, `p.permit_date <= $2`];
  const params: unknown[] = [win.from, win.to];
  if (f.counties.length) { params.push(f.counties); conds.push(`p.county = ANY($${params.length}::text[])`); }
  try {
    const rows = await prisma.$queryRawUnsafe<{ permitDate: Date; county: string; operator: string | null; api8: string | null; wellNo: string | null; abstract: string | null; survey: string | null }[]>(
      `SELECT p.permit_date AS "permitDate", p.county, p.operator, p.api8, p.well_no AS "wellNo",
              w.abstract, w.survey
         FROM rrc.permits p
         LEFT JOIN rrc.wells w ON w.api8 = p.api8
        WHERE ${conds.join(" AND ")}`,
      ...params,
    );
    const out: RrcPermitRow[] = [];
    for (const r of rows) {
      const operatorNorm = normalizeEntity(r.operator) ?? "";
      if (f.operators.length && !f.operators.includes(operatorNorm)) continue;
      const trajectory: WellTrajectory = /H[A-Z]?$/.test((r.wellNo ?? "").trim().toUpperCase()) ? "HORIZONTAL" : "UNKNOWN";
      if (f.trajectories.length && !f.trajectories.includes(trajectory)) continue;
      if (f.abstractIds.length && !(r.abstract && f.abstractIds.includes(r.abstract))) continue;
      if (f.surveys.length && !(r.survey && f.surveys.includes(r.survey))) continue;
      out.push({
        activityDate: r.permitDate, state: "TX", county: r.county,
        operator: r.operator ?? "Unknown", operatorNorm,
        status: "APPROVED" as ResearchPermitStatus, trajectory,
        abstractId: r.abstract, survey: r.survey, api8: r.api8,
      });
    }
    return out;
  } catch { return []; } // rrc schema absent (fresh install) → org data only
}

const within = (d: Date, w: Window) => d.getTime() >= w.from.getTime() && d.getTime() < w.to.getTime() + DAY;

// ---------------------------------------------------------------------------
// Filters (distinct values present in the org's research data)
// ---------------------------------------------------------------------------

researchRouter.get(
  "/filters",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    // Filter options are scoped to the active dataset (Transactions/Deeds vs
    // Leases) so the Buyers/Sellers/Doc-type dropdowns never offer parties or
    // instrument types from the other class.
    const { docClass } = parseFilters(req.query as Record<string, unknown>);
    const cls = docClass ? { docClass } : {};
    const [states, counties, docTypes, buyers, sellers, operators, permitGeo, docAbstracts, permitAbstracts, docSurveys, permitSurveys] = await withDbRetry(() => Promise.all([
      prisma.researchDocument.groupBy({ by: ["state"], where: { organizationId: org, ...cls } }),
      prisma.researchDocument.groupBy({ by: ["state", "county"], where: { organizationId: org, ...cls } }),
      prisma.researchDocument.groupBy({ by: ["docType"], where: { organizationId: org, ...cls } }),
      prisma.researchDocument.groupBy({
        by: ["granteeNorm", "grantee"], where: { organizationId: org, granteeNorm: { not: null }, ...cls },
        _count: true, orderBy: { _count: { granteeNorm: "desc" } }, take: 500,
      }),
      prisma.researchDocument.groupBy({
        by: ["grantorNorm", "grantor"], where: { organizationId: org, grantorNorm: { not: null }, ...cls },
        _count: true, orderBy: { _count: { grantorNorm: "desc" } }, take: 500,
      }),
      prisma.researchPermit.groupBy({
        by: ["operatorNorm", "operator"], where: { organizationId: org },
        _count: true, orderBy: { _count: { operatorNorm: "desc" } }, take: 500,
      }),
      prisma.researchPermit.groupBy({ by: ["state", "county"], where: { organizationId: org } }),
      prisma.researchDocument.groupBy({ by: ["state", "county", "abstractId"], where: { organizationId: org, abstractId: { not: null }, ...cls } }),
      prisma.researchPermit.groupBy({ by: ["state", "county", "abstractId"], where: { organizationId: org, abstractId: { not: null } } }),
      prisma.researchDocument.groupBy({ by: ["state", "county", "survey"], where: { organizationId: org, survey: { not: null }, ...cls } }),
      prisma.researchPermit.groupBy({ by: ["state", "county", "survey"], where: { organizationId: org, survey: { not: null } } }),
    ]));

    // Imported RRC permits (B3) contribute their counties + operators to the
    // filter lists so the whole platform dataset is filterable, not just files
    // imported through the Research page.
    let rrcGeo: { county: string }[] = [];
    let rrcOps: { operatorNorm: string; operator: string }[] = [];
    try {
      [rrcGeo, rrcOps] = await Promise.all([
        prisma.$queryRawUnsafe<{ county: string }[]>(`SELECT DISTINCT county FROM rrc.permits WHERE county IS NOT NULL`),
        prisma.$queryRawUnsafe<{ operator: string }[]>(`SELECT operator, count(*) n FROM rrc.permits WHERE operator IS NOT NULL GROUP BY operator ORDER BY n DESC LIMIT 500`)
          .then((rows) => rows.map((r) => ({ operator: r.operator, operatorNorm: normalizeEntity(r.operator) ?? "" })).filter((r) => r.operatorNorm)),
      ]);
    } catch { /* rrc schema absent */ }

    // Merge doc + permit geographies; dedupe entity display names per norm key.
    const stateSet = new Set<string>(states.map((s) => s.state));
    const countySet = new Map<string, { state: string; county: string }>();
    for (const c of counties) countySet.set(`${c.state}|${c.county}`, { state: c.state, county: c.county });
    for (const p of permitGeo) {
      stateSet.add(p.state);
      countySet.set(`${p.state}|${p.county}`, { state: p.state, county: p.county });
    }
    for (const g of rrcGeo) { stateSet.add("TX"); countySet.set(`TX|${g.county}`, { state: "TX", county: g.county }); }

    const entityOptions = (rows: { norm: string | null; raw: string | null }[]) => {
      const seen = new Map<string, string>();
      for (const r of rows) if (r.norm && !seen.has(r.norm)) seen.set(r.norm, r.raw ?? r.norm);
      return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    };

    // Abstracts with research activity, keyed to their state+county so the
    // client can cascade State → County → Abstract like every other selector.
    const abstractSet = new Map<string, { state: string; county: string; abstractId: string }>();
    for (const a of [...docAbstracts, ...permitAbstracts]) {
      if (a.abstractId) abstractSet.set(`${a.state}|${a.county}|${a.abstractId}`, { state: a.state, county: a.county, abstractId: a.abstractId });
    }
    // Survey names, dynamically from the imported data (documents + permits).
    const surveySet = new Map<string, { state: string; county: string; survey: string }>();
    for (const sv of [...docSurveys, ...permitSurveys]) {
      if (sv.survey) surveySet.set(`${sv.state}|${sv.county}|${sv.survey}`, { state: sv.state, county: sv.county, survey: sv.survey });
    }

    res.json({
      states: [...stateSet].sort(),
      counties: [...countySet.values()].sort((a, b) => a.county.localeCompare(b.county)),
      abstracts: [...abstractSet.values()].sort((a, b) => a.abstractId.localeCompare(b.abstractId, undefined, { numeric: true }) || a.county.localeCompare(b.county)),
      surveys: [...surveySet.values()].sort((a, b) => a.survey.localeCompare(b.survey) || a.county.localeCompare(b.county)),
      docTypes: docTypes.map((d) => d.docType).sort(),
      buyers: entityOptions(buyers.map((b) => ({ norm: b.granteeNorm, raw: b.grantee }))),
      sellers: entityOptions(sellers.map((s) => ({ norm: s.grantorNorm, raw: s.grantor }))),
      operators: entityOptions([
        ...operators.map((o) => ({ norm: o.operatorNorm, raw: o.operator })),
        ...rrcOps.map((o) => ({ norm: o.operatorNorm, raw: o.operator })),
      ]),
    });
  }),
);

// ---------------------------------------------------------------------------
// Summary — KPIs + comparison deltas + time series
// ---------------------------------------------------------------------------

researchRouter.get(
  "/summary",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const cmp = parseCompare(req.query as Record<string, unknown>, win);

    const [docs, permits, prevDocs, prevPermits] = await Promise.all([
      loadDocs(org, f, win), loadPermits(org, f, win), loadDocs(org, f, cmp), loadPermits(org, f, cmp),
    ]);

    const kpisOf = (ds: DocRow[], ps: PermitRow[]) => ({
      transactions: ds.filter((d) => d.docClass === "TRANSACTION").length,
      leases: ds.filter((d) => d.docClass === "LEASE").length,
      permits: ps.length,
      horizontalPermits: ps.filter((p) => p.trajectory === "HORIZONTAL").length,
      // Grantee count within the ACTIVE dataset only: deed buyers in
      // Transactions mode, lessees in Leases mode — never a mix.
      uniqueBuyers: new Set(ds.filter((d) => d.docClass === (f.docClass ?? "TRANSACTION") && d.granteeNorm).map((d) => d.granteeNorm)).size,
      uniqueOperators: new Set(ps.map((p) => p.operatorNorm)).size,
      acreage: Math.round(ds.reduce((s, d) => s + (d.acreage ?? 0), 0)),
    });
    const current = kpisOf(docs, permits);
    const previous = kpisOf(prevDocs, prevPermits);
    const trends: Record<string, Trend> = {};
    for (const k of Object.keys(current) as (keyof typeof current)[]) trends[k] = trend(current[k], previous[k]);

    // Time series over the current window, gap-free.
    const g = autoGranularity(win.from, win.to);
    const keys = bucketRange(win.from, win.to, g);
    const idx = new Map(keys.map((k, i) => [k, i]));
    const series = keys.map((key) => ({ key, transactions: 0, leases: 0, permits: 0 }));
    for (const d of docs) {
      const i = idx.get(bucketKey(d.recordingDate, g));
      if (i != null) series[i][d.docClass === "TRANSACTION" ? "transactions" : "leases"]++;
    }
    for (const p of permits) {
      const i = idx.get(bucketKey(p.activityDate, g));
      if (i != null) series[i].permits++;
    }
    const totals = series.map((s) => s.transactions + s.leases + s.permits);
    const avgWindow = g === "day" ? 7 : g === "week" ? 4 : 3;
    const rolling = rollingAverage(totals, avgWindow);
    const seriesOut = series.map((s, i) => ({ ...s, total: totals[i], rollingAvg: Math.round(rolling[i] * 10) / 10 }));

    // Doc-type breakdown for the current window.
    const byType = new Map<string, number>();
    for (const d of docs) byType.set(d.docType, (byType.get(d.docType) ?? 0) + 1);

    res.json({
      range: { from: win.from.toISOString().slice(0, 10), to: win.to.toISOString().slice(0, 10) },
      compare: { from: cmp.from.toISOString().slice(0, 10), to: cmp.to.toISOString().slice(0, 10) },
      granularity: g,
      kpis: current,
      previous,
      trends,
      series: seriesOut,
      docTypeBreakdown: [...byType.entries()].map(([docType, count]) => ({ docType, count })).sort((a, b) => b.count - a.count),
    });
  }),
);

// ---------------------------------------------------------------------------
// Geography — per state/county/abstract/survey aggregation + hotspots
// ---------------------------------------------------------------------------

type GeoLevel = "state" | "county" | "abstract";

function geoKeyOf(level: GeoLevel, row: { state: string; county: string; abstractId: string | null }): string | null {
  if (level === "state") return row.state;
  if (level === "county") return `${row.state}|${row.county}`;
  return row.abstractId ? `${row.state}|${row.county}|${row.abstractId}` : null;
}

researchRouter.get(
  "/geography",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const level = (["state", "county", "abstract"] as GeoLevel[]).includes(req.query.level as GeoLevel)
      ? (req.query.level as GeoLevel) : "county";

    // One load spanning the 6 history windows + compare + current.
    const hist = historyWindows(win.from, win.to, 6);
    const span: Window = { from: hist[0].from, to: win.to };
    const [docs, permits] = await Promise.all([loadDocs(org, f, span), loadPermits(org, f, span)]);
    const cmp = hist[hist.length - 1]; // window immediately before = comparison period

    interface GeoAgg {
      state: string; county: string | null; abstractId: string | null;
      transactions: number; leases: number; permits: number;
      prevTotal: number; history: number[];
    }
    const map = new Map<string, GeoAgg>();
    const get = (key: string, row: { state: string; county: string; abstractId: string | null }): GeoAgg => {
      let a = map.get(key);
      if (!a) {
        a = {
          state: row.state,
          county: level === "state" ? null : row.county,
          abstractId: level === "abstract" ? row.abstractId : null,
          transactions: 0, leases: 0, permits: 0, prevTotal: 0, history: hist.map(() => 0),
        };
        map.set(key, a);
      }
      return a;
    };
    const bump = (row: { state: string; county: string; abstractId: string | null }, date: Date, kind: "transactions" | "leases" | "permits") => {
      const key = geoKeyOf(level, row);
      if (!key) return;
      const a = get(key, row);
      if (within(date, win)) a[kind]++;
      if (within(date, cmp)) a.prevTotal++;
      hist.forEach((h, i) => { if (within(date, h)) a.history[i]++; });
    };
    for (const d of docs) bump(d, d.recordingDate, d.docClass === "TRANSACTION" ? "transactions" : "leases");
    for (const p of permits) bump(p, p.activityDate, "permits");

    const rows = [...map.values()]
      .map((a) => {
        const total = a.transactions + a.leases + a.permits;
        const t = trend(total, a.prevTotal);
        const hs = detectHotspot(total, a.history);
        return {
          state: a.state, county: a.county, abstractId: a.abstractId,
          transactions: a.transactions, leases: a.leases, permits: a.permits, total,
          previous: a.prevTotal, absoluteChange: t.absoluteChange, pctChange: t.pctChange,
          direction: t.direction, zScore: hs.zScore == null ? null : Math.round(hs.zScore * 100) / 100,
          isHotspot: hs.isHotspot,
        };
      })
      .filter((r) => r.total > 0 || r.previous > 0)
      .sort((a, b) => b.total - a.total);

    res.json({ level, rows });
  }),
);

// ---------------------------------------------------------------------------
// Entities — buyer / seller / operator rankings
// ---------------------------------------------------------------------------

researchRouter.get(
  "/entities",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const cmp = parseCompare(req.query as Record<string, unknown>, win);
    const role = req.query.role === "sellers" ? "sellers" : req.query.role === "operators" ? "operators" : "buyers";

    // Lookback (new-entrant detection): 12 months before the current window.
    const lookback: Window = { from: new Date(win.from.getTime() - 365 * DAY), to: new Date(win.from.getTime() - DAY) };
    const span: Window = { from: lookback.from.getTime() < cmp.from.getTime() ? lookback.from : cmp.from, to: win.to };

    interface EntityAgg {
      name: string; count: number; prev: number; seenBefore: boolean;
      acreage: number; counties: Set<string>; horizontal: number;
    }
    const map = new Map<string, EntityAgg>();
    const bump = (norm: string | null, raw: string | null, date: Date, county: string, acreage: number | null, horizontal = false) => {
      if (!norm) return;
      let a = map.get(norm);
      if (!a) { a = { name: raw ?? norm, count: 0, prev: 0, seenBefore: false, acreage: 0, counties: new Set(), horizontal: 0 }; map.set(norm, a); }
      if (within(date, win)) {
        a.count++;
        a.acreage += acreage ?? 0;
        a.counties.add(county);
        if (horizontal) a.horizontal++;
      }
      if (within(date, cmp)) a.prev++;
      if (within(date, lookback)) a.seenBefore = true;
    };

    if (role === "operators") {
      const permits = await loadPermits(org, f, span);
      for (const p of permits) bump(p.operatorNorm, p.operator, p.activityDate, p.county, null, p.trajectory === "HORIZONTAL");
    } else {
      // Party rankings are computed within ONE document class: deed/transaction
      // buyers must never be inflated by lease parties (the "operators showing
      // up as Top Buyers" bug) and vice versa. The page always sends docClass;
      // default to TRANSACTION so an unscoped call still can't mix datasets.
      const docs = await loadDocs(org, { ...f, docClass: f.docClass ?? "TRANSACTION" }, span);
      for (const d of docs) {
        if (role === "buyers") bump(d.granteeNorm, d.grantee, d.recordingDate, d.county, d.acreage);
        else bump(d.grantorNorm, d.grantor, d.recordingDate, d.county, d.acreage);
      }
    }

    const rows = [...map.entries()]
      .map(([key, a]) => {
        const t = trend(a.count, a.prev);
        return {
          key, name: a.name, count: a.count, previous: a.prev,
          absoluteChange: t.absoluteChange, pctChange: t.pctChange, direction: t.direction,
          acreage: Math.round(a.acreage), counties: [...a.counties].sort(),
          horizontal: a.horizontal, newEntrant: !a.seenBefore && a.count > 0,
        };
      })
      .filter((r) => r.count > 0 || r.previous > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 200);

    res.json({ role, rows });
  }),
);

// ---------------------------------------------------------------------------
// Relationship intelligence — grantor→grantee graph, co-buyers, chains, classes
// ---------------------------------------------------------------------------

/**
 * Load ownership-transfer edges (one Grantor → Grantee instrument) for the graph
 * analytics. Only TRANSACTION-class documents with both parties named
 * participate; `txKey` groups co-grantees recorded on the same instrument.
 */
async function loadTxEdges(org: string, f: ResearchFilters, win: Window): Promise<TxEdge[]> {
  const rows = await prisma.researchDocument.findMany({
    where: {
      ...docWhere(org, f, win),
      // One class per graph: acquisition chains and grantor→grantee analytics
      // come from deed/transaction instruments; in Leases mode the same graph
      // machinery runs over lease instruments (lessor→lessee) instead. The
      // two datasets never mix inside one graph.
      docClass: f.docClass ?? "TRANSACTION",
      grantorNorm: { not: null },
      granteeNorm: { not: null },
    },
    select: {
      id: true, grantor: true, grantorNorm: true, grantee: true, granteeNorm: true,
      grantorParties: true, granteeParties: true, grantorNorms: true, granteeNorms: true,
      state: true, county: true, abstractId: true, recordingDate: true, instrumentNumber: true,
    },
  });
  // Participant-level expansion: multi-party instruments yield one edge per
  // grantor×grantee pair, all sharing the document id (ONE transaction).
  return rows.flatMap((r) => expandDocToEdges(r));
}

researchRouter.get(
  "/relationships",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const edges = await loadTxEdges(org, f, win);

    // Participant-level relationships drive chains + classifications; the
    // DISPLAYED relationship list preserves each instrument's recorded party
    // groups — "(A + B) → (C + D)" is one relationship, never four.
    const relationships = aggregateRelationships(edges);
    const groupRelationships = aggregateGroupRelationships(edges);
    // Co-Buyer view: shared ACQUISITIONS only. Sell-side partnership data
    // stays computed (and feeds other analytics) but is not surfaced here.
    const coBuyers = coBuyerPartnerships(edges).filter((p) => p.sharedAcquisitions > 0);
    coBuyers.sort((a, b) => b.sharedAcquisitions - a.sharedAcquisitions || b.members.length - a.members.length);
    const chains = buildChains(relationships);
    const table = chainTableRows(chains);
    const classMap = classifyEntities(relationships);
    const classifications = [...classMap.values()]
      .map((s) => ({ ...s, classLabel: ENTITY_CLASS_LABEL[s.klass] }))
      .sort((a, b) => (b.acquisitions + b.dispositions) - (a.acquisitions + a.dispositions));

    res.json({
      totals: {
        // Distinct recorded documents — multi-party expansion never inflates this.
        transactions: new Set(edges.map((e) => e.id)).size,
        relationships: groupRelationships.length,
        entities: classMap.size,
        partnerships: coBuyers.length,
        chains: chains.length,
      },
      // Strip heavy txIds from the top-level list (drill-in fetches them on demand).
      relationships: groupRelationships.slice(0, 300).map(({ txIds, ...r }) => ({ ...r, transactions: r.count, _txCount: txIds.length })),
      coBuyers: coBuyers.slice(0, 100).map(({ txKeys, sharedDispositions, firstDate, lastDate, acqFirstDate, acqLastDate, ...p }) => ({
        ...p,
        count: p.sharedAcquisitions,           // rankings/counts: acquisitions only
        firstDate: acqFirstDate,               // first shared acquisition
        lastDate: acqLastDate,                 // most recent shared acquisition
        _txCount: txKeys.length,
      })),
      chainTable: table.map((row) => ({
        path: row.path, feeders: row.feeders, midTier: row.midTier, terminus: row.terminus,
        length: row.chain.length, strength: row.chain.strength, totalCount: row.chain.totalCount,
        counties: row.chain.counties, firstDate: row.chain.firstDate, lastDate: row.chain.lastDate,
        nodes: row.chain.nodes, hops: row.chain.hops,
      })),
      classifications: classifications.slice(0, 300),
      classLabels: ENTITY_CLASS_LABEL,
    });
  }),
);

// Drill-in: supporting transactions for a relationship pair, a co-buyer set,
// a chain path, or a single entity. Respects the active filters + window.
const relTxSchema = z.object({
  grantorNorm: z.string().optional(),
  granteeNorm: z.string().optional(),
  members: z.array(z.string()).optional(),   // co-buyer set (all must be grantees on the instrument)
  path: z.array(z.string()).optional(),      // chain node sequence
  entityNorm: z.string().optional(),         // any transfer touching this entity
});

researchRouter.post(
  "/relationships/transactions",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const sel = relTxSchema.parse(req.body ?? {});
    const edges = await loadTxEdges(org, f, win);

    let ids: string[] = [];
    if (sel.grantorNorm && sel.granteeNorm) {
      // Relationship rows preserve recorded party groups, so the pair selector
      // matches the GROUP keys first (participant keys as fallback for older
      // callers / single-party rows, where the two are identical).
      ids = edges
        .filter((e) =>
          ((e.grantorGroupNorm ?? e.grantorNorm) === sel.grantorNorm && (e.granteeGroupNorm ?? e.granteeNorm) === sel.granteeNorm) ||
          (e.grantorNorm === sel.grantorNorm && e.granteeNorm === sel.granteeNorm))
        .map((e) => e.id);
    } else if (sel.members && sel.members.length >= 2) {
      // Co-Buyer drill: transactions where the member set acquired together as
      // co-GRANTEES (the view is acquisitions-only). Grouped per recorded
      // transaction — instrument key when present, else document id.
      const want = new Set(sel.members);
      const byTx = new Map<string, TxEdge[]>();
      for (const e of edges) { const k = e.txKey ?? e.id; (byTx.get(k) ?? byTx.set(k, []).get(k)!).push(e); }
      for (const list of byTx.values()) {
        const grantees = new Set(list.map((e) => e.granteeNorm));
        if ([...want].every((m) => grantees.has(m)) && grantees.size === want.size) ids.push(...list.map((e) => e.id));
      }
    } else if (sel.path && sel.path.length >= 2) {
      const hops = new Set<string>();
      for (let i = 0; i < sel.path.length - 1; i++) hops.add(`${sel.path[i]}\u0000${sel.path[i + 1]}`);
      ids = edges.filter((e) => hops.has(`${e.grantorNorm}\u0000${e.granteeNorm}`)).map((e) => e.id);
    } else if (sel.entityNorm) {
      ids = edges
        .filter((e) => e.grantorNorm === sel.entityNorm || e.granteeNorm === sel.entityNorm ||
          e.grantorGroupNorm === sel.entityNorm || e.granteeGroupNorm === sel.entityNorm)
        .map((e) => e.id);
    } else {
      throw new HttpError(400, "Provide a relationship pair, co-buyer members, chain path, or entity.");
    }

    ids = [...new Set(ids)]; // expanded edges share document ids — one row each
    const rows = ids.length
      ? await prisma.researchDocument.findMany({
          where: { id: { in: ids.slice(0, 1000) }, organizationId: org },
          orderBy: { recordingDate: "desc" },
          take: 1000,
        })
      : [];
    res.json({ total: rows.length, rows });
  }),
);

// ---------------------------------------------------------------------------
// Add to Buyers — turn active research buyers into CRM Buyer profiles
// ---------------------------------------------------------------------------

const RESEARCH_TAG = "Research Imported";

const DOC_LITE_SELECT = {
  grantee: true, granteeNorm: true, granteeParties: true, granteeNorms: true,
  state: true, county: true, abstractId: true, docType: true, recordingDate: true,
} as const;

/**
 * Load all-time research docs for the given entity keys, grouped by key. Keys
 * are matched as grantees (the buyer role) first; any key with no grantee rows
 * falls back to its grantor rows (mapped as the entity) so a party that only
 * appears as a seller in the dataset — e.g. an entity surfaced from the
 * relationship graph — can still be turned into a CRM buyer.
 */
async function docsByGrantee(org: string, keys: string[]): Promise<Map<string, ResearchDocLite[]>> {
  // Match keys as the full-cell norm OR as an individual participant of a
  // multi-party grantee group — each participant owns its transaction history.
  const docs = await prisma.researchDocument.findMany({
    where: { organizationId: org, OR: [{ granteeNorm: { in: keys } }, { granteeNorms: { hasSome: keys } }] },
    select: DOC_LITE_SELECT,
  });
  const wanted = new Set(keys);
  const byKey = new Map<string, ResearchDocLite[]>();
  const attach = (key: string, name: string | null, d: (typeof docs)[number]) => {
    const list = byKey.get(key) ?? [];
    list.push({ grantee: name, granteeNorm: key, state: d.state, county: d.county, abstractId: d.abstractId, docType: d.docType, recordingDate: d.recordingDate });
    byKey.set(key, list);
  };
  for (const d of docs) {
    const matchedParticipants = d.granteeNorms
      .map((n, i) => ({ norm: n, name: d.granteeParties[i] ?? n }))
      .filter((p) => wanted.has(p.norm));
    for (const p of matchedParticipants) attach(p.norm, p.name, d);
    // Full-cell key match (single-party rows, or a caller using the group key).
    if (d.granteeNorm && wanted.has(d.granteeNorm) && !matchedParticipants.some((p) => p.norm === d.granteeNorm)) {
      attach(d.granteeNorm, d.grantee, d);
    }
  }
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length) {
    const grantorDocs = await prisma.researchDocument.findMany({
      where: { organizationId: org, grantorNorm: { in: missing } },
      select: { grantor: true, grantorNorm: true, state: true, county: true, abstractId: true, docType: true, recordingDate: true },
    });
    for (const d of grantorDocs) {
      if (!d.grantorNorm) continue;
      const list = byKey.get(d.grantorNorm) ?? [];
      list.push({ grantee: d.grantor, granteeNorm: d.grantorNorm, state: d.state, county: d.county, abstractId: d.abstractId, docType: d.docType, recordingDate: d.recordingDate });
      byKey.set(d.grantorNorm, list);
    }
  }
  return byKey;
}

// Preview: classify each selected buyer as new / exact / possible and show the
// additive changes a merge would make, so the client can auto-apply new/exact
// and surface possible duplicates for review.
researchRouter.post(
  "/buyers/preview",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { keys } = z.object({ keys: z.array(z.string()).min(1).max(500) }).parse(req.body);
    const byKey = await docsByGrantee(org, keys);
    const buyers = await prisma.buyer.findMany({
      where: { organizationId: org },
      select: { id: true, companyName: true, normalizedCompany: true, aliases: true, source: true, researchSummary: true, buyBox: { select: { counties: true, states: true } } },
    });
    const existingLite: ExistingBuyerLite[] = buyers.map((b) => ({ id: b.id, companyName: b.companyName, normalizedCompany: b.normalizedCompany, aliases: b.aliases }));

    const items = keys.map((key) => {
      const proposal = buildResearchBuyer(byKey.get(key) ?? []);
      if (!proposal) return null;
      const match = classifyMatch(proposal, existingLite);
      const base = {
        key, outcome: match.outcome,
        proposal: {
          companyName: proposal.companyName, aliases: proposal.aliases,
          counties: proposal.counties, states: proposal.states, abstracts: proposal.abstracts,
          transactionTypes: proposal.transactionTypes, transactionCount: proposal.transactionCount,
          firstSeen: proposal.firstSeen, lastSeen: proposal.lastSeen,
        },
        confidence: null as number | null,
        existing: null as null | { id: string; companyName: string; counties: string[]; states: string[]; aliases: string[] },
        mergePreview: null as null | { addCounties: string[]; addStates: string[]; addAliases: string[] },
      };
      if (match.outcome !== "new") {
        const eb = buyers.find((b) => b.id === match.buyerId)!;
        const plan = mergePlan(
          { aliases: eb.aliases, source: eb.source, researchSummary: (eb.researchSummary as never) ?? null, buyBoxCounties: eb.buyBox?.counties ?? [], buyBoxStates: eb.buyBox?.states ?? [] },
          proposal,
        );
        base.existing = { id: eb.id, companyName: eb.companyName, counties: eb.buyBox?.counties ?? [], states: eb.buyBox?.states ?? [], aliases: eb.aliases };
        base.mergePreview = { addCounties: plan.addCounties, addStates: plan.addStates, addAliases: plan.addAliases };
        if (match.outcome === "possible") base.confidence = match.confidence;
      }
      return base;
    }).filter((x): x is NonNullable<typeof x> => x != null);

    res.json({ items });
  }),
);

// Commit: apply the user's decisions — create new profiles, additively merge
// into existing ones, or skip. Every create/merge is recorded in ActivityLog.
researchRouter.post(
  "/buyers/commit",
  requirePermission("createBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { decisions } = z.object({
      decisions: z.array(z.object({
        key: z.string(),
        action: z.enum(["create", "merge", "skip"]),
        mergeIntoBuyerId: z.string().optional(),
      })).min(1).max(500),
    }).parse(req.body);

    const byKey = await docsByGrantee(org, decisions.map((d) => d.key));
    // Ensure this org's "Research Imported" tag exists (tags are per-org).
    const tag = await prisma.buyerTag.upsert({
      where: { organizationId_name: { organizationId: org, name: RESEARCH_TAG } },
      create: { organizationId: org, name: RESEARCH_TAG },
      update: {},
    });

    let created = 0, merged = 0, skipped = 0;
    for (const dec of decisions) {
      const proposal = dec.action === "skip" ? null : buildResearchBuyer(byKey.get(dec.key) ?? []);
      if (dec.action === "skip" || !proposal) { skipped++; continue; }

      if (dec.action === "create") {
        const buyer = await prisma.buyer.create({
          data: {
            organizationId: org,
            name: proposal.companyName,
            companyName: proposal.companyName,
            normalizedCompany: normalizeCompany(proposal.companyName),
            aliases: proposal.aliases,
            source: "research",
            researchSummary: summaryFor(proposal) as unknown as Prisma.InputJsonValue,
            buyBox: { create: { counties: proposal.counties, states: proposal.states, basins: [], formations: [], assetTypes: [] } },
            tags: { create: { tagId: tag.id } },
          },
        });
        await prisma.activityLog.create({
          data: {
            organizationId: org, eventType: "BUYER_RESEARCH_IMPORT", buyerId: buyer.id, actorUserId: req.user!.id,
            summary: `Buyer created from research: ${proposal.companyName} — ${proposal.transactionCount} transaction(s) across ${proposal.counties.join(", ") || "—"}`,
          },
        });
        created++;
      } else if (dec.action === "merge" && dec.mergeIntoBuyerId) {
        const eb = await prisma.buyer.findFirst({ where: { id: dec.mergeIntoBuyerId, organizationId: org }, include: { buyBox: true } });
        if (!eb) { skipped++; continue; }
        const plan = mergePlan(
          { aliases: eb.aliases, source: eb.source, researchSummary: (eb.researchSummary as never) ?? null, buyBoxCounties: eb.buyBox?.counties ?? [], buyBoxStates: eb.buyBox?.states ?? [] },
          proposal,
        );
        await prisma.$transaction(async (tx) => {
          await tx.buyer.update({
            where: { id: eb.id },
            data: {
              aliases: [...eb.aliases, ...plan.addAliases],
              ...(plan.markResearch ? { source: "research" } : {}),
              researchSummary: plan.summary as unknown as Prisma.InputJsonValue,
            },
          });
          if (eb.buyBox) {
            await tx.buyBoxCriteria.update({ where: { buyerId: eb.id }, data: { counties: [...eb.buyBox.counties, ...plan.addCounties], states: [...eb.buyBox.states, ...plan.addStates] } });
          } else {
            await tx.buyBoxCriteria.create({ data: { buyerId: eb.id, counties: plan.addCounties, states: plan.addStates, basins: [], formations: [], assetTypes: [] } });
          }
          await tx.activityLog.create({
            data: {
              organizationId: org, eventType: "BUYER_RESEARCH_MERGE", buyerId: eb.id, actorUserId: req.user!.id,
              summary: `Enriched ${eb.companyName} from research: +${plan.addCounties.length} counties, +${plan.addStates.length} states, +${plan.addAliases.length} aliases`,
            },
          });
        });
        merged++;
      } else {
        skipped++;
      }
    }

    res.json({ created, merged, skipped });
  }),
);

// ---------------------------------------------------------------------------
// Opportunities — automatically detected acquisition signals
// ---------------------------------------------------------------------------

researchRouter.get(
  "/opportunities",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const hist = historyWindows(win.from, win.to, 6);
    const span: Window = { from: new Date(Math.min(hist[0].from.getTime(), win.from.getTime() - 365 * DAY)), to: win.to };
    const lookback: Window = { from: new Date(win.from.getTime() - 365 * DAY), to: new Date(win.from.getTime() - DAY) };
    const prev = hist[hist.length - 1];

    const [docs, permits] = await Promise.all([loadDocs(org, f, span), loadPermits(org, f, span)]);

    interface Signal {
      id: string;
      kind: "TRANSACTION_SURGE" | "LEASE_SURGE" | "PERMIT_SURGE" | "ABSTRACT_CONCENTRATION" | "NEW_OPERATOR" | "CONFLUENCE";
      severity: number;
      title: string;
      detail: string;
      state: string; county: string | null; abstractId: string | null;
      metrics: Record<string, number | null>;
    }
    const signals: Signal[] = [];

    // -- County surges per activity category --------------------------------
    const countyAgg = new Map<string, { state: string; county: string; cur: Record<string, number>; prev: Record<string, number>; hist: Record<string, number[]> }>();
    const catOf = (kind: "transactions" | "leases" | "permits") => kind;
    const bumpCounty = (state: string, county: string, date: Date, kind: "transactions" | "leases" | "permits") => {
      const key = `${state}|${county}`;
      let a = countyAgg.get(key);
      if (!a) {
        a = {
          state, county,
          cur: { transactions: 0, leases: 0, permits: 0 },
          prev: { transactions: 0, leases: 0, permits: 0 },
          hist: { transactions: hist.map(() => 0), leases: hist.map(() => 0), permits: hist.map(() => 0) },
        };
        countyAgg.set(key, a);
      }
      const cat = catOf(kind);
      if (within(date, win)) a.cur[cat]++;
      if (within(date, prev)) a.prev[cat]++;
      hist.forEach((h, i) => { if (within(date, h)) a.hist[cat][i]++; });
    };
    for (const d of docs) bumpCounty(d.state, d.county, d.recordingDate, d.docClass === "TRANSACTION" ? "transactions" : "leases");
    for (const p of permits) bumpCounty(p.state, p.county, p.activityDate, "permits");

    const surgeKinds: { cat: "transactions" | "leases" | "permits"; kind: Signal["kind"]; label: string }[] = [
      { cat: "transactions", kind: "TRANSACTION_SURGE", label: "mineral transactions" },
      { cat: "leases", kind: "LEASE_SURGE", label: "leasing activity" },
      { cat: "permits", kind: "PERMIT_SURGE", label: "drilling permits" },
    ];
    const surgedCounties = new Map<string, Signal[]>();
    for (const a of countyAgg.values()) {
      for (const { cat, kind, label } of surgeKinds) {
        const cur = a.cur[cat];
        const before = a.prev[cat];
        const hs = detectHotspot(cur, a.hist[cat]);
        const t = trend(cur, before);
        const growing = t.pctChange == null ? cur >= 5 : t.pctChange >= 0.5;
        if (hs.isHotspot || (growing && cur >= 8)) {
          const sev = surgeSeverity(cur, before, hs.zScore);
          const pctTxt = t.pctChange == null ? "new activity" : `${t.pctChange >= 0 ? "+" : ""}${Math.round(t.pctChange * 100)}%`;
          const sig: Signal = {
            id: `${kind}:${a.state}|${a.county}`,
            kind,
            severity: sev,
            title: `${a.county} County, ${a.state}: surge in ${label}`,
            detail: `${cur} in the current period vs ${before} prior (${pctTxt}${hs.zScore != null ? `, z=${hs.zScore.toFixed(1)}` : ""}).`,
            state: a.state, county: a.county, abstractId: null,
            metrics: { current: cur, previous: before, pctChange: t.pctChange, zScore: hs.zScore },
          };
          signals.push(sig);
          const list = surgedCounties.get(`${a.state}|${a.county}`) ?? [];
          list.push(sig);
          surgedCounties.set(`${a.state}|${a.county}`, list);
        }
      }
    }

    // -- Confluence: multiple signal categories in the same county ----------
    for (const [key, list] of surgedCounties) {
      if (list.length >= 2) {
        const [state, county] = key.split("|");
        const maxSev = Math.max(...list.map((s) => s.severity));
        signals.push({
          id: `CONFLUENCE:${key}`,
          kind: "CONFLUENCE",
          severity: Math.min(100, maxSev + 15),
          title: `${county} County, ${state}: multiple signals converging`,
          detail: `Simultaneous surges in ${list.map((s) => s.kind.replace("_SURGE", "").toLowerCase() + "s").join(" and ")} — leasing/permitting and ownership changes overlapping is the strongest early-acquisition indicator.`,
          state, county, abstractId: null,
          metrics: { signals: list.length },
        });
      }
    }

    // -- Abstract concentration: transactions clustering in one abstract ----
    const absAgg = new Map<string, { state: string; county: string; abstractId: string; cur: number; prevCnt: number }>();
    for (const d of docs) {
      if (!d.abstractId || d.docClass !== "TRANSACTION") continue;
      const key = `${d.state}|${d.county}|${d.abstractId}`;
      let a = absAgg.get(key);
      if (!a) { a = { state: d.state, county: d.county, abstractId: d.abstractId, cur: 0, prevCnt: 0 }; absAgg.set(key, a); }
      if (within(d.recordingDate, win)) a.cur++;
      if (within(d.recordingDate, prev)) a.prevCnt++;
    }
    for (const a of absAgg.values()) {
      if (a.cur >= 3) {
        signals.push({
          id: `ABSTRACT:${a.state}|${a.county}|${a.abstractId}`,
          kind: "ABSTRACT_CONCENTRATION",
          severity: Math.min(100, 40 + a.cur * 8),
          title: `Abstract ${a.abstractId} (${a.county} Co, ${a.state}): concentrated buying`,
          detail: `${a.cur} mineral transactions recorded in this abstract during the period — someone may be assembling a position.`,
          state: a.state, county: a.county, abstractId: a.abstractId,
          metrics: { current: a.cur, previous: a.prevCnt, pctChange: null, zScore: null },
        });
      }
    }

    // -- New operators entering the area -------------------------------------
    const opAgg = new Map<string, { name: string; counties: Set<string>; state: string; cur: number; before: boolean }>();
    for (const p of permits) {
      let a = opAgg.get(p.operatorNorm);
      if (!a) { a = { name: p.operator, counties: new Set(), state: p.state, cur: 0, before: false }; opAgg.set(p.operatorNorm, a); }
      if (within(p.activityDate, win)) { a.cur++; a.counties.add(p.county); }
      if (within(p.activityDate, lookback)) a.before = true;
    }
    for (const a of opAgg.values()) {
      if (!a.before && a.cur >= 2) {
        signals.push({
          id: `NEWOP:${a.name}`,
          kind: "NEW_OPERATOR",
          severity: Math.min(100, 35 + a.cur * 6),
          title: `New operator: ${a.name}`,
          detail: `${a.cur} permits filed in ${[...a.counties].join(", ")} with no activity in the prior 12 months — a new entrant staking out acreage.`,
          state: a.state, county: [...a.counties][0] ?? null, abstractId: null,
          metrics: { current: a.cur, previous: 0, pctChange: null, zScore: null },
        });
      }
    }

    signals.sort((x, y) => y.severity - x.severity);
    res.json({ signals: signals.slice(0, 50) });
  }),
);

// ---------------------------------------------------------------------------
// Underlying records (drill-in tables)
// ---------------------------------------------------------------------------

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(50),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  // Free-text record search + dedicated instrument-number filter. Both run in
  // the DATABASE over the whole filtered dataset (case-insensitive contains),
  // so matches surface from any page. Length-capped: they land in LIKE
  // patterns, and an unbounded string is an unbounded pattern.
  q: z.string().trim().max(200).optional(),
  instrument: z.string().trim().max(100).optional(),
});

/** Case-insensitive contains, with LIKE wildcards in user input neutralized. */
const contains = (v: string) => ({ contains: v.replace(/[%_\\]/g, "\\$&"), mode: "insensitive" as const });

/**
 * Whole-dataset sorting: the ORDER BY runs in the database over every row
 * matching the filters, THEN the page is cut — a sort by amount surfaces the
 * top record on page 1 no matter which page it previously sat on. Sortable
 * columns are whitelisted per endpoint; anything else falls back to the
 * default date column. Nullable columns sort nulls last in both directions
 * so empty cells never crowd out real values at the top.
 */
const DOC_SORT_COLUMNS: Record<string, { column: string; nullable?: boolean }> = {
  recordingDate: { column: "recordingDate" },
  effectiveDate: { column: "effectiveDate", nullable: true },
  county: { column: "county" },
  docType: { column: "docType" },
  grantor: { column: "grantor", nullable: true },
  grantee: { column: "grantee", nullable: true },
  acreage: { column: "acreage", nullable: true },
  consideration: { column: "consideration", nullable: true },
  instrumentNumber: { column: "instrumentNumber", nullable: true },
  abstractId: { column: "abstractId", nullable: true },
  survey: { column: "survey", nullable: true },
};
const PERMIT_SORT_COLUMNS: Record<string, { column: string; nullable?: boolean }> = {
  activityDate: { column: "activityDate" },
  county: { column: "county" },
  operator: { column: "operator" },
  status: { column: "status" },
  trajectory: { column: "trajectory" },
  abstractId: { column: "abstractId", nullable: true },
  survey: { column: "survey", nullable: true },
  leaseName: { column: "leaseName", nullable: true },
  formation: { column: "formation", nullable: true },
  apiNumber: { column: "apiNumber", nullable: true },
};

function sortOrder(
  columns: Record<string, { column: string; nullable?: boolean }>,
  sortBy: string | undefined,
  sortDir: "asc" | "desc",
  fallback: string,
): Record<string, unknown>[] {
  const spec = (sortBy && columns[sortBy]) || columns[fallback];
  const dir = spec.nullable ? { sort: sortDir, nulls: "last" } : sortDir;
  const order: Record<string, unknown>[] = [{ [spec.column]: dir }];
  // Stable tiebreaker so pagination never shows a row twice across pages.
  if (spec.column !== fallback) order.push({ [fallback]: "desc" });
  order.push({ id: "asc" });
  return order;
}

/**
 * Dynamic option lists for the Records filter panel — distinct values drawn
 * from the data currently loaded into Research (i.e. under the page's active
 * filters + window), so the dropdowns never offer values with zero rows.
 */
researchRouter.get(
  "/records/options",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const kind = req.query.kind === "permits" ? "permits" : "documents";
    // Options describe the dataset BEFORE the panel's own selections, so
    // narrow the base filters only (the client omits panel params here).
    if (kind === "documents") {
      const where = docWhere(org, f, win);
      const [counties, abstracts, surveys, docTypes, docClasses] = await Promise.all([
        prisma.researchDocument.groupBy({ by: ["county"], where, orderBy: { county: "asc" } }),
        prisma.researchDocument.groupBy({ by: ["abstractId"], where, orderBy: { abstractId: "asc" } }),
        prisma.researchDocument.groupBy({ by: ["survey"], where, orderBy: { survey: "asc" } }),
        prisma.researchDocument.groupBy({ by: ["docType"], where, orderBy: { docType: "asc" } }),
        prisma.researchDocument.groupBy({ by: ["docClass"], where, orderBy: { docClass: "asc" } }),
      ]);
      return res.json({
        counties: counties.map((r) => r.county).filter(Boolean),
        abstracts: abstracts.map((r) => r.abstractId).filter((v): v is string => !!v),
        surveys: surveys.map((r) => r.survey).filter((v): v is string => !!v),
        docTypes: docTypes.map((r) => r.docType).filter(Boolean),
        docClasses: docClasses.map((r) => r.docClass).filter(Boolean),
      });
    }
    const where = permitWhere(org, f, win);
    const [counties, abstracts, surveys, statuses, trajectories] = await Promise.all([
      prisma.researchPermit.groupBy({ by: ["county"], where, orderBy: { county: "asc" } }),
      prisma.researchPermit.groupBy({ by: ["abstractId"], where, orderBy: { abstractId: "asc" } }),
      prisma.researchPermit.groupBy({ by: ["survey"], where, orderBy: { survey: "asc" } }),
      prisma.researchPermit.groupBy({ by: ["status"], where, orderBy: { status: "asc" } }),
      prisma.researchPermit.groupBy({ by: ["trajectory"], where, orderBy: { trajectory: "asc" } }),
    ]);
    res.json({
      counties: counties.map((r) => r.county).filter(Boolean),
      abstracts: abstracts.map((r) => r.abstractId).filter((v): v is string => !!v),
      surveys: surveys.map((r) => r.survey).filter((v): v is string => !!v),
      statuses: statuses.map((r) => r.status).filter(Boolean),
      trajectories: trajectories.map((r) => r.trajectory).filter(Boolean),
    });
  }),
);

/** Abstract-number join key: "A-123", "A123", "123 " all mean abstract 123. */
function abstractJoinKey(v: string): string {
  return v.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^A(?=\d)/, "");
}

/**
 * Single-county geography drill-in: every abstract boundary in the county
 * (from PostGIS) with the filtered research activity aggregated per abstract —
 * record count plus summed transaction amount (consideration). Returns an
 * empty FeatureCollection when cadastral coverage is unavailable.
 */
researchRouter.get(
  "/abstract-map",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const county = String(req.query.mapCounty ?? "").trim();
    if (!county) throw new HttpError(400, "mapCounty is required");

    const docs = await prisma.researchDocument.findMany({
      where: { ...docWhere(org, { ...f, counties: [county] }, win), abstractId: { not: null } },
      select: { abstractId: true, consideration: true },
    });
    const stats = new Map<string, { count: number; amount: number }>();
    for (const d of docs) {
      const k = abstractJoinKey(d.abstractId!);
      if (!k) continue;
      const st = stats.get(k) ?? { count: 0, amount: 0 };
      st.count++; st.amount += d.consideration ?? 0;
      stats.set(k, st);
    }

    // Abstract polygons for the county; simplified — this is a summary map.
    type AbsRow = { abstract: string | null; survey: string | null; geom: string | null };
    let features: unknown[] = [];
    try {
      const rows = await prisma.$queryRawUnsafe<AbsRow[]>(
        `SELECT replace(abstract, '?', '') AS abstract, survey,
                ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.0004), 5) AS geom
           FROM gis.abstracts WHERE upper(county) = upper($1)`,
        county,
      );
      features = rows
        .filter((r) => r.geom && r.abstract)
        .map((r) => {
          const st = stats.get(abstractJoinKey(r.abstract!));
          return {
            type: "Feature",
            properties: { abstract: r.abstract, survey: r.survey, count: st?.count ?? 0, amount: st?.amount ?? 0 },
            geometry: JSON.parse(r.geom!) as unknown,
          };
        });
    } catch {
      // gis schema absent (e.g. local sandbox) -> no boundaries to draw.
    }
    res.json({ type: "FeatureCollection", features });
  }),
);

/**
 * Top buyers (grantees) for the selected abstract(s) — powers the compact
 * "Top Buyers" preview shown above the Records table when an abstract filter
 * is active. Respects every active research filter and the period window.
 */
researchRouter.get(
  "/abstract-buyers",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    if (!f.abstractIds.length) {
      res.json({ total: 0, buyers: [] });
      return;
    }
    const docs = await prisma.researchDocument.findMany({
      where: { ...docWhere(org, f, win), granteeNorm: { not: null } },
      select: {
        grantee: true, granteeNorm: true, docClass: true, recordingDate: true,
        consideration: true, acreage: true,
      },
    });
    interface Agg {
      name: string; count: number; transactions: number; leases: number;
      amount: number; acreage: number; first: Date; last: Date;
    }
    const byNorm = new Map<string, Agg>();
    for (const d of docs) {
      const a = byNorm.get(d.granteeNorm!) ?? {
        name: d.grantee ?? d.granteeNorm!, count: 0, transactions: 0, leases: 0,
        amount: 0, acreage: 0, first: d.recordingDate, last: d.recordingDate,
      };
      a.count++;
      if (d.docClass === "TRANSACTION") a.transactions++; else a.leases++;
      a.amount += d.consideration ?? 0;
      a.acreage += d.acreage ?? 0;
      if (d.recordingDate < a.first) a.first = d.recordingDate;
      if (d.recordingDate > a.last) { a.last = d.recordingDate; a.name = d.grantee ?? a.name; }
      byNorm.set(d.granteeNorm!, a);
    }
    const buyers = [...byNorm.entries()]
      .sort((x, y) => y[1].count - x[1].count || y[1].amount - x[1].amount)
      .slice(0, 5)
      .map(([norm, a]) => ({
        norm, name: a.name, count: a.count, transactions: a.transactions,
        leases: a.leases, amount: a.amount, acreage: a.acreage,
        firstSeen: a.first, lastSeen: a.last,
      }));
    res.json({ total: byNorm.size, buyers });
  }),
);

/**
 * Records search predicates, shared by the paginated list endpoints and
 * /records/ids (whole-dataset selection) so "what matches" is defined once.
 */
function applyDocSearch(where: Prisma.ResearchDocumentWhereInput, q?: string, instrument?: string): void {
  if (instrument) where.instrumentNumber = contains(instrument);
  if (q) {
    // One free-text term matched against every user-visible record field.
    where.OR = [
      { grantor: contains(q) }, { grantee: contains(q) },
      { instrumentNumber: contains(q) }, { docTypeRaw: contains(q) },
      { county: contains(q) }, { abstractId: contains(q) },
      { survey: contains(q) }, { legalDescription: contains(q) },
      { volume: contains(q) }, { page: contains(q) },
    ];
  }
}
function applyPermitSearch(where: Prisma.ResearchPermitWhereInput, q?: string, instrument?: string): void {
  if (instrument) where.permitNumber = contains(instrument);
  if (q) {
    where.OR = [
      { operator: contains(q) }, { leaseName: contains(q) }, { wellName: contains(q) },
      { apiNumber: contains(q) }, { permitNumber: contains(q) },
      { county: contains(q) }, { abstractId: contains(q) }, { survey: contains(q) },
      { formation: contains(q) },
    ];
  }
}

/**
 * Every id matching the current filters/search — powers "Select all" across
 * ALL pages: the client swaps its selection for this list, so bulk actions
 * operate on the whole filtered dataset, never just the visible page.
 */
researchRouter.get(
  "/records/ids",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const { q, instrument } = pageSchema.parse(req.query);
    const kind = req.query.kind === "permits" ? "permits" : "documents";
    let ids: { id: string }[];
    if (kind === "documents") {
      const where = docWhere(org, f, win);
      applyDocSearch(where, q, instrument);
      ids = await prisma.researchDocument.findMany({ where, select: { id: true } });
    } else {
      const where = permitWhere(org, f, win);
      applyPermitSearch(where, q, instrument);
      ids = await prisma.researchPermit.findMany({ where, select: { id: true } });
    }
    res.json({ total: ids.length, ids: ids.map((r) => r.id) });
  }),
);

researchRouter.get(
  "/documents",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const { page, pageSize, sortBy, sortDir, q, instrument } = pageSchema.parse(req.query);
    const where = docWhere(org, f, win);
    applyDocSearch(where, q, instrument);
    const [total, rows] = await Promise.all([
      prisma.researchDocument.count({ where }),
      prisma.researchDocument.findMany({
        where,
        orderBy: sortOrder(DOC_SORT_COLUMNS, sortBy, sortDir, "recordingDate") as Prisma.ResearchDocumentOrderByWithRelationInput[],
        skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    res.json({ total, page, pageSize, rows });
  }),
);

researchRouter.get(
  "/permits",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const { page, pageSize, sortBy, sortDir, q, instrument } = pageSchema.parse(req.query);
    const where = permitWhere(org, f, win);
    applyPermitSearch(where, q, instrument);
    const [total, rows] = await Promise.all([
      prisma.researchPermit.count({ where }),
      prisma.researchPermit.findMany({
        where,
        orderBy: sortOrder(PERMIT_SORT_COLUMNS, sortBy, sortDir, "activityDate") as Prisma.ResearchPermitOrderByWithRelationInput[],
        skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    res.json({ total, page, pageSize, rows });
  }),
);

// ---------------------------------------------------------------------------
// Ingest — CSV imports (Data Type: Deeds / Leases / Drilling Permits)
// ---------------------------------------------------------------------------

researchRouter.get(
  "/ingest/sources",
  requirePermission("viewResearch"),
  asyncHandler(async (_req, res) => {
    res.json({
      documentFields: fieldsFor("DOCUMENTS"),
      permitFields: fieldsFor("PERMITS"),
    });
  }),
);

const analyzeSchema = z.object({
  category: z.enum(["deeds", "leases", "permits"]),
  csv: z.string().min(1).max(MAX_CSV_CHARS, "CSV file is too large"),
});

researchRouter.post(
  "/ingest/analyze",
  requirePermission("manageResearchData"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { category, csv } = analyzeSchema.parse(req.body);
    const { kind } = resolveCategory(category);
    const { headers, rows } = parseCsv(csv);
    res.json({
      headers,
      fields: fieldsFor(kind),
      suggestedMapping: guessMapping(sourceFor(kind), headers),
      rowCount: rows.length,
      sample: rows.slice(0, 5),
    });
  }),
);

const commitSchema = z.object({
  category: z.enum(["deeds", "leases", "permits"]),
  csv: z.string().min(1).max(MAX_CSV_CHARS, "CSV file is too large"),
  mapping: z.record(z.string(), z.string()),
  filename: z.string().optional(),
  // Fallback State/County the user assigns when the file has no such columns.
  assignedState: z.string().trim().min(1).optional(),
  assignedCounty: z.string().trim().min(1).optional(),
});

researchRouter.post(
  "/ingest/commit",
  requirePermission("manageResearchData"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { category, csv, mapping, filename, assignedState, assignedCounty } = commitSchema.parse(req.body);
    // All ingest logic (dedup, classification, geography normalization, the
    // per-import audit trail) lives in the shared core so the headless CLI
    // importer runs it identically. The route only supplies request context.
    const summary = await ingestResearchCsv({
      prisma, organizationId: orgId(req), createdByUserId: req.user!.id,
      category, csv, mapping, filename, assignedState, assignedCounty,
    });
    res.json(summary);
  }),
);

// Per-row review of an import: which rows were imported, skipped as duplicates,
// updated, or rejected — and why. Powers the post-import review views + export.
researchRouter.get(
  "/ingest/runs/:id/rows",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const run = await prisma.researchIngestRun.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
      select: { id: true, kind: true },
    });
    if (!run) throw new HttpError(404, "Import not found");
    const outcome = typeof req.query.outcome === "string" ? req.query.outcome.toUpperCase() : undefined;
    const items = await prisma.researchIngestRow.findMany({
      where: { ingestRunId: run.id, ...(outcome ? { outcome } : {}) },
      orderBy: { rowIndex: "asc" },
      take: 5000,
    });
    res.json({
      kind: run.kind,
      rows: items.map((r) => ({ rowIndex: r.rowIndex, outcome: r.outcome, reason: r.reason, data: r.data })),
    });
  }),
);

researchRouter.get(
  "/ingest/runs",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    // Import history is the USER'S upload log. Scheduled county-scan syncs
    // (automated=true) import through the same pipeline — their records appear
    // everywhere in Research — but the runs themselves stay out of this list.
    const runs = await prisma.researchIngestRun.findMany({
      where: { organizationId: orgId(req), automated: false },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(runs);
  }),
);

const deleteSchema = z.object({
  kind: z.enum(["DOCUMENTS", "PERMITS"]).optional(),
  source: z.string().optional(),
  state: z.string().optional(),
  county: z.string().optional(),
  // Required to wipe the org's ENTIRE research set (no source/state/county
  // filter). Guards against an accidental "delete everything" call.
  confirmDeleteAll: z.boolean().optional(),
});

// Bulk-remove imported research data (e.g. clear a bad import or the sample set).
researchRouter.delete(
  "/data",
  requirePermission("manageResearchData"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { kind, source, state, county, confirmDeleteAll } = deleteSchema.parse(req.body ?? {});
    // No filter at all = delete every research row in the org. Require an
    // explicit confirmation flag so this can't happen by accident.
    if (!source && !state && !county && !confirmDeleteAll) {
      throw new HttpError(400, "Refusing to delete all research data without a source/state/county filter or confirmDeleteAll=true");
    }
    const scope = {
      organizationId: org,
      ...(source ? { source } : {}),
      ...(state ? { state } : {}),
      ...(county ? { county } : {}),
    };
    let documents = 0, permits = 0;
    if (!kind || kind === "DOCUMENTS") documents = (await prisma.researchDocument.deleteMany({ where: scope })).count;
    if (!kind || kind === "PERMITS") permits = (await prisma.researchPermit.deleteMany({ where: scope })).count;
    res.json({ documents, permits });
  }),
);

// Delete one or more imports (ingest runs) AND only the records they created —
// other imports are untouched (records carry ingestRunId). #44.
researchRouter.post(
  "/ingest/runs/delete",
  requirePermission("manageResearchData"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(1000) }).parse(req.body);
    const runs = await prisma.researchIngestRun.findMany({ where: { id: { in: ids }, organizationId: org }, select: { id: true } });
    const runIds = runs.map((r) => r.id);
    if (!runIds.length) return res.json({ runs: 0, documents: 0, permits: 0 });
    const scope = { organizationId: org, ingestRunId: { in: runIds } };
    const [documents, permits] = await prisma.$transaction([
      prisma.researchDocument.deleteMany({ where: scope }),
      prisma.researchPermit.deleteMany({ where: scope }),
    ]);
    await prisma.researchIngestRun.deleteMany({ where: { id: { in: runIds }, organizationId: org } });
    res.json({ runs: runIds.length, documents: documents.count, permits: permits.count });
  }),
);

// Records bulk delete. Deletion is PERMANENT by design: removed records leave
// no hidden state behind, so they can never resurface in duplicate detection
// (the old soft-archive kept invisible rows in the dedupe set — phantom
// "duplicate" reports on re-import).
const bulkSchema = z.object({
  kind: z.enum(["DOCUMENTS", "PERMITS"]),
  ids: z.array(z.string()).min(1).max(5000),
  action: z.literal("delete"),
});
researchRouter.post(
  "/records/bulk",
  requirePermission("manageResearchData"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { kind, ids } = bulkSchema.parse(req.body);
    const where = { id: { in: ids }, organizationId: org };
    const model = kind === "DOCUMENTS" ? prisma.researchDocument : prisma.researchPermit;
    const count = (await (model as typeof prisma.researchDocument).deleteMany({ where })).count;
    res.json({ count });
  }),
);
