import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, researchOrgId, contactAccess, hasPermission, type AuthedRequest } from "../middleware/auth.js";
import { serializeDeal, serializeContractExtension } from "../serializers.js";
import { computeMatch } from "../domain/matching.js";
import { normalizePhone } from "../domain/phone.js";
import { userRef, userRefSelect } from "../domain/userRef.js";
import { syncAskToAcceptedOffer, ASK_SYNCED_EVENT } from "../services/acceptedOfferSync.js";
import { CONTACT_EDIT_FORBIDDEN, contactPatchFromSellerPatch, contactSyncFor, dealSellerFromInfo, fillContactGeography, overlayContact, resolveSellerContact, sellerContactSelect, sellerInfoSchema, type SellerContactRow } from "../domain/sellerContact.js";
import { contactName } from "../domain/contactName.js";
import { STALE_CONTACT_DAYS, LIST_LIMIT } from "../config.js";
import { daysUntil, formatCalendarDay, nextContractExtension } from "../domain/dates.js";
import { totalFromPerAcre } from "../domain/perAcre.js";
import { roundMoney, roundTo } from "../domain/money.js";
import { parseRoyaltyRate } from "../domain/royalty.js";
import { logActivity } from "../services/activityLog.js";
import { effectiveStatus, ENGAGED_STATUSES, BUYER_STATUSES } from "../domain/buyerStatus.js";
import { sendEmail, personalize, renderEmailBody } from "../services/email.js";
import { money as fmtMoney } from "../domain/format.js";
import { newPortalSlug } from "./portal.js";
import { ensureStages, activeStageKeys, isOpportunityPipeline, lockStageRow } from "../domain/stages.js";
import { applyStageChange, applyStageUndo, signStageUndo, verifyStageUndo, STAGE_UNDO_MAX_TOKEN_BYTES } from "../services/stageUndo.js";

export const dealsRouter = Router();
// All deal routes require membership in an organization and are scoped to it.
dealsRouter.use(requireAuth, requireOrg);

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

// Every deal the API returns — list, detail, and the response to any edit —
// carries the offers and child-asset scalars the serializer needs, so Profit
// est., Buyer purchase price and the package roll-ups are the same figures no
// matter which route produced the row.
const dealInclude = {
  selectedBuyer: true, relationshipOwner: true, assignees: { select: userRefSelect },
  offers: { select: { id: true, amount: true, status: true } },
  _count: { select: { assets: true } },
  assets: { select: { nra: true, acreageNma: true, ourPrice: true, askPrice: true } },
} as const;

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
  ownershipStatus: z.string().max(10_000).nullish(),
  ownershipType: z.string().max(10_000).nullish(),
  // Decimal interests (fractions 0–1, e.g. 0.1875) — never percents.
  workingInterest: z.number().min(0).max(1).nullish(),
  netRevenueInterest: z.number().min(0).max(1).nullish(),
  surveys: z.array(z.string().max(200)).max(500).optional(),
  wells: z.array(z.string().max(200)).max(500).optional(),
  producingStatus: z.string().max(10_000).nullish(),
  royaltyIncomeAnnual: z.number().nullish(),
  // Current-lease redesign.
  leaseStatuses: z.array(z.string().max(200)).max(500).optional(),
  // Any form the shared parser reads ("3/16", "18.75%", "0.1875", "18.75");
  // stored in its canonical form by normalizeRoyaltyRate below.
  royaltyRate: z.string().max(10_000).nullish(),
  leaseEffectiveDate: dateField,
  leaseExpirationDate: dateField,
  // Deprecated (still accepted so old clients don't 400, but no longer surfaced).
  leaseStatus: z.string().max(10_000).nullish(),
  leaseInfo: z.string().max(10_000).nullish(),
  divisionOrdersNote: z.string().max(10_000).nullish(),
  taxInfo: z.string().max(10_000).nullish(),
};
/** Per-acre pricing + contracted close window, shared by create/update. */
const pricingFields = {
  ourCostPerNma: z.number().nonnegative().nullish(),
  ourCostPerNra: z.number().nonnegative().nullish(),
  askPricePerNma: z.number().nonnegative().nullish(),
  askPricePerNra: z.number().nonnegative().nullish(),
  daysToClose: z.number().int().min(1).max(3650).nullish(),
};
const PRICING_KEYS = ["ourCostPerNma", "ourCostPerNra", "askPricePerNma", "askPricePerNra", "daysToClose"] as const;

// Numeric precision is fixed at the boundary: acreage keeps the 4 places the
// NMA ↔ NRA conversion uses and money keeps cents, so what is STORED is exactly
// what every screen shows and calculates with. (Before this, an NMA of 8.75234
// was stored as typed, displayed as 8.7523, and quietly moved the total and the
// per-acre figures away from what the display implied.)
const ACRE_KEYS = ["acreageNma", "nra"] as const;
const MONEY_KEYS = ["askPrice", "ourPrice", "ourCostPerNma", "ourCostPerNra", "askPricePerNma", "askPricePerNra", "estimatedClosingCosts", "purchasePrice", "currentValue", "bookValue", "royaltyIncomeAnnual"] as const;
export function normalizeNumbers<T extends object>(data: T): T {
  const rec = data as Record<string, unknown>;
  for (const k of ACRE_KEYS) if (typeof rec[k] === "number" && Number.isFinite(rec[k])) rec[k] = roundTo(rec[k] as number, 4);
  for (const k of MONEY_KEYS) if (typeof rec[k] === "number" && Number.isFinite(rec[k])) rec[k] = roundMoney(rec[k] as number);
  return data;
}

// Scalar asset keys copied straight into a Prisma patch (arrays/scalars only).
// Editable asset value/interest fields, copied straight through by the generic
// PATCH /:id. The lifecycle DISCRIMINATORS (recordType, assetMode) are
// deliberately NOT here: flipping them changes a deal's lifecycle and must go
// through POST /:id/convert and POST /:id/asset-mode, which apply the required
// stage transitions and clear/derive dependent fields. Copying them via the
// generic PATCH would skip those side effects and leave a deal in an
// inconsistent state (e.g. an OWNED_ASSET with a stale opportunity stage).
const ASSET_SCALAR_KEYS = [
  "purchasePrice", "currentValue", "bookValue",
  "ownershipStatus", "ownershipType", "workingInterest", "netRevenueInterest",
  "surveys", "wells", "producingStatus", "royaltyIncomeAnnual",
  "leaseStatuses", "royaltyRate",
  "leaseStatus", "leaseInfo", "divisionOrdersNote", "taxInfo",
] as const;

/**
 * A submitted royalty rate through the ONE shared parser (domain/royalty.ts):
 * blank → null, a valid rate → its canonical stored form ("2/16" → "1/8",
 * "0.1875" → "18.75%", "3/20" kept), anything else → 400 with the reason.
 * `stored` is the deal's current value: re-submitting it unchanged is always
 * accepted, so an old free-text rate never blocks an unrelated save.
 */
export function normalizeRoyaltyRate(v: string | null | undefined, stored?: string | null): string | null | undefined {
  if (v === undefined) return undefined;
  const t = (v ?? "").trim();
  if (!t) return null;
  if (stored != null && t === stored.trim()) return stored;
  const p = parseRoyaltyRate(t);
  if (!p.ok) throw new HttpError(400, `Royalty rate: ${p.error}`);
  return p.canonical;
}

