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

const dealInclude = { selectedBuyer: true, relationshipOwner: true, assignees: { select: { id: true, name: true } } } as const;

/** Validate that every id is a user in the caller's org; returns the clean list. */
async function validateOrgUsers(org: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = await prisma.user.findMany({ where: { id: { in: unique }, organizationId: org }, select: { id: true } });
  if (found.length !== unique.length) throw new HttpError(400, "One or more assignees are not in your organization");
  return found.map((u) => u.id);
}

/** Owned-asset fields shared by create/update. All optional/nullable. */
const assetFields = {
  recordType: z.enum(["OPPORTUNITY", "OWNED_ASSET"]).optional(),
  assetMode: z.enum(["HOLD", "SELL"]).nullish(),
  acquisitionDate: dateField,
  purchasePrice: z.number().nullish(),
  currentValue: z.number().nullish(),
  bookValue: z.number().nullish(),
  ownershipStatus: z.string().nullish(),
  ownershipType: z.string().nullish(),
  workingInterest: z.number().nullish(),
  netRevenueInterest: z.number().nullish(),
  surveys: z.array(z.string()).optional(),
  wells: z.array(z.string()).optional(),
  producingStatus: z.string().nullish(),
  royaltyIncomeAnnual: z.number().nullish(),
  leaseStatus: z.string().nullish(),
  leaseInfo: z.string().nullish(),
  divisionOrdersNote: z.string().nullish(),
  taxInfo: z.string().nullish(),
};
// Scalar asset keys copied straight into a Prisma patch (arrays/scalars only).
const ASSET_SCALAR_KEYS = [
  "recordType", "assetMode", "purchasePrice", "currentValue", "bookValue",
  "ownershipStatus", "ownershipType", "workingInterest", "netRevenueInterest",
  "surveys", "wells", "producingStatus", "royaltyIncomeAnnual", "leaseStatus",
  "leaseInfo", "divisionOrdersNote", "taxInfo",
] as const;

const hasPerm = (req: AuthedRequest, perm: string) =>
  req.user!.orgRole === "OWNER" || req.user!.permissions.includes(perm as never);

