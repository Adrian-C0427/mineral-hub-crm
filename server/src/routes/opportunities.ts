import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { logActivity } from "../services/activityLog.js";
import { ensureStages, ensureDefaultPipeline, activeStageKeys, isOpportunityPipeline } from "../domain/stages.js";
import { parseDayKey } from "../domain/calendar.js";
import {
  OPPORTUNITY_ACTIVITY_KINDS,
  convertedDealFields,
  convertedSeller,
  serializeOpportunity,
  serializeOpportunitySummary,
} from "../domain/opportunities.js";
import { dealDetail } from "./deals.js";

/**
 * Opportunities: lightweight prospects that live in an OPPORTUNITIES pipeline
 * (never Deals). Viewing uses the deal permissions (viewDeals / editDeals) —
 * an opportunity is a deal-in-waiting, not a separate module.
 */
export const opportunitiesRouter = Router();
opportunitiesRouter.use(requireAuth, requireOrg);

type Tx = Prisma.TransactionClient | typeof prisma;

const userSelect = { select: { id: true, name: true } } as const;
const summaryInclude = { owner: userSelect } as const;
const detailInclude = {
  owner: userSelect,
  contact: { select: { id: true, firstName: true, lastName: true, entityName: true, phone: true, email: true } },
  convertedDeal: { select: { id: true, name: true, stage: true } },
  stageHistory: { orderBy: { createdAt: "asc" as const } },
  activities: { orderBy: { createdAt: "desc" as const } },
} as const;

/** Full `Opp` payload. History/activity rows store bare user ids, so the
 *  names are resolved in one lookup. Cross-org ids read as 404. */
async function loadOpportunity(tx: Tx, organizationId: string, id: string) {
  const o = await tx.opportunity.findFirst({ where: { id, organizationId }, include: detailInclude });
  if (!o) throw new HttpError(404, "Opportunity not found");
  const userIds = new Set<string>();
  for (const h of o.stageHistory) if (h.changedByUserId) userIds.add(h.changedByUserId);
  for (const a of o.activities) if (a.createdByUserId) userIds.add(a.createdByUserId);
  const users = userIds.size
    ? await tx.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return serializeOpportunity({
    ...o,
    stageHistory: o.stageHistory.map((h) => ({ ...h, changedBy: h.changedByUserId ? byId.get(h.changedByUserId) ?? null : null })),
    activities: o.activities.map((a) => ({ ...a, createdBy: a.createdByUserId ? byId.get(a.createdByUserId) ?? null : null })),
  });
}

/** The caller's opportunity (summary row) or 404. */
async function ownOpportunity(req: AuthedRequest) {
  const o = await prisma.opportunity.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, include: { pipeline: true } });
  if (!o) throw new HttpError(404, "Opportunity not found");
  return o;
}

/** An OPPORTUNITIES pipeline of the caller's org, or 400. */
async function requireOpportunityPipeline(organizationId: string, pipelineId: string) {
  const p = await prisma.pipeline.findFirst({ where: { id: pipelineId, organizationId } });
  if (!p) throw new HttpError(400, "Unknown pipeline");
  if (!isOpportunityPipeline(p)) throw new HttpError(400, "That pipeline holds deals, not opportunities");
  return p;
}

async function validateOwner(organizationId: string, ownerId: string): Promise<void> {
  const u = await prisma.user.findFirst({ where: { id: ownerId, organizationId }, select: { id: true } });
  if (!u) throw new HttpError(400, "Owner is not in your organization");
}

async function validateContact(organizationId: string, contactId: string): Promise<void> {
  const c = await prisma.contact.findFirst({ where: { id: contactId, organizationId }, select: { id: true } });
  if (!c) throw new HttpError(400, "Contact not found in your organization");
}

// "YYYY-MM-DD" (a calendar day, stored at UTC midnight like task due dates).
const dayField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish();
function toDay(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = parseDayKey(v);
  if (!d) throw new HttpError(400, "Invalid follow-up date");
  return d;
}

