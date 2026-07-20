import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { ensureStages, ensurePipelines, ensureDefaultPipeline, seedStages, firstActiveStageKey, TERMINAL_STAGE_KEYS } from "../domain/stages.js";
import type { Pipeline, PipelineStage } from "@prisma/client";

export const pipelineStagesRouter = Router();
pipelineStagesRouter.use(requireAuth, requireOrg);

const serialize = (s: PipelineStage) => ({ id: s.id, key: s.key, label: s.label, position: s.position, isTerminal: s.isTerminal, pipelineId: s.pipelineId });
const serializePipeline = (p: Pipeline) => ({ id: p.id, name: p.name, isDefault: p.isDefault, position: p.position });

/** Resolve the pipeline a request targets (query/body pipelineId, else the
 *  org's default). Always validates org ownership. */
async function resolvePipeline(req: AuthedRequest): Promise<Pipeline> {
  const pid = (req.query.pipelineId as string | undefined) ?? (req.body?.pipelineId as string | undefined);
  if (!pid) return ensureDefaultPipeline(prisma, orgId(req));
  const p = await prisma.pipeline.findFirst({ where: { id: pid, organizationId: orgId(req) } });
  if (!p) throw new HttpError(404, "Pipeline not found");
  return p;
}

/** Deals belonging to a pipeline. Null Deal.pipelineId means "default". */
function dealsOfPipeline(organizationId: string, p: Pipeline) {
  return p.isDefault
    ? { organizationId, OR: [{ pipelineId: p.id }, { pipelineId: null }] }
    : { organizationId, pipelineId: p.id };
}

// Normalize positions to 0..n with all active stages before the terminal ones,
// preserving relative order within each group.
async function renumber(pipelineId: string) {
  const all = await prisma.pipelineStage.findMany({ where: { pipelineId } });
  const sorted = [...all].sort((a, b) => Number(a.isTerminal) - Number(b.isTerminal) || a.position - b.position);
  await prisma.$transaction(sorted.map((s, i) => prisma.pipelineStage.update({ where: { id: s.id }, data: { position: i } })));
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/** All pipelines with their ordered stages. Any member can read. */
pipelineStagesRouter.get(
  "/pipelines",
  asyncHandler(async (req: AuthedRequest, res) => {
    const pipelines = await ensurePipelines(prisma, orgId(req));
    const out = [];
    for (const p of pipelines) out.push({ ...serializePipeline(p), stages: (await ensureStages(prisma, orgId(req), p.id)).map(serialize) });
    res.json(out);
  }),
);

// Create a pipeline (seeded with the default stage set incl. Closed/Dead).
pipelineStagesRouter.post(
  "/pipelines",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const org = orgId(req);
    const max = await prisma.pipeline.aggregate({ where: { organizationId: org }, _max: { position: true } });
    const p = await prisma.pipeline.create({ data: { organizationId: org, name, position: (max._max.position ?? 0) + 1 } });
    await seedStages(prisma, org, p.id);
    const stages = await ensureStages(prisma, org, p.id);
    res.status(201).json({ ...serializePipeline(p), stages: stages.map(serialize) });
  }),
);

// Rename a pipeline.
pipelineStagesRouter.patch(
  "/pipelines/:id",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const p = await prisma.pipeline.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!p) throw new HttpError(404, "Pipeline not found");
    const out = await prisma.pipeline.update({ where: { id: p.id }, data: { name } });
    res.json(serializePipeline(out));
  }),
);

