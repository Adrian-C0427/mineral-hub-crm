import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, hasPermission, contactAccess, orgId, type AuthedRequest } from "../middleware/auth.js";
import { logActivity } from "../services/activityLog.js";
import { ensureStages, ensureDefaultPipeline, activeStageKeys, isOpportunityPipeline, lockStageRow } from "../domain/stages.js";
import { parseDayKey } from "../domain/calendar.js";
import {
  OPPORTUNITY_ACTIVITY_KINDS,
  convertedDealFields,
  convertedSeller,
  opportunityFieldValues,
  serializeOpportunity,
  serializeOpportunitySummary,
} from "../domain/opportunities.js";
import { dealDetail } from "./deals.js";
import { userRef, userRefSelect } from "../domain/userRef.js";
import { CONTACT_EDIT_FORBIDDEN, contactPatchFromSellerPatch, contactSyncFor, opportunitySellerFromInfo, resolveSellerContact, sellerContactSelect, sellerInfoSchema, type ContactAccess, type SellerInfo } from "../domain/sellerContact.js";
import { splitPersonName } from "../domain/opportunities.js";

/**
 * Opportunities: lightweight prospects that live in an OPPORTUNITIES pipeline
 * (never Deals). Viewing uses the deal permissions (viewDeals / editDeals) —
 * an opportunity is a deal-in-waiting, not a separate module. Converting one
 * (explicitly, or by an AUTO-convert stage move) creates a Deal, so it also
 * needs createDeals — the same gate as POST /deals.
 */
export const opportunitiesRouter = Router();
opportunitiesRouter.use(requireAuth, requireOrg);

type Tx = Prisma.TransactionClient | typeof prisma;

const userSelect = { select: userRefSelect } as const;
const summaryInclude = { owner: userSelect } as const;
const detailInclude = {
  owner: userSelect,
  contact: { select: sellerContactSelect },
  convertedDeal: { select: { id: true, name: true, stage: true } },
  stageHistory: { orderBy: { createdAt: "asc" as const } },
  activities: { orderBy: { createdAt: "desc" as const } },
  // Documents: current versions only (prior versions via /files/:id/versions).
  files: {
    where: { supersededById: null },
    include: { uploadedBy: { select: userRefSelect }, _count: { select: { supersedes: true } } },
    orderBy: { createdAt: "desc" as const },
  },
} as const;

/** Full `Opp` payload. History/activity rows store bare user ids, so the
 *  names are resolved in one lookup. Cross-org ids read as 404. */
async function loadOpportunity(tx: Tx, organizationId: string, id: string, req: AuthedRequest) {
  const o = await tx.opportunity.findFirst({ where: { id, organizationId }, include: detailInclude });
  if (!o) throw new HttpError(404, "Opportunity not found");
  const userIds = new Set<string>();
  for (const h of o.stageHistory) if (h.changedByUserId) userIds.add(h.changedByUserId);
  for (const a of o.activities) if (a.createdByUserId) userIds.add(a.createdByUserId);
  const users = userIds.size
    ? await tx.user.findMany({ where: { id: { in: [...userIds] } }, select: userRefSelect })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const out = serializeOpportunity({
    ...o,
    stageHistory: o.stageHistory.map((h) => ({ ...h, changedBy: h.changedByUserId ? byId.get(h.changedByUserId) ?? null : null })),
    activities: o.activities.map((a) => ({ ...a, createdBy: a.createdByUserId ? byId.get(a.createdByUserId) ?? null : null })),
  });
  // The LINKED Contact record's phone/email/mailing address are contact data:
  // shown only to callers who may view contacts (the opportunity's own fields
  // are its own).
  if (out.contact && !hasPermission(req, "viewContacts")) {
    out.contact = { ...out.contact, phone: null, email: null, mailingStreet: null, mailingCity: null, mailingState: null, mailingZip: null };
  }
  return out;
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
  // The seller (required): an existing Contact or the details of one, resolved
  // to a Contact and linked in the same transaction (domain/sellerContact.ts).
  // It also fills the plain seller columns (sellerName/companyName/phone/email).
  seller: sellerInfoSchema.optional(),
});
// Same field rules as create. The pipeline and stage are not edited here: a
// stage change goes through POST /:id/stage (history, terminal reasons, AUTO
// conversion) and an opportunity stays in the pipeline it was created in.
const updateSchema = z.object({ name: z.string().trim().min(1).max(200).optional(), ...editableFields, seller: sellerInfoSchema.optional() });

/** Seller edits mirrored onto the linked Contact: the plain columns a PATCH
 *  names, as Contact fields (a seller name splits into first/last). */