// --------------------------------------------------------------------------
// List
// --------------------------------------------------------------------------
dealsRouter.get(
  "/",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    // ?recordType=OPPORTUNITY (default) | OWNED_ASSET | ALL. Keeps the Deals
    // pages opportunity-only; Mineral Assets and the Pipeline request what they need.
    const rt = String(req.query.recordType ?? "OPPORTUNITY").toUpperCase();
    const where = { organizationId: orgId(req) } as Record<string, unknown>;
    if (rt === "OPPORTUNITY" || rt === "OWNED_ASSET") where.recordType = rt;
    const deals = await prisma.deal.findMany({
      where,
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
  assigneeIds: z.array(z.string()).optional(),
  notes: z.string().nullish(),
  ...assetFields,
});

dealsRouter.post(
  "/",
  requirePermission("createDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = createSchema.parse(req.body);
    const isAsset = data.recordType === "OWNED_ASSET";
    const assigneeIds = data.assigneeIds ? await validateOrgUsers(orgId(req), data.assigneeIds) : [];
    const deal = await prisma.$transaction(async (tx) => {
      const created = await tx.deal.create({
        data: {
          organizationId: orgId(req),
          name: data.name,
          sellerNames: data.sellerNames ?? [],
          recordType: data.recordType ?? "OPPORTUNITY",
          // Owned assets default to HOLD; opportunities have no asset mode.
          assetMode: isAsset ? (data.assetMode ?? "HOLD") : null,
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
          assignees: assigneeIds.length ? { connect: assigneeIds.map((id) => ({ id })) } : undefined,
          notes: data.notes ?? null,
          // Owned assets skip the acquisition pipeline — park them in CLOSING so
          // they don't clutter the acquisition board unless marked for sale.
          stage: isAsset ? "CLOSING" : "UNDER_CONTRACT",
          currentStageEnteredAt: new Date(),
          // Ownership/property/financial fields
          acquisitionDate: toDate(data.acquisitionDate) ?? null,
          purchasePrice: data.purchasePrice ?? null,
          currentValue: data.currentValue ?? null,
          bookValue: data.bookValue ?? null,
          ownershipStatus: data.ownershipStatus ?? null,
          ownershipType: data.ownershipType ?? null,
          workingInterest: data.workingInterest ?? null,
          netRevenueInterest: data.netRevenueInterest ?? null,
          surveys: data.surveys ?? [],
          wells: data.wells ?? [],
          producingStatus: data.producingStatus ?? null,
          royaltyIncomeAnnual: data.royaltyIncomeAnnual ?? null,
          leaseStatus: data.leaseStatus ?? null,
          leaseInfo: data.leaseInfo ?? null,
          divisionOrdersNote: data.divisionOrdersNote ?? null,
          taxInfo: data.taxInfo ?? null,
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
        sellers: { include: { assignedTeamMember: { select: { id: true, name: true } } }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        revenueEntries: { orderBy: { month: "asc" } },
      },
    });
    if (!deal) throw new HttpError(404, "Deal not found");
    const canSeeTaxId = hasPerm(req, "viewSellerTaxId");

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
      sellers: deal.sellers.map((s) => serializeSeller(s, canSeeTaxId)),
      revenueEntries: deal.revenueEntries.map((r) => ({
        id: r.id, month: r.month, amount: r.amount, kind: r.kind, operator: r.operator, note: r.note,
      })),
      canViewTaxId: canSeeTaxId,
      metrics: { buyersContacted, interested, offers: offerCount, highOffer },
    });
  }),
);

// Seller serialization — taxId is only included for callers with viewSellerTaxId.
function serializeSeller(
  s: {
    id: string; isPrimary: boolean; ownershipPercent: number | null;
    firstName: string | null; middleName: string | null; lastName: string | null;
    companyName: string | null; trustName: string | null; sellerType: string;
    primaryPhone: string | null; secondaryPhone: string | null; email: string | null; preferredContactMethod: string | null;
    mailingAddress: string | null; mailingCity: string | null; mailingState: string | null; mailingZip: string | null;
    physicalAddress: string | null; physicalCity: string | null; physicalState: string | null; physicalZip: string | null;
    internalNotes: string | null; taxId: string | null; preferredCommunicationNotes: string | null;
    assignedTeamMemberId: string | null; assignedTeamMember: { id: string; name: string } | null;
    createdAt: Date; updatedAt: Date;
  },
  includeTaxId: boolean,
) {
  return {
    id: s.id, isPrimary: s.isPrimary, ownershipPercent: s.ownershipPercent,
    firstName: s.firstName, middleName: s.middleName, lastName: s.lastName,
    companyName: s.companyName, trustName: s.trustName, sellerType: s.sellerType,
    primaryPhone: s.primaryPhone, secondaryPhone: s.secondaryPhone, email: s.email, preferredContactMethod: s.preferredContactMethod,
    mailingAddress: s.mailingAddress, mailingCity: s.mailingCity, mailingState: s.mailingState, mailingZip: s.mailingZip,
    physicalAddress: s.physicalAddress, physicalCity: s.physicalCity, physicalState: s.physicalState, physicalZip: s.physicalZip,
    internalNotes: s.internalNotes, preferredCommunicationNotes: s.preferredCommunicationNotes,
    // Sensitive: present only for permitted callers; a boolean flags its existence otherwise.
    taxId: includeTaxId ? s.taxId : undefined,
    hasTaxId: s.taxId != null,
    assignedTeamMember: s.assignedTeamMember ? { id: s.assignedTeamMember.id, name: s.assignedTeamMember.name } : null,
    dateAdded: s.createdAt, updatedAt: s.updatedAt,
  };
}

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
  assigneeIds: z.array(z.string()).optional(),
  notes: z.string().nullish(),
  ...assetFields,
});

dealsRouter.patch(
  "/:id",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = updateSchema.parse(req.body);
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "sellerNames", "counties", "state", "acreageNma", "nra", "abstractIds", "operator", "askPrice", "ourPrice", "assetTypes", "basins", "formations", "estimatedClosingCosts", "relationshipOwnerId", "notes", ...ASSET_SCALAR_KEYS] as const) {
      if (k in data) patch[k] = (data as Record<string, unknown>)[k];
    }
    for (const k of ["dateUnderContract", "originalClosingDate", "findBuyerByDateOverride", "finalClosingDateOverride", "acquisitionDate"] as const) {
      if (k in data) patch[k] = toDate((data as Record<string, unknown>)[k]);
    }
    const existing = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) throw new HttpError(404, "Deal not found");
    if (data.assigneeIds !== undefined) {
      const ids = await validateOrgUsers(orgId(req), data.assigneeIds);
      patch.assignees = { set: ids.map((id) => ({ id })) };
    }
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

