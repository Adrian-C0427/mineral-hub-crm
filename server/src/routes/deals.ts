import { Router } from "express";
import { z } from "zod";
import type { Stage } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { serializeDeal } from "../serializers.js";
import { computeMatch } from "../domain/matching.js";
import { STALE_CONTACT_DAYS } from "../config.js";
import { daysUntil } from "../domain/dates.js";
import { logActivity } from "../services/activityLog.js";
import { effectiveStatus, ENGAGED_STATUSES, BUYER_STATUSES } from "../domain/buyerStatus.js";
import { sendEmail, personalize, toHtmlBody } from "../services/email.js";
import { money as fmtMoney } from "../domain/format.js";

export const dealsRouter = Router();
// All deal routes require membership in an organization and are scoped to it.
dealsRouter.use(requireAuth, requireOrg);

const STAGES: Stage[] = [
  "UNDER_CONTRACT",
  "PREPARING_PACKAGE",
  "SENT_TO_BUYERS",
  "NEGOTIATING",
  "CLOSING",
  "CLOSED",
  "DEAD",
];

const dateField = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
  .nullable()
  .optional();

function toDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return new Date(v as string);
}

const dealInclude = { selectedBuyer: true, relationshipOwner: true } as const;

// --------------------------------------------------------------------------
// List
// --------------------------------------------------------------------------
dealsRouter.get(
  "/",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const deals = await prisma.deal.findMany({
      where: { organizationId: orgId(req) },
      include: { ...dealInclude, offers: { select: { amount: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(deals.map((d) => serializeDeal(d)));
  }),
);

// --------------------------------------------------------------------------
// Create — always into UNDER_CONTRACT
// --------------------------------------------------------------------------
const createSchema = z.object({
  name: z.string().min(1),
  sellerNames: z.array(z.string()).optional(),
  counties: z.array(z.string()).optional(),
  state: z.string().nullish(),
  acreageNma: z.number().nullish(),
  nra: z.number().nullish(),
  abstractIds: z.array(z.string()).optional(),
  operator: z.string().nullish(),
  askPrice: z.number().nullish(),
  ourPrice: z.number().nullish(),
  assetTypes: z.array(z.string()).optional(),
  basins: z.array(z.string()).optional(),
  formations: z.array(z.string()).optional(),
  dateUnderContract: dateField,
  originalClosingDate: dateField,
  estimatedClosingCosts: z.number().nullish(),
  relationshipOwnerId: z.string().nullish(),
  notes: z.string().nullish(),
});

dealsRouter.post(
  "/",
  requirePermission("createDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = createSchema.parse(req.body);
    const deal = await prisma.$transaction(async (tx) => {
      const created = await tx.deal.create({
        data: {
          organizationId: orgId(req),
          name: data.name,
          sellerNames: data.sellerNames ?? [],
          counties: data.counties ?? [],
          state: data.state ?? null,
          acreageNma: data.acreageNma ?? null,
          nra: data.nra ?? null,
          abstractIds: data.abstractIds ?? [],
          operator: data.operator ?? null,
          askPrice: data.askPrice ?? null,
          ourPrice: data.ourPrice ?? null,
          assetTypes: data.assetTypes ?? [],
          basins: data.basins ?? [],
          formations: data.formations ?? [],
          dateUnderContract: toDate(data.dateUnderContract) ?? null,
          originalClosingDate: toDate(data.originalClosingDate) ?? null,
          estimatedClosingCosts: data.estimatedClosingCosts ?? null,
          relationshipOwnerId: data.relationshipOwnerId ?? req.user!.id,
          notes: data.notes ?? null,
          stage: "UNDER_CONTRACT",
          currentStageEnteredAt: new Date(),
        },
        include: dealInclude,
      });
      await tx.dealStageHistory.create({
        data: { dealId: created.id, fromStage: null, toStage: "UNDER_CONTRACT", changedByUserId: req.user!.id },
      });
      await logActivity(
        {
          eventType: "DEAL_CREATED",
          summary: `${req.user!.name} created deal "${created.name}"`,
          organizationId: orgId(req),
          actorUserId: req.user!.id,
          dealId: created.id,
        },
        tx,
      );
      return created;
    });
    res.status(201).json(serializeDeal(deal));
  }),
);

// --------------------------------------------------------------------------
// Detail
// --------------------------------------------------------------------------
dealsRouter.get(
  "/:id",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const deal = await prisma.deal.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
      include: {
        ...dealInclude,
        stageHistory: { orderBy: { createdAt: "asc" }, include: { changedBy: { select: { name: true } } } },
        offers: { include: { buyer: { select: { id: true, name: true, companyName: true } } }, orderBy: { dateSubmitted: "desc" } },
        // Only current versions; prior (superseded) versions stay reachable via /files/:id/versions.
        files: {
          where: { supersededById: null },
          include: { uploadedBy: { select: { name: true } }, _count: { select: { supersedes: true } } },
          orderBy: { createdAt: "desc" },
        },
        buyerActivity: {
          include: {
            buyer: { include: { buyBox: true } },
            sentBy: { select: { name: true } },
            assignedTeamMember: { select: { id: true, name: true } },
            messages: { orderBy: { occurredAt: "desc" }, include: { createdBy: { select: { name: true } } } },
          },
        },
      },
    });
    if (!deal) throw new HttpError(404, "Deal not found");

    const now = new Date();
    // Buyer activity rows with live match %.
    const activity = deal.buyerActivity.map((a) => {
      const match = a.buyer.buyBox
        ? computeMatch(deal, a.buyer.buyBox)
        : computeMatch(deal, emptyBox());
      return {
        id: a.id,
        buyerId: a.buyerId,
        buyerName: a.buyer.name,
        companyName: a.buyer.companyName,
        matchPercent: match.matchPercent,
        dateSent: a.dateSent,
        status: effectiveStatus(a),
        responseReceived: a.responseReceived,
        offerAmount: a.offerAmount,
        lastActivityDate: a.lastActivityDate,
        nextFollowUpDate: a.nextFollowUpDate,
        notes: a.notes,
        sentBy: a.sentBy?.name ?? null,
        assignedTeamMember: a.assignedTeamMember ? { id: a.assignedTeamMember.id, name: a.assignedTeamMember.name } : null,
        timeline: a.messages.map((m) => ({
          id: m.id,
          kind: m.kind,
          subject: m.subject,
          body: m.body,
          occurredAt: m.occurredAt,
          createdBy: m.createdBy?.name ?? null,
          threadId: m.threadId,
        })),
      };
    });

    // Metrics row.
    const buyersContacted = activity.length;
    const interested = activity.filter((a) => ENGAGED_STATUSES.includes(a.status)).length;
    const offerCount = deal.offers.length;
    const highOffer = deal.offers.reduce<number | null>((max, o) => (max == null || o.amount > max ? o.amount : max), null);

    res.json({
      ...serializeDeal(deal, now),
      stageHistory: deal.stageHistory.map((h) => ({
        id: h.id,
        fromStage: h.fromStage,
        toStage: h.toStage,
        changedBy: h.changedBy?.name ?? null,
        deadReason: h.deadReason,
        createdAt: h.createdAt,
      })),
      offers: deal.offers.map((o) => ({
        id: o.id,
        buyer: o.buyer,
        amount: o.amount,
        dateSubmitted: o.dateSubmitted,
        conditions: o.conditions,
        expirationDate: o.expirationDate,
        status: o.status,
        parentOfferId: o.parentOfferId,
        notes: o.notes,
      })),
      files: deal.files.map((f) => ({
        id: f.id,
        category: f.category,
        folder: f.folder,
        filename: f.filename,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        uploadedBy: f.uploadedBy?.name ?? null,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        versionCount: f._count.supersedes,
      })),
      buyerActivity: activity,
      metrics: { buyersContacted, interested, offers: offerCount, highOffer },
    });
  }),
);