function contactSyncFromOppPatch(f: { sellerName?: string | null; companyName?: string | null; phone?: string | null; email?: string | null }) {
  const name = f.sellerName !== undefined ? splitPersonName(f.sellerName) : null;
  return contactPatchFromSellerPatch({
    ...(name ? { firstName: name.firstName, lastName: name.lastName } : {}),
    ...(f.companyName !== undefined ? { companyName: f.companyName } : {}),
    ...(f.phone !== undefined ? { primaryPhone: f.phone } : {}),
    ...(f.email !== undefined ? { email: f.email } : {}),
  });
}

/** Mirror a seller edit onto its linked Contact as this caller may
 *  (domain/sellerContact.ts contactSyncFor): changed fields only, refused
 *  without "Manage contacts". */
async function applyContactSync(tx: Tx, access: ContactAccess, patch: Prisma.ContactUpdateInput, contact: Parameters<typeof contactSyncFor>[2]) {
  const sync = contactSyncFor(access, patch, contact);
  if (!sync) throw new HttpError(403, CONTACT_EDIT_FORBIDDEN);
  if (Object.keys(sync).length) await tx.contact.update({ where: { id: contact.id }, data: sync });
}

/** Validated editable columns of a create/PATCH body (blank → null; the
 *  owner and contact must belong to the caller's org). */
async function editableValues(organizationId: string, data: z.infer<typeof updateSchema>) {
  const fields = opportunityFieldValues(data);
  if (fields.ownerId) await validateOwner(organizationId, fields.ownerId);
  if (fields.contactId) await validateContact(organizationId, fields.contactId);
  return fields;
}

// ---------------------------------------------------------------------------
// Conversion — the one place an opportunity becomes a Deal. Runs inside the
// caller's transaction so a stage move that auto-converts is all-or-nothing.
// ---------------------------------------------------------------------------
async function convertInTx(
  tx: Prisma.TransactionClient,
  p: { organizationId: string; user: { id: string; name: string }; opportunityId: string; targetPipelineId?: string | null; viewContacts: boolean },
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
  const seller = convertedSeller(opp, opp.contact, p.viewContacts);
  if (seller) await tx.dealSeller.create({ data: { dealId: deal.id, ...seller } });

  await tx.opportunity.update({ where: { id: opp.id }, data: { convertedDealId: deal.id, convertedAt: now, lastActivityAt: now } });
  await tx.opportunityActivity.create({
    data: { opportunityId: opp.id, kind: "SYSTEM", body: `Converted to deal ${deal.name}`, createdByUserId: p.user.id },
  });
  return deal.id;
}

// ---------------------------------------------------------------------------
// Document folders — same contract as POST /deals/:id/doc-folders (the client's
// shared Documents section): rename / remove / reorder the opportunity's folder
// list; "Other" is the fallback folder and can't be renamed or removed.
// ---------------------------------------------------------------------------
const folderName = z.string().trim().min(1).max(80);
const folderListSchema = z.array(folderName).min(1).max(30)
  .refine((xs) => new Set(xs.map((x) => x.toLowerCase())).size === xs.length, "Folder names must be unique")
  .refine((xs) => xs.includes("Other"), "The Other folder is required");
const folderOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("reorder"), folders: folderListSchema }),
  z.object({ op: z.literal("rename"), from: folderName, to: folderName, folders: folderListSchema }),
  z.object({ op: z.literal("remove"), name: folderName, folders: folderListSchema }),
]);

opportunitiesRouter.post(
  "/:id/doc-folders",
  requirePermission("manageDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const o = await prisma.opportunity.findFirst({ where: { id: req.params.id, organizationId: org }, select: { id: true } });
    if (!o) throw new HttpError(404, "Opportunity not found");
    const body = folderOpSchema.parse(req.body);
    if (body.op === "rename") {
      if (body.from === "Other") throw new HttpError(400, "The Other folder can't be renamed — it's where unfiled documents live.");
      await prisma.$transaction([
        prisma.opportunity.update({ where: { id: o.id }, data: { docFolders: body.folders } }),
        prisma.fileAttachment.updateMany({ where: { opportunityId: o.id, folder: body.from }, data: { folder: body.to } }),
      ]);
    } else if (body.op === "remove") {
      if (body.name === "Other") throw new HttpError(400, "The Other folder can't be removed — it's where unfiled documents live.");
      await prisma.$transaction([
        prisma.opportunity.update({ where: { id: o.id }, data: { docFolders: body.folders } }),
        prisma.fileAttachment.updateMany({ where: { opportunityId: o.id, folder: body.name }, data: { folder: "Other" } }),
      ]);
    } else {
      await prisma.opportunity.update({ where: { id: o.id }, data: { docFolders: body.folders } });
    }
    res.json({ docFolders: body.folders });
  }),
);

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Hard ceiling on one board load. A board past this is truncated and says so
 *  in the X-Result-Truncated header rather than dumping an unbounded list. */