const text = (max: number) => z.string().trim().max(max).nullish();
const editableFields = {
  ownerId: z.string().max(200).nullish(),
  contactId: z.string().max(200).nullish(),
  sellerName: text(200),
  companyName: text(200),
  phone: text(40),
  email: text(200),
  state: text(40),
  county: text(120),
  abstract: text(120),
  survey: text(200),
  estAcres: z.number().nonnegative().nullish(),
  estNma: z.number().nonnegative().nullish(),
  estNra: z.number().nonnegative().nullish(),
  source: text(200),
  notes: text(10_000),
  nextFollowUpDate: dayField,
};
const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  pipelineId: z.string().max(200),
  stage: z.string().max(200).optional(),
  ...editableFields,
});
const updateSchema = z.object({ name: z.string().trim().min(1).max(200).optional(), ...editableFields });
const EDITABLE_KEYS = ["ownerId", "contactId", "sellerName", "companyName", "phone", "email", "state", "county", "abstract", "survey", "estAcres", "estNma", "estNra", "source", "notes"] as const;

// ---------------------------------------------------------------------------
// Conversion — the one place an opportunity becomes a Deal. Runs inside the
// caller's transaction so a stage move that auto-converts is all-or-nothing.
// ---------------------------------------------------------------------------
async function convertInTx(
  tx: Prisma.TransactionClient,
  p: { organizationId: string; user: { id: string; name: string }; opportunityId: string; targetPipelineId?: string | null },
): Promise<string> {
  const opp = await tx.opportunity.findFirst({
    where: { id: p.opportunityId, organizationId: p.organizationId },
    include: { contact: true, pipeline: true },
  });
  if (!opp) throw new HttpError(404, "Opportunity not found");
  if (opp.convertedDealId) throw new HttpError(409, "This opportunity has already been converted to a deal");

  // Target: the explicit override, else the pipeline's configured deals
  // pipeline, else the org's default — always a DEALS pipeline of this org.
  let target = null as Awaited<ReturnType<typeof tx.pipeline.findFirst>>;
  if (p.targetPipelineId) {
    target = await tx.pipeline.findFirst({ where: { id: p.targetPipelineId, organizationId: p.organizationId } });
    if (!target || isOpportunityPipeline(target)) throw new HttpError(400, "Converted deals must go to a deals pipeline");
  } else if (opp.pipeline.convertToPipelineId) {
    const configured = await tx.pipeline.findFirst({ where: { id: opp.pipeline.convertToPipelineId, organizationId: p.organizationId } });
    if (configured && !isOpportunityPipeline(configured)) target = configured;
  }
  if (!target) target = await ensureDefaultPipeline(tx, p.organizationId);
  // Mirrors POST /deals: null pipelineId = the default pipeline, and a deal
  // needs an active stage to land in.
  const dealPipelineId = target.isDefault ? null : target.id;
  const activeKeys = await activeStageKeys(tx, p.organizationId, dealPipelineId);
  if (activeKeys.length === 0) throw new HttpError(400, "The deals pipeline has no stages yet — add a stage to it before converting");
  const firstStage = activeKeys[0];
  const now = new Date();

  const deal = await tx.deal.create({
    data: {
      organizationId: p.organizationId,
      pipelineId: dealPipelineId,
      ...convertedDealFields(opp, p.user.id),
      stage: firstStage,
      currentStageEnteredAt: now,
    },
    select: { id: true, name: true },
  });
  await tx.dealStageHistory.create({ data: { dealId: deal.id, fromStage: null, toStage: firstStage, changedByUserId: p.user.id } });
  await logActivity(
    { eventType: "DEAL_CREATED", summary: `${p.user.name} created deal "${deal.name}"`, organizationId: p.organizationId, actorUserId: p.user.id, dealId: deal.id },
    tx,
  );
  await logActivity(
    {
      eventType: "OPPORTUNITY_CONVERTED",
      summary: `${p.user.name} converted opportunity "${opp.name}" into a deal`,
      organizationId: p.organizationId,
      actorUserId: p.user.id,
      dealId: deal.id,
    },
    tx,
  );
  const seller = convertedSeller(opp, opp.contact);
  if (seller) await tx.dealSeller.create({ data: { dealId: deal.id, ...seller } });

  await tx.opportunity.update({ where: { id: opp.id }, data: { convertedDealId: deal.id, convertedAt: now, lastActivityAt: now } });
  await tx.opportunityActivity.create({
    data: { opportunityId: opp.id, kind: "SYSTEM", body: `Converted to deal ${deal.name}`, createdByUserId: p.user.id },
  });
  return deal.id;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Every opportunity of a pipeline (all stages, converted ones included); the
 *  whole org's when pipelineId is omitted. */
opportunitiesRouter.get(
  "/",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const pipelineId = typeof req.query.pipelineId === "string" && req.query.pipelineId ? req.query.pipelineId : undefined;
    if (pipelineId) {
      const p = await prisma.pipeline.findFirst({ where: { id: pipelineId, organizationId: org }, select: { id: true } });
      if (!p) throw new HttpError(404, "Pipeline not found");
    }
    const rows = await prisma.opportunity.findMany({
      where: { organizationId: org, ...(pipelineId ? { pipelineId } : {}) },
      include: summaryInclude,
      orderBy: [{ currentStageEnteredAt: "asc" }, { createdAt: "asc" }],
    });
    res.json(rows.map(serializeOpportunitySummary));
  }),
);

