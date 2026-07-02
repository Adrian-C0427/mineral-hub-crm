import { Router } from "express";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import type { Prisma, WellStatus, WellTrajectory } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { normalizeAssumptions, runValuation, type MonthVolumes } from "../domain/valuation.js";

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
const dateToYm = (d: Date): string => d.toISOString().slice(0, 7);

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

async function productionSummaries(wellIds: string[]): Promise<Map<string, WellSummary>> {
  if (!wellIds.length) return new Map();
  const groups = await prisma.wellProductionMonth.groupBy({
    by: ["wellId"],
    where: { wellId: { in: wellIds } },
    _min: { month: true },
    _max: { month: true },
    _count: true,
    _sum: { oilBbl: true, gasMcf: true, nglBbl: true },
  });
  return new Map(
    groups.map((g) => [
      g.wellId,
      {
        firstMonth: g._min.month ? dateToYm(g._min.month) : null,
        lastMonth: g._max.month ? dateToYm(g._max.month) : null,
        months: g._count,
        cumOilBbl: g._sum.oilBbl ?? 0,
        cumGasMcf: g._sum.gasMcf ?? 0,
        cumNglBbl: g._sum.nglBbl ?? 0,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Wells: search / list / CRUD
// ---------------------------------------------------------------------------

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
  requirePermission("viewResearch"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { q, ids, state, county, operator, page, pageSize } = listSchema.parse(req.query);
    const where: Prisma.ResearchWellWhereInput = { organizationId: orgId(req) };
    if (ids) where.id = { in: ids.split(",").filter(Boolean).slice(0, 100) };
    if (state) where.state = state;
    if (county) where.county = county;
    if (operator) where.operator = { contains: operator, mode: "insensitive" };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { apiNumber: { contains: q, mode: "insensitive" } },
        { operator: { contains: q, mode: "insensitive" } },
        { leaseName: { contains: q, mode: "insensitive" } },
        { fieldName: { contains: q, mode: "insensitive" } },
      ];
    }
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
  requirePermission("viewResearch"),
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
  requirePermission("manageResearchData"),
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
  requirePermission("manageResearchData"),
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
  requirePermission("manageResearchData"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const existing = await prisma.researchWell.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) { res.status(404).json({ error: "Well not found" }); return; }
    await prisma.researchWell.delete({ where: { id: existing.id } }); // production cascades
    res.status(204).end();
  }),
);

wellsRouter.get(
  "/:id/production",
  requirePermission("viewResearch"),
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
  const rows = await prisma.wellProductionMonth.findMany({
    where: { wellId: { in: wells.map((w) => w.id) } },
    orderBy: { month: "asc" },
  });
  const volumes: MonthVolumes[] = rows.map((r) => ({
    month: dateToYm(r.month), oilBbl: r.oilBbl, gasMcf: r.gasMcf, nglBbl: r.nglBbl, waterBbl: r.waterBbl,
  }));
  return { wells, volumes };
}

wellsRouter.post(
  "/analyze",
  requirePermission("viewResearch"),
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
  requirePermission("viewResearch"),
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
  requirePermission("viewResearch"),
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
  requirePermission("viewResearch"),
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
  requirePermission("viewResearch"),
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
  requirePermission("viewResearch"),
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
  requirePermission("viewResearch"),
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
  requirePermission("manageResearchData"),
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
  requirePermission("manageResearchData"),
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