export const OPPORTUNITY_LIST_MAX = 5_000;

/** Every opportunity of one pipeline (all stages, converted ones included).
 *  pipelineId is required: there is no org-wide dump of the prospect list. */
opportunitiesRouter.get(
  "/",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const pipelineId = typeof req.query.pipelineId === "string" && req.query.pipelineId ? req.query.pipelineId : undefined;
    if (!pipelineId) throw new HttpError(400, "pipelineId is required");
    const p = await prisma.pipeline.findFirst({ where: { id: pipelineId, organizationId: org }, select: { id: true } });
    if (!p) throw new HttpError(404, "Pipeline not found");
    const rows = await prisma.opportunity.findMany({
      where: { organizationId: org, pipelineId },
      include: summaryInclude,
      orderBy: [{ currentStageEnteredAt: "asc" }, { createdAt: "asc" }],
      take: OPPORTUNITY_LIST_MAX + 1,
    });
    if (rows.length > OPPORTUNITY_LIST_MAX) {
      rows.length = OPPORTUNITY_LIST_MAX;
      res.setHeader("X-Result-Truncated", "true");
    }
    res.json(rows.map(serializeOpportunitySummary));
  }),
);

opportunitiesRouter.get(
  "/:id",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await loadOpportunity(prisma, orgId(req), req.params.id, req));
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
    const fields = await editableValues(org, data);
    // An opportunity is always created with its seller — the block, or (API
    // callers) a linked contact / the plain seller columns.
    if (!data.seller && !fields.contactId && !fields.sellerName && !fields.companyName) {
      throw new HttpError(400, "Seller information is required: a seller name or entity name, or an existing contact");
    }
    const now = new Date();
    const access = contactAccess(req);
    const created = await prisma.$transaction(async (tx) => {
      // The seller: resolve to a Contact (named, matched, or created) and link
      // it, all in this transaction — no half-created opportunity or contact.
      const sellerCols = data.seller
        ? opportunitySellerFromInfo(data.seller, (await resolveSellerContact(tx, org, data.seller, {
            ownerId: fields.ownerId ?? req.user!.id, type: "PROSPECT", notFound: (m) => new HttpError(400, m), manage: access.manage,
          })).contact, access.view)
        : {};
      const o = await tx.opportunity.create({
        data: {
          organizationId: org,
          name: data.name,
          pipelineId: p.id,
          stage,
          currentStageEnteredAt: now,
          ...fields,
          ...sellerCols,
          nextFollowUpDate: toDay(data.nextFollowUpDate) ?? null,
          lastActivityAt: now,
          createdByUserId: req.user!.id,
        },
        select: { id: true },
      });
      await tx.opportunityStageHistory.create({ data: { opportunityId: o.id, fromStage: "", toStage: stage, changedByUserId: req.user!.id } });
      return o;
    });
    res.status(201).json(await loadOpportunity(prisma, org, created.id, req));
  }),
);

