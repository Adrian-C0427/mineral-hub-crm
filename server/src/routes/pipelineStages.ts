import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { ensureStages } from "../domain/stages.js";
import type { PipelineStage } from "@prisma/client";

export const pipelineStagesRouter = Router();
pipelineStagesRouter.use(requireAuth, requireOrg);

const serialize = (s: PipelineStage) => ({ id: s.id, key: s.key, label: s.label, position: s.position, isTerminal: s.isTerminal });

// Normalize positions to 0..n with all active stages before the terminal ones,
// preserving relative order within each group.
async function renumber(organizationId: string) {
  const all = await prisma.pipelineStage.findMany({ where: { organizationId } });
  const sorted = [...all].sort((a, b) => Number(a.isTerminal) - Number(b.isTerminal) || a.position - b.position);
  await prisma.$transaction(sorted.map((s, i) => prisma.pipelineStage.update({ where: { id: s.id }, data: { position: i } })));
}

/** The org's pipeline stages (ordered). Any authenticated member can read them. */
pipelineStagesRouter.get(
  "/stages",
  asyncHandler(async (req: AuthedRequest, res) => {
    const stages = await ensureStages(prisma, orgId(req));
    res.json(stages.map(serialize));
  }),
);

// Add a custom active stage (appended after the existing active stages).
pipelineStagesRouter.post(
  "/stages",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { label } = z.object({ label: z.string().trim().min(1).max(60) }).parse(req.body);
    const stages = await ensureStages(prisma, orgId(req));
    const activeCount = stages.filter((s) => !s.isTerminal).length;
    const key = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await prisma.pipelineStage.create({ data: { organizationId: orgId(req), key, label, position: activeCount, isTerminal: false } });
    await renumber(orgId(req));
    const out = await prisma.pipelineStage.findMany({ where: { organizationId: orgId(req) }, orderBy: { position: "asc" } });
    res.status(201).json(out.map(serialize));
  }),
);

// Rename an active stage. Terminal (Closed / Dead) stages are locked.
pipelineStagesRouter.patch(
  "/stages/:id",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { label } = z.object({ label: z.string().trim().min(1).max(60) }).parse(req.body);
    const stage = await prisma.pipelineStage.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!stage) throw new HttpError(404, "Stage not found");
    if (stage.isTerminal) throw new HttpError(400, "Closed and Dead are permanent system stages and cannot be renamed");
    await prisma.pipelineStage.update({ where: { id: stage.id }, data: { label } });
    const out = await prisma.pipelineStage.findMany({ where: { organizationId: orgId(req) }, orderBy: { position: "asc" } });
    res.json(out.map(serialize));
  }),
);

// Reorder the active stages (ids in desired order). Terminals always stay last.
pipelineStagesRouter.post(
  "/stages/reorder",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { order } = z.object({ order: z.array(z.string()).min(1) }).parse(req.body);
    const stages = await ensureStages(prisma, orgId(req));
    const byId = new Map(stages.map((s) => [s.id, s]));
    let pos = 0;
    const updates = [] as ReturnType<typeof prisma.pipelineStage.update>[];
    for (const id of order) {
      const s = byId.get(id);
      if (s && !s.isTerminal) updates.push(prisma.pipelineStage.update({ where: { id }, data: { position: pos++ } }));
    }
    for (const s of stages.filter((x) => x.isTerminal)) updates.push(prisma.pipelineStage.update({ where: { id: s.id }, data: { position: pos++ } }));
    await prisma.$transaction(updates);
    await renumber(orgId(req));
    const out = await prisma.pipelineStage.findMany({ where: { organizationId: orgId(req) }, orderBy: { position: "asc" } });
    res.json(out.map(serialize));
  }),
);

// Remove a custom/active stage. Terminals are locked; you can't remove the last
// active stage. Deals sitting in the removed stage move to the first active one.
pipelineStagesRouter.delete(
  "/stages/:id",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const stages = await ensureStages(prisma, orgId(req));
    const stage = stages.find((s) => s.id === req.params.id);
    if (!stage) throw new HttpError(404, "Stage not found");
    if (stage.isTerminal) throw new HttpError(400, "Closed and Dead are permanent system stages and cannot be removed");
    const remainingActive = stages.filter((s) => !s.isTerminal && s.id !== stage.id);
    if (remainingActive.length === 0) throw new HttpError(400, "At least one active stage is required");
    const fallbackKey = remainingActive[0].key;
    await prisma.$transaction([
      prisma.deal.updateMany({ where: { organizationId: orgId(req), stage: stage.key }, data: { stage: fallbackKey } }),
      prisma.pipelineStage.delete({ where: { id: stage.id } }),
    ]);
    await renumber(orgId(req));
    const out = await prisma.pipelineStage.findMany({ where: { organizationId: orgId(req) }, orderBy: { position: "asc" } });
    res.json(out.map(serialize));
  }),
);
