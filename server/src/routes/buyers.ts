import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOwner, type AuthedRequest } from "../middleware/auth.js";
import { normalizeCompany } from "../serializers.js";
import { closeRate } from "../domain/metrics.js";
import { importRouter } from "./import.js";

export const buyersRouter = Router();
buyersRouter.use(requireAuth);

const dateField = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish();
function toDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return new Date(v as string);
}

// CSV import lives under /buyers/import (no separate Import page/route).
buyersRouter.use("/import", importRouter);

/** Per-buyer close rate: closed-won deals ÷ deals where buyer made an offer. */
async function buyerCloseRate(buyerId: string): Promise<{ rate: number; closedWon: number; dealsWithOffer: number }> {
  const closedWon = await prisma.deal.count({ where: { selectedBuyerId: buyerId, stage: "CLOSED" } });
  const offerDeals = await prisma.offer.findMany({ where: { buyerId }, select: { dealId: true }, distinct: ["dealId"] });
  const dealsWithOffer = offerDeals.length;
  return { rate: closeRate(closedWon, dealsWithOffer), closedWon, dealsWithOffer };
}

function focusArea(box: { states: string[]; counties: string[]; basins: string[] } | null): string {
  if (!box) return "—";
  const parts: string[] = [];
  if (box.counties.length) parts.push(box.counties.slice(0, 2).join(", ") + (box.counties.length > 2 ? "…" : ""));
  else if (box.states.length) parts.push(box.states.join(", "));
  else if (box.basins.length) parts.push(box.basins.join(", "));
  return parts.length ? parts.join(" / ") : "—";
}

// --------------------------------------------------------------------------
// List (simplified table)
// --------------------------------------------------------------------------
buyersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const buyers = await prisma.buyer.findMany({
      include: { buyBox: true },
      orderBy: { companyName: "asc" },
    });
    const rows = await Promise.all(
      buyers.map(async (b) => {
        const cr = await buyerCloseRate(b.id);
        return {
          id: b.id,
          name: b.name,
          companyName: b.companyName,
          focusArea: focusArea(b.buyBox),
          relationshipStatus: b.relationshipStatus,
          closeRate: cr.rate,
          closedDeals: cr.closedWon,
          active: b.active,
        };
      }),
    );
    res.json(rows);
  }),
);

// --------------------------------------------------------------------------
// Profile detail
// --------------------------------------------------------------------------
buyersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = await prisma.buyer.findUnique({
      where: { id: req.params.id },
      include: {
        buyBox: true,
        owners: { include: { user: { select: { id: true, name: true } } } },
        tags: { include: { tag: true } },
      },
    });
    if (!b) throw new HttpError(404, "Buyer not found");
    const cr = await buyerCloseRate(b.id);

    // Deal history: every deal this buyer has activity on (clickable rows).
    const activity = await prisma.dealBuyerActivity.findMany({
      where: { buyerId: b.id },
      include: { deal: { include: { selectedOffer: true } } },
      orderBy: { lastActivityDate: "desc" },
    });
    const dealHistory = activity.map((a) => {
      const isSelected = a.deal.selectedBuyerId === b.id;
      const amount = isSelected ? a.deal.selectedOffer?.amount ?? a.offerAmount : a.offerAmount;
      return {
        dealId: a.dealId,
        dealName: a.deal.name,
        stage: a.deal.stage,
        responseStatus: a.responseStatus,
        amount: amount ?? null,
        isSelectedBuyer: isSelected,
        date: a.lastActivityDate ?? a.dateSent ?? a.createdAt,
      };
    });

    res.json({
      id: b.id,
      name: b.name,
      companyName: b.companyName,
      contactName: b.contactName,
      email: b.email,
      phone: b.phone,
      website: b.website,
      mailingAddress: b.mailingAddress,
      relationshipStatus: b.relationshipStatus,
      lastContactDate: b.lastContactDate,
      nextFollowUpDate: b.nextFollowUpDate,
      notes: b.notes,
      active: b.active,
      owners: b.owners.map((o) => ({ id: o.user.id, name: o.user.name })),
      tags: b.tags.map((t) => ({ id: t.tag.id, name: t.tag.name })),
      buyBox: b.buyBox ?? {
        states: [], counties: [], basins: [], formations: [], assetTypes: [],
        minAcreage: null, maxAcreage: null, minPrice: null, maxPrice: null,
      },
      closeRate: cr.rate,
      closedDeals: cr.closedWon,
      dealsWithOffer: cr.dealsWithOffer,
      dealHistory,
    });
  }),
);

