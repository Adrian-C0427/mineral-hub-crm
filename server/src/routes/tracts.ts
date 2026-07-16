import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { anchorPolygon, parseTract, type ParsedTract } from "../domain/tractParser.js";
import { logActivity } from "../services/activityLog.js";

/**
 * Tract descriptions on a deal (/api/deals/:id/tracts). The raw legal text is
 * authoritative; parse + geometry are derived server-side so every client sees
 * the same reading. Anchoring: a parsed abstract reference is looked up in
 * gis.abstracts (scoped to the parsed/deal counties) and its point-on-surface
 * becomes the suggested POB; the user can re-place the POB on the map, which
 * is stored as a "manual" anchor and survives re-parses.
 */
export const tractsRouter = Router();
tractsRouter.use(requireAuth, requireOrg);

async function ownDealOr404(req: AuthedRequest): Promise<string> {
  const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, select: { id: true } });
  if (!deal) throw new HttpError(404, "Deal not found");
  return deal.id;
}

type Anchor = { lon: number; lat: number; source: "abstract" | "manual"; abstractId?: string };

/** Suggest a POB from the description's abstract references (best-effort). */
async function suggestAnchor(parsed: ParsedTract, dealCounties: string[]): Promise<Anchor | null> {
  const refs = parsed.refs.abstracts.map((a) => a.replace(/^A-/, ""));
  if (!refs.length) return null;
  const counties = [parsed.refs.county, ...dealCounties].filter(Boolean) as string[];
  // Abstract labels vary by source ("A-123" vs "123"); match both spellings,
  // preferring rows in the referenced county.
  const rows = await prisma.$queryRawUnsafe<{ id: string; county: string; lon: number; lat: number }[]>(
    `SELECT id, county, ST_X(ST_PointOnSurface(geom)) AS lon, ST_Y(ST_PointOnSurface(geom)) AS lat
       FROM gis.abstracts
      WHERE (abstract = ANY($1::text[]) OR abstract = ANY($2::text[]))
      ORDER BY CASE WHEN county ILIKE ANY($3::text[]) THEN 0 ELSE 1 END
      LIMIT 1`,
    refs, refs.map((r) => `A-${r}`), counties.length ? counties : ["__none__"],
  ).catch(() => []);
  const hit = rows[0];
  return hit ? { lon: hit.lon, lat: hit.lat, source: "abstract", abstractId: hit.id } : null;
}

function withGeometry(parsed: ParsedTract, anchor: Anchor | null, name: string) {
  if (!parsed.ok || !anchor) return null;
  const polygon = anchorPolygon(parsed.points, anchor);
  return { type: "Feature", properties: { name }, geometry: polygon } as const;
}

function serialize(t: { id: string; name: string; text: string; state: string; parse: Prisma.JsonValue; geometry: Prisma.JsonValue; anchor: Prisma.JsonValue; createdAt: Date; updatedAt: Date }) {
  return { id: t.id, name: t.name, text: t.text, state: t.state, parse: t.parse, geometry: t.geometry, anchor: t.anchor, createdAt: t.createdAt, updatedAt: t.updatedAt };
}

const anchorSchema = z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) });

tractsRouter.get(
  "/:id/tracts",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const tracts = await prisma.tractDescription.findMany({ where: { dealId }, orderBy: { createdAt: "asc" } });
    res.json(tracts.map(serialize));
  }),
);

// Parse without saving — powers the live preview in the editor.
tractsRouter.post(
  "/:id/tracts/preview",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    await ownDealOr404(req);
    const { text, state } = z.object({ text: z.string().trim().min(1).max(50_000), state: z.string().trim().length(2).default("TX") }).parse(req.body);
    res.json(parseTract(text, state));
  }),
);