opportunitiesRouter.patch(
  "/:id",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = updateSchema.parse(req.body);
    // Say so rather than silently dropping a stage/pipeline the caller meant to change.
    if (req.body && typeof req.body === "object" && ("stage" in req.body || "pipelineId" in req.body)) {
      throw new HttpError(400, "Stages change with Move stage, and an opportunity stays in its pipeline");
    }
    const org = orgId(req);
    const o = await ownOpportunity(req);
    const fields = await editableValues(org, data);
    const patch: Record<string, unknown> = { lastActivityAt: new Date(), ...fields };
    if (data.name !== undefined) patch.name = data.name;
    if (data.nextFollowUpDate !== undefined) patch.nextFollowUpDate = toDay(data.nextFollowUpDate);
    const access = contactAccess(req);
    await prisma.$transaction(async (tx) => {
      if (data.seller) {
        // A seller block re-resolves the contact (link / match / create) and
        // refreshes the plain seller columns from it.
        const { contact } = await resolveSellerContact(tx, org, data.seller as SellerInfo, {
          ownerId: fields.ownerId ?? o.ownerId ?? req.user!.id, type: "PROSPECT", notFound: (m) => new HttpError(400, m), manage: access.manage,
        });
        Object.assign(patch, opportunitySellerFromInfo(data.seller as SellerInfo, contact, access.view));
        // The block's values are the shared ones: mirror them onto the contact.
        const sync = contactPatchFromSellerPatch({
          ...(data.seller.firstName != null || data.seller.lastName != null ? { firstName: data.seller.firstName, lastName: data.seller.lastName } : {}),
          ...(data.seller.companyName != null ? { companyName: data.seller.companyName } : {}),
          ...(data.seller.phone != null ? { primaryPhone: data.seller.phone } : {}),
          ...(data.seller.email != null ? { email: data.seller.email } : {}),
          ...(data.seller.mailingAddress != null ? { mailingAddress: data.seller.mailingAddress } : {}),
          ...(data.seller.mailingCity != null ? { mailingCity: data.seller.mailingCity } : {}),
          ...(data.seller.mailingState != null ? { mailingState: data.seller.mailingState } : {}),
          ...(data.seller.mailingZip != null ? { mailingZip: data.seller.mailingZip } : {}),
        });
        await applyContactSync(tx, access, sync, contact);
      } else {
        // Plain seller columns edited on a linked opportunity are the Contact's
        // shared fields too — keep the one record consistent.
        const linked = (fields.contactId as string | null | undefined) ?? (fields.contactId === null ? null : o.contactId);
        const current = linked ? await tx.contact.findFirst({ where: { id: linked, organizationId: org }, select: sellerContactSelect }) : null;
        if (current) {
          const sync = contactSyncFromOppPatch(fields as { sellerName?: string | null; companyName?: string | null; phone?: string | null; email?: string | null });
          await applyContactSync(tx, access, sync, current);
        }
      }
      await tx.opportunity.update({ where: { id: o.id }, data: patch });
    });
    res.json(await loadOpportunity(prisma, org, o.id, req));
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
      res.json(await loadOpportunity(prisma, org, o.id, req));
      return;
    }
    // Landing on the AUTO-convert stage creates a Deal: same gate as POST /deals.
    const autoConvert = !target.isTerminal && o.pipeline.convertMode === "AUTO" && o.pipeline.convertStageKey === toStage;
    if (autoConvert && !hasPermission(req, "createDeals")) {
      throw new HttpError(403, "Moving to this stage converts the opportunity into a deal, which needs permission to create deals");
    }
    const now = new Date();
    const user = { id: req.user!.id, name: req.user!.name };
    await prisma.$transaction(async (tx) => {
      // Serialize moves of one opportunity and act on the row as it is once the
      // lock is held (see lockStageRow): a concurrent move has committed by
      // then, so history records the stage it really left, and a conversion
      // that move triggered stops this one.
      await lockStageRow(tx, "Opportunity", o.id);
      const current = await tx.opportunity.findFirst({ where: { id: o.id, organizationId: org }, select: { stage: true, convertedDealId: true } });
      if (!current) throw new HttpError(404, "Opportunity not found");
      if (current.convertedDealId) throw new HttpError(409, "This opportunity was converted to a deal and can no longer be moved");
      if (current.stage === toStage) return; // a concurrent move already landed it there
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
        data: { opportunityId: o.id, fromStage: current.stage, toStage, reason: reason?.trim() || null, changedByUserId: user.id },
      });
      if (autoConvert) {
        await convertInTx(tx, { organizationId: org, user, opportunityId: o.id, viewContacts: hasPermission(req, "viewContacts") });
      }
    });
    res.json(await loadOpportunity(prisma, org, o.id, req));
  }),
);

// Explicit "Convert to deal". Optional pipelineId overrides the pipeline's
// configured target (must be a DEALS pipeline of the org).
const convertSchema = z.object({ pipelineId: z.string().max(200).nullish() });

opportunitiesRouter.post(
  "/:id/convert",
  requirePermission("editDeals"),
  requirePermission("createDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { pipelineId } = convertSchema.parse(req.body ?? {});
    const org = orgId(req);
    const o = await ownOpportunity(req);
    if (o.convertedDealId) throw new HttpError(409, "This opportunity has already been converted to a deal");
    const user = { id: req.user!.id, name: req.user!.name };
    const dealId = await prisma.$transaction((tx) => convertInTx(tx, { organizationId: org, user, opportunityId: o.id, targetPipelineId: pipelineId, viewContacts: hasPermission(req, "viewContacts") }));
    res.json({ opportunity: await loadOpportunity(prisma, org, o.id, req), deal: await dealDetail(org, dealId, hasPermission(req, "viewContacts")) });
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