// --------------------------------------------------------------------------
// List
// --------------------------------------------------------------------------
dealsRouter.get(
  "/",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    // ?recordType=OPPORTUNITY (default) | OWNED_ASSET | ALL.
    // Asset sale lifecycle: an owned asset marked SELL is actively marketed, so
    // it also behaves as an opportunity (Deals / Pipeline / Dashboard). A HOLD
    // asset stays only in the Mineral Assets module. Once a sale CLOSES the
    // record leaves the assets module (it's now a Closed Deal).
    const rt = String(req.query.recordType ?? "OPPORTUNITY").toUpperCase();
    // Every deal of the org is listed on its own (the former "additional deals"
    // grouping is no longer surfaced; records that were grouped stay intact and
    // appear here as ordinary deals).
    const where = { organizationId: orgId(req) } as Record<string, unknown>;
    // ?visibility=active | hidden | all — the Deals list's Hide/Unhide control.
    // Filtered here, in the query, so a hidden deal never reaches the list or
    // the table-level metrics computed from it. Omitted = all: every other
    // consumer (Pipeline, Reports, Mineral Assets, Dashboard) keeps counting
    // hidden deals — hiding is a Deals-page working-view choice, not a status.
    const visibility = String(req.query.visibility ?? "all").toLowerCase();
    if (visibility === "active") where.hiddenAt = null;
    else if (visibility === "hidden") where.hiddenAt = { not: null };
    if (rt === "OPPORTUNITY") {
      where.OR = [{ recordType: "OPPORTUNITY" }, { recordType: "OWNED_ASSET", assetMode: "SELL" }];
    } else if (rt === "OWNED_ASSET") {
      where.recordType = "OWNED_ASSET";
      where.stage = { not: "CLOSED" }; // sold assets move to Closed Deals, not the portfolio
    }
    // Owned-asset portfolio derives Annual Royalty Income from recorded revenue,
    // so pull the lightweight revenue scalars only for that listing.
    const revenueInclude = rt === "OWNED_ASSET"
      ? { revenueEntries: { select: { month: true, amount: true, kind: true } } }
      : {};
    const deals = await prisma.deal.findMany({
      where,
      include: { ...dealInclude, offers: { select: { id: true, amount: true, status: true } }, _count: { select: { assets: true } }, assets: { select: { nra: true, acreageNma: true, ourPrice: true, askPrice: true } }, ...revenueInclude },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
    });
    res.json(deals.map((d) => serializeDeal(d)));
  }),
);

// --------------------------------------------------------------------------
// Operator options for the deal form — operators with activity in the selected
// state(s) AND county(ies). Sources: RRC wells (Texas only — rrc.wells carries
// no state column), the org's imported drilling permits, and operators already
// recorded on the org's deals there. No county → no options.
// --------------------------------------------------------------------------
const operatorOptionsSchema = z.object({
  states: z.string().max(2_000).optional(),
  counties: z.string().max(8_000).optional(),
});
const csvList = (s: string | undefined, max: number) =>
  [...new Set((s ?? "").split(",").map((v) => v.trim()).filter(Boolean))].slice(0, max);

dealsRouter.get(
  "/operator-options",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = operatorOptionsSchema.parse(req.query);
    const states = csvList(q.states, 60).map((s) => s.toUpperCase());
    const counties = csvList(q.counties, 300);
    if (!states.length || !counties.length) { res.json([]); return; }
    const countiesLc = counties.map((c) => c.toLowerCase());

    const [wells, permits, deals] = await Promise.all([
      states.includes("TX")
        ? prisma.$queryRawUnsafe<{ name: string; n: number }[]>(
            `SELECT operator AS name, count(*)::int AS n FROM rrc.wells
              WHERE county = ANY($1::text[]) AND operator IS NOT NULL AND operator <> ''
              GROUP BY operator`,
            counties,
          ).catch(() => [] as { name: string; n: number }[]) // rrc schema absent (dev DBs)
        : Promise.resolve([] as { name: string; n: number }[]),
      prisma.researchPermit.findMany({
        where: {
          organizationId: researchOrgId(req), // reference data (demo: reference org)
          state: { in: states, mode: "insensitive" },
          county: { in: counties, mode: "insensitive" },
        },
        select: { operator: true },
        distinct: ["operator"],
        take: 2_000,
      }),
      prisma.deal.findMany({
        where: { organizationId: orgId(req), operator: { not: null }, states: { hasSome: states }, counties: { hasSome: counties } },
        select: { operator: true, counties: true },
        take: 2_000,
      }),
    ]);

    // Dedupe case-insensitively; keep the first spelling seen (RRC's canonical
    // name first) and the well count as a hint.
    const byKey = new Map<string, { name: string; wells: number }>();
    const add = (name: string | null | undefined, wellCount = 0) => {
      const n = name?.trim();
      if (!n) return;
      const k = n.toUpperCase();
      const cur = byKey.get(k);
      if (cur) cur.wells += wellCount;
      else byKey.set(k, { name: n, wells: wellCount });
    };
    for (const w of wells) add(w.name, w.n);
    for (const p of permits) add(p.operator);
    for (const d of deals) if (d.counties.some((c) => countiesLc.includes(c.toLowerCase()))) add(d.operator);
    res.json([...byKey.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }),
);

const createSchema = z.object({
  name: z.string().min(1).max(500),
  sellerNames: z.array(z.string().max(200)).max(500).optional(),
  counties: z.array(z.string().max(200)).max(500).optional(),
  state: z.string().max(10_000).nullish(),
  states: z.array(z.string().max(200)).max(500).optional(),
  acreageNma: z.number().nullish(),
  nra: z.number().nullish(),
  abstractIds: z.array(z.string().max(200)).max(500).optional(),
  operator: z.string().max(10_000).nullish(),
  rrc: z.string().max(10_000).nullish(),
  askPrice: z.number().nullish(),
  ourPrice: z.number().nullish(),
  assetTypes: z.array(z.string().max(200)).max(500).optional(),
  dateUnderContract: dateField,
  originalClosingDate: dateField,
  estimatedClosingCosts: z.number().nullish(),
  relationshipOwnerId: z.string().max(10_000).nullish(),
  assigneeIds: z.array(z.string().max(200)).max(500).optional(),
  notes: z.string().max(10_000).nullish(),
  // Which pipeline the deal enters (default pipeline when omitted).
  pipelineId: z.string().max(200).nullish(),
  // The seller (required for a new deal): an existing Contact or the details
  // of one — resolved to a Contact and linked as the deal's primary seller in
  // the same transaction (domain/sellerContact.ts).
  seller: sellerInfoSchema.optional(),
  ...pricingFields,
  ...assetFields,
});

