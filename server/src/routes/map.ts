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
      abstractIds: { isEmpty: false },
    };
    if (f.status && f.status !== "ALL") {
      where.stage = f.status === "ACTIVE" ? { in: ACTIVE_STAGES } : (f.status as Stage);
    } else if (!f.status) {
      where.stage = { in: ACTIVE_STAGES };
    }
    if (f.county) where.counties = { has: f.county };
    if (f.basin) where.basins = { has: f.basin };
    if (f.formation) where.formations = { has: f.formation };
    if (f.assetType) where.assetTypes = { has: f.assetType };

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