// Delete a user-created pipeline. The default pipeline is permanent. Deals move
// to the default pipeline: Closed/Dead keep their stage (those keys exist in
// every pipeline); everything else lands in the default's first active stage.
pipelineStagesRouter.delete(
  "/pipelines/:id",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const p = await prisma.pipeline.findFirst({ where: { id: req.params.id, organizationId: org } });
    if (!p) throw new HttpError(404, "Pipeline not found");
    if (p.isDefault) throw new HttpError(400, "The default pipeline cannot be deleted");
    const def = await ensureDefaultPipeline(prisma, org);
    const fallbackKey = await firstActiveStageKey(prisma, org, def.id);
    await prisma.$transaction([
      // Terminal deals keep their stage; active deals restart in the default's first stage.
      prisma.deal.updateMany({
        where: { organizationId: org, pipelineId: p.id, stage: { notIn: [...TERMINAL_STAGE_KEYS] } },
        data: { pipelineId: def.id, stage: fallbackKey },
      }),
      prisma.deal.updateMany({
        where: { organizationId: org, pipelineId: p.id, stage: { in: [...TERMINAL_STAGE_KEYS] } },
        data: { pipelineId: def.id },
      }),
      prisma.pipeline.delete({ where: { id: p.id } }), // stages cascade
    ]);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Stages (scoped to a pipeline; default pipeline when pipelineId is absent)
// ---------------------------------------------------------------------------

/** A pipeline's stages (ordered). Any authenticated member can read them. */
pipelineStagesRouter.get(
  "/stages",
  asyncHandler(async (req: AuthedRequest, res) => {
    const p = await resolvePipeline(req);
    const stages = await ensureStages(prisma, orgId(req), p.id);
    res.json(stages.map(serialize));
  }),
);

// Add a custom active stage (appended after the existing active stages).
pipelineStagesRouter.post(
  "/stages",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { label } = z.object({ label: z.string().trim().min(1).max(60), pipelineId: z.string().optional() }).parse(req.body);
    const p = await resolvePipeline(req);
    const stages = await ensureStages(prisma, orgId(req), p.id);
    const activeCount = stages.filter((s) => !s.isTerminal).length;
    const key = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await prisma.pipelineStage.create({ data: { organizationId: orgId(req), pipelineId: p.id, key, label, position: activeCount, isTerminal: false } });
    await renumber(p.id);
    const out = await prisma.pipelineStage.findMany({ where: { pipelineId: p.id }, orderBy: { position: "asc" } });
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
    const out = await prisma.pipelineStage.findMany({ where: { pipelineId: stage.pipelineId }, orderBy: { position: "asc" } });
    res.json(out.map(serialize));
  }),
);

// Reorder the active stages (ids in desired order). Terminals always stay last.
pipelineStagesRouter.post(
  "/stages/reorder",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { order } = z.object({ order: z.array(z.string()).min(1), pipelineId: z.string().optional() }).parse(req.body);
    const p = await resolvePipeline(req);
    const stages = await ensureStages(prisma, orgId(req), p.id);
    const byId = new Map(stages.map((s) => [s.id, s]));
    let pos = 0;
    const updates = [] as ReturnType<typeof prisma.pipelineStage.update>[];
    for (const id of order) {
      const s = byId.get(id);
      if (s && !s.isTerminal) updates.push(prisma.pipelineStage.update({ where: { id }, data: { position: pos++ } }));
    }
    for (const s of stages.filter((x) => x.isTerminal)) updates.push(prisma.pipelineStage.update({ where: { id: s.id }, data: { position: pos++ } }));
    await prisma.$transaction(updates);
    await renumber(p.id);
    const out = await prisma.pipelineStage.findMany({ where: { pipelineId: p.id }, orderBy: { position: "asc" } });
    res.json(out.map(serialize));
  }),
);

// Remove a custom/active stage. Terminals are locked; you can't remove the last
// active stage. Deals sitting in the removed stage move to the first active one.
pipelineStagesRouter.delete(
  "/stages/:id",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const stage = await prisma.pipelineStage.findFirst({ where: { id: req.params.id, organizationId: org } });
    if (!stage) throw new HttpError(404, "Stage not found");
    if (stage.isTerminal) throw new HttpError(400, "Closed and Dead are permanent system stages and cannot be removed");
    const p = stage.pipelineId
      ? await prisma.pipeline.findFirst({ where: { id: stage.pipelineId, organizationId: org } })
      : await ensureDefaultPipeline(prisma, org);
    if (!p) throw new HttpError(404, "Pipeline not found");
    const stages = await ensureStages(prisma, org, p.id);
    const remainingActive = stages.filter((s) => !s.isTerminal && s.id !== stage.id);
    if (remainingActive.length === 0) throw new HttpError(400, "At least one active stage is required");
    const fallbackKey = remainingActive[0].key;
    await prisma.$transaction([
      prisma.deal.updateMany({ where: { ...dealsOfPipeline(org, p), stage: stage.key }, data: { stage: fallbackKey } }),
      prisma.pipelineStage.delete({ where: { id: stage.id } }),
    ]);
    await renumber(p.id);
    const out = await prisma.pipelineStage.findMany({ where: { pipelineId: p.id }, orderBy: { position: "asc" } });
    res.json(out.map(serialize));
  }),
);
