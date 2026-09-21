import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { serializeDeal } from "../serializers.js";
import { TERMINAL_STAGE_KEYS } from "../domain/stages.js";
import { parseShapefileUpload, MAX_TRACT_FEATURES, type UploadedFile } from "../domain/shpImport.js";
import { env } from "../config.js";

export const mapRouter = Router();
// viewMap is in every role's defaults; the gate only bites when an org
// explicitly removes it — which previously only hid the UI, not this data.
mapRouter.use(requireAuth, requireOrg, requirePermission("viewMap"));

// "Active" = any non-terminal stage (robust to custom stages).
const ACTIVE_FILTER = { notIn: [...TERMINAL_STAGE_KEYS] };

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

/** Every imported tract as one FeatureCollection (map source + panel detail). */
mapRouter.get(
  "/tracts",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.mapTract.findMany({
      where: { organizationId: orgId(req) },
      orderBy: { createdAt: "asc" },
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
    const groups = await prisma.mapTract.groupBy({
      by: ["importId", "sourceFile"],
      where: { organizationId: orgId(req) },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    res.json(groups
      .map((g) => ({ importId: g.importId, sourceFile: g.sourceFile, count: g._count._all, createdAt: g._min.createdAt }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  }),
);

/** Import a shapefile: parse, reproject via its .prj, store polygon features. */
mapRouter.post(
  "/tracts/import",
  requirePermission("manageMapData"),
  shpUpload.array("files", 6),
  asyncHandler(async (req: AuthedRequest, res) => {
    const files = (req.files as Express.Multer.File[] | undefined ?? [])
      .map((f): UploadedFile => ({ originalname: f.originalname, buffer: f.buffer }));
    const primary = files.find((f) => /\.(zip|shp)$/i.test(f.originalname)) ?? files[0];
    if (!primary) throw new HttpError(400, "No files uploaded");
    const sourceFile = primary.originalname.slice(0, 300);
    const baseName = sourceFile.replace(/\.[^.]+$/, "");

    const parsed = await parseShapefileUpload(files, baseName);

    // Guard the org's total row count too, not just the single upload.
    const existing = await prisma.mapTract.count({ where: { organizationId: orgId(req) } });
    if (existing + parsed.features.length > MAX_TRACT_FEATURES * 4) {
      throw new HttpError(400, "Imported-tract limit reached for this workspace — delete an older import first");
    }

    const importId = randomUUID();
    await prisma.mapTract.createMany({
      data: parsed.features.map((f) => ({
        organizationId: orgId(req),
        importId,
        sourceFile,
        name: f.name,
        properties: f.properties as Prisma.InputJsonValue,
        geometry: f.geometry as unknown as Prisma.InputJsonValue,
      })),
    });
    res.status(201).json({ importId, sourceFile, count: parsed.features.length, skipped: parsed.skipped, bbox: parsed.bbox });
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
