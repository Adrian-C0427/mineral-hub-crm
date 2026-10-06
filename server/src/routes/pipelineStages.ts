import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { ensureStages, ensurePipelines, ensureDefaultPipeline, seedStages, firstActiveStageKey, TERMINAL_STAGE_KEYS, PIPELINE_KINDS, isOpportunityPipeline } from "../domain/stages.js";
import { CONVERT_MODES } from "../domain/opportunities.js";
import type { Pipeline, PipelineStage } from "@prisma/client";

export const pipelineStagesRouter = Router();
pipelineStagesRouter.use(requireAuth, requireOrg);

const serialize = (s: PipelineStage) => ({ id: s.id, key: s.key, label: s.label, position: s.position, isTerminal: s.isTerminal, pipelineId: s.pipelineId, color: s.color });

// Stage colors are hex values picked in the UI ("#rrggbb").
const colorField = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish();
const serializePipeline = (p: Pipeline) => ({
  id: p.id, name: p.name, isDefault: p.isDefault, position: p.position,
  kind: p.kind, description: p.description,
  convertStageKey: p.convertStageKey, convertMode: p.convertMode, convertToPipelineId: p.convertToPipelineId,
});

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

/** The pipeline a stage row belongs to (null pipelineId = the org's default). */
async function pipelineOfStage(organizationId: string, stage: PipelineStage): Promise<Pipeline> {
  const p = stage.pipelineId
    ? await prisma.pipeline.findFirst({ where: { id: stage.pipelineId, organizationId } })
    : await ensureDefaultPipeline(prisma, organizationId);
  if (!p) throw new HttpError(404, "Pipeline not found");
  return p;
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

// Create a pipeline. New pipelines are OPPORTUNITIES (prospects) unless the
// caller asks for a DEALS pipeline; the kind is fixed for the pipeline's life.
pipelineStagesRouter.post(
  "/pipelines",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name, kind, description } = z.object({
      name: z.string().trim().min(1).max(60),
      kind: z.enum(PIPELINE_KINDS).default("OPPORTUNITIES"),
      description: z.string().trim().max(500).nullish(),
    }).parse(req.body);
    const org = orgId(req);
    const max = await prisma.pipeline.aggregate({ where: { organizationId: org }, _max: { position: true } });
    const p = await prisma.pipeline.create({ data: { organizationId: org, name, kind, description: description || null, position: (max._max.position ?? 0) + 1 } });
    // User-created DEALS pipelines start blank: only the permanent Closed/Dead
    // terminals — users build their own active stages from scratch. An
    // OPPORTUNITIES pipeline gets the opportunity starter stages.
    await seedStages(prisma, org, p.id, true, kind);
    const stages = await ensureStages(prisma, org, p.id);
    res.status(201).json({ ...serializePipeline(p), stages: stages.map(serialize) });
  }),
);

// Reorder pipelines (ids in desired order; missing ids keep relative order at the end).
pipelineStagesRouter.post(
  "/pipelines/reorder",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { order } = z.object({ order: z.array(z.string()).min(1) }).parse(req.body);
    const org = orgId(req);
    const all = await ensurePipelines(prisma, org);
    const byId = new Map(all.map((p) => [p.id, p]));
    let pos = 0;
    const updates = [];
    for (const id of order) if (byId.has(id)) { updates.push(prisma.pipeline.update({ where: { id }, data: { position: pos++ } })); byId.delete(id); }
    for (const p of byId.values()) updates.push(prisma.pipeline.update({ where: { id: p.id }, data: { position: pos++ } }));
    await prisma.$transaction(updates);
    res.json({ ok: true });
  }),
);

// Rename / describe a pipeline; opportunity pipelines also carry their
// conversion settings here. The kind is fixed at creation.
pipelineStagesRouter.patch(
  "/pipelines/:id",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z.object({
      name: z.string().trim().min(1).max(60).optional(),
      kind: z.enum(PIPELINE_KINDS).optional(),
      description: z.string().trim().max(500).nullish(),
      // Stage whose entry converts (AUTO) or offers to convert (MANUAL) an
      // opportunity; must be one of the pipeline's active stages, or null.
      convertStageKey: z.string().max(200).nullish(),
      convertMode: z.enum(CONVERT_MODES).optional(),
      // The DEALS pipeline converted deals are created in (null = default).
      convertToPipelineId: z.string().max(200).nullish(),
    }).parse(req.body);
    const org = orgId(req);
    const p = await prisma.pipeline.findFirst({ where: { id: req.params.id, organizationId: org } });
    if (!p) throw new HttpError(404, "Pipeline not found");
    if (body.kind !== undefined && body.kind !== p.kind) throw new HttpError(400, "A pipeline's kind cannot be changed after it is created");
    const data: { name?: string; description?: string | null; convertStageKey?: string | null; convertMode?: string; convertToPipelineId?: string | null } = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description || null;
    if (body.convertStageKey !== undefined) {
      if (body.convertStageKey) {
        if (!isOpportunityPipeline(p)) throw new HttpError(400, "Conversion settings apply to opportunity pipelines only");
        const stages = await ensureStages(prisma, org, p.id);
        if (!stages.some((s) => s.key === body.convertStageKey && !s.isTerminal)) throw new HttpError(400, "The conversion stage must be one of this pipeline's active stages");
      }
      data.convertStageKey = body.convertStageKey || null;
    }
    if (body.convertMode !== undefined) data.convertMode = body.convertMode;
    if (body.convertToPipelineId !== undefined) {
      if (body.convertToPipelineId) {
        if (!isOpportunityPipeline(p)) throw new HttpError(400, "Conversion settings apply to opportunity pipelines only");
        const target = await prisma.pipeline.findFirst({ where: { id: body.convertToPipelineId, organizationId: org } });
        if (!target || isOpportunityPipeline(target)) throw new HttpError(400, "Converted deals must go to a deals pipeline");
      }
      data.convertToPipelineId = body.convertToPipelineId || null;
    }
    const out = await prisma.pipeline.update({ where: { id: p.id }, data });
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
    // An opportunity pipeline has nowhere to move its prospects: it must be
    // emptied first. Other opportunity pipelines that pointed converted deals
    // at this one would only ever target a DEALS pipeline, so nothing dangles.
    if (isOpportunityPipeline(p)) {
      const held = await prisma.opportunity.count({ where: { organizationId: org, pipelineId: p.id } });
      if (held > 0) throw new HttpError(400, `This pipeline still holds ${held} opportunit${held === 1 ? "y" : "ies"} — move or delete them first`);
      await prisma.pipeline.delete({ where: { id: p.id } }); // stages cascade
      res.json({ ok: true });
      return;
    }
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
    const { label, color } = z.object({ label: z.string().trim().min(1).max(60), color: colorField, pipelineId: z.string().optional() }).parse(req.body);
    const p = await resolvePipeline(req);
    const stages = await ensureStages(prisma, orgId(req), p.id);
    const activeCount = stages.filter((s) => !s.isTerminal).length;
    const key = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await prisma.pipelineStage.create({ data: { organizationId: orgId(req), pipelineId: p.id, key, label, position: activeCount, isTerminal: false, color: color ?? null } });
    await renumber(p.id);
    const out = await prisma.pipelineStage.findMany({ where: { pipelineId: p.id }, orderBy: { position: "asc" } });
    res.status(201).json(out.map(serialize));
  }),
);