const buyBoxSchema = z.object({
  states: z.array(z.string()).default([]),
  counties: z.array(z.string()).default([]),
  basins: z.array(z.string()).default([]),
  formations: z.array(z.string()).default([]),
  assetTypes: z.array(z.string()).default([]),
  minAcreage: z.number().nullish(),
  maxAcreage: z.number().nullish(),
  minPrice: z.number().nullish(),
  maxPrice: z.number().nullish(),
});

const upsertSchema = z.object({
  name: z.string().min(1),
  companyName: z.string().min(1),
  contactName: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal("")),
  phone: z.string().nullish(),
  website: z.string().nullish(),
  mailingAddress: z.string().nullish(),
  relationshipStatus: z.enum(["HOT", "WARM", "COLD"]).optional(),
  lastContactDate: dateField,
  nextFollowUpDate: dateField,
  notes: z.string().nullish(),
  active: z.boolean().optional(),
  ownerIds: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  buyBox: buyBoxSchema.optional(),
});

// --------------------------------------------------------------------------
// Create
// --------------------------------------------------------------------------
buyersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = upsertSchema.parse(req.body);
    const buyer = await prisma.$transaction(async (tx) => {
      const created = await tx.buyer.create({
        data: {
          name: data.name,
          companyName: data.companyName,
          normalizedCompany: normalizeCompany(data.companyName),
          contactName: data.contactName ?? null,
          email: data.email ? data.email.toLowerCase() : null,
          phone: data.phone ?? null,
          website: data.website ?? null,
          mailingAddress: data.mailingAddress ?? null,
          relationshipStatus: data.relationshipStatus ?? "WARM",
          lastContactDate: toDate(data.lastContactDate) ?? null,
          nextFollowUpDate: toDate(data.nextFollowUpDate) ?? null,
          notes: data.notes ?? null,
          buyBox: { create: data.buyBox ?? {} },
        },
      });
      await syncOwners(tx, created.id, data.ownerIds ?? []);
      await syncTags(tx, created.id, data.tags ?? []);
      return created;
    });
    res.status(201).json({ id: buyer.id });
  }),
);

// --------------------------------------------------------------------------
// Whole-profile update — single Save commits everything in one request
// --------------------------------------------------------------------------
buyersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = upsertSchema.partial({ name: true, companyName: true }).parse(req.body);
    await prisma.$transaction(async (tx) => {
      const patch: Record<string, unknown> = {};
      if (data.name !== undefined) patch.name = data.name;
      if (data.companyName !== undefined) {
        patch.companyName = data.companyName;
        patch.normalizedCompany = normalizeCompany(data.companyName);
      }
      if (data.contactName !== undefined) patch.contactName = data.contactName;
      if (data.email !== undefined) patch.email = data.email ? data.email.toLowerCase() : null;
      if (data.phone !== undefined) patch.phone = data.phone;
      if (data.website !== undefined) patch.website = data.website;
      if (data.mailingAddress !== undefined) patch.mailingAddress = data.mailingAddress;
      if (data.relationshipStatus !== undefined) patch.relationshipStatus = data.relationshipStatus;
      if (data.lastContactDate !== undefined) patch.lastContactDate = toDate(data.lastContactDate);
      if (data.nextFollowUpDate !== undefined) patch.nextFollowUpDate = toDate(data.nextFollowUpDate);
      if (data.notes !== undefined) patch.notes = data.notes;
      if (data.active !== undefined) patch.active = data.active;
      await tx.buyer.update({ where: { id: req.params.id }, data: patch });

      if (data.buyBox) {
        await tx.buyBoxCriteria.upsert({
          where: { buyerId: req.params.id },
          create: { buyerId: req.params.id, ...data.buyBox },
          update: data.buyBox,
        });
      }
      if (data.ownerIds) await syncOwners(tx, req.params.id, data.ownerIds);
      if (data.tags) await syncTags(tx, req.params.id, data.tags);
    });
    res.json({ ok: true });
  }),
);

buyersRouter.delete(
  "/:id",
  requireOwner,
  asyncHandler(async (req, res) => {
    await prisma.buyer.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

async function syncOwners(tx: any, buyerId: string, userIds: string[]) {
  await tx.buyerOwner.deleteMany({ where: { buyerId } });
  if (userIds.length) {
    await tx.buyerOwner.createMany({ data: userIds.map((userId) => ({ buyerId, userId })), skipDuplicates: true });
  }
}

async function syncTags(tx: any, buyerId: string, tagNames: string[]) {
  await tx.buyerTagOnBuyer.deleteMany({ where: { buyerId } });
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;
    const tag = await tx.buyerTag.upsert({ where: { name }, create: { name }, update: {} });
    await tx.buyerTagOnBuyer.create({ data: { buyerId, tagId: tag.id } });
  }
}
