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
import { nameSimilarity } from "../domain/researchBuyers.js";
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
      mailingState: b.mailingState,
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
        grantorNorm: { not: null }, granteeNorm: { not: null },
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
    // Relationship analysis shows business entities ONLY — individual people
    // are excluded outright (no client-side toggle exists to reveal them).
    const companiesOnly = <T extends { norm: string; entityType: string }>(list: T[]) =>
      annotate(list.filter((x) => x.entityType !== "individual"));

    // The network-map graph is no longer shipped (the Buyer Profile map was
    // removed); everything else in the payload is unchanged.
    const { graph: _graph, ...networkRest } = network;
    res.json({
      network: {
        ...networkRest,
        classLabels: ENTITY_CLASS_LABEL,
        topGrantors: companiesOnly(network.topGrantors),
        topGrantees: companiesOnly(network.topGrantees),
        coBuyers: companiesOnly(network.coBuyers),
      },
    });
  }),
);

// --------------------------------------------------------------------------
// Alias detection & merging
//
// Research entities are grouped by normalized name; similar-but-distinct names
// ("Morningstar Minerals" vs "Morningstar Minerals West") are separate keys.
// We NEVER merge them automatically: suggestions above a confidence threshold
// are surfaced for the user to review, and only a confirmed choice creates the
// alias relationship (or merges two CRM buyer records).
// --------------------------------------------------------------------------

/** Minimum name similarity for an alias suggestion to be worth the user's time. */
const ALIAS_SUGGEST_THRESHOLD = 0.72;

const uniqCI = (list: string[]): string[] => {
  const seen = new Map<string, string>();
  for (const v of list) { const k = v.trim().toUpperCase(); if (v.trim() && !seen.has(k)) seen.set(k, v.trim()); }
  return [...seen.values()];
};

