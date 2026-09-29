import { randomUUID } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { serializeDeal } from "../serializers.js";
import { TERMINAL_STAGE_KEYS } from "../domain/stages.js";
import { parseShapefileUpload, MAX_TRACT_FEATURES, MAX_ORG_TRACT_BYTES, type UploadedFile } from "../domain/shpImport.js";
import { env } from "../config.js";

export const mapRouter = Router();
// viewMap is in every role's defaults; the gate only bites when an org
// explicitly removes it — which previously only hid the UI, not this data.
mapRouter.use(requireAuth, requireOrg, requirePermission("viewMap"));

// "Active" = any non-terminal stage (robust to custom stages).
const ACTIVE_FILTER = { notIn: [...TERMINAL_STAGE_KEYS] };

// Deal workflow on the map = acquisition opportunities + owned assets actively
// marketed for sale (assetMode SELL). An owned asset on HOLD is not a deal —
// its parked "Closing" stage and computed priority mean nothing — so it's
// served separately as a Mineral Asset (GET /map/assets).
const DEAL_WORKFLOW: Prisma.DealWhereInput = {
  OR: [{ recordType: "OPPORTUNITY" }, { recordType: "OWNED_ASSET", assetMode: "SELL" }],
};

const filterSchema = z.object({
  status: z.string().optional(), // "ACTIVE" (default) | "ALL" | a specific Stage
  county: z.string().optional(),
  basin: z.string().optional(),
  formation: z.string().optional(),
  assetType: z.string().optional(),
});

/**
 * Deals in the caller's org that are linked to a survey/abstract, with the fields
 * the map popup needs. The client groups these by abstractId to highlight
 * boundaries. Geometry itself is served as a static GeoJSON asset (per-county),
 * so this endpoint stays tiny and fast.
 */
mapRouter.get(
  "/deals",
  asyncHandler(async (req: AuthedRequest, res) => {
    const f = filterSchema.parse(req.query);

    const where: Prisma.DealWhereInput = {
      organizationId: orgId(req),
      abstractIds: { isEmpty: false },
      ...DEAL_WORKFLOW,
    };
    if (f.status && f.status !== "ALL") {
      where.stage = f.status === "ACTIVE" ? ACTIVE_FILTER : f.status;
    } else if (!f.status) {
      where.stage = ACTIVE_FILTER;
    }
    if (f.county) where.counties = { has: f.county };
    if (f.basin) where.basins = { has: f.basin };
    if (f.formation) where.formations = { has: f.formation };
    if (f.assetType) where.assetTypes = { has: f.assetType };

    const deals = await prisma.deal.findMany({
      where,
      include: { selectedBuyer: true, relationshipOwner: true, offers: { select: { amount: true } } },
      orderBy: { createdAt: "desc" },
      // Guard against a pathologically large org loading unbounded rows into
      // memory; well above any realistic mapped-deal count (newest first).
      take: 5000,
    });

    const now = new Date();
    res.json(
      deals.map((d) => {
        const s = serializeDeal(d, now);
        return {
          id: s.id,
          abstractIds: s.abstractIds,
          name: s.name,
          // OWNED_ASSET here is always one marketed for sale.
          recordType: s.recordType,
          stage: s.stage,
          priority: s.priority,
          counties: s.counties,
          state: s.state,
          operator: s.operator,
          assetTypes: s.assetTypes,
          basins: s.basins,
          formations: s.formations,
          acreageNma: s.acreageNma,
          nra: s.nra,
          askPrice: s.askPrice,
          profitEst: s.profitEst,
          selectedBuyer: s.selectedBuyer,
        };
      }),
    );
  }),
);

/**
 * Owned mineral assets NOT marketed for sale (HOLD), linked to abstracts — shown
 * on the map as Mineral Assets, never as deals (no stage, priority, or buyer).
 * Sold assets (a CLOSED sale) have left the portfolio and are excluded.
 */