dealsRouter.post(
  "/",
  requirePermission("createDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = normalizeNumbers(createSchema.parse(req.body));
    data.royaltyRate = normalizeRoyaltyRate(data.royaltyRate);
    // A manually entered total always wins; otherwise derive it from the
    // per-acre rate × the deal's acreage (so it also satisfies "Our Price").
    data.ourPrice ??= totalFromPerAcre(data.ourCostPerNma, data.acreageNma, data.ourCostPerNra, data.nra);
    data.askPrice ??= totalFromPerAcre(data.askPricePerNma, data.acreageNma, data.askPricePerNra, data.nra);
    const isAsset = data.recordType === "OWNED_ASSET";
    // Required fields for a new acquisition opportunity (owned assets follow the
    // asset flow and are exempt).
    const dealRequired = (d: { states?: string[]; state?: string | null; counties?: string[]; nra?: number | null; acreageNma?: number | null; assetTypes?: string[]; ourPrice?: number | null; dateUnderContract?: unknown; name?: string }): string[] => {
      const states = d.states ?? (d.state ? [d.state] : []);
      const req_: [boolean, string][] = [
        [!!d.name?.trim(), "Deal Name"],
        [states.length > 0, "State"],
        // Abstract is intentionally NOT required: cadastral coverage only exists
        // for GIS-imported counties, and deals elsewhere must still be creatable.
        [(d.counties ?? []).length > 0, "County"],
        // Either acreage measurement satisfies the requirement: unleased
        // acreage has no royalty interest, so NRA may not apply — NMA stands
        // in for it there.
        [d.nra != null || d.acreageNma != null, "NRA or NMA"],
        [(d.assetTypes ?? []).length > 0, "Asset Type"],
        [d.ourPrice != null, "Our Price"],
        [d.dateUnderContract != null, "Date Under Contract"],
      ];
      return req_.filter(([ok]) => !ok).map(([, name]) => name);
    };
    if (!isAsset) {
      const missing = dealRequired(data);
      // A deal is always created with its seller (an existing Contact or a new one).
      if (!data.seller) missing.push("Seller");
      if (missing.length) throw new HttpError(400, `Missing required fields: ${missing.join(", ")}`);
    } else {
      // New Mineral Assets carry the full location chain plus the standardized
      // Asset Type. (Converting an existing deal PATCHes and isn't gated.)
      const states = data.states ?? (data.state ? [data.state] : []);
      const req_: [boolean, string][] = [
        [!!data.name?.trim(), "Asset Name"],
        [states.length > 0, "State"],
        [(data.counties ?? []).length > 0, "County"],
        [(data.abstractIds ?? []).length > 0, "Abstract"],
        [(data.surveys ?? []).length > 0, "Survey"],
        [(data.assetTypes ?? []).length > 0, "Asset Type"],
      ];
      const missing = req_.filter(([ok]) => !ok).map(([, n]) => n);
      if (missing.length) throw new HttpError(400, `Missing required fields: ${missing.join(", ")}`);
    }
    const assigneeIds = data.assigneeIds ? await validateOrgUsers(orgId(req), data.assigneeIds) : [];
    // A caller-supplied relationship owner must be a user in the caller's org;
    // otherwise a foreign userId would be persisted and serialized back.
    if (data.relationshipOwnerId) await validateOrgUsers(orgId(req), [data.relationshipOwnerId]);
    // New opportunities enter the chosen pipeline's first active stage (the
    // org's default pipeline when none was specified; seeds stages on first
    // use). Owned assets park in CLOSING as before.
    let pipelineId: string | null = null;
    if (data.pipelineId) {
      const p = await prisma.pipeline.findFirst({ where: { id: data.pipelineId, organizationId: orgId(req) } });
      if (!p) throw new HttpError(400, "Unknown pipeline");
      // Opportunity pipelines hold prospects (Opportunity records), never deals.
      if (isOpportunityPipeline(p)) throw new HttpError(400, "Deals cannot be created in an opportunity pipeline");
      pipelineId = p.isDefault ? null : p.id; // null = default, keeps legacy rows uniform
    }
    const activeKeys = await activeStageKeys(prisma, orgId(req), pipelineId);
    if (!isAsset && activeKeys.length === 0) {
      throw new HttpError(400, "This pipeline has no stages yet — add a stage to it before creating deals there");
    }
    const firstStage = activeKeys[0] ?? "UNDER_CONTRACT";
    const initialStage = isAsset ? "CLOSING" : firstStage;
    const deal = await prisma.$transaction(async (tx) => {
      const created = await tx.deal.create({
        data: {
          organizationId: orgId(req),
          pipelineId,
          name: data.name,
          sellerNames: data.sellerNames ?? [],
          recordType: data.recordType ?? "OPPORTUNITY",
          // Owned assets default to HOLD; opportunities have no asset mode.
          assetMode: isAsset ? (data.assetMode ?? "HOLD") : null,
          counties: data.counties ?? [],
          states: data.states ?? (data.state ? [data.state] : []),
          state: data.states?.[0] ?? data.state ?? null,
          acreageNma: data.acreageNma ?? null,
          nra: data.nra ?? null,
          abstractIds: data.abstractIds ?? [],
          operator: data.operator ?? null,
          rrc: data.rrc ?? null,
          askPrice: data.askPrice ?? null,
          ourPrice: data.ourPrice ?? null,
          ourCostPerNma: data.ourCostPerNma ?? null,
          ourCostPerNra: data.ourCostPerNra ?? null,
          askPricePerNma: data.askPricePerNma ?? null,
          askPricePerNra: data.askPricePerNra ?? null,
          daysToClose: data.daysToClose ?? null,
          assetTypes: data.assetTypes ?? [],
          dateUnderContract: toDate(data.dateUnderContract) ?? null,
          originalClosingDate: toDate(data.originalClosingDate) ?? null,
          closingBaselineDate: toDate(data.originalClosingDate) ?? null, // the +15 baseline (domain/dates)
          estimatedClosingCosts: data.estimatedClosingCosts ?? null,
          relationshipOwnerId: data.relationshipOwnerId ?? req.user!.id,
          assignees: assigneeIds.length ? { connect: assigneeIds.map((id) => ({ id })) } : undefined,
          notes: data.notes ?? null,
          // Owned assets skip the acquisition pipeline — park them in CLOSING so
          // they don't clutter the acquisition board unless marked for sale.
          stage: initialStage,
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
          leaseStatuses: data.leaseStatuses ?? [],
          royaltyRate: data.royaltyRate ?? null,
          leaseEffectiveDate: toDate(data.leaseEffectiveDate) ?? null,
          leaseExpirationDate: toDate(data.leaseExpirationDate) ?? null,
          leaseStatus: data.leaseStatus ?? null,
          leaseInfo: data.leaseInfo ?? null,
          divisionOrdersNote: data.divisionOrdersNote ?? null,
          taxInfo: data.taxInfo ?? null,
        },
        include: dealInclude,
      });
      await tx.dealStageHistory.create({
        data: { dealId: created.id, fromStage: null, toStage: initialStage, changedByUserId: req.user!.id },
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

      // The seller: resolve the block to a Contact (named, matched, or created)
      // and link it as the deal's primary seller — all in this transaction, so
      // a failure anywhere leaves no half-created deal, seller or contact.
      if (data.seller) {
        const access = contactAccess(req);
        const { contact, created: newContact } = await resolveSellerContact(tx, orgId(req), data.seller, {
          ownerId: data.relationshipOwnerId ?? req.user!.id, type: "SELLER", notFound: (m) => new HttpError(400, m), manage: access.manage,
        });
        await tx.dealSeller.create({ data: { dealId: created.id, ...dealSellerFromInfo(data.seller, contact, access.view) } });
        // The seller's geography of interest, from the deal, when the contact
        // has none yet (an existing contact only for a caller who may manage contacts).
        if (newContact || access.manage) {
          await fillContactGeography(tx, contact, { states: created.states.length ? created.states : created.state ? [created.state] : [], counties: created.counties });
        }
      }
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
    res.json(await dealDetail(orgId(req), req.params.id, hasPermission(req, "viewContacts")));
  }),
);

/**
 * The full deal-page payload (GET /deals/:id). Exported so the opportunity
 * conversion endpoint can return the new deal in exactly this shape.
 * `viewContacts`: whether the caller may see the sellers' linked Contact
 * details (phone, email, mailing address) — see serializeSeller.
 */
export async function dealDetail(organizationId: string, id: string, viewContacts: boolean) {
  const deal = await prisma.deal.findFirst({
    where: { id, organizationId },
    include: {
      ...dealInclude,
      stageHistory: { orderBy: { createdAt: "asc" }, include: { changedBy: { select: userRefSelect } } },
      offers: { include: { buyer: { select: { id: true, name: true, companyName: true } } }, orderBy: { dateSubmitted: "desc" } },
      // Only current versions; prior (superseded) versions stay reachable via /files/:id/versions.
      files: {
        where: { supersededById: null },
        include: { uploadedBy: { select: userRefSelect }, _count: { select: { supersedes: true } } },
        orderBy: { createdAt: "desc" },
      },
      buyerActivity: {
        include: {
          buyer: { include: { buyBox: true } },
          sentBy: { select: userRefSelect },
          assignedTeamMember: { select: userRefSelect },
          messages: { orderBy: { occurredAt: "desc" }, include: { createdBy: { select: userRefSelect } } },
        },
      },
      sellers: { include: { assignedTeamMember: { select: userRefSelect }, contact: { select: sellerContactSelect } }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      revenueEntries: { orderBy: { month: "asc" } },
      // Contract-timeline extensions, oldest first (each chains from the last).
      contractExtensions: { orderBy: { createdAt: "asc" } },
      _count: { select: { assets: true } },
    },
  });
  if (!deal) throw new HttpError(404, "Deal not found");

  const now = new Date();
  // Who extended the closing: the extension rows keep only the user id, so the
  // names are looked up here (a departed user shows as unknown rather than
  // blocking the row).
  const extenderIds = [...new Set(deal.contractExtensions.map((e) => e.extendedByUserId).filter((v): v is string => v != null))];
  const priceHistory = await prisma.activityLog.findMany({
    where: { dealId: deal.id, organizationId, eventType: ASK_SYNCED_EVENT },
    orderBy: { createdAt: "desc" }, take: 50,
    include: { actor: { select: userRefSelect } },
  });
  const buyerIdsInHistory = [...new Set(priceHistory.map((h) => h.buyerId).filter((v): v is string => v != null))];
  const buyerNames = new Map((buyerIdsInHistory.length ? await prisma.buyer.findMany({ where: { id: { in: buyerIdsInHistory } }, select: { id: true, name: true } }) : []).map((b) => [b.id, b.name]));
  const extenders = extenderIds.length
    ? await prisma.user.findMany({ where: { id: { in: extenderIds } }, select: { id: true, name: true } })
    : [];
  const extenderById = new Map(extenders.map((u) => [u.id, userRef(u)]));
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
      sentBy: userRef(a.sentBy),
      assignedTeamMember: a.assignedTeamMember ? { id: a.assignedTeamMember.id, name: a.assignedTeamMember.name } : null,
      timeline: a.messages.map((m) => ({
        id: m.id,
        kind: m.kind,
        subject: m.subject,
        body: m.body,
        occurredAt: m.occurredAt,
        createdBy: userRef(m.createdBy),
        threadId: m.threadId,
      })),
    };
  });

  // Metrics row.
  const buyersContacted = activity.length;
  const interested = activity.filter((a) => ENGAGED_STATUSES.includes(a.status)).length;
  const offerCount = deal.offers.length;
  const highOffer = deal.offers.reduce<number | null>((max, o) => (max == null || o.amount > max ? o.amount : max), null);

  return {
    ...serializeDeal(deal, now),
    // Full child-asset cards for the package's Assets/Tracts section.
    stageHistory: deal.stageHistory.map((h) => ({
      id: h.id,
      fromStage: h.fromStage,
      toStage: h.toStage,
      changedBy: userRef(h.changedBy),
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
      uploadedBy: userRef(f.uploadedBy),
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      versionCount: f._count.supersedes,
    })),
    buyerActivity: activity,
    contractExtensions: deal.contractExtensions.map((e) => serializeContractExtension(e, e.extendedByUserId ? extenderById.get(e.extendedByUserId) ?? null : null)),
    // Asking-price history: every time an accepted offer set the price (newest first).
    priceHistory: priceHistory.map((h) => {
      const m = (h.metadata ?? {}) as { before?: Record<string, number | null>; after?: Record<string, number | null>; offerId?: string; offerAmount?: number; buyerId?: string; ourPriceKeptFromAsk?: number };
      return { id: h.id, at: h.createdAt, summary: h.summary, actor: userRef(h.actor), before: m.before ?? null, after: m.after ?? null, offerId: m.offerId ?? null, offerAmount: m.offerAmount ?? null, buyerId: m.buyerId ?? null, buyerName: h.buyerId ? buyerNames.get(h.buyerId) ?? null : null, ourPriceKeptFromAsk: m.ourPriceKeptFromAsk ?? null };
    }),
    sellers: deal.sellers.map((s) => serializeSeller(s, viewContacts)),
    revenueEntries: deal.revenueEntries.map((r) => ({
      id: r.id, month: r.month, amount: r.amount, kind: r.kind, operator: r.operator, note: r.note,
    })),
    metrics: { buyersContacted, interested, offers: offerCount, highOffer },
  };
}

// Seller serialization — the buyer/UI-facing projection of a DealSeller row.
function serializeSeller(
  s: {
    id: string; isPrimary: boolean; ownershipPercent: number | null;
    firstName: string | null; middleName: string | null; lastName: string | null;
    companyName: string | null; trustName: string | null; sellerType: string;
    primaryPhone: string | null; secondaryPhone: string | null; email: string | null; preferredContactMethod: string | null;
    mailingAddress: string | null; mailingCity: string | null; mailingState: string | null; mailingZip: string | null;
    physicalAddress: string | null; physicalCity: string | null; physicalState: string | null; physicalZip: string | null;
    internalNotes: string | null; preferredCommunicationNotes: string | null;
    assignedTeamMemberId: string | null; assignedTeamMember: { id: string; name: string; firstName?: string | null; lastName?: string | null; avatarColor?: string | null } | null;
    contactId?: string | null; contact?: SellerContactRow | null;
    createdAt: Date; updatedAt: Date;
  },
  viewContacts: boolean,
) {
  // The linked Contact is the source of truth for the shared fields (its
  // contact details only for a caller who may view contacts).
  s = overlayContact(s, s.contact, viewContacts);
  return {
    id: s.id, isPrimary: s.isPrimary, ownershipPercent: s.ownershipPercent,
    contact: s.contact ? { id: s.contact.id, name: contactName(s.contact) || "Contact" } : null,
    firstName: s.firstName, middleName: s.middleName, lastName: s.lastName,
    companyName: s.companyName, trustName: s.trustName, sellerType: s.sellerType,
    primaryPhone: s.primaryPhone, secondaryPhone: s.secondaryPhone, email: s.email, preferredContactMethod: s.preferredContactMethod,
    mailingAddress: s.mailingAddress, mailingCity: s.mailingCity, mailingState: s.mailingState, mailingZip: s.mailingZip,
    physicalAddress: s.physicalAddress, physicalCity: s.physicalCity, physicalState: s.physicalState, physicalZip: s.physicalZip,
    internalNotes: s.internalNotes, preferredCommunicationNotes: s.preferredCommunicationNotes,
    assignedTeamMember: userRef(s.assignedTeamMember),
    dateAdded: s.createdAt, updatedAt: s.updatedAt,
  };
}

// --------------------------------------------------------------------------
// Send the deal to selected buyers by email (CRM-side, SMTP). Each send logs a
// Buyer Activity (CONTACTED) + an EMAIL_OUT timeline entry with sender + time.
// --------------------------------------------------------------------------
const sendEmailSchema = z.object({
  buyerIds: z.array(z.string().max(200)).min(1).max(1000),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(100_000),
});

/**
 * The only user-triggered outbound email path in the app, and the one endpoint
 * here that spends a resource the org cannot get back: a send burns the
 * organization's Resend/SMTP quota and, more durably, its sending domain's
 * reputation. One call already fans out to as many as 1,000 buyers (see
 * sendEmailSchema), so an unthrottled loop is a bulk mailer pointed at the CRM's
 * real business contacts — quota exhaustion and a blacklisted domain, not just
 * wasted cycles. Recipients are org-scoped below, so this is never an open relay.
 *
 * Keyed on the authenticated user, NOT req.ip: requireAuth + requireOrg run
 * above, so the caller is always known, and the org's sending budget is the
 * thing being protected — an IP bucket would let one user rotate egress
 * addresses (mobile switch, VPN, second device) to keep sending. Mirrors the
 * keying in aiRouter and twoFactorLimiter.
 *
 * The ceiling clears real outreach comfortably: a batch send is one request, and
 * working through even a dozen deals in a quarter hour stays well inside it.
 */
const sendEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user?.id ?? req.ip ?? "unknown",
  message: { error: "Too many email sends. Wait a few minutes and try again." },
});