/** Distinct research entity keys for the org, with tx counts + best raw spelling per side. */
async function researchEntityIndex(org: string): Promise<Map<string, { name: string; asGrantee: number; asGrantor: number }>> {
  const [grantees, grantors] = await Promise.all([
    prisma.researchDocument.groupBy({
      by: ["granteeNorm", "grantee"], where: { organizationId: org, docClass: "TRANSACTION", granteeNorm: { not: null } },
      _count: { _all: true },
    }),
    prisma.researchDocument.groupBy({
      by: ["grantorNorm", "grantor"], where: { organizationId: org, docClass: "TRANSACTION", grantorNorm: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const idx = new Map<string, { name: string; nameCount: number; asGrantee: number; asGrantor: number }>();
  const add = (norm: string | null, raw: string | null, n: number, side: "asGrantee" | "asGrantor") => {
    if (!norm) return;
    const e = idx.get(norm) ?? { name: raw ?? norm, nameCount: 0, asGrantee: 0, asGrantor: 0 };
    e[side] += n;
    // Display name = the most frequent raw spelling across both sides.
    if (raw && n > e.nameCount) { e.name = raw; e.nameCount = n; }
    idx.set(norm, e);
  };
  for (const g of grantees) add(g.granteeNorm, g.grantee, g._count._all, "asGrantee");
  for (const g of grantors) add(g.grantorNorm, g.grantor, g._count._all, "asGrantor");
  return new Map([...idx.entries()].map(([k, v]) => [k, { name: v.name, asGrantee: v.asGrantee, asGrantor: v.asGrantor }]));
}

/**
 * Possible aliases for a buyer: research entity names highly similar to the
 * buyer's name (or existing aliases) that are NOT already counted as this
 * buyer. Review-only — nothing is merged until the user confirms.
 */
buyersRouter.get(
  "/:id/alias-suggestions",
  requirePermission("viewBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const buyer = await prisma.buyer.findFirst({
      where: { id: req.params.id, organizationId: org },
      select: { id: true, companyName: true, aliases: true, dismissedAliasNorms: true },
    });
    if (!buyer) throw new HttpError(404, "Buyer not found");

    const focusNorms = new Set(buyerEntityKeys(buyer.companyName, buyer.aliases));
    const dismissed = new Set(buyer.dismissedAliasNorms);
    const index = await researchEntityIndex(org);

    // Other CRM buyers' keys — a suggestion that maps to an existing buyer
    // becomes a "merge profiles" prompt instead of a plain alias add.
    const allBuyers = await prisma.buyer.findMany({
      where: { organizationId: org, id: { not: buyer.id } },
      select: { id: true, companyName: true, aliases: true },
    });
    const normToBuyer = new Map<string, { id: string; companyName: string }>();
    for (const b of allBuyers) for (const k of buyerEntityKeys(b.companyName, b.aliases)) if (!normToBuyer.has(k)) normToBuyer.set(k, { id: b.id, companyName: b.companyName });

    const own = [buyer.companyName, ...buyer.aliases];
    const suggestions = [...index.entries()]
      .filter(([norm]) => !focusNorms.has(norm) && !dismissed.has(norm))
      .map(([norm, e]) => {
        const confidence = Math.max(...own.map((n) => nameSimilarity(n, e.name)));
        const other = normToBuyer.get(norm) ?? null;
        return {
          norm, name: e.name, confidence: Math.round(confidence * 100) / 100,
          txCount: e.asGrantee + e.asGrantor, asGrantee: e.asGrantee, asGrantor: e.asGrantor,
          buyerId: other?.id ?? null, buyerName: other?.companyName ?? null,
        };
      })
      .filter((s) => s.confidence >= ALIAS_SUGGEST_THRESHOLD)
      .sort((a, b) => b.confidence - a.confidence || b.txCount - a.txCount)
      .slice(0, 8);

    res.json({ suggestions });
  }),
);

/** Confirm an alias: the reviewed name joins this buyer's alias list. */
buyersRouter.post(
  "/:id/aliases",
  requirePermission("editBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(200) }).parse(req.body);
    const buyer = await prisma.buyer.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
      select: { id: true, companyName: true, aliases: true, dismissedAliasNorms: true },
    });
    if (!buyer) throw new HttpError(404, "Buyer not found");
    const aliases = uniqCI([...buyer.aliases, name]).filter((a) => a.toUpperCase() !== buyer.companyName.trim().toUpperCase());
    const norm = normalizeEntity(name);
    const updated = await prisma.buyer.update({
      where: { id: buyer.id },
      data: {
        aliases,
        // A confirmed alias is no longer a dismissed suggestion.
        dismissedAliasNorms: buyer.dismissedAliasNorms.filter((d) => d !== norm),
      },
      select: { id: true, aliases: true },
    });
    res.json(updated);
  }),
);

/**
 * Merge two CRM buyer records into one logical buyer (target absorbs source).
 * Everything the source accumulated moves to the target — deal activity,
 * timelines, offers, documents, tags, owners, activity log, selected-buyer
 * links — and the source's name + aliases become aliases of the target, so the
 * relationship network keeps attributing each historical transaction to the
 * alias that actually appears on the instrument. Nothing is lost; the source
 * record itself is deleted once emptied.
 */
