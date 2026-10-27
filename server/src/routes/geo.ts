/**
 * Basins, plays and formations (domain/geoRegions.ts) — reference data, not
 * the map: the deal / opportunity forms ask here which basin an abstract or
 * county lies in, so the gate is membership (requireAuth + requireOrg), not
 * viewMap. Nothing here is org data; nothing here writes.
 */
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireOrg } from "../middleware/auth.js";
import { geoCatalog, suggestedTags, type RegionKind } from "../domain/geoRegions.js";
import { formationsDataset, geoContext, geoRegionsDataset, regionsPayload, type OverlayPayload } from "../services/geoRegions.js";

export const geoRouter = Router();
geoRouter.use(requireAuth, requireOrg);
geoRouter.use(rateLimit({ windowMs: 5 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests. Wait a moment and try again." } }));

const csv = (s: string | undefined, max: number) => [...new Set((s ?? "").split(",").map((v) => v.trim()).filter(Boolean))].slice(0, max);
const contextSchema = z.object({
  abstractIds: z.string().max(20_000).optional(),
  counties: z.string().max(8_000).optional(),
  state: z.string().max(40).optional(),
});

/**
 * GET /geo/context?abstractIds=TX-289653,…&counties=Leon,Freestone&state=TX
 * The basins / sub-basins / plays / formations a record with that geography
 * lies in, each with its basis (abstract footprint or county) and confidence,
 * plus `suggested` — what the forms auto-fill when the user has entered nothing.
 */
geoRouter.get(
  "/context",
  asyncHandler(async (req, res) => {
    const q = contextSchema.parse(req.query);
    const ctx = await geoContext({ abstractIds: csv(q.abstractIds, 500), counties: csv(q.counties, 300), state: q.state ?? null });
    if (!ctx) { res.status(503).json({ error: "Basin reference data is not available on this server" }); return; }
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json({ ...ctx, suggested: suggestedTags(ctx) });
  }),
);

/** The picker / filter catalog (basins, sub-basins, plays, formations, sources, what is not covered). */
geoRouter.get(
  "/catalog",
  asyncHandler(async (_req, res) => {
    const ds = geoRegionsDataset(); const fds = formationsDataset();
    if (!ds || !fds) { res.status(503).json({ error: "Basin reference data is not available on this server" }); return; }
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.json(geoCatalog(ds, fds));
  }),
);

function sendOverlay(req: Request, res: Response, p: OverlayPayload | null): void {
  if (!p) { res.json({ type: "FeatureCollection", features: [] }); return; }
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("ETag", p.etag);
  if (req.headers["if-none-match"] === p.etag) { res.status(304).end(); return; }
  res.type("application/json").send(p.body);
}

const KINDS: readonly RegionKind[] = ["basin", "subbasin", "play"];
const regionsSchema = z.object({ kind: z.string().max(60).optional() });

/** GET /geo/regions?kind=basin|subbasin|play (comma-separated; default basins + sub-basins) — GeoJSON for the map overlay. */
geoRouter.get(
  "/regions",
  asyncHandler(async (req, res) => {
    const q = regionsSchema.parse(req.query);
    const wanted = csv(q.kind, 4).filter((k): k is RegionKind => (KINDS as readonly string[]).includes(k));
    sendOverlay(req, res, regionsPayload(wanted.length ? wanted : ["basin", "subbasin"]));
  }),
);