dealsRouter.post(
  "/:id/email",
  requirePermission("sendEmail"),
  sendEmailLimiter,
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
      // Subject stays plain text; the body is escaped exactly once inside
      // renderEmailBody (fixes double-encoded "&amp;" in delivered emails).
      const finalSubject = personalize(subject, tokens);
      const finalBody = renderEmailBody(body, tokens);
      try {
        await sendEmail({ to: b.email, subject: finalSubject, html: finalBody, replyTo: req.user!.email, organizationId: orgId(req) });
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
    states: [], counties: [], assetTypes: [],
    minAcreage: null, maxAcreage: null, minPrice: null, maxPrice: null,
  };
}

// --------------------------------------------------------------------------
// Match recommendations — live, every buyer, ranked, NO filters
// --------------------------------------------------------------------------
dealsRouter.get(
  "/:id/matches",
  requirePermission("viewDeals"),
  requirePermission("viewBuyers"), // it returns the org's buyer roster
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
          criteriaSpecified: match.criteriaSpecified,
          criteriaSpecifiedMatched: match.criteriaSpecifiedMatched,
          owners: b.owners.map((o) => o.user.name),
          previousDealsClosed: closedCount,
          lastContactDate: lastContact,
          stale,
        };
      }),
    );

    // Equal percentages: the better-specified buy box ranks first — 100% of 5
    // criteria is stronger evidence than 100% of an empty box.
    recs.sort((a, b) => b.matchPercent - a.matchPercent || b.criteriaSpecified - a.criteriaSpecified);
    res.json(recs.map((r, i) => ({ rank: i + 1, ...r })));
  }),
);

// --------------------------------------------------------------------------
// Update (characteristics + dates + overrides)
// --------------------------------------------------------------------------
const updateSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  sellerNames: z.array(z.string().max(200)).max(500).optional(),
  counties: z.array(z.string().max(200)).max(500).optional(),
  state: z.string().max(10_000).nullish(),
  states: z.array(z.string().max(200)).max(500).optional(),
  acreageNma: z.number().nullish(),
  nra: z.number().nullish(),
  abstractIds: z.array(z.string().max(200)).max(500).optional(),
  operator: z.string().max(10_000).nullish(),
  rrc: z.string().max(10_000).nullish(),
  askPrice: z.number().nullish(),
  ourPrice: z.number().nullish(),
  assetTypes: z.array(z.string().max(200)).max(500).optional(),
  dateUnderContract: dateField,
  originalClosingDate: dateField,
  findBuyerByDateOverride: dateField,
  finalClosingDateOverride: dateField,
  closedDate: dateField,
  // Manual "Closing with buyer" date (never calculated).
  buyerClosingDate: dateField,
  estimatedClosingCosts: z.number().nullish(),
  relationshipOwnerId: z.string().max(10_000).nullish(),
  assigneeIds: z.array(z.string().max(200)).max(500).optional(),
  notes: z.string().max(10_000).nullish(),
  ...pricingFields,
  ...assetFields,
});

