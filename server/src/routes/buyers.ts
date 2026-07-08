import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { normalizeCompany } from "../serializers.js";
import { normalizePhone } from "../domain/phone.js";
import { effectiveStatus } from "../domain/buyerStatus.js";
import { closeRate } from "../domain/metrics.js";
import { normalizeEntity } from "../domain/research.js";
import { entityNetwork, ENTITY_CLASS_LABEL, type TxEdge } from "../domain/researchGraph.js";
import { importRouter } from "./import.js";

export const buyersRouter = Router();
buyersRouter.use(requireAuth, requireOrg);

const dateField = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish();
function toDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return new Date(v as string);
}

// CSV import lives under /buyers/import (no separate Import page/route).
buyersRouter.use("/import", requirePermission("createBuyers"), importRouter);

/** Per-buyer close rate: closed-won deals ÷ deals where buyer made an offer. */
async function buyerCloseRate(buyerId: string, organizationId: string): Promise<{ rate: number; closedWon: number; dealsWithOffer: number }> {
  const closedWon = await prisma.deal.count({ where: { selectedBuyerId: buyerId, stage: "CLOSED", organizationId } });
  const offerDeals = await prisma.offer.findMany({ where: { buyerId, deal: { organizationId } }, select: { dealId: true }, distinct: ["dealId"] });
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
  requirePermission("viewBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const buyers = await prisma.buyer.findMany({
      where: { organizationId: orgId(req) },
      include: { buyBox: true },
      orderBy: { companyName: "asc" },
    });
    const rows = await Promise.all(
      buyers.map(async (b) => {
        const cr = await buyerCloseRate(b.id, orgId(req));
        return {
          id: b.id,
          name: b.name,
          companyName: b.companyName,
          contactName: b.contactName,
          focusArea: focusArea(b.buyBox),
          relationshipStatus: b.relationshipStatus,
          closeRate: cr.rate,
          closedDeals: cr.closedWon,
          active: b.active,
          // Provenance flags so portal leads and review-needed profiles are
          // visually distinguishable in the list.
          source: b.source,
          portalLead: b.portalSubmittedAt != null,
          duplicateReview: b.duplicateReview,
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
  requirePermission("viewBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const b = await prisma.buyer.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
      include: {
        buyBox: true,
        owners: { include: { user: { select: { id: true, name: true } } } },
        tags: { include: { tag: true } },
      },
    });
    if (!b) throw new HttpError(404, "Buyer not found");
    const cr = await buyerCloseRate(b.id, orgId(req));

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
        status: effectiveStatus(a),
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
      mailingCity: b.mailingCity,
      mailingZip: b.mailingZip,
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

// --------------------------------------------------------------------------
// Relationship intelligence — the buyer's transaction network derived from all
// research data (grantors, grantees, co-buyers, chains, classification, graph).
// --------------------------------------------------------------------------

/** Normalized research-entity keys for a buyer: its company name + all aliases. */
function buyerEntityKeys(companyName: string, aliases: string[]): string[] {
  const keys = new Set<string>();
  for (const raw of [companyName, ...aliases]) {
    const k = normalizeEntity(raw);
    if (k) keys.add(k);
  }
  return [...keys];
}

buyersRouter.get(
  "/:id/relationships",
  requirePermission("viewBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const buyer = await prisma.buyer.findFirst({
      where: { id: req.params.id, organizationId: org },
      select: { id: true, companyName: true, aliases: true },
    });
    if (!buyer) throw new HttpError(404, "Buyer not found");

    const focusNorms = buyerEntityKeys(buyer.companyName, buyer.aliases);
    if (focusNorms.length === 0) {
      return res.json({ network: null, reason: "no-entity-key" });
    }

    // All-time ownership-transfer edges for the org (relationship analysis is not
    // date-scoped — it always reflects the full transaction history).
    const rows = await prisma.researchDocument.findMany({
      where: {
        organizationId: org, docClass: "TRANSACTION",
        grantorNorm: { not: null }, granteeNorm: { not: null }, archivedAt: null,
      },
      select: {
        id: true, grantor: true, grantorNorm: true, grantee: true, granteeNorm: true,
        state: true, county: true, abstractId: true, recordingDate: true, instrumentNumber: true,
      },
    });
    const edges: TxEdge[] = rows.map((r) => ({
      id: r.id,
      grantorNorm: r.grantorNorm!, grantor: r.grantor ?? r.grantorNorm!,
      granteeNorm: r.granteeNorm!, grantee: r.grantee ?? r.granteeNorm!,
      state: r.state, county: r.county, abstractId: r.abstractId, date: r.recordingDate,
      txKey: r.instrumentNumber ? `${r.state}|${r.county}|${r.instrumentNumber}` : null,
    }));

    const network = entityNetwork(edges, focusNorms, buyer.companyName);
    if (!network) return res.json({ network: null, reason: "no-activity" });

    // Match related entities to existing CRM buyers so the client can link
    // straight to a profile (or offer to create one). Keyed by entity norm.
    const allBuyers = await prisma.buyer.findMany({
      where: { organizationId: org },
      select: { id: true, companyName: true, aliases: true },
    });
    const normToBuyer = new Map<string, string>();
    for (const b of allBuyers) for (const k of buyerEntityKeys(b.companyName, b.aliases)) if (!normToBuyer.has(k)) normToBuyer.set(k, b.id);

    const annotate = <T extends { norm: string }>(list: T[]) => list.map((x) => ({ ...x, buyerId: normToBuyer.get(x.norm) ?? null }));

    res.json({
      network: {
        ...network,
        classLabels: ENTITY_CLASS_LABEL,
        topGrantors: annotate(network.topGrantors),
        topGrantees: annotate(network.topGrantees),
        coBuyers: annotate(network.coBuyers),
        graph: {
          ...network.graph,
          nodes: network.graph.nodes.map((n) => ({ ...n, buyerId: normToBuyer.get(n.norm) ?? null })),
        },
      },
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
  // Display name is retired from the UI — `name` mirrors companyName (kept as a
  // column for legacy references). Optional in the payload; derived server-side.
  name: z.string().min(1).optional(),
  companyName: z.string().min(1),
  contactName: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal("")),
  // Normalize to canonical digits, but preserve undefined (partial PATCH) and null.
  phone: z.string().nullish().transform((v) => (v == null ? v : normalizePhone(v))),
  website: z.string().nullish(),
  mailingAddress: z.string().nullish(),
  mailingCity: z.string().nullish(),
  mailingZip: z.string().nullish(),
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
  requirePermission("createBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = upsertSchema.parse(req.body);
    const buyer = await prisma.$transaction(async (tx) => {
      const created = await tx.buyer.create({
        data: {
          organizationId: orgId(req),
          name: data.name ?? data.companyName,
          companyName: data.companyName,
          normalizedCompany: normalizeCompany(data.companyName),
          contactName: data.contactName ?? null,
          email: data.email ? data.email.toLowerCase() : null,
          phone: data.phone ?? null,
          website: data.website ?? null,
          mailingAddress: data.mailingAddress ?? null,
          mailingCity: data.mailingCity ?? null,
          mailingZip: data.mailingZip ?? null,
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
  requirePermission("editBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = upsertSchema.partial({ name: true, companyName: true }).parse(req.body);
    const existing = await prisma.buyer.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) throw new HttpError(404, "Buyer not found");
    await prisma.$transaction(async (tx) => {
      const patch: Record<string, unknown> = {};
      if (data.name !== undefined) patch.name = data.name;
      if (data.companyName !== undefined) {
        patch.companyName = data.companyName;
        patch.normalizedCompany = normalizeCompany(data.companyName);
        if (data.name === undefined) patch.name = data.companyName; // keep name mirroring company
      }
      if (data.contactName !== undefined) patch.contactName = data.contactName;
      if (data.email !== undefined) patch.email = data.email ? data.email.toLowerCase() : null;
      if (data.phone !== undefined) patch.phone = data.phone;
      if (data.website !== undefined) patch.website = data.website;
      if (data.mailingAddress !== undefined) patch.mailingAddress = data.mailingAddress;
      if (data.mailingCity !== undefined) patch.mailingCity = data.mailingCity;
      if (data.mailingZip !== undefined) patch.mailingZip = data.mailingZip;
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
  requirePermission("deleteBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const result = await prisma.buyer.deleteMany({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (result.count === 0) throw new HttpError(404, "Buyer not found");
    res.json({ ok: true });
  }),
);

// Bulk actions (mirror the deals router).
buyersRouter.post(
  "/bulk-delete",
  requirePermission("deleteBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(500) }).parse(req.body);
    const result = await prisma.buyer.deleteMany({ where: { id: { in: ids }, organizationId: orgId(req) } });
    res.json({ deleted: result.count });
  }),
);

buyersRouter.post(
  "/bulk-assign",
  requirePermission("editBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { ids, ownerIds } = z.object({ ids: z.array(z.string()).min(1).max(500), ownerIds: z.array(z.string()) }).parse(req.body);
    const org = orgId(req);
    if (ownerIds.length) {
      const valid = await prisma.user.count({ where: { id: { in: ownerIds }, organizationId: org } });
      if (valid !== new Set(ownerIds).size) throw new HttpError(400, "One or more owners are not in your organization");
    }
    // Reject the whole request if any target buyer is outside the caller's org,
    // rather than silently assigning a subset — the client should never see a
    // partial success it can't distinguish from a full one.
    const uniqueIds = [...new Set(ids)];
    const owned = await prisma.buyer.findMany({ where: { id: { in: uniqueIds }, organizationId: org }, select: { id: true } });
    if (owned.length !== uniqueIds.length) throw new HttpError(400, "One or more buyers are not in your organization");
    for (const b of owned) await prisma.$transaction((tx) => syncOwners(tx, b.id, ownerIds));
    res.json({ updated: owned.length });
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
