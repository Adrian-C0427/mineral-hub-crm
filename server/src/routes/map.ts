import { Router } from "express";
import { z } from "zod";
import type { Prisma, Stage } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireOrg, orgId, type AuthedRequest } from "../middleware/auth.js";
import { serializeDeal } from "../serializers.js";

export const mapRouter = Router();
mapRouter.use(requireAuth, requireOrg);

const ACTIVE_STAGES: Stage[] = ["UNDER_CONTRACT", "PREPARING_PACKAGE", "SENT_TO_BUYERS", "NEGOTIATING", "CLOSING"];

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
      abstractId: { not: null },
    };
    if (f.status && f.status !== "ALL") {
      where.stage = f.status === "ACTIVE" ? { in: ACTIVE_STAGES } : (f.status as Stage);
    } else if (!f.status) {
      where.stage = { in: ACTIVE_STAGES };
    }
    if (f.county) where.county = { equals: f.county, mode: "insensitive" };
    if (f.basin) where.basin = { equals: f.basin, mode: "insensitive" };
    if (f.formation) where.formation = { equals: f.formation, mode: "insensitive" };
    if (f.assetType) where.assetType = { equals: f.assetType, mode: "insensitive" };

    const deals = await prisma.deal.findMany({
      where,
      include: { selectedBuyer: true, relationshipOwner: true, offers: { select: { amount: true } } },
      orderBy: { createdAt: "desc" },
    });

    const now = new Date();
    res.json(
      deals.map((d) => {
        const s = serializeDeal(d, now);
        return {
          id: s.id,
          abstractId: s.abstractId,
          name: s.name,
          stage: s.stage,
          priority: s.priority,
          county: s.county,
          state: s.state,
          operator: s.operator,
          assetType: s.assetType,
          basin: s.basin,
          formation: s.formation,
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
      where: { organizationId: orgId(req), abstractId: { not: null } },
      select: { county: true, basin: true, formation: true, assetType: true },
    });
    const uniq = (vals: (string | null)[]) =>
      [...new Set(vals.filter((v): v is string => !!v))].sort();
    res.json({
      counties: uniq(deals.map((d) => d.county)),
      basins: uniq(deals.map((d) => d.basin)),
      formations: uniq(deals.map((d) => d.formation)),
      assetTypes: uniq(deals.map((d) => d.assetType)),
    });
  }),
);