// --- Buyer Offering Portal controls ----------------------------------------
// Publish state, visibility, featured flag, and buyer-facing summary. The
// share slug is generated once on first publish and never rotates (shared
// links keep working); it stays valid-but-inactive while unpublished.
// All of the org's portal offerings (published + unpublished-but-slugged) for
// the Buyer Portal admin page.
dealsRouter.get(
  "/portal/offerings",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.deal.findMany({
      where: { organizationId: orgId(req), OR: [{ publishedToPortal: true }, { portalSlug: { not: null } }] },
      select: {
        id: true, name: true, stage: true, counties: true, states: true, nra: true,
        publishedToPortal: true, portalSlug: true, portalVisibility: true, portalFeatured: true, updatedAt: true,
      },
      orderBy: [{ publishedToPortal: "desc" }, { portalFeatured: "desc" }, { updatedAt: "desc" }],
    });
    res.json(rows);
  }),
);

dealsRouter.get(
  "/:id/portal",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const deal = await prisma.deal.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
      select: { id: true, publishedToPortal: true, portalSlug: true, portalVisibility: true, portalFeatured: true,
        portalSummary: true, portalAskPrice: true, askPrice: true,
        portalContacts: true, portalContactName: true, portalContactTitle: true, portalContactEmail: true, portalContactPhone: true,
        files: { where: { supersededById: null }, select: { id: true, filename: true, folder: true, visibleToBuyers: true } } },
    });
    if (!deal) throw new HttpError(404, "Deal not found");
    const { portalContacts, portalContactName, portalContactTitle, portalContactEmail, portalContactPhone, ...rest } = deal;
    res.json({
      ...rest,
      contacts: normalizeDealContacts(portalContacts, { name: portalContactName, title: portalContactTitle, email: portalContactEmail, phone: portalContactPhone }),
    });
  }),
);

// Listing analytics for the Buyer Portal panel: views / unique visitors /
// document downloads from anonymous PortalEvent rows, plus inquiry context
// from the deal's offers. Everything here is computed — nothing is estimated.
dealsRouter.get(
  "/:id/portal/stats",
  requirePermission("viewDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const deal = await prisma.deal.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
      select: { id: true },
    });
    if (!deal) throw new HttpError(404, "Deal not found");
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [views, viewsThisWeek, viewVisitors, downloads, topDownloads, firstView, offers] = await Promise.all([
      prisma.portalEvent.count({ where: { dealId: deal.id, kind: "VIEW" } }),
      prisma.portalEvent.count({ where: { dealId: deal.id, kind: "VIEW", createdAt: { gte: weekAgo } } }),
      prisma.portalEvent.groupBy({ by: ["visitorId"], where: { dealId: deal.id, kind: "VIEW" }, _count: { _all: true } }),
      prisma.portalEvent.count({ where: { dealId: deal.id, kind: "DOWNLOAD" } }),
      prisma.portalEvent.groupBy({ by: ["fileId"], where: { dealId: deal.id, kind: "DOWNLOAD", fileId: { not: null } }, _count: { _all: true }, orderBy: { _count: { fileId: "desc" } }, take: 1 }),
      prisma.portalEvent.findFirst({ where: { dealId: deal.id, kind: "VIEW" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      prisma.offer.findMany({ where: { dealId: deal.id }, orderBy: { dateSubmitted: "desc" }, select: { dateSubmitted: true, buyer: { select: { name: true } } } }),
    ]);
    const topFileId = topDownloads[0]?.fileId ?? null;
    const topFile = topFileId
      ? await prisma.fileAttachment.findUnique({ where: { id: topFileId }, select: { filename: true, folder: true } })
      : null;
    res.json({
      views,
      viewsThisWeek,
      uniqueVisitors: viewVisitors.length,
      returningVisitors: viewVisitors.filter((v) => v._count._all >= 2).length,
      downloads,
      topDownload: topFile ? { filename: topFile.filename, folder: topFile.folder } : null,
      firstViewAt: firstView?.createdAt ?? null,
      inquiries: offers.length,
      lastInquiry: offers[0] ? { name: offers[0].buyer.name, date: offers[0].dateSubmitted } : null,
    });
  }),
);

// Per-deal published contacts. Source of truth is the `portalContacts` JSON
// array; a legacy single-contact (scalar columns) seeds a one-element array so
// existing listings keep their contact through the rollout.
export interface DealPortalContact { id: string; name: string; title: string | null; email: string | null; phone: string | null }
const cstr = (v: unknown): string => (typeof v === "string" ? v : "");
const cstrn = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
export function normalizeDealContacts(
  raw: unknown,
  legacy?: { name: string | null; title: string | null; email: string | null; phone: string | null },
): DealPortalContact[] {
  if (Array.isArray(raw)) {
    return raw
      .map((c, i): DealPortalContact => {
        const o = (c && typeof c === "object") ? c as Record<string, unknown> : {};
        return { id: cstrn(o.id) ?? `c${i}`, name: cstr(o.name).trim(), title: cstrn(o.title), email: cstrn(o.email), phone: cstrn(o.phone) };
      })
      .filter((c) => c.name || c.email || c.phone);
  }
  if (legacy && (legacy.name || legacy.email || legacy.phone)) {
    return [{ id: "legacy", name: (legacy.name ?? "").trim(), title: legacy.title, email: legacy.email, phone: legacy.phone }];
  }
  return [];
}

dealsRouter.patch(
  "/:id/portal",
  requirePermission("publishOfferings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z.object({
      published: z.boolean().optional(),
      visibility: z.enum(["PUBLIC", "LINK_ONLY"]).optional(),
      featured: z.boolean().optional(),
      summary: z.string().trim().max(4000).nullish(),
      // Buyer-facing asking-price override; null clears it (falls back to askPrice).
      askPrice: z.number().nonnegative().nullish(),
      // Per-deal published contacts (ordered) — the representatives shown on THIS
      // listing. Replaces the whole list; unique to this deal.
      contacts: z.array(z.object({
        id: z.string().optional(),
        name: z.string().trim().max(160).optional().default(""),
        title: z.string().trim().max(120).nullish(),
        email: z.string().trim().max(200).nullish(),
        phone: z.string().trim().max(60).nullish().transform((v) => (v == null ? v : normalizePhone(v))),
      })).max(25).optional(),
    }).parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, select: { id: true, portalSlug: true } });
    if (!deal) throw new HttpError(404, "Deal not found");
    const patch: Record<string, unknown> = {};
    if (body.published !== undefined) {
      patch.publishedToPortal = body.published;
      if (body.published && !deal.portalSlug) patch.portalSlug = newPortalSlug();
    }
    if (body.visibility !== undefined) patch.portalVisibility = body.visibility;
    if (body.featured !== undefined) patch.portalFeatured = body.featured;
    if (body.summary !== undefined) patch.portalSummary = body.summary;
    if (body.askPrice !== undefined) patch.portalAskPrice = body.askPrice;
    if (body.contacts !== undefined) {
      const list = normalizeDealContacts(body.contacts);
      patch.portalContacts = list;
      // Mirror the primary contact into the legacy scalars for back-compat.
      const first = list[0] ?? null;
      patch.portalContactName = first?.name ?? null;
      patch.portalContactTitle = first?.title ?? null;
      patch.portalContactEmail = first?.email ?? null;
      patch.portalContactPhone = first?.phone ?? null;
    }
    const updated = await prisma.deal.update({
      where: { id: deal.id }, data: patch,
      select: { id: true, publishedToPortal: true, portalSlug: true, portalVisibility: true, portalFeatured: true,
        portalSummary: true, portalAskPrice: true, askPrice: true,
        portalContacts: true, portalContactName: true, portalContactTitle: true, portalContactEmail: true, portalContactPhone: true },
    });
    const { portalContacts, portalContactName, portalContactTitle, portalContactEmail, portalContactPhone, ...urest } = updated;
    res.json({
      ...urest,
      contacts: normalizeDealContacts(portalContacts, { name: portalContactName, title: portalContactTitle, email: portalContactEmail, phone: portalContactPhone }),
    });
  }),
);