mapRouter.get(
  "/assets",
  asyncHandler(async (req: AuthedRequest, res) => {
    const assets = await prisma.deal.findMany({
      where: {
        organizationId: orgId(req),
        abstractIds: { isEmpty: false },
        recordType: "OWNED_ASSET",
        // HOLD, or no mode recorded (assets default to HOLD).
        OR: [{ assetMode: "HOLD" }, { assetMode: null }],
        stage: { notIn: [...TERMINAL_STAGE_KEYS] },
      },
      select: { id: true, abstractIds: true, name: true, operator: true, assetTypes: true, acreageNma: true, nra: true, counties: true, state: true },
      orderBy: { createdAt: "desc" },
      take: 5000,
    });
    res.json(assets);
  }),
);

/** Distinct filter values present on the org's abstract-linked deals (for filter menus). */
mapRouter.get(
  "/filters",
  asyncHandler(async (req: AuthedRequest, res) => {
    const deals = await prisma.deal.findMany({
      where: { organizationId: orgId(req), abstractIds: { isEmpty: false } },
      select: { counties: true, basins: true, formations: true, assetTypes: true },
    });
    const uniq = (vals: string[][]) => [...new Set(vals.flat())].filter(Boolean).sort();
    res.json({
      counties: uniq(deals.map((d) => d.counties)),
      basins: uniq(deals.map((d) => d.basins)),
      formations: uniq(deals.map((d) => d.formations)),
      assetTypes: uniq(deals.map((d) => d.assetTypes)),
    });
  }),
);

/* ------------------------- Imported tract boundaries ------------------------
 * Shapefile uploads (.zip or loose .shp/.dbf/.prj) become org-scoped WGS84
 * polygon rows (MapTract) rendered as the map's "Imported tracts" overlay.
 * Org data must never ride the public, LRU-cached /gis tile pipeline, so these
 * are served as an authed GeoJSON FeatureCollection instead. */

// Shapefile sidecars: at most one .zip, or .shp + .dbf/.prj/.shx/.cpg.
const shpUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 6 } });

// Each import parses and reprojects up to 150 MB of uploads; cap replays.
const tractImportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user?.id ?? req.ip ?? "unknown",
  message: { error: "Too many shapefile imports. Wait a few minutes and try again." },
});

// ?dealId= scopes a list to one deal's imports (the deal map); omitted = every
// org tract, deal-linked ones included (the main map).
const dealScopeSchema = z.object({ dealId: z.string().min(1).max(200).optional() });

/** The deal an import attaches to — must be in the caller's org. */
async function orgDealId(req: AuthedRequest, raw: unknown): Promise<string | null> {
  if (raw == null || raw === "") return null;
  const id = z.string().min(1).max(200).parse(raw);
  const deal = await prisma.deal.findFirst({ where: { id, organizationId: orgId(req) }, select: { id: true } });
  if (!deal) throw new HttpError(404, "Deal not found");
  return deal.id;
}

/** Every imported tract as one FeatureCollection (map source + panel detail). */
mapRouter.get(
  "/tracts",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { dealId } = dealScopeSchema.parse(req.query);
    const rows = await prisma.mapTract.findMany({
      where: { organizationId: orgId(req), ...(dealId ? { dealId } : {}) },
      orderBy: { createdAt: "asc" },
      include: { deal: { select: { id: true, name: true } } },
    });
    res.json({
      type: "FeatureCollection",
      features: rows.map((r) => ({
        type: "Feature",
        id: r.id,
        // DBF attributes first; the reserved __-keys (id/name/source) always win.
        properties: {
          ...(r.properties as Record<string, unknown> | null ?? {}),
          __id: r.id, __name: r.name, __source: r.sourceFile, __importId: r.importId,
          __dealId: r.deal?.id ?? null, __dealName: r.deal?.name ?? null,
        },
        geometry: r.geometry,
      })),
    });
  }),
);