// ==========================================================================
// Seller details (structured owners on a deal) — hasMany, expandable
// ==========================================================================
const sellerSchema = z.object({
  isPrimary: z.boolean().optional(),
  ownershipPercent: z.number().min(0).max(100).nullish(),
  firstName: z.string().trim().max(120).nullish(),
  middleName: z.string().trim().max(120).nullish(),
  lastName: z.string().trim().max(120).nullish(),
  companyName: z.string().trim().max(200).nullish(),
  trustName: z.string().trim().max(200).nullish(),
  sellerType: z.enum(["INDIVIDUAL", "TRUST", "LLC", "CORPORATION", "ESTATE", "PARTNERSHIP", "OTHER"]).optional(),
  primaryPhone: z.string().trim().max(40).nullish(),
  secondaryPhone: z.string().trim().max(40).nullish(),
  email: z.string().trim().max(200).nullish(),
  preferredContactMethod: z.string().trim().max(40).nullish(),
  mailingAddress: z.string().trim().max(300).nullish(),
  mailingCity: z.string().trim().max(120).nullish(),
  mailingState: z.string().trim().max(40).nullish(),
  mailingZip: z.string().trim().max(20).nullish(),
  physicalAddress: z.string().trim().max(300).nullish(),
  physicalCity: z.string().trim().max(120).nullish(),
  physicalState: z.string().trim().max(40).nullish(),
  physicalZip: z.string().trim().max(20).nullish(),
  internalNotes: z.string().trim().max(5000).nullish(),
  taxId: z.string().trim().max(40).nullish(),
  preferredCommunicationNotes: z.string().trim().max(2000).nullish(),
  assignedTeamMemberId: z.string().nullish(),
});

const sellerInclude = { assignedTeamMember: { select: { id: true, name: true } } } as const;

async function ownDealOr404(req: AuthedRequest): Promise<string> {
  const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, select: { id: true } });
  if (!deal) throw new HttpError(404, "Deal not found");
  return deal.id;
}

// taxId is only writable by callers who can view it (keeps the field consistent
// with its read gate).
function stripTaxIdIfNeeded(req: AuthedRequest, data: Record<string, unknown>) {
  if ("taxId" in data && !hasPerm(req, "viewSellerTaxId")) delete data.taxId;
  return data;
}

dealsRouter.post(
  "/:id/sellers",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const data = stripTaxIdIfNeeded(req, sellerSchema.parse(req.body));
    if (data.assignedTeamMemberId) {
      const u = await prisma.user.findFirst({ where: { id: data.assignedTeamMemberId as string, organizationId: orgId(req) } });
      if (!u) throw new HttpError(400, "Assigned team member is not in your organization");
    }
    // First seller on a deal becomes primary automatically.
    const count = await prisma.dealSeller.count({ where: { dealId } });
    const seller = await prisma.dealSeller.create({
      data: { ...(data as object), dealId, isPrimary: (data.isPrimary as boolean) ?? count === 0 },
      include: sellerInclude,
    });
    res.status(201).json(serializeSeller(seller, hasPerm(req, "viewSellerTaxId")));
  }),
);

dealsRouter.patch(
  "/:id/sellers/:sellerId",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const existing = await prisma.dealSeller.findFirst({ where: { id: req.params.sellerId, dealId } });
    if (!existing) throw new HttpError(404, "Seller not found");
    const data = stripTaxIdIfNeeded(req, sellerSchema.partial().parse(req.body));
    if (data.assignedTeamMemberId) {
      const u = await prisma.user.findFirst({ where: { id: data.assignedTeamMemberId as string, organizationId: orgId(req) } });
      if (!u) throw new HttpError(400, "Assigned team member is not in your organization");
    }
    const seller = await prisma.dealSeller.update({ where: { id: existing.id }, data: data as object, include: sellerInclude });
    // Enforce a single primary per deal.
    if (data.isPrimary === true) {
      await prisma.dealSeller.updateMany({ where: { dealId, id: { not: seller.id }, isPrimary: true }, data: { isPrimary: false } });
    }
    res.json(serializeSeller(seller, hasPerm(req, "viewSellerTaxId")));
  }),
);

dealsRouter.delete(
  "/:id/sellers/:sellerId",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const result = await prisma.dealSeller.deleteMany({ where: { id: req.params.sellerId, dealId } });
    if (result.count === 0) throw new HttpError(404, "Seller not found");
    res.json({ ok: true });
  }),
);

// ==========================================================================
// Convert opportunity ↔ owned asset, and set the asset's HOLD/SELL mode
// ==========================================================================
const convertSchema = z.object({
  recordType: z.enum(["OPPORTUNITY", "OWNED_ASSET"]),
  assetMode: z.enum(["HOLD", "SELL"]).optional(),
});

dealsRouter.post(
  "/:id/convert",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { recordType, assetMode } = convertSchema.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    const toAsset = recordType === "OWNED_ASSET";
    const updated = await prisma.deal.update({
      where: { id: deal.id },
      data: {
        recordType,
        assetMode: toAsset ? (assetMode ?? deal.assetMode ?? "HOLD") : null,
        // Park a HOLD asset off the acquisition board; SELL / opportunity go active.
        stage: toAsset && (assetMode ?? "HOLD") === "HOLD" ? "CLOSING" : deal.stage,
      },
      include: dealInclude,
    });
    await logActivity({
      eventType: "DEAL_CONVERTED",
      summary: `${req.user!.name} ${toAsset ? "converted to owned asset" : "reverted to opportunity"}: "${updated.name}"`,
      organizationId: orgId(req), actorUserId: req.user!.id, dealId: updated.id,
    });
    res.json(serializeDeal(updated));
  }),
);