// --------------------------------------------------------------------------
// Send the deal to selected buyers by email (CRM-side, SMTP). Each send logs a
// Buyer Activity (CONTACTED) + an EMAIL_OUT timeline entry with sender + time.
// --------------------------------------------------------------------------
const sendEmailSchema = z.object({
  buyerIds: z.array(z.string()).min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

dealsRouter.post(
  "/:id/email",
  requirePermission("sendEmail"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { buyerIds, subject, body } = sendEmailSchema.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    const buyers = await prisma.buyer.findMany({
      where: { id: { in: buyerIds }, organizationId: orgId(req) },
      select: { id: true, name: true, companyName: true, email: true },
    });

    const threadId = `deal-${deal.id}-${Date.now()}`;
    const sent: string[] = [];
    const skipped: { buyer: string; reason: string }[] = [];

    for (const b of buyers) {
      if (!b.email) { skipped.push({ buyer: b.name, reason: "no email on file" }); continue; }
      const tokens = {
        buyer: b.name, company: b.companyName, deal: deal.name,
        county: deal.counties.join(", "), askPrice: deal.askPrice != null ? fmtMoney(deal.askPrice) : "",
        sender: req.user!.name,
      };
      const finalSubject = personalize(subject, tokens);
      const finalBody = personalize(body, tokens);
      try {
        await sendEmail({ to: b.email, subject: finalSubject, html: toHtmlBody(finalBody), replyTo: req.user!.email });
      } catch (e) {
        // First failure (e.g. SMTP not configured) aborts with a clear error.
        if (sent.length === 0) throw e;
        skipped.push({ buyer: b.name, reason: e instanceof Error ? e.message : "send failed" });
        continue;
      }
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        const activity = await tx.dealBuyerActivity.upsert({
          where: { dealId_buyerId: { dealId: deal.id, buyerId: b.id } },
          create: { dealId: deal.id, buyerId: b.id, status: "CONTACTED", dateSent: now, lastActivityDate: now, sentByUserId: req.user!.id },
          update: { lastActivityDate: now },
        });
        await tx.dealBuyerMessage.create({
          data: {
            organizationId: orgId(req), dealId: deal.id, buyerId: b.id, activityId: activity.id,
            kind: "EMAIL_OUT", subject: finalSubject, body: finalBody, occurredAt: now,
            createdByUserId: req.user!.id, threadId,
          },
        });
      });
      sent.push(b.name);
    }

    await logActivity({
      eventType: "DEAL_EMAILED",
      summary: `${req.user!.name} emailed "${deal.name}" to ${sent.length} buyer(s)`,
      organizationId: orgId(req),
      actorUserId: req.user!.id,
      dealId: deal.id,
    });
    res.json({ ok: true, sent: sent.length, skipped });
  }),
);