/** The org's uploads, one row per import (for the manage list). */
mapRouter.get(
  "/tracts/imports",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { dealId } = dealScopeSchema.parse(req.query);
    const groups = await prisma.mapTract.groupBy({
      by: ["importId", "sourceFile", "dealId"],
      where: { organizationId: orgId(req), ...(dealId ? { dealId } : {}) },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    const dealIds = [...new Set(groups.map((g) => g.dealId).filter((v): v is string => !!v))];
    const deals = dealIds.length
      ? await prisma.deal.findMany({ where: { id: { in: dealIds }, organizationId: orgId(req) }, select: { id: true, name: true } })
      : [];
    const dealName = new Map(deals.map((d) => [d.id, d.name]));
    res.json(groups
      .map((g) => ({
        importId: g.importId, sourceFile: g.sourceFile, count: g._count._all, createdAt: g._min.createdAt,
        dealId: g.dealId, dealName: g.dealId ? dealName.get(g.dealId) ?? null : null,
      }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  }),
);

/** Import a shapefile: parse, reproject via its .prj, store polygon features. */
mapRouter.post(
  "/tracts/import",
  requirePermission("manageMapData"),
  tractImportLimiter,
  shpUpload.array("files", 6),
  asyncHandler(async (req: AuthedRequest, res) => {
    const files = (req.files as Express.Multer.File[] | undefined ?? [])
      .map((f): UploadedFile => ({ originalname: f.originalname, buffer: f.buffer }));
    const primary = files.find((f) => /\.(zip|shp)$/i.test(f.originalname)) ?? files[0];
    if (!primary) throw new HttpError(400, "No files uploaded");
    const sourceFile = primary.originalname.slice(0, 300);
    const baseName = sourceFile.replace(/\.[^.]+$/, "");

    // Imported from a deal's map: link every feature to that deal.
    const dealId = await orgDealId(req, (req.body as Record<string, unknown> | undefined)?.dealId);
    const parsed = await parseShapefileUpload(files, baseName);

    // Guard the org's total row count too, not just the single upload.
    const existing = await prisma.mapTract.count({ where: { organizationId: orgId(req) } });
    if (existing + parsed.features.length > MAX_TRACT_FEATURES * 4) {
      throw new HttpError(400, "Imported-tract limit reached for this workspace — delete an older import first");
    }
    // …and its stored bytes: GET /tracts ships every row to every map viewer,
    // so the feature count alone doesn't bound the response (vertex-dense
    // polygons do).
    const [{ bytes }] = await prisma.$queryRaw<{ bytes: bigint | null }[]>`
      SELECT SUM(octet_length(geometry::text) + COALESCE(octet_length(properties::text), 0))::bigint AS bytes
      FROM "MapTract" WHERE "organizationId" = ${orgId(req)}`;
    const incoming = parsed.features.reduce((n, f) => n + JSON.stringify(f.geometry).length + JSON.stringify(f.properties).length, 0);
    if (Number(bytes ?? 0) + incoming > MAX_ORG_TRACT_BYTES) {
      throw new HttpError(400, "Imported-tract storage limit reached for this workspace — delete an older import or simplify the shapefile");
    }

    const importId = randomUUID();
    await prisma.mapTract.createMany({
      data: parsed.features.map((f) => ({
        organizationId: orgId(req),
        dealId,
        importId,
        sourceFile,
        name: f.name,
        properties: f.properties as Prisma.InputJsonValue,
        geometry: f.geometry as unknown as Prisma.InputJsonValue,
      })),
    });
    res.status(201).json({ importId, sourceFile, dealId, count: parsed.features.length, skipped: parsed.skipped, bbox: parsed.bbox });
  }),
);

/** Remove one upload's tracts (the whole import as a unit). */
mapRouter.delete(
  "/tracts/imports/:importId",
  requirePermission("manageMapData"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const idSchema = z.string().min(1).max(200);
    const del = await prisma.mapTract.deleteMany({
      where: { organizationId: orgId(req), importId: idSchema.parse(req.params.importId) },
    });
    if (del.count === 0) throw new HttpError(404, "Import not found");
    res.json({ deleted: del.count });
  }),
);