opportunitiesRouter.get(
  "/:id",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await loadOpportunity(prisma, orgId(req), req.params.id));
  }),
);

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------
opportunitiesRouter.post(
  "/",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = createSchema.parse(req.body);
    const org = orgId(req);
    const p = await requireOpportunityPipeline(org, data.pipelineId);
    const stages = await ensureStages(prisma, org, p.id);
    const stage = data.stage ?? stages.find((s) => !s.isTerminal)?.key;
    if (!stage || !stages.some((s) => s.key === stage)) throw new HttpError(400, "Unknown pipeline stage");
    if (data.ownerId) await validateOwner(org, data.ownerId);
    if (data.contactId) await validateContact(org, data.contactId);
    const now = new Date();
    const created = await prisma.$transaction(async (tx) => {
      const o = await tx.opportunity.create({
        data: {
          organizationId: org,
          name: data.name,
          pipelineId: p.id,
          stage,
          currentStageEnteredAt: now,
          ownerId: data.ownerId ?? null,
          contactId: data.contactId ?? null,
          sellerName: data.sellerName ?? null,
          companyName: data.companyName ?? null,
          phone: data.phone ?? null,
          email: data.email ?? null,
          state: data.state ?? null,
          county: data.county ?? null,
          abstract: data.abstract ?? null,
          survey: data.survey ?? null,
          estAcres: data.estAcres ?? null,
          estNma: data.estNma ?? null,
          estNra: data.estNra ?? null,
          source: data.source ?? null,
          notes: data.notes ?? null,
          nextFollowUpDate: toDay(data.nextFollowUpDate) ?? null,
          lastActivityAt: now,
          createdByUserId: req.user!.id,
        },
        select: { id: true },
      });
      await tx.opportunityStageHistory.create({ data: { opportunityId: o.id, fromStage: "", toStage: stage, changedByUserId: req.user!.id } });
      return o;
    });
    res.status(201).json(await loadOpportunity(prisma, org, created.id));
  }),
);

opportunitiesRouter.patch(
  "/:id",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = updateSchema.parse(req.body);
    const org = orgId(req);
    const o = await ownOpportunity(req);
    if (data.ownerId) await validateOwner(org, data.ownerId);
    if (data.contactId) await validateContact(org, data.contactId);
    const patch: Record<string, unknown> = { lastActivityAt: new Date() };
    if (data.name !== undefined) patch.name = data.name;
    for (const k of EDITABLE_KEYS) if (k in data) patch[k] = (data as Record<string, unknown>)[k] ?? null;
    if (data.nextFollowUpDate !== undefined) patch.nextFollowUpDate = toDay(data.nextFollowUpDate);
    await prisma.opportunity.update({ where: { id: o.id }, data: patch });
    res.json(await loadOpportunity(prisma, org, o.id));
  }),
);