buyersRouter.post(
  "/:id/merge",
  requirePermission("deleteBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { sourceBuyerId } = z.object({ sourceBuyerId: z.string().min(1) }).parse(req.body);
    if (sourceBuyerId === req.params.id) throw new HttpError(400, "A buyer cannot be merged into itself");

    const [target, source] = await Promise.all([
      prisma.buyer.findFirst({ where: { id: req.params.id, organizationId: org }, include: { buyBox: true } }),
      prisma.buyer.findFirst({ where: { id: sourceBuyerId, organizationId: org }, include: { buyBox: true, owners: true, tags: true } }),
    ]);
    if (!target || !source) throw new HttpError(404, "Buyer not found");

    await prisma.$transaction(async (tx) => {
      // Deal activity: (dealId, buyerId) is unique. Where both buyers touched
      // the same deal, fold the source's timeline into the target's row and
      // drop the source row; otherwise the row simply moves.
      const [targetActs, sourceActs] = await Promise.all([
        tx.dealBuyerActivity.findMany({ where: { buyerId: target.id }, select: { id: true, dealId: true } }),
        tx.dealBuyerActivity.findMany({ where: { buyerId: source.id }, select: { id: true, dealId: true } }),
      ]);
      const targetByDeal = new Map(targetActs.map((a) => [a.dealId, a.id]));
      for (const act of sourceActs) {
        const existing = targetByDeal.get(act.dealId);
        if (existing) {
          await tx.dealBuyerMessage.updateMany({ where: { activityId: act.id }, data: { activityId: existing } });
          await tx.dealBuyerActivity.delete({ where: { id: act.id } });
        } else {
          await tx.dealBuyerActivity.update({ where: { id: act.id }, data: { buyerId: target.id } });
        }
      }
      await tx.dealBuyerMessage.updateMany({ where: { buyerId: source.id }, data: { buyerId: target.id } });
      await tx.offer.updateMany({ where: { buyerId: source.id }, data: { buyerId: target.id } });
      await tx.fileAttachment.updateMany({ where: { buyerId: source.id }, data: { buyerId: target.id } });
      await tx.activityLog.updateMany({ where: { buyerId: source.id }, data: { buyerId: target.id } });
      await tx.deal.updateMany({ where: { selectedBuyerId: source.id }, data: { selectedBuyerId: target.id } });

      // Owners / tags: composite PKs — copy only what the target lacks.
      const targetOwners = new Set((await tx.buyerOwner.findMany({ where: { buyerId: target.id }, select: { userId: true } })).map((o) => o.userId));
      for (const o of source.owners) if (!targetOwners.has(o.userId)) await tx.buyerOwner.create({ data: { buyerId: target.id, userId: o.userId } });
      const targetTags = new Set((await tx.buyerTagOnBuyer.findMany({ where: { buyerId: target.id }, select: { tagId: true } })).map((t) => t.tagId));
      for (const t of source.tags) if (!targetTags.has(t.tagId)) await tx.buyerTagOnBuyer.create({ data: { buyerId: target.id, tagId: t.tagId } });

      // Buy box: additive union of the geography/type arrays; the target's
      // numeric bounds win where set, the source's fill the gaps.
      if (source.buyBox) {
        const tb = target.buyBox, sb = source.buyBox;
        const union = (a: string[] = [], b: string[] = []) => uniqCI([...a, ...b]);
        const boxData = {
          states: union(tb?.states, sb.states), counties: union(tb?.counties, sb.counties),
          basins: union(tb?.basins, sb.basins), formations: union(tb?.formations, sb.formations),
          assetTypes: union(tb?.assetTypes, sb.assetTypes),
          minAcreage: tb?.minAcreage ?? sb.minAcreage, maxAcreage: tb?.maxAcreage ?? sb.maxAcreage,
          minPrice: tb?.minPrice ?? sb.minPrice, maxPrice: tb?.maxPrice ?? sb.maxPrice,
        };
        if (tb) await tx.buyBoxCriteria.update({ where: { buyerId: target.id }, data: boxData });
        else await tx.buyBoxCriteria.create({ data: { buyerId: target.id, ...boxData } });
      }

      // Research summaries: counts add, sets union, date range widens.
      type RS = { counties?: string[]; states?: string[]; abstracts?: string[]; transactionTypes?: string[]; transactionCount?: number; firstSeen?: string | null; lastSeen?: string | null };
      const ts = (target.researchSummary ?? null) as RS | null;
      const ss = (source.researchSummary ?? null) as RS | null;
      const mergedSummary = ts || ss ? {
        counties: uniqCI([...(ts?.counties ?? []), ...(ss?.counties ?? [])]),
        states: uniqCI([...(ts?.states ?? []), ...(ss?.states ?? [])]),
        abstracts: uniqCI([...(ts?.abstracts ?? []), ...(ss?.abstracts ?? [])]),
        transactionTypes: uniqCI([...(ts?.transactionTypes ?? []), ...(ss?.transactionTypes ?? [])]),
        transactionCount: (ts?.transactionCount ?? 0) + (ss?.transactionCount ?? 0),
        firstSeen: [ts?.firstSeen, ss?.firstSeen].filter(Boolean).sort()[0] ?? null,
        lastSeen: [ts?.lastSeen, ss?.lastSeen].filter(Boolean).sort().pop() ?? null,
      } : undefined;

      // The source's identity lives on as aliases of the target — that is what
      // keeps each historical transaction attributable to the name it used.
      const aliases = uniqCI([...target.aliases, source.companyName, ...source.aliases])
        .filter((a) => a.toUpperCase() !== target.companyName.trim().toUpperCase());
      const mergedNorms = new Set(buyerEntityKeys(target.companyName, aliases));

      await tx.buyer.update({
        where: { id: target.id },
        data: {
          aliases,
          dismissedAliasNorms: uniqCI([...target.dismissedAliasNorms, ...source.dismissedAliasNorms]).filter((n) => !mergedNorms.has(n)),
          ...(mergedSummary !== undefined ? { researchSummary: mergedSummary } : {}),
          // Fill contact gaps from the source; never overwrite target data.
          contactName: target.contactName ?? source.contactName,
          email: target.email ?? source.email,
          phone: target.phone ?? source.phone,
          website: target.website ?? source.website,
          notes: target.notes && source.notes
            ? `${target.notes}\n\n— Merged from ${source.companyName} —\n${source.notes}`
            : target.notes ?? (source.notes ? `— Merged from ${source.companyName} —\n${source.notes}` : null),
        },
      });

      await tx.buyer.delete({ where: { id: source.id } });
    });

    const merged = await prisma.buyer.findUnique({ where: { id: target.id }, select: { id: true, companyName: true, aliases: true } });
    res.json({ ok: true, buyer: merged });
  }),
);

