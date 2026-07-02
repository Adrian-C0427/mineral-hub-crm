import { Router } from "express";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import type { Prisma, ResearchDocClass, ResearchDocType, ResearchPermitStatus, WellTrajectory } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import {
  autoGranularity, bucketKey, bucketRange, classifyDocType, classifyPermitStatus,
  classifyTrajectory, detectHotspot, historyWindows, normalizeEntity, rollingAverage,
  surgeSeverity, trend, type Trend,
} from "../domain/research.js";
import { fieldsFor, guessMapping, sourceFor } from "../domain/researchSources.js";

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

const DAY = 86400000;

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const arr = (v: unknown): string[] =>
  v == null ? [] : Array.isArray(v) ? v.map(String).filter(Boolean) : [String(v)].filter(Boolean);

/** Parse YYYY-MM-DD (or ISO) as UTC midnight. */
function parseDay(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return isNaN(d.getTime()) ? null : d;
}

interface ResearchFilters {
  state?: string;
  counties: string[];
  docClass?: ResearchDocClass;
  docTypes: string[];
  buyers: string[];   // granteeNorm keys
  sellers: string[];  // grantorNorm keys
  operators: string[]; // operatorNorm keys
  abstractId?: string;
  survey?: string;
  statuses: string[];
  trajectories: string[];
  source?: string;
}

interface Window { from: Date; to: Date } // [from, to] inclusive days

function parseFilters(q: Record<string, unknown>): ResearchFilters {
  return {
    state: q.state ? String(q.state) : undefined,
    counties: arr(q.county),
    docClass: q.docClass === "TRANSACTION" || q.docClass === "LEASE" ? (q.docClass as ResearchDocClass) : undefined,
    docTypes: arr(q.docType),
    buyers: arr(q.buyer),
    sellers: arr(q.seller),
    operators: arr(q.operator),
    abstractId: q.abstractId ? String(q.abstractId) : undefined,
    survey: q.survey ? String(q.survey) : undefined,
    statuses: arr(q.permitStatus),
    trajectories: arr(q.trajectory),
    source: q.source ? String(q.source) : undefined,
  };
}

/** Current window from ?from/&to (defaults to the last 90 days). */
function parseWindow(q: Record<string, unknown>): Window {
  const to = parseDay(q.to as string | undefined) ?? new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const from = parseDay(q.from as string | undefined) ?? new Date(to.getTime() - 89 * DAY);
  return { from, to };
}

/** Optional compare window; defaults to the same-length period immediately before. */
function parseCompare(q: Record<string, unknown>, win: Window): Window {
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
  if (f.state) w.state = f.state;
  if (f.counties.length) w.county = { in: f.counties };
  if (f.docClass) w.docClass = f.docClass;
  if (f.docTypes.length) w.docType = { in: f.docTypes as ResearchDocType[] };
  if (f.buyers.length) w.granteeNorm = { in: f.buyers };
  if (f.sellers.length) w.grantorNorm = { in: f.sellers };
  if (f.abstractId) w.abstractId = f.abstractId;
  if (f.survey) w.survey = { contains: f.survey, mode: "insensitive" };
  if (f.source) w.source = f.source;
  return w;
}

function permitWhere(org: string, f: ResearchFilters, win?: Window): Prisma.ResearchPermitWhereInput {
  const w: Prisma.ResearchPermitWhereInput = { organizationId: org };
  if (win) w.activityDate = { gte: win.from, lt: new Date(win.to.getTime() + DAY) };
  if (f.state) w.state = f.state;
  if (f.counties.length) w.county = { in: f.counties };
  if (f.operators.length) w.operatorNorm = { in: f.operators };
  if (f.abstractId) w.abstractId = f.abstractId;
  if (f.survey) w.survey = { contains: f.survey, mode: "insensitive" };
  if (f.statuses.length) w.status = { in: f.statuses as ResearchPermitStatus[] };
  if (f.trajectories.length) w.trajectory = { in: f.trajectories as WellTrajectory[] };
  if (f.source) w.source = f.source;
  return w;
}

async function loadDocs(org: string, f: ResearchFilters, win: Window): Promise<DocRow[]> {
  return prisma.researchDocument.findMany({
    where: docWhere(org, f, win),
    select: {
      recordingDate: true, docClass: true, docType: true, state: true, county: true,
      abstractId: true, survey: true, grantee: true, granteeNorm: true, grantor: true,
      grantorNorm: true, acreage: true,
    },
  });
}