opportunitiesRouter.delete(
  "/:id",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const o = await ownOpportunity(req);
    // The converted deal references this record; keep the trail.
    if (o.convertedDealId) throw new HttpError(409, "A converted opportunity cannot be deleted");
    await prisma.opportunity.delete({ where: { id: o.id } }); // history/activities cascade
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Stage move — history + stage-entered reset; terminal stages take a reason.
// Landing on the pipeline's conversion stage in AUTO mode converts in the
// same transaction. Converted opportunities are frozen.
// ---------------------------------------------------------------------------
const stageSchema = z.object({ toStage: z.string().min(1).max(200), reason: z.string().trim().max(2_000).nullish() });

opportunitiesRouter.post(
  "/:id/stage",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { toStage, reason } = stageSchema.parse(req.body);
    const org = orgId(req);
    const o = await ownOpportunity(req);
    if (o.convertedDealId) throw new HttpError(409, "This opportunity was converted to a deal and can no longer be moved");
    const stages = await ensureStages(prisma, org, o.pipelineId);
    const target = stages.find((s) => s.key === toStage);
    if (!target) throw new HttpError(400, "Unknown pipeline stage");
    if (toStage === o.stage) {
      res.json(await loadOpportunity(prisma, org, o.id));
      return;
    }
    const now = new Date();
    const user = { id: req.user!.id, name: req.user!.name };
    await prisma.$transaction(async (tx) => {
      await tx.opportunity.update({
        where: { id: o.id },
        data: {
          stage: toStage,
          currentStageEnteredAt: now,
          lastActivityAt: now,
          // The reason belongs to the terminal stage it was given for.
          closeReason: target.isTerminal ? (reason?.trim() || null) : null,
        },
      });
      await tx.opportunityStageHistory.create({
        data: { opportunityId: o.id, fromStage: o.stage, toStage, reason: reason?.trim() || null, changedByUserId: user.id },
      });
      if (!target.isTerminal && o.pipeline.convertMode === "AUTO" && o.pipeline.convertStageKey === toStage) {
        await convertInTx(tx, { organizationId: org, user, opportunityId: o.id });
      }
    });
    res.json(await loadOpportunity(prisma, org, o.id));
  }),
);

// Explicit "Convert to deal". Optional pipelineId overrides the pipeline's
// configured target (must be a DEALS pipeline of the org).
const convertSchema = z.object({ pipelineId: z.string().max(200).nullish() });

opportunitiesRouter.post(
  "/:id/convert",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { pipelineId } = convertSchema.parse(req.body ?? {});
    const org = orgId(req);
    const o = await ownOpportunity(req);
    if (o.convertedDealId) throw new HttpError(409, "This opportunity has already been converted to a deal");
    const user = { id: req.user!.id, name: req.user!.name };
    const dealId = await prisma.$transaction((tx) => convertInTx(tx, { organizationId: org, user, opportunityId: o.id, targetPipelineId: pipelineId }));
    res.json({ opportunity: await loadOpportunity(prisma, org, o.id), deal: await dealDetail(org, dealId) });
  }),
);

// ---------------------------------------------------------------------------
// Activity trail
// ---------------------------------------------------------------------------
const activitySchema = z.object({ kind: z.enum(OPPORTUNITY_ACTIVITY_KINDS), body: z.string().trim().min(1).max(4_000) });

opportunitiesRouter.post(
  "/:id/activities",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { kind, body } = activitySchema.parse(req.body);
    const o = await ownOpportunity(req);
    const now = new Date();
    const a = await prisma.$transaction(async (tx) => {
      const row = await tx.opportunityActivity.create({ data: { opportunityId: o.id, kind, body, createdByUserId: req.user!.id } });
      await tx.opportunity.update({ where: { id: o.id }, data: { lastActivityAt: now } });
      return row;
    });
    res.status(201).json({ id: a.id, kind: a.kind, body: a.body, createdBy: { id: req.user!.id, name: req.user!.name }, createdAt: a.createdAt });
  }),
);