dealsRouter.patch(
  "/:id",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = updateSchema.parse(req.body);
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "sellerNames", "counties", "state", "states", "acreageNma", "nra", "abstractIds", "operator", "rrc", "askPrice", "ourPrice", "assetTypes", "estimatedClosingCosts", "relationshipOwnerId", "notes", ...PRICING_KEYS, ...ASSET_SCALAR_KEYS] as const) {
      if (k in data) patch[k] = (data as Record<string, unknown>)[k];
    }
    for (const k of ["dateUnderContract", "originalClosingDate", "findBuyerByDateOverride", "finalClosingDateOverride", "closedDate", "buyerClosingDate", "acquisitionDate", "leaseEffectiveDate", "leaseExpirationDate"] as const) {
      if (k in data) patch[k] = toDate((data as Record<string, unknown>)[k]);
    }
    const existing = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) throw new HttpError(404, "Deal not found");
    if ("royaltyRate" in data) patch.royaltyRate = normalizeRoyaltyRate(data.royaltyRate, existing.royaltyRate);
    // Editing Closing never moves the automatic Extended Closing: the baseline
    // it derives from is fixed the first time Closing is edited — the date the
    // deal had until now (for deals created before the baseline existed) —
    // and stays until a user explicitly changes the extended date.
    if ("originalClosingDate" in data && existing.closingBaselineDate == null) {
      patch.closingBaselineDate = existing.originalClosingDate ?? toDate(data.originalClosingDate) ?? null;
    }
    if (data.assigneeIds !== undefined) {
      const ids = await validateOrgUsers(orgId(req), data.assigneeIds);
      patch.assignees = { set: ids.map((id) => ({ id })) };
    }
    // Reassigning the relationship owner: the new owner must be in the org.
    if (data.relationshipOwnerId) await validateOrgUsers(orgId(req), [data.relationshipOwnerId]);
    // Keep the single `state` synced to the first selected state (matching/map).
    if (data.states !== undefined) patch.state = data.states[0] ?? null;
    const deal = await prisma.deal.update({ where: { id: req.params.id }, data: normalizeNumbers(patch), include: dealInclude });
    res.json(serializeDeal(deal));
  }),
);

// --------------------------------------------------------------------------
// Contract timeline — "Extended": push the applicable Final Closing out by
// 15 calendar days. The new deadline lands in finalClosingDateOverride (so it
// is what resolveDealDates — and therefore the calendar, alerts and Outlook
// sync — read from now on), and a DealContractExtension row records the move.
// Repeated extensions chain from the current applicable deadline.
// --------------------------------------------------------------------------
dealsRouter.post(
  "/:id/extend",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    const ext = nextContractExtension(deal);
    if (!ext) throw new HttpError(400, "There is no closing date to extend — set the Closing date first.");
    await prisma.$transaction(async (tx) => {
      await tx.deal.update({ where: { id: deal.id }, data: { finalClosingDateOverride: ext.toDate } });
      await tx.dealContractExtension.create({
        data: { dealId: deal.id, fromDate: ext.fromDate, toDate: ext.toDate, days: ext.days, extendedByUserId: req.user!.id },
      });
      await logActivity(
        {
          eventType: "CLOSING_EXTENDED",
          summary: `${req.user!.name} extended the closing on "${deal.name}" to ${formatCalendarDay(ext.toDate)} (+${ext.days} days)`,
          organizationId: orgId(req),
          actorUserId: req.user!.id,
          dealId: deal.id,
        },
        tx,
      );
    });
    res.json(await dealDetail(orgId(req), deal.id, hasPermission(req, "viewContacts")));
  }),
);

// --------------------------------------------------------------------------
// Stage change — records history; Dead requires a reason
// --------------------------------------------------------------------------
const stageSchema = z.object({
  toStage: z.string().min(1),
  deadReason: z.string().max(2_000).optional(),
});

dealsRouter.post(
  "/:id/stage",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { toStage, deadReason } = stageSchema.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    // toStage must be one of the DEAL'S pipeline's configured stages.
    const stages = await ensureStages(prisma, orgId(req), deal.pipelineId);
    if (!stages.some((s) => s.key === toStage)) throw new HttpError(400, "Unknown pipeline stage");

    if (toStage === "DEAD" && (!deadReason || !deadReason.trim())) {
      throw new HttpError(400, "A reason is required to move a deal to Dead");
    }
    if (toStage === deal.stage) {
      res.json(serializeDeal(await reload(deal.id)));
      return;
    }

    // The move and all of its side effects (unpublish, cleared follow-ups, read
    // notifications, closed date, winning buyer, history) live in applyStageChange,
    // which also returns the "before" snapshot that makes the move undoable.
    // Moves of one deal are serialized (lockStageRow) and act on the row as it
    // is once the lock is held — a concurrent move (rapid drags, another user)
    // has committed by then, so history and side effects start from the real
    // stage instead of the one read above.
    const snapshot = await prisma.$transaction(async (tx) => {
      await lockStageRow(tx, "Deal", deal.id);
      const current = await tx.deal.findFirst({ where: { id: deal.id, organizationId: orgId(req) } });
      if (!current) throw new HttpError(404, "Deal not found");
      // A concurrent move already landed it there: nothing to do or undo.
      if (current.stage === toStage) return null;
      return applyStageChange(tx, current, {
        toStage,
        deadReason,
        orgId: orgId(req),
        user: { id: req.user!.id, name: req.user!.name },
      });
    });
    // Additive: a short-lived signed token for POST /:id/stage/undo (null when
    // the snapshot is too large to carry, or the move was a no-op).
    res.json({ ...serializeDeal(await reload(deal.id)), undoToken: snapshot ? signStageUndo(snapshot) : null });
  }),
);

// Undo the most recent stage change, restoring the deal exactly: previous
// stage and stage-entered date, dead reason, closed date, portal publication,
// cleared buyer follow-ups, read notifications, the winning buyer's status, and
// the history/activity rows the move wrote. Only the user who made the move,
// within the token's lifetime, and only while nothing has changed since (409).
const stageUndoSchema = z.object({ undoToken: z.string().min(1).max(STAGE_UNDO_MAX_TOKEN_BYTES) });

dealsRouter.post(
  "/:id/stage/undo",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { undoToken } = stageUndoSchema.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, select: { id: true, pipelineId: true } });
    if (!deal) throw new HttpError(404, "Deal not found");
    const snap = verifyStageUndo(undoToken, { dealId: deal.id, orgId: orgId(req), userId: req.user!.id });
    // The stage it came from must still exist on the deal's pipeline.
    const stages = await ensureStages(prisma, orgId(req), deal.pipelineId);
    if (!stages.some((s) => s.key === snap.fromStage)) {
      throw new HttpError(409, "This move can no longer be undone — the stage it came from no longer exists.");
    }
    await prisma.$transaction(async (tx) => {
      await lockStageRow(tx, "Deal", deal.id); // never interleave with a move of the same deal
      await applyStageUndo(tx, snap);
    });
    res.json(serializeDeal(await reload(deal.id)));
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
  notes: z.string().max(10_000).nullish(),
  responseReceived: z.boolean().optional(),
  assignedTeamMemberId: z.string().max(10_000).nullish(),
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
  subject: z.string().max(10_000).nullish(),
  body: z.string().min(1).max(100_000),
  occurredAt: dateField,
});

dealsRouter.post(
  "/:id/activity/:buyerId/messages",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = messageSchema.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    // The buyer must belong to the caller's org — otherwise a foreign buyerId
    // would be linked to this deal (and leaked back via GET /:id). Mirrors the
    // check on POST /:id/activity.
    const buyer = await prisma.buyer.findFirst({ where: { id: req.params.buyerId, organizationId: orgId(req) }, select: { id: true } });
    if (!buyer) throw new HttpError(404, "Buyer not found");
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

/** Org-scoped lookup of one timeline entry on this deal+buyer, or 404. */
async function findDealMessage(req: AuthedRequest): Promise<{ id: string }> {
  const message = await prisma.dealBuyerMessage.findFirst({
    where: {
      id: req.params.messageId,
      dealId: req.params.id,
      buyerId: req.params.buyerId,
      organizationId: orgId(req),
    },
    select: { id: true },
  });
  if (!message) throw new HttpError(404, "Timeline entry not found");
  return message;
}

// Edit a timeline entry. STATUS_CHANGE rows are system-generated, so the kind
// enum here intentionally covers only the user-loggable kinds.
dealsRouter.patch(
  "/:id/activity/:buyerId/messages/:messageId",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = messageSchema.partial().parse(req.body);
    const found = await findDealMessage(req);
    const patch: Record<string, unknown> = {};
    if (data.kind !== undefined) patch.kind = data.kind;
    if (data.subject !== undefined) patch.subject = data.subject ?? null;
    if (data.body !== undefined) patch.body = data.body;
    if (data.occurredAt !== undefined) patch.occurredAt = toDate(data.occurredAt);
    const message = await prisma.dealBuyerMessage.update({ where: { id: found.id }, data: patch });
    res.json(message);
  }),
);