// Rename / recolor a stage. In deals pipelines the terminal (Closed / Dead)
// stages are locked; an opportunity pipeline's Passed / Lost may be renamed
// and recoloured (nothing keys on their labels).
pipelineStagesRouter.patch(
  "/stages/:id",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { label, color } = z.object({ label: z.string().trim().min(1).max(60).optional(), color: colorField }).parse(req.body);
    const stage = await prisma.pipelineStage.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!stage) throw new HttpError(404, "Stage not found");
    if (stage.isTerminal && !isOpportunityPipeline(await pipelineOfStage(orgId(req), stage))) {
      throw new HttpError(400, "Closed and Dead are permanent system stages and cannot be changed");
    }
    await prisma.pipelineStage.update({
      where: { id: stage.id },
      data: { ...(label !== undefined ? { label } : {}), ...(color !== undefined ? { color } : {}) },
    });
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
// Opportunity pipelines follow the same rules with their opportunities.
pipelineStagesRouter.delete(
  "/stages/:id",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const stage = await prisma.pipelineStage.findFirst({ where: { id: req.params.id, organizationId: org } });
    if (!stage) throw new HttpError(404, "Stage not found");
    const p = await pipelineOfStage(org, stage);
    if (stage.isTerminal) {
      throw new HttpError(400, isOpportunityPipeline(p)
        ? "Passed and Lost are permanent stages and cannot be removed"
        : "Closed and Dead are permanent system stages and cannot be removed");
    }
    if (isOpportunityPipeline(p)) {
      const stages = await ensureStages(prisma, org, p.id);
      const remainingActive = stages.filter((s) => !s.isTerminal && s.id !== stage.id);
      const where = { organizationId: org, pipelineId: p.id, stage: stage.key };
      if (remainingActive.length === 0) {
        const occupied = await prisma.opportunity.count({ where });
        if (occupied > 0) throw new HttpError(400, "Opportunities are still in this stage — add another stage or move them first");
      }
      const fallbackKey = remainingActive[0]?.key;
      await prisma.$transaction([
        ...(fallbackKey
          ? [prisma.opportunity.updateMany({ where, data: { stage: fallbackKey, currentStageEnteredAt: new Date() } })]
          : []),
        prisma.pipelineStage.delete({ where: { id: stage.id } }),
      ]);
      // A removed stage can no longer be the conversion trigger.
      if (p.convertStageKey === stage.key) await prisma.pipeline.update({ where: { id: p.id }, data: { convertStageKey: null } });
      await renumber(p.id);
      const out = await prisma.pipelineStage.findMany({ where: { pipelineId: p.id }, orderBy: { position: "asc" } });
      res.json(out.map(serialize));
      return;
    }
    const stages = await ensureStages(prisma, org, p.id);
    const remainingActive = stages.filter((s) => !s.isTerminal && s.id !== stage.id);
    // The default pipeline always keeps at least one active stage (new deals
    // land there). User-created pipelines may be emptied back to just
    // Closed/Dead — but never while deals still occupy the stage being
    // removed, since there'd be nowhere to move them.
    if (remainingActive.length === 0) {
      if (p.isDefault) throw new HttpError(400, "At least one active stage is required");
      const occupied = await prisma.deal.count({ where: { ...dealsOfPipeline(org, p), stage: stage.key } });
      if (occupied > 0) throw new HttpError(400, "Deals are still in this stage — add another stage or move them first");
    }
    const fallbackKey = remainingActive[0]?.key;
    await prisma.$transaction([
      ...(fallbackKey
        ? [prisma.deal.updateMany({ where: { ...dealsOfPipeline(org, p), stage: stage.key }, data: { stage: fallbackKey } })]
        : []),
      prisma.pipelineStage.delete({ where: { id: stage.id } }),
    ]);
    await renumber(p.id);
    const out = await prisma.pipelineStage.findMany({ where: { pipelineId: p.id }, orderBy: { position: "asc" } });
    res.json(out.map(serialize));
  }),
);