tractsRouter.post(
  "/:id/tracts",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const body = z.object({
      name: z.string().trim().max(120).optional(),
      text: z.string().trim().min(1).max(50_000),
      state: z.string().trim().length(2).default("TX"),
    }).parse(req.body);

    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId }, select: { counties: true, _count: { select: { tracts: true } } } });
    const parsed = parseTract(body.text, body.state);
    const anchor = await suggestAnchor(parsed, deal.counties);
    const name = body.name || `Tract ${deal._count.tracts + 1}`;
    const tract = await prisma.tractDescription.create({
      data: {
        dealId, name, text: body.text, state: body.state.toUpperCase(),
        parse: parsed as unknown as Prisma.InputJsonValue,
        anchor: (anchor ?? undefined) as Prisma.InputJsonValue | undefined,
        geometry: (withGeometry(parsed, anchor, name) ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    res.status(201).json(serialize(tract));
  }),
);

tractsRouter.patch(
  "/:id/tracts/:tractId",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const body = z.object({
      name: z.string().trim().min(1).max(120).optional(),
      text: z.string().trim().min(1).max(50_000).optional(),
      state: z.string().trim().length(2).optional(),
      anchor: anchorSchema.optional(), // user re-placed the POB on the map
    }).parse(req.body);

    const existing = await prisma.tractDescription.findFirst({ where: { id: req.params.tractId, dealId } });
    if (!existing) throw new HttpError(404, "Tract not found");

    const name = body.name ?? existing.name;
    const text = body.text ?? existing.text;
    const state = (body.state ?? existing.state).toUpperCase();
    const reparse = body.text !== undefined || body.state !== undefined;
    const parsed = reparse ? parseTract(text, state) : (existing.parse as unknown as ParsedTract | null);

    // Anchor precedence: an explicit re-placement wins; otherwise keep a manual
    // anchor across re-parses (the user's placement is ground truth); otherwise
    // refresh the abstract-derived suggestion.
    let anchor = (existing.anchor as Anchor | null) ?? null;
    if (body.anchor) anchor = { ...body.anchor, source: "manual" };
    else if (reparse && parsed && anchor?.source !== "manual") {
      const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId }, select: { counties: true } });
      anchor = (await suggestAnchor(parsed, deal.counties)) ?? anchor;
    }

    const geometry = parsed ? withGeometry(parsed, anchor, name) : null;
    const tract = await prisma.tractDescription.update({
      where: { id: existing.id },
      data: {
        name, text, state,
        parse: (parsed ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
        anchor: anchor ? (anchor as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        geometry: geometry ? (geometry as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
    res.json(serialize(tract));
  }),
);

/**
 * Generate Tract Map: re-runs the deterministic parsing engine on the saved
 * legal description, refreshes the abstract-derived anchor (a manual POB
 * placement survives), and rebuilds the polygon. Fully self-contained — no AI
 * provider or API key involved.
 */
tractsRouter.post(
  "/:id/tracts/:tractId/generate",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const tract = await prisma.tractDescription.findFirst({ where: { id: req.params.tractId, dealId } });
    if (!tract) throw new HttpError(404, "Tract not found");

    const parsed = parseTract(tract.text, tract.state);

    let anchor = (tract.anchor as Anchor | null) ?? null;
    if (anchor?.source !== "manual") {
      const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId }, select: { counties: true } });
      anchor = (await suggestAnchor(parsed, deal.counties)) ?? anchor;
    }
    const geometry = withGeometry(parsed, anchor, tract.name);
    const updated = await prisma.tractDescription.update({
      where: { id: tract.id },
      data: {
        parse: parsed as unknown as Prisma.InputJsonValue,
        anchor: anchor ? (anchor as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        geometry: geometry ? (geometry as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
    await logActivity({
      eventType: "tract_parse",
      summary: `Tract map generated for "${tract.name}" (${parsed.ok ? `${parsed.calls.length} calls, ${parsed.computedAcres ?? "?"} ac` : "no polygon"}${parsed.confidence != null ? `, confidence ${parsed.confidence}%` : ""})`,
      organizationId: orgId(req), actorUserId: req.user?.id ?? null, dealId,
    });
    res.json(serialize(updated));
  }),
);

tractsRouter.delete(
  "/:id/tracts/:tractId",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const result = await prisma.tractDescription.deleteMany({ where: { id: req.params.tractId, dealId } });
    if (result.count === 0) throw new HttpError(404, "Tract not found");
    res.json({ ok: true });
  }),
);