/** Reject an alias suggestion: never prompt for this entity again. */
buyersRouter.post(
  "/:id/alias-dismissals",
  requirePermission("editBuyers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { norm } = z.object({ norm: z.string().trim().min(1).max(200) }).parse(req.body);
    const buyer = await prisma.buyer.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
      select: { id: true, dismissedAliasNorms: true },
    });
    if (!buyer) throw new HttpError(404, "Buyer not found");
    await prisma.buyer.update({
      where: { id: buyer.id },
      data: { dismissedAliasNorms: uniqCI([...buyer.dismissedAliasNorms, norm]) },
    });
    res.json({ ok: true });
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
  mailingState: z.string().nullish(),
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
    if (data.ownerIds) await validateOrgOwners(orgId(req), data.ownerIds);
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
          mailingState: data.mailingState ?? null,
          mailingZip: data.mailingZip ?? null,
          relationshipStatus: data.relationshipStatus ?? "WARM",
          lastContactDate: toDate(data.lastContactDate) ?? null,
          nextFollowUpDate: toDate(data.nextFollowUpDate) ?? null,
          notes: data.notes ?? null,
          buyBox: { create: data.buyBox ?? {} },
        },
      });
      await syncOwners(tx, created.id, data.ownerIds ?? []);
      await syncTags(tx, orgId(req), created.id, data.tags ?? []);
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
    if (data.ownerIds) await validateOrgOwners(orgId(req), data.ownerIds);
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
      if (data.mailingState !== undefined) patch.mailingState = data.mailingState;
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
      if (data.tags) await syncTags(tx, orgId(req), req.params.id, data.tags);
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

/** Reject ownerIds that aren't users in the caller's org (cross-tenant guard). */
async function validateOrgOwners(org: string, ownerIds: string[]): Promise<void> {
  const unique = [...new Set(ownerIds)];
  if (unique.length === 0) return;
  const valid = await prisma.user.count({ where: { id: { in: unique }, organizationId: org } });
  if (valid !== unique.length) throw new HttpError(400, "One or more owners are not in your organization");
}

async function syncOwners(tx: any, buyerId: string, userIds: string[]) {
  await tx.buyerOwner.deleteMany({ where: { buyerId } });
  if (userIds.length) {
    await tx.buyerOwner.createMany({ data: userIds.map((userId) => ({ buyerId, userId })), skipDuplicates: true });
  }
}

async function syncTags(tx: any, org: string, buyerId: string, tagNames: string[]) {
  await tx.buyerTagOnBuyer.deleteMany({ where: { buyerId } });
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;
    // Tags are scoped to the caller's org — never a shared global namespace.
    const tag = await tx.buyerTag.upsert({
      where: { organizationId_name: { organizationId: org, name } },
      create: { organizationId: org, name },
      update: {},
    });
    await tx.buyerTagOnBuyer.create({ data: { buyerId, tagId: tag.id } });
  }
}