function emptyBox() {
  return {
    states: [], counties: [], basins: [], formations: [], assetTypes: [],
    minAcreage: null, maxAcreage: null, minPrice: null, maxPrice: null,
  };
}

// --------------------------------------------------------------------------
// Match recommendations — live, every buyer, ranked, NO filters
// --------------------------------------------------------------------------
dealsRouter.get(
  "/:id/matches",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");

    const buyers = await prisma.buyer.findMany({
      where: { active: true, organizationId: orgId(req) },
      include: {
        buyBox: true,
        owners: { include: { user: { select: { id: true, name: true } } } },
      },
    });

    const now = new Date();
    const recs = await Promise.all(
      buyers.map(async (b) => {
        const match = computeMatch(deal, b.buyBox ?? emptyBox());
        // # previous deals closed with this buyer (selected buyer on a CLOSED deal).
        const closedCount = await prisma.deal.count({
          where: { selectedBuyerId: b.id, stage: "CLOSED", organizationId: orgId(req) },
        });
        const lastContact = b.lastContactDate;
        const stale = lastContact ? daysUntil(lastContact, now) < -STALE_CONTACT_DAYS : true;
        return {
          buyerId: b.id,
          buyerName: b.name,
          companyName: b.companyName,
          matchPercent: match.matchPercent,
          matching: match.matching,
          nonMatching: match.nonMatching,
          owners: b.owners.map((o) => o.user.name),
          previousDealsClosed: closedCount,
          lastContactDate: lastContact,
          stale,
        };
      }),
    );

    recs.sort((a, b) => b.matchPercent - a.matchPercent);
    res.json(recs.map((r, i) => ({ rank: i + 1, ...r })));
  }),
);