// Delete a timeline entry (any kind, including system STATUS_CHANGE rows).
dealsRouter.delete(
  "/:id/activity/:buyerId/messages/:messageId",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const found = await findDealMessage(req);
    await prisma.dealBuyerMessage.delete({ where: { id: found.id } });
    res.json({ ok: true });
  }),
);

// --------------------------------------------------------------------------
// Bulk "mark as contacted" from Match Recommendations
// --------------------------------------------------------------------------
dealsRouter.post(
  "/:id/contact-bulk",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { buyerIds } = z.object({ buyerIds: z.array(z.string().max(200)).min(1).max(1000) }).parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!deal) throw new HttpError(404, "Deal not found");
    // Only buyers in this org.
    const buyers = await prisma.buyer.findMany({ where: { id: { in: buyerIds }, organizationId: orgId(req) }, select: { id: true } });
    const now = new Date();
    // One batched transaction instead of a sequential await per buyer — bulk
    // marking 50 buyers was 50 round-trips.
    await prisma.$transaction(buyers.map((b) =>
      prisma.dealBuyerActivity.upsert({
        where: { dealId_buyerId: { dealId: deal.id, buyerId: b.id } },
        create: { dealId: deal.id, buyerId: b.id, status: "CONTACTED", dateSent: now, lastActivityDate: now, sentByUserId: req.user!.id },
        update: { lastActivityDate: now },
      }),
    ));
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
    // Scope the offer lookup to this (already org-verified) deal so a
    // caller-supplied offerId can't reach another org's offer.
    const offer = await prisma.offer.findFirst({ where: { id: offerId, dealId: deal.id } });
    if (!offer) throw new HttpError(404, "Offer not found on this deal");

    // Accepting moves the deal into the closing process and pulls the offering
    // from the public portal so it's no longer marketed to other buyers. Buyer
    // activity and communications are untouched (kept for auditing). Stage only
    // advances forward — never regress a deal already at/after CLOSING (by the
    // org's own stage order).
    const stages = await ensureStages(prisma, orgId(req), deal.pipelineId);
    const closing = stages.find((s) => s.key === "CLOSING");
    const posOf = (key: string) => stages.find((s) => s.key === key)?.position ?? Number.MAX_SAFE_INTEGER;
    const advanceToClosing = !!closing && deal.stage !== "DEAD" && deal.stage !== "CLOSED" && posOf(deal.stage) < closing.position;
    const wasPublished = deal.publishedToPortal;
    const updated = await prisma.$transaction(async (tx) => {
      await tx.offer.update({ where: { id: offerId }, data: { status: "ACCEPTED" } });
      // The winning buyer's activity status advances to Accepted Offer — only
      // this buyer; everyone else's history is untouched, and the status stays
      // manually editable afterwards.
      const now = new Date();
      const prevAct = await tx.dealBuyerActivity.findUnique({
        where: { dealId_buyerId: { dealId: deal.id, buyerId: offer.buyerId } },
        select: { id: true, status: true },
      });
      // On a deal that is already Closed the winning buyer's record reads CLOSED
      // (the deal's lifecycle), never a stale ACCEPTED.
      const actStatus = deal.stage === "CLOSED" ? "CLOSED" : "ACCEPTED";
      const acceptedAct = await tx.dealBuyerActivity.upsert({
        where: { dealId_buyerId: { dealId: deal.id, buyerId: offer.buyerId } },
        create: {
          dealId: deal.id, buyerId: offer.buyerId, status: actStatus, responseReceived: true,
          offerAmount: offer.amount, dateSent: now, lastActivityDate: now, sentByUserId: req.user!.id,
        },
        update: { status: actStatus, responseReceived: true, offerAmount: offer.amount, lastActivityDate: now },
      });
      if (prevAct?.status !== "ACCEPTED") {
        await tx.dealBuyerMessage.create({
          data: {
            organizationId: orgId(req), dealId: deal.id, buyerId: offer.buyerId, activityId: acceptedAct.id,
            kind: "STATUS_CHANGE", body: "Status set to ACCEPTED (offer accepted)", occurredAt: now, createdByUserId: req.user!.id,
          },
        });
      }
      const u = await tx.deal.update({
        where: { id: req.params.id },
        data: {
          selectedBuyerId: offer.buyerId,
          selectedOfferId: offerId,
          publishedToPortal: false,
          ...(advanceToClosing ? { stage: "CLOSING", currentStageEnteredAt: new Date() } : {}),
        },
        include: dealInclude,
      });
      if (advanceToClosing) {
        await tx.dealStageHistory.create({
          data: { dealId: deal.id, fromStage: deal.stage, toStage: "CLOSING", changedByUserId: req.user!.id },
        });
      }
      // The accepted offer now controls the asking price (total + per-acre).
      await syncAskToAcceptedOffer(tx, { dealId: deal.id, offer: { id: offer.id, amount: offer.amount, buyerId: offer.buyerId }, organizationId: orgId(req), actor: req.user! });
      await logActivity(
        {
          eventType: "OFFER_ACCEPTED",
          summary: `${req.user!.name} accepted an offer on "${u.name}"${advanceToClosing ? " — moved to Closing" : ""}${wasPublished ? " and unpublished the offering" : ""}`,
          organizationId: orgId(req),
          actorUserId: req.user!.id,
          dealId: u.id,
          buyerId: offer.buyerId,
        },
        tx,
      );
      // Re-read: the price sync above changed the asking fields after `u` was loaded.
      return tx.deal.findUniqueOrThrow({ where: { id: u.id }, include: dealInclude });
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
  primaryPhone: z.string().trim().max(40).nullish().transform((v) => (v == null ? v : normalizePhone(v))),
  secondaryPhone: z.string().trim().max(40).nullish().transform((v) => (v == null ? v : normalizePhone(v))),
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
  preferredCommunicationNotes: z.string().trim().max(2000).nullish(),
  assignedTeamMemberId: z.string().max(10_000).nullish(),
  /** Link this seller to an existing Contact (the caller's org). */
  contactId: z.string().max(200).nullish(),
});

const sellerInclude = { assignedTeamMember: { select: userRefSelect }, contact: { select: sellerContactSelect } } as const;

async function ownDealOr404(req: AuthedRequest): Promise<string> {
  const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, select: { id: true } });
  if (!deal) throw new HttpError(404, "Deal not found");
  return deal.id;
}

dealsRouter.post(
  "/:id/sellers",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const data = sellerSchema.parse(req.body);
    if (data.assignedTeamMemberId) {
      const u = await prisma.user.findFirst({ where: { id: data.assignedTeamMemberId as string, organizationId: orgId(req) } });
      if (!u) throw new HttpError(400, "Assigned team member is not in your organization");
    }
    // First seller on a deal becomes primary automatically.
    const count = await prisma.dealSeller.count({ where: { dealId } });
    const { contactId, ...cols } = data;
    const access = contactAccess(req);
    const seller = await prisma.$transaction(async (tx) => {
      // Every seller is a Contact: link the named one, else reuse a matching
      // contact, else create one — so the same person on two deals is one record.
      const info = sellerInfoSchema.parse({
        contactId: contactId ?? null, sellerType: cols.sellerType,
        firstName: cols.firstName, middleName: cols.middleName, lastName: cols.lastName, companyName: cols.companyName ?? cols.trustName,
        phone: cols.primaryPhone, email: cols.email,
        mailingAddress: cols.mailingAddress, mailingCity: cols.mailingCity, mailingState: cols.mailingState, mailingZip: cols.mailingZip,
      });
      const { contact } = await resolveSellerContact(tx, orgId(req), info, { ownerId: req.user!.id, type: "SELLER", notFound: (m) => new HttpError(400, m), manage: access.manage });
      const fromContact = dealSellerFromInfo(info, contact, access.view);
      return tx.dealSeller.create({
        data: {
          ...fromContact,
          ...(cols as object),
          // A seller typed without a name takes the linked contact's.
          firstName: cols.firstName ?? fromContact.firstName, middleName: cols.middleName ?? fromContact.middleName, lastName: cols.lastName ?? fromContact.lastName,
          companyName: cols.companyName ?? fromContact.companyName, primaryPhone: cols.primaryPhone ?? fromContact.primaryPhone, email: cols.email ?? fromContact.email,
          contactId: contact.id, dealId, isPrimary: (data.isPrimary as boolean) ?? count === 0,
        },
        include: sellerInclude,
      });
    });
    res.status(201).json(serializeSeller(seller, access.view));
  }),
);