// Set an owned asset's operational mode. SELL puts it on the marketing board
// (SENT_TO_BUYERS if it was parked); HOLD parks it back in CLOSING.
dealsRouter.post(
  "/:id/asset-mode",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { assetMode } = z.object({ assetMode: z.enum(["HOLD", "SELL"]) }).parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    if (deal.recordType !== "OWNED_ASSET") throw new HttpError(400, "Only owned assets have a HOLD/SELL mode");
    const stage =
      assetMode === "SELL" && (deal.stage === "CLOSING" || deal.stage === "CLOSED")
        ? "SENT_TO_BUYERS"
        : assetMode === "HOLD"
          ? "CLOSING"
          : deal.stage;
    const updated = await prisma.deal.update({
      where: { id: deal.id },
      data: { assetMode, stage, currentStageEnteredAt: stage !== deal.stage ? new Date() : deal.currentStageEnteredAt },
      include: dealInclude,
    });
    res.json(serializeDeal(updated));
  }),
);

// ==========================================================================
// Asset revenue history (royalty / lease-bonus entries) for owned assets
// ==========================================================================
const revenueSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM"),
  amount: z.number(),
  kind: z.enum(["ROYALTY", "LEASE_BONUS", "OTHER"]).default("ROYALTY"),
  operator: z.string().trim().max(200).nullish(),
  note: z.string().trim().max(1000).nullish(),
});

dealsRouter.post(
  "/:id/revenue",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const data = revenueSchema.parse(req.body);
    const entry = await prisma.assetRevenueEntry.create({
      data: {
        dealId,
        month: new Date(`${data.month}-01T00:00:00Z`),
        amount: data.amount,
        kind: data.kind,
        operator: data.operator ?? null,
        note: data.note ?? null,
      },
    });
    res.status(201).json({ id: entry.id, month: entry.month, amount: entry.amount, kind: entry.kind, operator: entry.operator, note: entry.note });
  }),
);

dealsRouter.delete(
  "/:id/revenue/:entryId",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const result = await prisma.assetRevenueEntry.deleteMany({ where: { id: req.params.entryId, dealId } });
    if (result.count === 0) throw new HttpError(404, "Revenue entry not found");
    res.json({ ok: true });
  }),
);

// ==========================================================================
// Bulk actions (Deals + Mineral Assets share this router)
// ==========================================================================
dealsRouter.post(
  "/bulk-delete",
  requirePermission("deleteDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(500) }).parse(req.body);
    const result = await prisma.deal.deleteMany({ where: { id: { in: ids }, organizationId: orgId(req) } });
    res.json({ deleted: result.count });
  }),
);

dealsRouter.post(
  "/bulk-assign",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { ids, assigneeIds } = z.object({ ids: z.array(z.string()).min(1).max(500), assigneeIds: z.array(z.string()) }).parse(req.body);
    const org = orgId(req);
    const valid = await validateOrgUsers(org, assigneeIds);
    const owned = await prisma.deal.findMany({ where: { id: { in: ids }, organizationId: org }, select: { id: true } });
    for (const d of owned) {
      await prisma.deal.update({ where: { id: d.id }, data: { assignees: { set: valid.map((id) => ({ id })) } } });
    }
    res.json({ updated: owned.length });
  }),
);

// Bulk archive → move to DEAD (the "Archived Deals" bucket), recording history.
dealsRouter.post(
  "/bulk-archive",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(500) }).parse(req.body);
    const org = orgId(req);
    const owned = await prisma.deal.findMany({ where: { id: { in: ids }, organizationId: org, stage: { not: "DEAD" } }, select: { id: true, stage: true } });
    const now = new Date();
    for (const d of owned) {
      await prisma.$transaction([
        prisma.deal.update({ where: { id: d.id }, data: { stage: "DEAD", currentStageEnteredAt: now, deadReason: "Bulk archived" } }),
        prisma.dealStageHistory.create({ data: { dealId: d.id, fromStage: d.stage, toStage: "DEAD", changedByUserId: req.user!.id, deadReason: "Bulk archived" } }),
      ]);
    }
    res.json({ archived: owned.length });
  }),
);

async function reload(id: string) {
  const d = await prisma.deal.findUniqueOrThrow({ where: { id }, include: dealInclude });
  return d;
}

function prettyStage(s: Stage): string {
  return s.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}
