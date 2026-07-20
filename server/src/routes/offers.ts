import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { logActivity } from "../services/activityLog.js";

export const offersRouter = Router();
// Offers are part of a deal's negotiation — treat them as deal edits.
offersRouter.use(requireAuth, requireOrg, requirePermission("editDeals"));

const dateField = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish();

// Bound the money field (no negative/absurd offers flowing into activity
// summaries and derived metrics) and free-text; mirrors the public portal's
// offer schema.
const amountField = z.number().nonnegative().max(1e12);

const createSchema = z.object({
  dealId: z.string(),
  buyerId: z.string(),
  amount: amountField,
  conditions: z.string().max(2000).nullish(),
  expirationDate: dateField,
  parentOfferId: z.string().nullish(),
  notes: z.string().max(4000).nullish(),
});

// Creating an Offer is the "Offer Made" trigger: it also upserts the buyer
// activity to OFFER_MADE so the marketing log stays in sync.
offersRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = createSchema.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: data.dealId, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    const buyer = await prisma.buyer.findFirst({ where: { id: data.buyerId, organizationId: orgId(req) } });
    if (!buyer) throw new HttpError(404, "Buyer not found");

    const now = new Date();
    const offer = await prisma.$transaction(async (tx) => {
      const o = await tx.offer.create({
        data: {
          dealId: data.dealId,
          buyerId: data.buyerId,
          amount: data.amount,
          conditions: data.conditions ?? null,
          expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
          parentOfferId: data.parentOfferId ?? null,
          notes: data.notes ?? null,
          status: "ACTIVE",
        },
      });
      if (data.parentOfferId) {
        // The parent must be an offer on THIS (org-scoped) deal — never trust a
        // caller-supplied id to point at another org's offer (IDOR write).
        const parent = await tx.offer.findFirst({
          where: { id: data.parentOfferId, dealId: data.dealId },
          select: { id: true },
        });
        if (!parent) throw new HttpError(404, "Parent offer not found on this deal");
        await tx.offer.update({ where: { id: parent.id }, data: { status: "COUNTERED" } });
      }
      await tx.dealBuyerActivity.upsert({
        where: { dealId_buyerId: { dealId: data.dealId, buyerId: data.buyerId } },
        create: {
          dealId: data.dealId,
          buyerId: data.buyerId,
          status: "OFFER_RECEIVED",
          responseReceived: true,
          offerAmount: data.amount,
          dateSent: now,
          lastActivityDate: now,
          sentByUserId: req.user!.id,
        },
        update: { status: "OFFER_RECEIVED", responseReceived: true, offerAmount: data.amount, lastActivityDate: now },
      });
      await logActivity(
        {
          eventType: "OFFER_MADE",
          summary: `${buyer.name} made an offer of $${data.amount.toLocaleString()} on "${deal.name}"`,
          organizationId: orgId(req),
          actorUserId: req.user!.id,
          dealId: deal.id,
          buyerId: buyer.id,
        },
        tx,
      );
      return o;
    });
    res.status(201).json(offer);
  }),
);

const updateSchema = z.object({
  amount: amountField.optional(),
  conditions: z.string().max(2000).nullish(),
  expirationDate: dateField,
  status: z.enum(["ACTIVE", "ACCEPTED", "REJECTED", "EXPIRED", "COUNTERED", "WITHDRAWN"]).optional(),
  notes: z.string().max(4000).nullish(),
});

offersRouter.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = updateSchema.parse(req.body);
    const patch: Record<string, unknown> = {};
    if (data.amount !== undefined) patch.amount = data.amount;
    if (data.conditions !== undefined) patch.conditions = data.conditions;
    if (data.expirationDate !== undefined) patch.expirationDate = data.expirationDate ? new Date(data.expirationDate) : null;
    if (data.status !== undefined) patch.status = data.status;
    if (data.notes !== undefined) patch.notes = data.notes;
    // Ensure the offer belongs to a deal in the caller's org.
    const owned = await prisma.offer.findFirst({ where: { id: req.params.id, deal: { organizationId: orgId(req) } } });
    if (!owned) throw new HttpError(404, "Offer not found");
    const offer = await prisma.offer.update({ where: { id: req.params.id }, data: patch });
    // Amount edits flow into every derived number at read time (best offer,
    // profit estimates, dashboard, reports) — the only STORED copy is the
    // buyer-activity offerAmount, so keep it in sync when this offer is the
    // buyer's latest.
    if (data.amount !== undefined) {
      const latest = await prisma.offer.findFirst({
        where: { dealId: owned.dealId, buyerId: owned.buyerId },
        orderBy: { dateSubmitted: "desc" },
        select: { id: true },
      });
      if (latest?.id === offer.id) {
        await prisma.dealBuyerActivity.updateMany({
          where: { dealId: owned.dealId, buyerId: owned.buyerId },
          data: { offerAmount: data.amount },
        });
      }
    }
    res.json(offer);
  }),
);

// Deleting an offer removes it from every calculation (metrics/serializers
// derive from the offers relation at read time). If it was the deal's ACCEPTED
// offer, the selection is cleared too so profit/reporting stop counting it.
offersRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const owned = await prisma.offer.findFirst({
      where: { id: req.params.id, deal: { organizationId: orgId(req) } },
      include: { deal: { select: { id: true, name: true, selectedOfferId: true } }, buyer: { select: { id: true, name: true } } },
    });
    if (!owned) throw new HttpError(404, "Offer not found");
    await prisma.$transaction(async (tx) => {
      if (owned.deal.selectedOfferId === owned.id) {
        await tx.deal.update({ where: { id: owned.deal.id }, data: { selectedOfferId: null } });
      }
      // Counters that pointed at this offer survive as stand-alone offers.
      await tx.offer.updateMany({ where: { parentOfferId: owned.id }, data: { parentOfferId: null } });
      await tx.offer.delete({ where: { id: owned.id } });
      // Keep the buyer-activity offerAmount honest: fall back to the buyer's
      // most recent remaining offer on this deal (or null when none are left).
      const remaining = await tx.offer.findFirst({
        where: { dealId: owned.dealId, buyerId: owned.buyerId },
        orderBy: { dateSubmitted: "desc" },
        select: { amount: true },
      });
      await tx.dealBuyerActivity.updateMany({
        where: { dealId: owned.dealId, buyerId: owned.buyerId },
        data: { offerAmount: remaining?.amount ?? null },
      });
      await logActivity(
        {
          eventType: "OFFER_DELETED",
          summary: `${owned.buyer.name}'s offer of $${owned.amount.toLocaleString()} on "${owned.deal.name}" was deleted`,
          organizationId: orgId(req),
          actorUserId: req.user!.id,
          dealId: owned.deal.id,
          buyerId: owned.buyer.id,
        },
        tx,
      );
    });
    res.status(204).end();
  }),
);