// --------------------------------------------------------------------------
// Update (characteristics + dates + overrides)
// --------------------------------------------------------------------------
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  sellerNames: z.array(z.string()).optional(),
  counties: z.array(z.string()).optional(),
  state: z.string().nullish(),
  acreageNma: z.number().nullish(),
  nra: z.number().nullish(),
  abstractIds: z.array(z.string()).optional(),
  operator: z.string().nullish(),
  askPrice: z.number().nullish(),
  ourPrice: z.number().nullish(),
  assetTypes: z.array(z.string()).optional(),
  basins: z.array(z.string()).optional(),
  formations: z.array(z.string()).optional(),
  dateUnderContract: dateField,
  originalClosingDate: dateField,
  findBuyerByDateOverride: dateField,
  finalClosingDateOverride: dateField,
  estimatedClosingCosts: z.number().nullish(),
  relationshipOwnerId: z.string().nullish(),
  notes: z.string().nullish(),
});

dealsRouter.patch(
  "/:id",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = updateSchema.parse(req.body);
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "sellerNames", "counties", "state", "acreageNma", "nra", "abstractIds", "operator", "askPrice", "ourPrice", "assetTypes", "basins", "formations", "estimatedClosingCosts", "relationshipOwnerId", "notes"] as const) {
      if (k in data) patch[k] = (data as Record<string, unknown>)[k];
    }
    for (const k of ["dateUnderContract", "originalClosingDate", "findBuyerByDateOverride", "finalClosingDateOverride"] as const) {
      if (k in data) patch[k] = toDate((data as Record<string, unknown>)[k]);
    }
    const existing = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) throw new HttpError(404, "Deal not found");
    const deal = await prisma.deal.update({ where: { id: req.params.id }, data: patch, include: dealInclude });
    res.json(serializeDeal(deal));
  }),
);

// --------------------------------------------------------------------------
// Stage change — records history; Dead requires a reason
// --------------------------------------------------------------------------
const stageSchema = z.object({
  toStage: z.enum(STAGES as [Stage, ...Stage[]]),
  deadReason: z.string().optional(),
});

dealsRouter.post(
  "/:id/stage",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { toStage, deadReason } = stageSchema.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");

    if (toStage === "DEAD" && (!deadReason || !deadReason.trim())) {
      throw new HttpError(400, "A reason is required to move a deal to Dead");
    }
    if (toStage === deal.stage) {
      res.json(serializeDeal(await reload(deal.id)));
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.deal.update({
        where: { id: deal.id },
        data: {
          stage: toStage,
          currentStageEnteredAt: new Date(),
          deadReason: toStage === "DEAD" ? deadReason!.trim() : deal.deadReason,
        },
        include: dealInclude,
      });
      await tx.dealStageHistory.create({
        data: {
          dealId: deal.id,
          fromStage: deal.stage,
          toStage,
          changedByUserId: req.user!.id,
          deadReason: toStage === "DEAD" ? deadReason!.trim() : null,
        },
      });
      await logActivity(
        {
          eventType: "STAGE_CHANGE",
          summary: `${req.user!.name} moved "${deal.name}" to ${prettyStage(toStage)}${toStage === "DEAD" ? ` (${deadReason!.trim()})` : ""}`,
          organizationId: orgId(req),
          actorUserId: req.user!.id,
          dealId: deal.id,
        },
        tx,
      );
      return u;
    });
    res.json(serializeDeal(updated));
  }),
);