dealsRouter.patch(
  "/:id/sellers/:sellerId",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const dealId = await ownDealOr404(req);
    const existing = await prisma.dealSeller.findFirst({ where: { id: req.params.sellerId, dealId } });
    if (!existing) throw new HttpError(404, "Seller not found");
    const data = sellerSchema.partial().parse(req.body);
    if (data.assignedTeamMemberId) {
      const u = await prisma.user.findFirst({ where: { id: data.assignedTeamMemberId as string, organizationId: orgId(req) } });
      if (!u) throw new HttpError(400, "Assigned team member is not in your organization");
    }
    const { contactId, ...cols } = data;
    if (contactId) {
      const c = await prisma.contact.findFirst({ where: { id: contactId, organizationId: orgId(req) }, select: { id: true } });
      if (!c) throw new HttpError(400, "Contact not found in your organization");
    }
    const access = contactAccess(req);
    const seller = await prisma.$transaction(async (tx) => {
      // Shared fields edited here are the Contact's too — keep the one record
      // consistent (the contact first, so the row below reads the new values).
      // Changing the contact needs "Manage contacts" (contactSyncFor).
      const linked = contactId ?? existing.contactId;
      const current = linked ? await tx.contact.findFirst({ where: { id: linked, organizationId: orgId(req) }, select: sellerContactSelect }) : null;
      if (current) {
        const sync = contactSyncFor(access, contactPatchFromSellerPatch(cols), current);
        if (!sync) throw new HttpError(403, CONTACT_EDIT_FORBIDDEN);
        if (Object.keys(sync).length) await tx.contact.update({ where: { id: current.id }, data: sync });
      }
      return tx.dealSeller.update({ where: { id: existing.id }, data: { ...(cols as object), ...(contactId ? { contactId } : {}) }, include: sellerInclude });
    });
    // Enforce a single primary per deal.
    if (data.isPrimary === true) {
      await prisma.dealSeller.updateMany({ where: { dealId, id: { not: seller.id }, isPrimary: true }, data: { isPrimary: false } });
    }
    res.json(serializeSeller(seller, access.view));
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
        // "What we paid" follows the record across the conversion: an asset's
        // purchase price is the deal's Our Cost (and back), unless already set —
        // so ROI, unrealized gain and per-acre cost never start from nothing.
        ...(toAsset && deal.purchasePrice == null && deal.ourPrice != null ? { purchasePrice: deal.ourPrice } : {}),
        ...(!toAsset && deal.ourPrice == null && deal.purchasePrice != null ? { ourPrice: deal.purchasePrice } : {}),
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

// Set an owned asset's operational mode. Marking an asset For Sale automatically
// enters it into the Preparing Package pipeline stage (no manual stage pick);
// HOLD parks it back in CLOSING.
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
        ? "PREPARING_PACKAGE"
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
  amount: z.number().transform(roundMoney), // cents, like every money figure
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
    const { ids, assigneeIds } = z.object({ ids: z.array(z.string()).min(1).max(500), assigneeIds: z.array(z.string().max(200)).max(500) }).parse(req.body);
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

// ---------------------------------------------------------------------------
// Hide / Unhide — remove a deal from the Deals list's default view and its
// metrics without touching anything else about it. Reversible; the deal keeps
// its stage, dates, prices, offers, documents, notes and relationships, and
// stays reachable on its own page (Deals → Hidden view, or a direct link).
// ---------------------------------------------------------------------------
async function setDealsHidden(req: AuthedRequest, ids: string[], hidden: boolean): Promise<number> {
  const org = orgId(req);
  // Only flip rows whose state actually changes, so re-hiding a hidden deal
  // neither re-stamps hiddenAt nor writes a duplicate activity entry.
  const rows = await prisma.deal.findMany({
    where: { id: { in: ids }, organizationId: org, hiddenAt: hidden ? null : { not: null } },
    select: { id: true, name: true },
  });
  if (!rows.length) return 0;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.deal.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { hiddenAt: hidden ? now : null } });
    for (const r of rows) {
      await logActivity(
        {
          eventType: hidden ? "DEAL_HIDDEN" : "DEAL_UNHIDDEN",
          summary: `${req.user!.name} ${hidden ? "hid" : "unhid"} deal "${r.name}" ${hidden ? "from" : "on"} the Deals list`,
          organizationId: org,
          actorUserId: req.user!.id,
          dealId: r.id,
        },
        tx,
      );
    }
  });
  return rows.length;
}

const hiddenBody = z.object({ hidden: z.boolean() });

dealsRouter.post(
  "/:id/hidden",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { hidden } = hiddenBody.parse(req.body);
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, select: { id: true } });
    if (!deal) throw new HttpError(404, "Deal not found");
    await setDealsHidden(req, [deal.id], hidden);
    const updated = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id }, include: dealInclude });
    res.json(serializeDeal(updated));
  }),
);

dealsRouter.post(
  "/bulk-hidden",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { ids, hidden } = hiddenBody.extend({ ids: z.array(z.string()).min(1).max(500) }).parse(req.body);
    const updated = await setDealsHidden(req, ids, hidden);
    res.json({ updated, hidden });
  }),
);

// ---------------------------------------------------------------------------
// Document folders — per-deal customization of the Documents section's folder
// list (rename / delete / reorder). The client sends the resulting effective
// folder list with every op so the stored list always reflects what the user
// sees (defaults materialize on first customization). "Other" is the system
// fallback folder (files with no folder display there) and can't be renamed
// or removed.
const folderName = z.string().trim().min(1).max(80);
const folderListSchema = z.array(folderName).min(1).max(30)
  .refine((xs) => new Set(xs.map((x) => x.toLowerCase())).size === xs.length, "Folder names must be unique")
  .refine((xs) => xs.includes("Other"), "The Other folder is required");
const folderOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("reorder"), folders: folderListSchema }),
  z.object({ op: z.literal("rename"), from: folderName, to: folderName, folders: folderListSchema }),
  z.object({ op: z.literal("remove"), name: folderName, folders: folderListSchema }),
]);

dealsRouter.post(
  "/:id/doc-folders",
  requirePermission("manageDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, select: { id: true } });
    if (!deal) throw new HttpError(404, "Deal not found");
    const body = folderOpSchema.parse(req.body);

    if (body.op === "rename") {
      if (body.from === "Other") throw new HttpError(400, "The Other folder can't be renamed — it's where unfiled documents live.");
      // Rename moves the folder's files with it, atomically with the list update.
      await prisma.$transaction([
        prisma.deal.update({ where: { id: deal.id }, data: { docFolders: body.folders } }),
        prisma.fileAttachment.updateMany({ where: { dealId: deal.id, folder: body.from }, data: { folder: body.to } }),
      ]);
    } else if (body.op === "remove") {
      if (body.name === "Other") throw new HttpError(400, "The Other folder can't be removed — it's where unfiled documents live.");
      // Deleting a folder never deletes documents: they move to Other.
      await prisma.$transaction([
        prisma.deal.update({ where: { id: deal.id }, data: { docFolders: body.folders } }),
        prisma.fileAttachment.updateMany({ where: { dealId: deal.id, folder: body.name }, data: { folder: "Other" } }),
      ]);
    } else {
      await prisma.deal.update({ where: { id: deal.id }, data: { docFolders: body.folders } });
    }
    const updated = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id }, select: { docFolders: true } });
    res.json({ docFolders: updated.docFolders });
  }),
);

async function reload(id: string) {
  const d = await prisma.deal.findUniqueOrThrow({ where: { id }, include: dealInclude });
  return d;
}

