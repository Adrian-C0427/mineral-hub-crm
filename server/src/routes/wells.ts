import { Router } from "express";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import type { Prisma, WellStatus, WellTrajectory } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { normalizeAssumptions, runValuation, type MonthVolumes } from "../domain/valuation.js";
import { monthKey } from "../domain/dates.js";

/**
 * Well Production Analysis & Valuation API.
 *
 * Wells + monthly production are org-scoped reference data (imported via CSV
 * or entered manually). Analyses are run ONLY on demand — POST /analyze is the
 * single compute entry point, so nothing heavy ever runs from map interactions.
 * Saved analyses snapshot both assumptions and results so past runs stay
 * stable as new production months arrive.
 */
export const wellsRouter = Router();
wellsRouter.use(requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// Month helpers ("YYYY-MM" ⇄ first-of-month UTC DateTime)
// ---------------------------------------------------------------------------

const ymToDate = (ym: string): Date => new Date(`${ym}-01T00:00:00Z`);
const dateToYm = monthKey;

/** Tolerant month parser: YYYY-MM, YYYY-MM-DD, MM/YYYY, MM/DD/YYYY, "Jan 2024". */
function parseMonth(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (m) {
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? `${m[1]}-${String(mo).padStart(2, "0")}` : null;
  }
  m = t.match(/^(\d{1,2})[\/\-](?:(\d{1,2})[\/\-])?(\d{4})$/); // MM/YYYY or MM/DD/YYYY
  if (m) {
    const mo = Number(m[1]);
    return mo >= 1 && mo <= 12 ? `${m[3]}-${String(mo).padStart(2, "0")}` : null;
  }
  const d = new Date(t);
  if (!isNaN(d.getTime())) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return null;
}

const numOf = (s: string): number | null => {
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const WELL_STATUSES = ["PRODUCING", "SHUT_IN", "PLUGGED", "INACTIVE", "UNKNOWN"] as const;

function classifyWellStatus(s: string): WellStatus {
  const t = s.trim().toUpperCase();
  if (!t) return "UNKNOWN";
  if (/(PLUG|P&A|ABANDON)/.test(t)) return "PLUGGED";
  if (/(SHUT|SI)/.test(t)) return "SHUT_IN";
  if (/(INACT|IDLE|TA\b)/.test(t)) return "INACTIVE";
  if (/(PRODUC|ACTIVE|FLOW)/.test(t)) return "PRODUCING";
  return "UNKNOWN";
}

function classifyTrajectory(s: string): WellTrajectory {
  const t = s.trim().toUpperCase();
  if (t.startsWith("H")) return "HORIZONTAL";
  if (t.startsWith("V")) return "VERTICAL";
  if (t.startsWith("D")) return "DIRECTIONAL";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

interface WellSummary {
  firstMonth: string | null;
  lastMonth: string | null;
  months: number;
  cumOilBbl: number;
  cumGasMcf: number;
  cumNglBbl: number;
}

function serializeWell(w: {
  id: string; apiNumber: string | null; name: string; operator: string | null; leaseName: string | null;
  fieldName: string | null; formation: string | null; state: string; county: string; status: WellStatus;
  trajectory: WellTrajectory; wellType: string | null; spudDate: Date | null; firstProdDate: Date | null;
  abstractId: string | null; survey: string | null; latitude: number | null; longitude: number | null;
  source: string; createdAt: Date;
}, summary?: WellSummary) {
  return {
    id: w.id,
    apiNumber: w.apiNumber,
    name: w.name,
    operator: w.operator,
    leaseName: w.leaseName,
    fieldName: w.fieldName,
    formation: w.formation,
    state: w.state,
    county: w.county,
    status: w.status,
    trajectory: w.trajectory,
    wellType: w.wellType,
    spudDate: w.spudDate?.toISOString() ?? null,
    firstProdDate: w.firstProdDate?.toISOString() ?? null,
    abstractId: w.abstractId,
    survey: w.survey,
    latitude: w.latitude,
    longitude: w.longitude,
    source: w.source,
    createdAt: w.createdAt.toISOString(),
    production: summary ?? null,
  };
}

// ---------------------------------------------------------------------------
// Production is read LIVE from the centralized well database — never copied.
//
// A well imported from the B5 pipeline (source "rrc") carries a `sourceRef`
// (the rrc.wells fid). Its production comes straight from rrc.production at
// read time, so the Map, Well Analysis, Research and any future module all see
// the same rows and a subsequent B5 import is reflected instantly with no sync
// step. Manually entered / CSV-imported wells keep using WellProductionMonth.
// ---------------------------------------------------------------------------

const ymStr = (ym: number): string => `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, "0")}`;

type ProdWell = { id: string; source: string; sourceRef: string | null; apiNumber: string | null };

/**
 * Live lease-allocated production for a set of rrc-linked wells, keyed by
 * well id. Texas reports at the lease level, so a lease's series is split
 * evenly across the lease's wells (identical allocation to the map heat
 * layer). One round-trip resolves every well's lease; a second pulls all the
 * production rows.
 */
async function rrcVolumesByWell(wells: ProdWell[]): Promise<Map<string, MonthVolumes[]>> {
  const out = new Map<string, MonthVolumes[]>();
  const rrc = wells.filter((w) => w.source === "rrc" && (w.sourceRef || w.apiNumber));
  if (!rrc.length) return out;

  // Resolve each well's rrc lease (lease_no/district/oil_gas) by fid or API.
  const fids = rrc.map((w) => w.sourceRef).filter(Boolean) as string[];
  const apis = rrc.filter((w) => !w.sourceRef && w.apiNumber).map((w) => (w.apiNumber ?? "").replace(/\D/g, ""));
  const leaseRows = await prisma.$queryRawUnsafe<{ fid: number; api8: string | null; api10: string | null; lease_no: string | null; district: string | null; oil_gas: string | null }[]>(
    `SELECT fid, api8, api10, lease_no, district, oil_gas FROM rrc.wells
      WHERE fid = ANY($1::int[]) OR api8 = ANY($2::text[]) OR api10 = ANY($2::text[])`,
    fids.map(Number), apis,
  );

  // Distinct (og,district,lease) tuples → one production query for all.
  const leaseKey = (og: string, d: string, l: string) => `${og}|${d}|${l}`;
  const leases = new Map<string, { og: string; district: string; leaseNo: string }>();
  const wellLease = new Map<string, string>(); // well.id → leaseKey
  const shareOf = new Map<string, number>();    // leaseKey → sibling count (oil only)

  for (const w of rrc) {
    const row = w.sourceRef
      ? leaseRows.find((r) => String(r.fid) === w.sourceRef)
      : leaseRows.find((r) => r.api8 === (w.apiNumber ?? "").replace(/\D/g, "") || r.api10 === (w.apiNumber ?? "").replace(/\D/g, ""));
    if (!row?.lease_no || !row.district) continue;
    const og = row.oil_gas === "Gas" ? "G" : "O";
    const key = leaseKey(og, row.district, row.lease_no);
    leases.set(key, { og, district: row.district, leaseNo: row.lease_no });
    wellLease.set(w.id, key);
  }
  if (!leases.size) return out;

  const leaseList = [...leases.values()];
  const [prodRows, siblingRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ og: string; district: string; lease_no: string; ym: number; oil: number; gas: number }[]>(
      `SELECT og_code AS og, district, lease_no, cycle_ym AS ym,
              sum(oil_bbl + cond_bbl)::float AS oil, sum(gas_mcf + csgd_mcf)::float AS gas
         FROM rrc.production
        WHERE (og_code, district, lease_no) IN (${leaseList.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(",")})
        GROUP BY og_code, district, lease_no, cycle_ym ORDER BY cycle_ym`,
      ...leaseList.flatMap((l) => [l.og, l.district, l.leaseNo]),
    ),
    // Oil leases split among their wells; gas leases are per-well (share = 1).
    prisma.$queryRawUnsafe<{ district: string; lease_no: string; oil_gas: string; n: bigint }[]>(
      `SELECT district, lease_no, oil_gas, count(*)::bigint AS n FROM rrc.wells
        WHERE (district, lease_no) IN (${leaseList.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(",")})
        GROUP BY district, lease_no, oil_gas`,
      ...leaseList.flatMap((l) => [l.district, l.leaseNo]),
    ),
  ]);
  for (const l of leaseList) {
    const sib = siblingRows.find((s) => s.district === l.district && s.lease_no === l.leaseNo && (s.oil_gas === "Gas") === (l.og === "G"));
    shareOf.set(leaseKey(l.og, l.district, l.leaseNo), l.og === "G" ? 1 : Math.max(1, Number(sib?.n ?? 1n)));
  }

  // Group production rows by leaseKey.
  const byLease = new Map<string, MonthVolumes[]>();
  for (const r of prodRows) {
    const key = leaseKey(r.og, r.district, r.lease_no);
    const share = shareOf.get(key) ?? 1;
    (byLease.get(key) ?? byLease.set(key, []).get(key)!).push({
      month: ymStr(r.ym), oilBbl: r.oil / share, gasMcf: r.gas / share, nglBbl: 0, waterBbl: 0,
    });
  }
  for (const [wellId, key] of wellLease) out.set(wellId, byLease.get(key) ?? []);
  return out;
}

function summaryOf(volumes: MonthVolumes[]): WellSummary {
  if (!volumes.length) return { firstMonth: null, lastMonth: null, months: 0, cumOilBbl: 0, cumGasMcf: 0, cumNglBbl: 0 };
  const months = volumes.map((v) => v.month).sort();
  return {
    firstMonth: months[0], lastMonth: months[months.length - 1], months: volumes.length,
    cumOilBbl: volumes.reduce((s, v) => s + v.oilBbl, 0),
    cumGasMcf: volumes.reduce((s, v) => s + v.gasMcf, 0),
    cumNglBbl: volumes.reduce((s, v) => s + v.nglBbl, 0),
  };
}

async function productionSummaries(wellIds: string[]): Promise<Map<string, WellSummary>> {
  if (!wellIds.length) return new Map();
  const wells = await prisma.researchWell.findMany({ where: { id: { in: wellIds } }, select: { id: true, source: true, sourceRef: true, apiNumber: true } });
  const rrcVols = await rrcVolumesByWell(wells);
  // Manual / CSV production (everything that isn't an rrc live read).
  const groups = await prisma.wellProductionMonth.groupBy({
    by: ["wellId"],
    where: { wellId: { in: wellIds }, NOT: { source: "rrc" } },
    _min: { month: true }, _max: { month: true }, _count: true,
    _sum: { oilBbl: true, gasMcf: true, nglBbl: true },
  });
  const manual = new Map(groups.map((g) => [g.wellId, g]));

  const result = new Map<string, WellSummary>();
  for (const w of wells) {
    const live = rrcVols.get(w.id);
    if (live && live.length) { result.set(w.id, summaryOf(live)); continue; }
    const g = manual.get(w.id);
    if (g) result.set(w.id, {
      firstMonth: g._min.month ? dateToYm(g._min.month) : null,
      lastMonth: g._max.month ? dateToYm(g._max.month) : null,
      months: g._count, cumOilBbl: g._sum.oilBbl ?? 0, cumGasMcf: g._sum.gasMcf ?? 0, cumNglBbl: g._sum.nglBbl ?? 0,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Wells: search / list / CRUD
// ---------------------------------------------------------------------------

/**
 * Free-text well search across every indexed attribute stored on the well.
 * Partial, case-insensitive matches on all text columns (name, identifiers,
 * operator, lease/field/formation, geography, survey/abstract, well type),
 * plus enum matching so terms like "horizontal" or "shut in" hit the
 * trajectory/status columns. Returns an OR array for the Prisma `where`.
 */
function buildWellSearch(q: string): Prisma.ResearchWellWhereInput[] {
  const like = { contains: q, mode: "insensitive" as const };
  const or: Prisma.ResearchWellWhereInput[] = [
    { name: like },
    { apiNumber: like },
    { operator: like },
    { leaseName: like },
    { fieldName: like },
    { formation: like },
    { county: like },
    { state: like },
    { survey: like },
    { abstractId: like },
    { wellType: like },
  ];
  const term = q.trim().toUpperCase().replace(/[\s_-]+/g, "");
  if (term) {
    const statuses = WELL_STATUSES.filter((s) => s.replace(/_/g, "").includes(term));
    if (statuses.length) or.push({ status: { in: statuses as WellStatus[] } });
    const trajectories = (["VERTICAL", "HORIZONTAL", "DIRECTIONAL", "UNKNOWN"] as const).filter((t) => t.includes(term));
    if (trajectories.length) or.push({ trajectory: { in: trajectories as WellTrajectory[] } });
  }
  return or;
}

const listSchema = z.object({
  q: z.string().optional(),
  ids: z.string().optional(), // comma-separated (rehydrating saved analyses)
  state: z.string().optional(),
  county: z.string().optional(),
  operator: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

wellsRouter.get(
  "/",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { q, ids, state, county, operator, page, pageSize } = listSchema.parse(req.query);
    const where: Prisma.ResearchWellWhereInput = { organizationId: orgId(req) };
    if (ids) where.id = { in: ids.split(",").filter(Boolean).slice(0, 100) };
    if (state) where.state = state;
    if (county) where.county = county;
    if (operator) where.operator = { contains: operator, mode: "insensitive" };
    if (q) where.OR = buildWellSearch(q);
    const [total, rows] = await Promise.all([
      prisma.researchWell.count({ where }),
      prisma.researchWell.findMany({ where, orderBy: [{ name: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    const summaries = await productionSummaries(rows.map((r) => r.id));
    res.json({ total, page, pageSize, rows: rows.map((w) => serializeWell(w, summaries.get(w.id))) });
  }),
);

wellsRouter.get(
  "/filters",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const [geo, operators] = await Promise.all([
      prisma.researchWell.groupBy({ by: ["state", "county"], where: { organizationId: org } }),
      prisma.researchWell.groupBy({ by: ["operator"], where: { organizationId: org, operator: { not: null } }, _count: true, orderBy: { _count: { operator: "desc" } }, take: 200 }),
    ]);
    res.json({
      states: [...new Set(geo.map((g) => g.state))].sort(),
      counties: geo.map((g) => ({ state: g.state, county: g.county })).sort((a, b) => a.county.localeCompare(b.county)),
      operators: operators.map((o) => o.operator).filter(Boolean),
    });
  }),
);

// ---------------------------------------------------------------------------
// RRC bridge — every well imported through the B5/GIS pipeline (rrc.wells +
// rrc.production) is available in Well Analysis automatically. Search runs
// live against the rrc schema; opening a well upserts it as a ResearchWell
// (source "rrc") and re-syncs its production ON EVERY OPEN, so a subsequent
// B5 import is reflected immediately with no manual synchronization step.
// ---------------------------------------------------------------------------

interface RrcWellRow {
  fid: number; api8: string | null; api10: string | null; well_no: string | null;
  lease_no: string | null; lease_name: string | null; operator: string | null;
  county: string; district: string | null; oil_gas: string | null; type: string | null;
  status: string | null; field_name: string | null; formations: string[] | null;
  spud_date: Date | null; abstract: string | null; survey: string | null;
  lon: number | null; lat: number | null;
}

wellsRouter.get(
  "/rrc-search",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(120) }).parse(req.query);
    const rows = await prisma.$queryRawUnsafe<(RrcWellRow & { has_prod: boolean })[]>(
      `SELECT w.fid, w.api8, w.api10, w.well_no, w.lease_no, w.lease_name, w.operator, w.county,
              w.district, w.oil_gas, w.type, w.status,
              EXISTS (SELECT 1 FROM rrc.production p
                       WHERE p.lease_no = w.lease_no AND p.district = w.district
                         AND p.og_code = CASE WHEN w.oil_gas = 'Gas' THEN 'G' ELSE 'O' END) AS has_prod
         FROM rrc.wells w
        WHERE w.api8 LIKE '%' || $1 || '%' OR w.api10 LIKE '%' || $1 || '%'
           OR w.lease_name ILIKE '%' || $1 || '%' OR w.operator ILIKE '%' || $1 || '%'
        ORDER BY has_prod DESC, similarity(coalesce(w.lease_name, ''), $1) DESC, w.county
        LIMIT 15`,
      q,
    );
    res.json(rows.map((w) => ({
      fid: w.fid, api: w.api10 ?? w.api8, name: `${w.lease_name ?? "Well"}${w.well_no ? ` #${w.well_no}` : ""}`,
      operator: w.operator, county: w.county, type: w.type, status: w.status, hasProduction: w.has_prod,
    })));
  }),
);

wellsRouter.post(
  "/import-rrc",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z.object({ fid: z.number().int().optional(), api: z.string().trim().max(20).optional() })
      .refine((b) => b.fid !== undefined || b.api, "fid or api required").parse(req.body);
    const org = orgId(req);
    const rows = await prisma.$queryRawUnsafe<RrcWellRow[]>(
      `SELECT fid, api8, api10, well_no, lease_no, lease_name, operator, county, district, oil_gas,
              type, status, field_name, formations, spud_date, abstract, survey,
              ST_X(geom) AS lon, ST_Y(geom) AS lat
         FROM rrc.wells WHERE ${body.fid !== undefined ? "fid = $1" : "(api8 = $1 OR api10 = $1)"} LIMIT 1`,
      body.fid !== undefined ? body.fid : body.api!.replace(/-/g, ""),
    );
    const w = rows[0];
    if (!w) return res.status(404).json({ error: "Well not found in the imported RRC data" });

    const api = w.api10 ?? w.api8;
    const name = `${w.lease_name ?? "WELL"}${w.well_no ? ` #${w.well_no}` : ""}`.toUpperCase();
    const data = {
      name,
      operator: w.operator,
      leaseName: w.lease_name,
      fieldName: w.field_name,
      formation: w.formations?.[0] ?? null,
      state: "TX",
      county: w.county,
      status: classifyWellStatus(w.status ?? ""),
      trajectory: classifyTrajectory(/HORIZ|\dH\b/i.test(`${w.type ?? ""} ${w.well_no ?? ""}`) ? "H" : ""),
      wellType: w.oil_gas ?? w.type,
      spudDate: w.spud_date,
      abstractId: w.abstract,
      survey: w.survey,
      latitude: w.lat,
      longitude: w.lon,
      source: "rrc",
      sourceRef: String(w.fid),
    };
    const existing = await prisma.researchWell.findFirst({
      where: { organizationId: org, OR: [{ source: "rrc", sourceRef: String(w.fid) }, ...(api ? [{ apiNumber: api }] : [])] },
    });
    const well = existing
      ? await prisma.researchWell.update({ where: { id: existing.id }, data })
      : await prisma.researchWell.create({ data: { ...data, organizationId: org, apiNumber: api } });

    // Production is NOT copied — it's read live from rrc.production wherever it's
    // needed (single source of truth). Purge any stale copies from earlier
    // versions so nothing is double-counted, and stamp firstProdDate from the
    // live series for the well card.
    await prisma.wellProductionMonth.deleteMany({ where: { wellId: well.id, source: "rrc" } });
    const liveVols = (await rrcVolumesByWell([{ id: well.id, source: "rrc", sourceRef: String(w.fid), apiNumber: api }])).get(well.id) ?? [];
    const synced = liveVols.length;
    if (synced && !well.firstProdDate) {
      const first = liveVols.map((v) => v.month).sort()[0];
      await prisma.researchWell.update({ where: { id: well.id }, data: { firstProdDate: ymToDate(first) } });
    }

    // Permit history rides along so the workspace can show it without a
    // second lookup (rrc.permits is keyed by 8-digit state API).
    const permits = w.api8
      ? await prisma.$queryRawUnsafe<{ statusNo: string; permitDate: Date | null; operator: string | null; leaseName: string | null; wellNo: string | null }[]>(
          `SELECT status_no AS "statusNo", permit_date AS "permitDate", operator, lease_name AS "leaseName", well_no AS "wellNo"
             FROM rrc.permits WHERE api8 = $1 ORDER BY permit_date DESC NULLS LAST LIMIT 10`, w.api8)
      : [];

    const summaries = await productionSummaries([well.id]);
    const fresh = await prisma.researchWell.findUniqueOrThrow({ where: { id: well.id } });
    res.json({ well: serializeWell(fresh, summaries.get(well.id)), monthsSynced: synced, permits });
  }),
);

// Permit history for an analysis well (live from rrc.permits, keyed by the
// 8-digit state API — apiNumber may carry the "42" prefix).
wellsRouter.get(
  "/:id/permits",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const well = await prisma.researchWell.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, select: { apiNumber: true } });
    if (!well?.apiNumber) return res.json([]);
    const api8 = well.apiNumber.replace(/\D/g, "").replace(/^42/, "").slice(0, 8);
    if (api8.length < 8) return res.json([]);
    const permits = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT status_no AS "statusNo", permit_date AS "permitDate", operator, lease_name AS "leaseName", well_no AS "wellNo"
         FROM rrc.permits WHERE api8 = $1 ORDER BY permit_date DESC NULLS LAST LIMIT 10`, api8);
    res.json(permits);
  }),
);

const wellBodySchema = z.object({
  apiNumber: z.string().trim().max(20).optional().nullable(),
  name: z.string().trim().min(1).max(200),
  operator: z.string().trim().max(200).optional().nullable(),
  leaseName: z.string().trim().max(200).optional().nullable(),
  fieldName: z.string().trim().max(200).optional().nullable(),
  formation: z.string().trim().max(200).optional().nullable(),
  state: z.string().trim().length(2).transform((s) => s.toUpperCase()),
  county: z.string().trim().min(1).max(100),
  status: z.enum(WELL_STATUSES).optional(),
  trajectory: z.enum(["VERTICAL", "HORIZONTAL", "DIRECTIONAL", "UNKNOWN"]).optional(),
  wellType: z.string().trim().max(40).optional().nullable(),
  abstractId: z.string().trim().max(40).optional().nullable(),
  survey: z.string().trim().max(200).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
});

wellsRouter.post(
  "/",
  requirePermission("manageWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = wellBodySchema.parse(req.body);
    const well = await prisma.researchWell.create({
      data: { ...body, apiNumber: body.apiNumber || null, organizationId: orgId(req), source: "manual" },
    });
    res.status(201).json(serializeWell(well));
  }),
);

wellsRouter.patch(
  "/:id",
  requirePermission("manageWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = wellBodySchema.partial().parse(req.body);
    const existing = await prisma.researchWell.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) { res.status(404).json({ error: "Well not found" }); return; }
    const well = await prisma.researchWell.update({ where: { id: existing.id }, data: body });
    res.json(serializeWell(well));
  }),
);

wellsRouter.delete(
  "/:id",
  requirePermission("manageWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const existing = await prisma.researchWell.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) { res.status(404).json({ error: "Well not found" }); return; }
    await prisma.researchWell.delete({ where: { id: existing.id } }); // production cascades
    res.status(204).end();
  }),
);

wellsRouter.get(
  "/:id/production",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const well = await prisma.researchWell.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!well) { res.status(404).json({ error: "Well not found" }); return; }
    const rows = await prisma.wellProductionMonth.findMany({ where: { wellId: well.id }, orderBy: { month: "asc" } });
    res.json({
      well: serializeWell(well),
      months: rows.map((r) => ({
        month: dateToYm(r.month), oilBbl: r.oilBbl, gasMcf: r.gasMcf, nglBbl: r.nglBbl,
        waterBbl: r.waterBbl, daysOn: r.daysOn,
      })),
    });
  }),
);

// ---------------------------------------------------------------------------
// Analysis — the on-demand compute entry point
// ---------------------------------------------------------------------------

/**
 * Assumption payload is intentionally permissive (partial, unknown keys
 * stripped); normalizeAssumptions applies defaults and clamps ranges.
 */
const assumptionsSchema = z
  .object({
    oilPrice: z.number().min(0).max(1000),
    gasPrice: z.number().min(0).max(100),
    nglPrice: z.number().min(0).max(500),
    priceEscalationPct: z.number().min(-20).max(20),
    nri: z.number().min(0).max(1),
    workingInterest: z.number().min(0).max(1),
    opexPerMonth: z.number().min(0).max(10_000_000),
    opexEscalationPct: z.number().min(-20).max(20),
    sevTaxOilPct: z.number().min(0).max(50),
    sevTaxGasPct: z.number().min(0).max(50),
    adValoremPct: z.number().min(0).max(50),
    askingPrice: z.number().min(0).max(1e12),
    closingCosts: z.number().min(0).max(1e12),
    discountRatePct: z.number().min(0).max(100),
    targetRoiPct: z.number().min(-99).max(10_000).nullable(),
    targetProfitMarginPct: z.number().min(0).max(99).nullable(),
    targetProfitAmount: z.number().min(0).max(1e12).nullable(),
    resalePrice: z.number().min(0).max(1e12).nullable(),
    maxForecastMonths: z.number().int().min(12).max(720),
    economicLimitNetCashFlow: z.number().min(0).max(1_000_000),
    declineOverride: z
      .object({
        oil: z.object({ b: z.number().min(0).max(2).optional(), diAnnual: z.number().min(0.01).max(5).optional() }).optional(),
        gas: z.object({ b: z.number().min(0).max(2).optional(), diAnnual: z.number().min(0.01).max(5).optional() }).optional(),
      })
      .nullable(),
  })
  .partial();

const analyzeSchema = z.object({
  wellIds: z.array(z.string().min(1)).min(1).max(50),
  assumptions: assumptionsSchema.optional(),
});

async function loadMergedProduction(org: string, wellIds: string[]) {
  const wells = await prisma.researchWell.findMany({ where: { id: { in: wellIds }, organizationId: org } });
  if (wells.length !== wellIds.length) return null;
  // Live production from the centralized rrc dataset (single source of truth)…
  const rrcVols = await rrcVolumesByWell(wells);
  // …plus any manually entered / CSV production (never double-counted with rrc).
  const rows = await prisma.wellProductionMonth.findMany({
    where: { wellId: { in: wells.map((w) => w.id) }, NOT: { source: "rrc" } },
    orderBy: { month: "asc" },
  });
  const volumes: MonthVolumes[] = [
    ...[...rrcVols.values()].flat(),
    ...rows.map((r) => ({ month: dateToYm(r.month), oilBbl: r.oilBbl, gasMcf: r.gasMcf, nglBbl: r.nglBbl, waterBbl: r.waterBbl })),
  ];
  return { wells, volumes };
}

wellsRouter.post(
  "/analyze",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { wellIds, assumptions } = analyzeSchema.parse(req.body);
    const loaded = await loadMergedProduction(orgId(req), wellIds);
    if (!loaded) { res.status(404).json({ error: "One or more wells were not found" }); return; }
    const result = runValuation(loaded.volumes, assumptions);
    const summaries = await productionSummaries(loaded.wells.map((w) => w.id));
    res.json({ wells: loaded.wells.map((w) => serializeWell(w, summaries.get(w.id))), result });
  }),
);

/** Default assumptions (for the client to pre-fill the form). */
wellsRouter.get(
  "/assumptions/defaults",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (_req, res) => {
    res.json(normalizeAssumptions({}));
  }),
);

// ---------------------------------------------------------------------------
// Saved analyses
// ---------------------------------------------------------------------------

const analysisBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  wellIds: z.array(z.string().min(1)).min(1).max(50),
  assumptions: assumptionsSchema,
  results: z.unknown().optional(),
  notes: z.string().trim().max(5000).optional().nullable(),
});

wellsRouter.get(
  "/analyses",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.wellAnalysis.findMany({
      where: { organizationId: orgId(req) },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    // Resolve well names for the list without shipping full result payloads.
    const allWellIds = [...new Set(rows.flatMap((r) => r.wellIds))];
    const wells = allWellIds.length
      ? await prisma.researchWell.findMany({ where: { id: { in: allWellIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(wells.map((w) => [w.id, w.name]));
    res.json(
      rows.map((r) => {
        const results = r.results as { valuation?: { recommendedOffer?: number; fairMarketValue?: number }; economics?: { npv?: number; irrAnnualPct?: number | null; roiPct?: number | null } } | null;
        return {
          id: r.id,
          name: r.name,
          wellIds: r.wellIds,
          wellNames: r.wellIds.map((id) => nameOf.get(id) ?? "(deleted well)"),
          notes: r.notes,
          updatedAt: r.updatedAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
          headline: results
            ? {
                fairMarketValue: results.valuation?.fairMarketValue ?? null,
                recommendedOffer: results.valuation?.recommendedOffer ?? null,
                npv: results.economics?.npv ?? null,
                irrAnnualPct: results.economics?.irrAnnualPct ?? null,
                roiPct: results.economics?.roiPct ?? null,
              }
            : null,
        };
      }),
    );
  }),
);

wellsRouter.post(
  "/analyses",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = analysisBodySchema.parse(req.body);
    const row = await prisma.wellAnalysis.create({
      data: {
        organizationId: orgId(req),
        name: body.name,
        wellIds: body.wellIds,
        assumptions: body.assumptions as Prisma.InputJsonValue,
        results: (body.results ?? undefined) as Prisma.InputJsonValue | undefined,
        notes: body.notes ?? null,
        createdByUserId: req.user!.id,
      },
    });
    res.status(201).json({ id: row.id });
  }),
);

wellsRouter.get(
  "/analyses/:id",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const row = await prisma.wellAnalysis.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!row) { res.status(404).json({ error: "Analysis not found" }); return; }
    res.json({
      id: row.id,
      name: row.name,
      wellIds: row.wellIds,
      assumptions: row.assumptions,
      results: row.results,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }),
);

wellsRouter.patch(
  "/analyses/:id",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = analysisBodySchema.partial().parse(req.body);
    const existing = await prisma.wellAnalysis.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) { res.status(404).json({ error: "Analysis not found" }); return; }
    const row = await prisma.wellAnalysis.update({
      where: { id: existing.id },
      data: {
        ...(body.name != null ? { name: body.name } : {}),
        ...(body.wellIds != null ? { wellIds: body.wellIds } : {}),
        ...(body.assumptions != null ? { assumptions: body.assumptions as Prisma.InputJsonValue } : {}),
        ...(body.results !== undefined ? { results: body.results as Prisma.InputJsonValue } : {}),
        ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
      },
    });
    res.json({ id: row.id, updatedAt: row.updatedAt.toISOString() });
  }),
);

wellsRouter.delete(
  "/analyses/:id",
  requirePermission("viewWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const existing = await prisma.wellAnalysis.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) { res.status(404).json({ error: "Analysis not found" }); return; }
    await prisma.wellAnalysis.delete({ where: { id: existing.id } });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Production CSV import (analyze → commit, mirroring the research ingest UX)
// ---------------------------------------------------------------------------

/** Importable fields; one row = one well-month. Wells are auto-created. */
const IMPORT_FIELDS = [
  { key: "apiNumber", label: "API Number", required: false, hint: "Primary well identity when present" },
  { key: "wellName", label: "Well Name", required: true, hint: "Used to create/match wells when API is missing" },
  { key: "operator", label: "Operator", required: false },
  { key: "leaseName", label: "Lease Name", required: false },
  { key: "county", label: "County", required: false, hint: "Falls back to the county chosen above" },
  { key: "month", label: "Production Month", required: true, hint: "YYYY-MM, MM/YYYY or any full date" },
  { key: "oilBbl", label: "Oil (bbl)", required: false },
  { key: "gasMcf", label: "Gas (mcf)", required: false },
  { key: "nglBbl", label: "NGL (bbl)", required: false },
  { key: "waterBbl", label: "Water (bbl)", required: false },
  { key: "daysOn", label: "Days Producing", required: false },
  { key: "status", label: "Well Status", required: false },
  { key: "trajectory", label: "Trajectory", required: false },
  { key: "fieldName", label: "Field", required: false },
  { key: "formation", label: "Formation", required: false },
  { key: "latitude", label: "Latitude", required: false },
  { key: "longitude", label: "Longitude", required: false },
] as const;

type ImportField = (typeof IMPORT_FIELDS)[number]["key"];

/** Header keyword → field guesses for the mapping UI. */
const HEADER_GUESSES: [RegExp, ImportField][] = [
  [/api/i, "apiNumber"],
  [/well.*name|name.*well|^well$|lease.*well/i, "wellName"],
  [/operator|company/i, "operator"],
  [/lease(?!.*well)/i, "leaseName"],
  [/county/i, "county"],
  [/month|date|period/i, "month"],
  [/oil|liquid|bbl(?!.*water)/i, "oilBbl"],
  [/gas|mcf/i, "gasMcf"],
  [/ngl|condensate/i, "nglBbl"],
  [/water|bwpd/i, "waterBbl"],
  [/days/i, "daysOn"],
  [/status/i, "status"],
  [/traj|drill.*type|hor|vert/i, "trajectory"],
  [/field/i, "fieldName"],
  [/formation|reservoir/i, "formation"],
  [/lat/i, "latitude"],
  [/lon|lng/i, "longitude"],
];

function guessImportMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const h of headers) {
    for (const [re, field] of HEADER_GUESSES) {
      if (re.test(h) && !Object.values(mapping).includes(h) && !mapping[field]) {
        mapping[field] = h;
        break;
      }
    }
  }
  return mapping;
}

function parseCsv(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Record<string, string>[];
  const headers = records.length ? Object.keys(records[0]) : [];
  return { headers, rows: records };
}

const importAnalyzeSchema = z.object({ csv: z.string().min(1) });

wellsRouter.post(
  "/import/analyze",
  requirePermission("manageWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { csv } = importAnalyzeSchema.parse(req.body);
    const { headers, rows } = parseCsv(csv);
    res.json({
      headers,
      fields: IMPORT_FIELDS,
      suggestedMapping: guessImportMapping(headers),
      rowCount: rows.length,
      sample: rows.slice(0, 5),
    });
  }),
);

const importCommitSchema = z.object({
  csv: z.string().min(1),
  mapping: z.record(z.string(), z.string()),
  state: z.string().min(2).max(2).transform((s) => s.toUpperCase()),
  county: z.string().optional(),
  filename: z.string().optional(),
});

const CHUNK = 500;

wellsRouter.post(
  "/import/commit",
  requirePermission("manageWellAnalysis"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { csv, mapping, state, county, filename } = importCommitSchema.parse(req.body);
    const { rows } = parseCsv(csv);
    const get = (row: Record<string, string>, field: ImportField): string => {
      const header = mapping[field];
      return header ? (row[header] ?? "").trim() : "";
    };

    let imported = 0, skipped = 0, failed = 0;
    const skippedReasons = new Map<string, number>();
    const skip = (reason: string) => { skipped++; skippedReasons.set(reason, (skippedReasons.get(reason) ?? 0) + 1); };

    // Pass 1: resolve/create wells. Identity: API number first, else name+county.
    const existing = await prisma.researchWell.findMany({
      where: { organizationId: org, state },
      select: { id: true, apiNumber: true, name: true, county: true },
    });
    const byApi = new Map(existing.filter((w) => w.apiNumber).map((w) => [w.apiNumber as string, w.id]));
    const byName = new Map(existing.map((w) => [`${w.name.toUpperCase()}|${w.county.toUpperCase()}`, w.id]));

    interface ParsedRow { wellKey: string; month: string; oilBbl: number; gasMcf: number; nglBbl: number; waterBbl: number; daysOn: number | null }
    const parsed: ParsedRow[] = [];
    const newWells = new Map<string, Prisma.ResearchWellCreateManyInput>();

    for (const row of rows) {
      const wellName = get(row, "wellName");
      const apiNumber = get(row, "apiNumber").replace(/[^0-9\-]/g, "") || null;
      if (!wellName && !apiNumber) { failed++; continue; }
      const rowCounty = get(row, "county") || county || "";
      if (!rowCounty) { skip("Missing county (map a county column or pick one above)"); continue; }
      const month = parseMonth(get(row, "month"));
      if (!month) { failed++; continue; }

      const name = wellName || `API ${apiNumber}`;
      const nameKey = `${name.toUpperCase()}|${rowCounty.toUpperCase()}`;
      let wellKey = apiNumber && byApi.has(apiNumber) ? `id:${byApi.get(apiNumber)}` : byName.has(nameKey) ? `id:${byName.get(nameKey)}` : `new:${apiNumber ?? nameKey}`;

      if (wellKey.startsWith("new:") && !newWells.has(wellKey)) {
        newWells.set(wellKey, {
          organizationId: org,
          apiNumber,
          name,
          operator: get(row, "operator") || null,
          leaseName: get(row, "leaseName") || null,
          fieldName: get(row, "fieldName") || null,
          formation: get(row, "formation") || null,
          state,
          county: rowCounty,
          status: classifyWellStatus(get(row, "status")),
          trajectory: classifyTrajectory(get(row, "trajectory")),
          latitude: numOf(get(row, "latitude")),
          longitude: numOf(get(row, "longitude")),
          source: "csv",
        });
      }

      parsed.push({
        wellKey,
        month,
        oilBbl: numOf(get(row, "oilBbl")) ?? 0,
        gasMcf: numOf(get(row, "gasMcf")) ?? 0,
        nglBbl: numOf(get(row, "nglBbl")) ?? 0,
        waterBbl: numOf(get(row, "waterBbl")) ?? 0,
        daysOn: (() => { const n = numOf(get(row, "daysOn")); return n == null ? null : Math.round(n); })(),
      });
    }

    // Create the new wells, then resolve every wellKey to a real id.
    const keyToId = new Map<string, string>();
    for (const [key, data] of newWells) {
      const w = await prisma.researchWell.create({ data });
      keyToId.set(key, w.id);
      if (w.apiNumber) byApi.set(w.apiNumber, w.id);
      byName.set(`${w.name.toUpperCase()}|${w.county.toUpperCase()}`, w.id);
    }
    const resolveId = (key: string): string => (key.startsWith("id:") ? key.slice(3) : keyToId.get(key)!);

    // Pass 2: replace overlapping months, then bulk-insert. Last row wins on
    // in-file duplicates; re-imports overwrite (newest data is authoritative).
    const byWellMonth = new Map<string, ParsedRow & { wellId: string }>();
    for (const p of parsed) {
      const wellId = resolveId(p.wellKey);
      const k = `${wellId}|${p.month}`;
      if (byWellMonth.has(k)) skip("Duplicate well-month in file (last row kept)");
      byWellMonth.set(k, { ...p, wellId });
    }
    const finalRows = [...byWellMonth.values()];
    const wellIds = [...new Set(finalRows.map((r) => r.wellId))];
    const monthsByWell = new Map<string, Date[]>();
    for (const r of finalRows) {
      const arr = monthsByWell.get(r.wellId) ?? [];
      arr.push(ymToDate(r.month));
      monthsByWell.set(r.wellId, arr);
    }
    for (const wid of wellIds) {
      await prisma.wellProductionMonth.deleteMany({ where: { wellId: wid, month: { in: monthsByWell.get(wid)! } } });
    }
    const batch: Prisma.WellProductionMonthCreateManyInput[] = finalRows.map((r) => ({
      wellId: r.wellId, month: ymToDate(r.month), oilBbl: r.oilBbl, gasMcf: r.gasMcf,
      nglBbl: r.nglBbl, waterBbl: r.waterBbl, daysOn: r.daysOn, source: "csv",
    }));
    for (let i = 0; i < batch.length; i += CHUNK) {
      const r = await prisma.wellProductionMonth.createMany({ data: batch.slice(i, i + CHUNK) });
      imported += r.count;
    }

    const run = await prisma.researchIngestRun.create({
      data: {
        organizationId: org, kind: "PRODUCTION", source: "csv", state, county: county ?? null,
        filename: filename ?? null, rowsTotal: rows.length, rowsImported: imported,
        rowsSkipped: skipped, rowsFailed: failed, status: "COMPLETED", createdByUserId: req.user!.id,
      },
    });

    res.json({
      runId: run.id,
      rowsTotal: rows.length,
      imported,
      skipped,
      failed,
      wellsCreated: newWells.size,
      skippedReasons: [...skippedReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    });
  }),
);