// --------------------------------------------------------------------------
// Log contact / upsert buyer activity
// --------------------------------------------------------------------------
const logContactSchema = z.object({
  buyerId: z.string(),
  status: z.enum(BUYER_STATUSES as [string, ...string[]]).optional(),
  dateSent: dateField,
  offerAmount: z.number().nullish(),
  nextFollowUpDate: dateField,
  notes: z.string().nullish(),
  responseReceived: z.boolean().optional(),
  assignedTeamMemberId: z.string().nullish(),
});

dealsRouter.post(
  "/:id/activity",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = logContactSchema.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    const buyer = await prisma.buyer.findFirst({ where: { id: data.buyerId, organizationId: orgId(req) } });
    if (!buyer) throw new HttpError(404, "Buyer not found");
    if (data.assignedTeamMemberId) {
      const assignee = await prisma.user.findFirst({ where: { id: data.assignedTeamMemberId, organizationId: orgId(req) } });
      if (!assignee) throw new HttpError(400, "Assigned team member is not in your organization");
    }

    const now = new Date();
    const existing = await prisma.dealBuyerActivity.findUnique({
      where: { dealId_buyerId: { dealId: deal.id, buyerId: data.buyerId } },
      select: { status: true },
    });
    const activity = await prisma.$transaction(async (tx) => {
      const a = await tx.dealBuyerActivity.upsert({
        where: { dealId_buyerId: { dealId: deal.id, buyerId: data.buyerId } },
        create: {
          dealId: deal.id,
          buyerId: data.buyerId,
          dateSent: toDate(data.dateSent) ?? now,
          status: (data.status as never) ?? "CONTACTED",
          offerAmount: data.offerAmount ?? null,
          responseReceived: data.responseReceived ?? false,
          lastActivityDate: now,
          nextFollowUpDate: toDate(data.nextFollowUpDate) ?? null,
          notes: data.notes ?? null,
          sentByUserId: req.user!.id,
          assignedTeamMemberId: data.assignedTeamMemberId ?? null,
        },
        update: {
          status: (data.status as never) ?? undefined,
          dateSent: data.dateSent !== undefined ? toDate(data.dateSent) : undefined,
          offerAmount: data.offerAmount !== undefined ? data.offerAmount : undefined,
          responseReceived: data.responseReceived !== undefined ? data.responseReceived : undefined,
          nextFollowUpDate: data.nextFollowUpDate !== undefined ? toDate(data.nextFollowUpDate) : undefined,
          notes: data.notes !== undefined ? data.notes : undefined,
          assignedTeamMemberId: data.assignedTeamMemberId !== undefined ? data.assignedTeamMemberId : undefined,
          lastActivityDate: now,
        },
      });
      // Record a status change on the timeline when it actually changed.
      if (data.status && data.status !== existing?.status) {
        await tx.dealBuyerMessage.create({
          data: {
            organizationId: orgId(req), dealId: deal.id, buyerId: data.buyerId, activityId: a.id,
            kind: "STATUS_CHANGE", body: `Status set to ${data.status}`, occurredAt: now, createdByUserId: req.user!.id,
          },
        });
      }
      // Touch the buyer's last-contact date.
      await tx.buyer.update({ where: { id: data.buyerId }, data: { lastContactDate: now } });
      await logActivity(
        {
          eventType: "CONTACT_LOGGED",
          summary: `${req.user!.name} logged contact with ${buyer.name} on "${deal.name}"`,
          organizationId: orgId(req),
          actorUserId: req.user!.id,
          dealId: deal.id,
          buyerId: buyer.id,
        },
        tx,
      );
      return a;
    });
    res.status(201).json(activity);
  }),
);