async function loadPermits(org: string, f: ResearchFilters, win: Window): Promise<PermitRow[]> {
  return prisma.researchPermit.findMany({
    where: permitWhere(org, f, win),
    select: {
      activityDate: true, state: true, county: true, operator: true, operatorNorm: true,
      status: true, trajectory: true, abstractId: true, survey: true,
    },
  });
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
    const [states, counties, docTypes, sources, buyers, sellers, operators, permitSources] = await Promise.all([
      prisma.researchDocument.groupBy({ by: ["state"], where: { organizationId: org } }),
      prisma.researchDocument.groupBy({ by: ["state", "county"], where: { organizationId: org } }),
      prisma.researchDocument.groupBy({ by: ["docType"], where: { organizationId: org } }),
      prisma.researchDocument.groupBy({ by: ["source"], where: { organizationId: org } }),
      prisma.researchDocument.groupBy({
        by: ["granteeNorm", "grantee"], where: { organizationId: org, granteeNorm: { not: null } },
        _count: true, orderBy: { _count: { granteeNorm: "desc" } }, take: 500,
      }),
      prisma.researchDocument.groupBy({
        by: ["grantorNorm", "grantor"], where: { organizationId: org, grantorNorm: { not: null } },
        _count: true, orderBy: { _count: { grantorNorm: "desc" } }, take: 500,
      }),
      prisma.researchPermit.groupBy({
        by: ["operatorNorm", "operator"], where: { organizationId: org },
        _count: true, orderBy: { _count: { operatorNorm: "desc" } }, take: 500,
      }),
      prisma.researchPermit.groupBy({ by: ["state", "county", "source"], where: { organizationId: org } }),
    ]);

    // Merge doc + permit geographies; dedupe entity display names per norm key.
    const stateSet = new Set<string>(states.map((s) => s.state));
    const countySet = new Map<string, { state: string; county: string }>();
    for (const c of counties) countySet.set(`${c.state}|${c.county}`, { state: c.state, county: c.county });
    for (const p of permitSources) {
      stateSet.add(p.state);
      countySet.set(`${p.state}|${p.county}`, { state: p.state, county: p.county });
    }
    const sourceSet = new Set<string>([...sources.map((s) => s.source), ...permitSources.map((p) => p.source)]);

    const entityOptions = (rows: { norm: string | null; raw: string | null }[]) => {
      const seen = new Map<string, string>();
      for (const r of rows) if (r.norm && !seen.has(r.norm)) seen.set(r.norm, r.raw ?? r.norm);
      return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    };

    res.json({
      states: [...stateSet].sort(),
      counties: [...countySet.values()].sort((a, b) => a.county.localeCompare(b.county)),
      docTypes: docTypes.map((d) => d.docType).sort(),
      sources: [...sourceSet].sort(),
      buyers: entityOptions(buyers.map((b) => ({ norm: b.granteeNorm, raw: b.grantee }))),
      sellers: entityOptions(sellers.map((s) => ({ norm: s.grantorNorm, raw: s.grantor }))),
      operators: entityOptions(operators.map((o) => ({ norm: o.operatorNorm, raw: o.operator }))),
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
      uniqueBuyers: new Set(ds.filter((d) => d.docClass === "TRANSACTION" && d.granteeNorm).map((d) => d.granteeNorm)).size,
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

type GeoLevel = "state" | "county" | "abstract" | "survey";

function geoKeyOf(level: GeoLevel, row: { state: string; county: string; abstractId: string | null; survey: string | null }): string | null {
  if (level === "state") return row.state;
  if (level === "county") return `${row.state}|${row.county}`;
  if (level === "abstract") return row.abstractId ? `${row.state}|${row.county}|${row.abstractId}` : null;
  return row.survey ? `${row.state}|${row.county}|${row.survey}` : null;
}

researchRouter.get(
  "/geography",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const level = (["state", "county", "abstract", "survey"] as GeoLevel[]).includes(req.query.level as GeoLevel)
      ? (req.query.level as GeoLevel) : "county";

    // One load spanning the 6 history windows + compare + current.
    const hist = historyWindows(win.from, win.to, 6);
    const span: Window = { from: hist[0].from, to: win.to };
    const [docs, permits] = await Promise.all([loadDocs(org, f, span), loadPermits(org, f, span)]);
    const cmp = hist[hist.length - 1]; // window immediately before = comparison period

    interface GeoAgg {
      state: string; county: string | null; abstractId: string | null; survey: string | null;
      transactions: number; leases: number; permits: number;
      prevTotal: number; history: number[];
    }
    const map = new Map<string, GeoAgg>();
    const get = (key: string, row: { state: string; county: string; abstractId: string | null; survey: string | null }): GeoAgg => {
      let a = map.get(key);
      if (!a) {
        a = {
          state: row.state,
          county: level === "state" ? null : row.county,
          abstractId: level === "abstract" ? row.abstractId : null,
          survey: level === "survey" ? row.survey : null,
          transactions: 0, leases: 0, permits: 0, prevTotal: 0, history: hist.map(() => 0),
        };
        map.set(key, a);
      }
      return a;
    };
    const bump = (row: { state: string; county: string; abstractId: string | null; survey: string | null }, date: Date, kind: "transactions" | "leases" | "permits") => {
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
          state: a.state, county: a.county, abstractId: a.abstractId, survey: a.survey,
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
      const docs = await loadDocs(org, f, span);
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
});

researchRouter.get(
  "/documents",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const f = parseFilters(req.query as Record<string, unknown>);
    const win = parseWindow(req.query as Record<string, unknown>);
    const { page, pageSize } = pageSchema.parse(req.query);
    const where = docWhere(org, f, win);
    const [total, rows] = await Promise.all([
      prisma.researchDocument.count({ where }),
      prisma.researchDocument.findMany({
        where, orderBy: { recordingDate: "desc" }, skip: (page - 1) * pageSize, take: pageSize,
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
    const { page, pageSize } = pageSchema.parse(req.query);
    const where = permitWhere(org, f, win);
    const [total, rows] = await Promise.all([
      prisma.researchPermit.count({ where }),
      prisma.researchPermit.findMany({
        where, orderBy: { activityDate: "desc" }, skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    res.json({ total, page, pageSize, rows });
  }),
);

// ---------------------------------------------------------------------------
// Ingest — CSV imports (Data Type: Deeds / Leases / Drilling Permits)
// ---------------------------------------------------------------------------

/**
 * Import geography defaults. State/county are no longer entered by hand in the
 * import UI: a per-row "County" column (when the file has one) wins, otherwise
 * imports resolve to the platform's current scope — Leon County, Texas. This is
 * the single place to re-scope; multi-county datasets carry their own County
 * column and a state column can be added here the same way.
 */
const DEFAULT_IMPORT_STATE = "TX";
const DEFAULT_IMPORT_COUNTY = "Leon";

type ImportCategory = "deeds" | "leases" | "permits";

/**
 * Map a Data Type to the underlying ingest kind, a provenance tag, and (for
 * recorded documents) the document class the category is scoped to — Deeds keep
 * ownership-transfer instruments, Leases keep leasing instruments.
 */
function resolveCategory(category: ImportCategory): {
  kind: "DOCUMENTS" | "PERMITS"; source: string; docClass?: ResearchDocClass;
} {
  if (category === "permits") return { kind: "PERMITS", source: "csv-permits" };
  return { kind: "DOCUMENTS", source: `csv-${category}`, docClass: category === "deeds" ? "TRANSACTION" : "LEASE" };
}

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

function parseCsv(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Record<string, string>[];
  const headers = records.length ? Object.keys(records[0]) : [];
  return { headers, rows: records };
}

/** Tolerant date parser for public-records exports (MM/DD/YYYY, YYYY-MM-DD, ISO). */
function parseRecordDate(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  const us = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (us) {
    const yr = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    const d = new Date(Date.UTC(yr, Number(us[1]) - 1, Number(us[2])));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  return isNaN(d.getTime()) ? null : d;
}

const analyzeSchema = z.object({
  category: z.enum(["deeds", "leases", "permits"]),
  csv: z.string().min(1),
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
  csv: z.string().min(1),
  mapping: z.record(z.string(), z.string()),
  filename: z.string().optional(),
});

const CHUNK = 500;

researchRouter.post(
  "/ingest/commit",
  requirePermission("manageResearchData"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { category, csv, mapping, filename } = commitSchema.parse(req.body);
    const { kind, source, docClass: wantClass } = resolveCategory(category);
    const state = DEFAULT_IMPORT_STATE;
    const { rows } = parseCsv(csv);
    const get = (row: Record<string, string>, field: string): string => {
      const header = mapping[field];
      return header ? (row[header] ?? "").trim() : "";
    };
    const numOf = (s: string): number | null => {
      const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };

    let imported = 0, skipped = 0, failed = 0;
    const skippedReasons = new Map<string, number>();
    const skip = (reason: string) => { skipped++; skippedReasons.set(reason, (skippedReasons.get(reason) ?? 0) + 1); };

    if (kind === "DOCUMENTS") {
      // Pre-load existing instrument numbers for dedupe (org+state scope).
      const existing = new Set(
        (await prisma.researchDocument.findMany({
          where: { organizationId: org, state, instrumentNumber: { not: null } },
          select: { instrumentNumber: true, county: true },
        })).map((r) => `${r.county}|${r.instrumentNumber}`),
      );
      const batch: Prisma.ResearchDocumentCreateManyInput[] = [];
      for (const row of rows) {
        const docTypeRaw = get(row, "docType");
        const cls = classifyDocType(docTypeRaw);
        if (!cls) { skip(docTypeRaw ? `Not mineral-related: "${docTypeRaw}"` : "Missing document type"); continue; }
        // Scope to the selected Data Type: Deeds keep transfers, Leases keep leases.
        if (wantClass && cls.docClass !== wantClass) {
          skip(cls.docClass === "LEASE" ? "Lease document — import under Leases" : "Deed document — import under Deeds");
          continue;
        }
        const recordingDate = parseRecordDate(get(row, "recordingDate"));
        if (!recordingDate) { failed++; continue; }
        const rowCounty = get(row, "county") || DEFAULT_IMPORT_COUNTY;
        const instrumentNumber = get(row, "instrumentNumber") || null;
        if (instrumentNumber) {
          const dedupeKey = `${rowCounty}|${instrumentNumber}`;
          if (existing.has(dedupeKey)) { skip("Duplicate instrument number"); continue; }
          existing.add(dedupeKey);
        }
        const grantor = get(row, "grantor") || null;
        const grantee = get(row, "grantee") || null;
        batch.push({
          organizationId: org, state, county: rowCounty,
          docTypeRaw, docType: cls.docType, docClass: cls.docClass,
          instrumentNumber, volume: get(row, "volume") || null, page: get(row, "page") || null,
          recordingDate,
          grantor, grantee, grantorNorm: normalizeEntity(grantor), granteeNorm: normalizeEntity(grantee),
          abstractId: get(row, "abstractId") || null, survey: get(row, "survey") || null,
          legalDescription: get(row, "legalDescription") || null,
          source,
        });
      }
      for (let i = 0; i < batch.length; i += CHUNK) {
        const r = await prisma.researchDocument.createMany({ data: batch.slice(i, i + CHUNK) });
        imported += r.count;
      }
    } else {
      const existing = new Set(
        (await prisma.researchPermit.findMany({
          where: { organizationId: org, state },
          select: { apiNumber: true, permitNumber: true, county: true },
        })).map((r) => `${r.county}|${r.apiNumber ?? ""}|${r.permitNumber ?? ""}`),
      );
      const batch: Prisma.ResearchPermitCreateManyInput[] = [];
      for (const row of rows) {
        const operator = get(row, "operator");
        if (!operator) { failed++; continue; }
        const rowCounty = get(row, "county") || DEFAULT_IMPORT_COUNTY;
        const filedDate = parseRecordDate(get(row, "filedDate"));
        const approvedDate = parseRecordDate(get(row, "approvedDate"));
        const spudDate = parseRecordDate(get(row, "spudDate"));
        const completionDate = parseRecordDate(get(row, "completionDate"));
        const activityDate = filedDate ?? approvedDate ?? spudDate ?? completionDate;
        if (!activityDate) { failed++; continue; }
        const apiNumber = get(row, "apiNumber") || null;
        const permitNumber = get(row, "permitNumber") || null;
        if (apiNumber || permitNumber) {
          const key = `${rowCounty}|${apiNumber ?? ""}|${permitNumber ?? ""}`;
          if (existing.has(key)) { skip("Duplicate API/permit number"); continue; }
          existing.add(key);
        }
        batch.push({
          organizationId: org, state, county: rowCounty,
          apiNumber, permitNumber, operator, operatorNorm: normalizeEntity(operator) ?? operator.toUpperCase(),
          leaseName: get(row, "leaseName") || null, wellName: get(row, "wellName") || null,
          status: classifyPermitStatus(get(row, "status")), trajectory: classifyTrajectory(get(row, "trajectory")),
          activityDate, filedDate, approvedDate, spudDate, completionDate,
          formation: get(row, "formation") || null, field: get(row, "field") || null,
          totalDepth: numOf(get(row, "totalDepth")),
          abstractId: get(row, "abstractId") || null, survey: get(row, "survey") || null,
          latitude: numOf(get(row, "latitude")), longitude: numOf(get(row, "longitude")),
          source,
        });
      }
      for (let i = 0; i < batch.length; i += CHUNK) {
        const r = await prisma.researchPermit.createMany({ data: batch.slice(i, i + CHUNK) });
        imported += r.count;
      }
    }

    const run = await prisma.researchIngestRun.create({
      data: {
        organizationId: org, kind, source, state, county: DEFAULT_IMPORT_COUNTY, filename: filename ?? null,
        rowsTotal: rows.length, rowsImported: imported, rowsSkipped: skipped, rowsFailed: failed,
        status: "COMPLETED", createdByUserId: req.user!.id,
      },
    });

    res.json({
      runId: run.id,
      rowsTotal: rows.length,
      imported, skipped, failed,
      skippedReasons: [...skippedReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    });
  }),
);

researchRouter.get(
  "/ingest/runs",
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const runs = await prisma.researchIngestRun.findMany({
      where: { organizationId: orgId(req) },
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
});

// Bulk-remove imported research data (e.g. clear a bad import or the sample set).
researchRouter.delete(
  "/data",
  requirePermission("manageResearchData"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { kind, source, state, county } = deleteSchema.parse(req.body ?? {});
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