// --------------------------------------------------------------------------
// Add a manual communication-timeline entry (phone / meeting / note / negotiation)
// --------------------------------------------------------------------------
const messageSchema = z.object({
  kind: z.enum(["PHONE", "MEETING", "NOTE", "NEGOTIATION", "EMAIL_OUT", "EMAIL_IN"]),
  subject: z.string().nullish(),
  body: z.string().min(1),
  occurredAt: dateField,
});

dealsRouter.post(
  "/:id/activity/:buyerId/messages",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = messageSchema.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    const now = new Date();
    // Ensure an activity row exists so the timeline attaches to it.
    const activity = await prisma.dealBuyerActivity.upsert({
      where: { dealId_buyerId: { dealId: deal.id, buyerId: req.params.buyerId } },
      create: { dealId: deal.id, buyerId: req.params.buyerId, status: "CONTACTED", lastActivityDate: now, sentByUserId: req.user!.id },
      update: { lastActivityDate: now },
    });
    const message = await prisma.dealBuyerMessage.create({
      data: {
        organizationId: orgId(req), dealId: deal.id, buyerId: req.params.buyerId, activityId: activity.id,
        kind: data.kind, subject: data.subject ?? null, body: data.body,
        occurredAt: toDate(data.occurredAt) ?? now, createdByUserId: req.user!.id,
      },
    });
    res.status(201).json(message);
  }),
);

// --------------------------------------------------------------------------
// Bulk "mark as contacted" from Match Recommendations
// --------------------------------------------------------------------------
dealsRouter.post(
  "/:id/contact-bulk",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { buyerIds } = z.object({ buyerIds: z.array(z.string()).min(1) }).parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    // Only buyers in this org.
    const buyers = await prisma.buyer.findMany({ where: { id: { in: buyerIds }, organizationId: orgId(req) }, select: { id: true } });
    const now = new Date();
    for (const b of buyers) {
      await prisma.dealBuyerActivity.upsert({
        where: { dealId_buyerId: { dealId: deal.id, buyerId: b.id } },
        create: { dealId: deal.id, buyerId: b.id, status: "CONTACTED", dateSent: now, lastActivityDate: now, sentByUserId: req.user!.id },
        update: { lastActivityDate: now },
      });
    }
    res.json({ ok: true, count: buyers.length });
  }),
);

// --------------------------------------------------------------------------
// Accept an offer — sets selectedBuyer/selectedOffer, does NOT change stage
// --------------------------------------------------------------------------
const acceptSchema = z.object({ offerId: z.string() });

dealsRouter.post(
  "/:id/accept-offer",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { offerId } = acceptSchema.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    const offer = await prisma.offer.findUnique({ where: { id: offerId } });
    if (!offer || offer.dealId !== req.params.id) throw new HttpError(404, "Offer not found on this deal");

    const updated = await prisma.$transaction(async (tx) => {
      await tx.offer.update({ where: { id: offerId }, data: { status: "ACCEPTED" } });
      const u = await tx.deal.update({
        where: { id: req.params.id },
        data: { selectedBuyerId: offer.buyerId, selectedOfferId: offerId },
        include: dealInclude,
      });
      await logActivity(
        {
          eventType: "OFFER_ACCEPTED",
          summary: `${req.user!.name} accepted an offer on "${u.name}"`,
          organizationId: orgId(req),
          actorUserId: req.user!.id,
          dealId: u.id,
          buyerId: offer.buyerId,
        },
        tx,
      );
      return u;
    });
    res.json(serializeDeal(updated));
  }),
);

// --------------------------------------------------------------------------
// Delete — any organization member may delete their org's records
// --------------------------------------------------------------------------
dealsRouter.delete(
  "/:id",
  requirePermission("deleteDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const result = await prisma.deal.deleteMany({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (result.count === 0) throw new HttpError(404, "Deal not found");
    res.json({ ok: true });
  }),
);

async function reload(id: string) {
  const d = await prisma.deal.findUniqueOrThrow({ where: { id }, include: dealInclude });
  return d;
}

function prettyStage(s: Stage): string {
  return s.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}
