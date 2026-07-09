import type { Prisma } from "@prisma/client";
import { resolveDealDates } from "./domain/dates.js";
import { computePriority, isOverdue } from "./domain/priority.js";
import { closeRate, netProfit } from "./domain/metrics.js";

/** Deal with the relations we need to fully serialize a list/detail row. */
export type DealWithRels = Prisma.DealGetPayload<{
  include: {
    selectedBuyer: true;
    relationshipOwner: true;
  };
}> & {
  offers?: { amount: number }[];
  assignees?: { id: string; name: string }[];
  // Multi-asset grouping (optional, populated by list/detail queries). `assets`
  // carries only the scalars needed to roll a package's aggregate up for display;
  // the full child-asset cards are emitted by the detail route via serializeAssetChild.
  _count?: { assets?: number };
  parentDeal?: { id: string; name: string } | null;
  assets?: RollupAsset[];
  // Recorded revenue statements (optional; loaded on the owned-asset list + detail).
  // When present, Annual Royalty Income is derived from these actual entries
  // rather than the stored estimate — the Financials section is the source of truth.
  revenueEntries?: RevenueRow[];
};

/** The revenue-entry scalars used to derive Annual Royalty Income. */
export type RevenueRow = { month: Date; amount: number; kind: string };

/**
 * Annual Royalty Income derived from recorded revenue: the sum of ROYALTY-kind
 * statements over the trailing twelve months (the current month and the eleven
 * before it). Returns null only when no royalty has ever been recorded, so the
 * asset shows "—" instead of "$0"; once any royalty exists it reflects the last
 * year of actual income (which may legitimately be $0 if production has lapsed).
 */
export function annualRoyaltyIncome(entries: RevenueRow[], now: Date = new Date()): number | null {
  const royalty = entries.filter((e) => e.kind === "ROYALTY");
  if (!royalty.length) return null;
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  return royalty.filter((e) => e.month >= cutoff).reduce((s, e) => s + e.amount, 0);
}

/** The child-asset scalars a package sums into its own displayed figures. */
export type RollupAsset = { nra: number | null; acreageNma: number | null; ourPrice: number | null; askPrice: number | null };

/** A child asset with just the relation needed for its compact summary. */
export type AssetChild = Prisma.DealGetPayload<{ include: { selectedBuyer: true } }>;

/** Compact summary of a child asset shown within its parent package. */
export function serializeAssetChild(a: AssetChild) {
  return {
    id: a.id,
    name: a.name,
    stage: a.stage,
    counties: a.counties,
    states: a.states ?? [],
    assetTypes: a.assetTypes,
    nra: a.nra,
    ourPrice: a.ourPrice,
    askPrice: a.askPrice,
    operator: a.operator,
    rrc: a.rrc,
    publishedToPortal: a.publishedToPortal,
    portalSlug: a.portalSlug,
    selectedBuyer: a.selectedBuyer ? { id: a.selectedBuyer.id, name: a.selectedBuyer.name } : null,
  };
}

export function serializeDeal(deal: DealWithRels, now: Date = new Date()) {
  const dates = resolveDealDates(deal);
  const priority = computePriority({ ...deal, selectedBuyerId: deal.selectedBuyerId }, now);
  // Profit Est. = best offer − ask − closing costs (null when no offers logged yet).
  const bestOffer = deal.offers && deal.offers.length
    ? deal.offers.reduce((m, o) => (o.amount > m ? o.amount : m), -Infinity)
    : null;
  // Cost basis is Our Price (acquisition cost); fall back to askPrice for
  // pre-Our-Price deals so historical profit stays correct.
  const costBasis = deal.ourPrice ?? deal.askPrice;
  const profitEst = bestOffer != null ? netProfit(bestOffer, costBasis, deal.estimatedClosingCosts) : null;

  // Package roll-up: a deal that groups child assets displays the aggregate of
  // its own value plus its children's. This is display-only — analytics read
  // each deal's own stored value, so the package row equals the sum of the
  // separately-counted children (totals reconcile, nothing double-counts).
  const kids = deal.assets ?? [];
  const rollUp = (own: number | null, pick: (a: RollupAsset) => number | null): number | null => {
    if (!kids.length) return own;
    const vals = [own, ...kids.map(pick)].filter((v): v is number => v != null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) : own;
  };
  const aggNra = rollUp(deal.nra, (a) => a.nra);
  const aggNma = rollUp(deal.acreageNma, (a) => a.acreageNma);
  const aggOur = rollUp(deal.ourPrice, (a) => a.ourPrice);
  const aggAsk = rollUp(deal.askPrice, (a) => a.askPrice);

  // Owned-asset economics (null for opportunities / when inputs are missing).
  const roiSinceAcquisition =
    deal.purchasePrice && deal.purchasePrice !== 0 && deal.currentValue != null
      ? ((deal.currentValue - deal.purchasePrice) / deal.purchasePrice) * 100
      : null;
  const gainBasis = deal.bookValue ?? deal.purchasePrice;
  const unrealizedGainLoss =
    deal.currentValue != null && gainBasis != null ? deal.currentValue - gainBasis : null;

  // Annual Royalty Income is derived from recorded revenue when the entries are
  // loaded (owned-asset list + detail); elsewhere it falls back to the stored value.
  const royaltyIncomeAnnual = deal.revenueEntries
    ? annualRoyaltyIncome(deal.revenueEntries, now)
    : deal.royaltyIncomeAnnual;

  return {
    id: deal.id,
    name: deal.name,
    sellerNames: deal.sellerNames,
    recordType: deal.recordType,
    assetMode: deal.assetMode,
    // Owned-asset: ownership
    acquisitionDate: deal.acquisitionDate,
    purchasePrice: deal.purchasePrice,
    currentValue: deal.currentValue,
    bookValue: deal.bookValue,
    ownershipStatus: deal.ownershipStatus,
    ownershipType: deal.ownershipType,
    workingInterest: deal.workingInterest,
    netRevenueInterest: deal.netRevenueInterest,
    // Owned-asset: property
    surveys: deal.surveys,
    wells: deal.wells,
    producingStatus: deal.producingStatus,
    // Owned-asset: financial
    royaltyIncomeAnnual,
    leaseStatuses: deal.leaseStatuses ?? [],
    royaltyRate: deal.royaltyRate,
    leaseEffectiveDate: deal.leaseEffectiveDate,
    leaseExpirationDate: deal.leaseExpirationDate,
    leaseStatus: deal.leaseStatus,
    leaseInfo: deal.leaseInfo,
    divisionOrdersNote: deal.divisionOrdersNote,
    taxInfo: deal.taxInfo,
    roiSinceAcquisition,
    unrealizedGainLoss,
    counties: deal.counties,
    state: deal.state,
    states: deal.states ?? [],
    acreageNma: deal.acreageNma,
    nra: deal.nra,
    abstractIds: deal.abstractIds,
    operator: deal.operator,
    rrc: deal.rrc,
    askPrice: deal.askPrice,
    ourPrice: deal.ourPrice,
    assetTypes: deal.assetTypes,
    basins: deal.basins,
    formations: deal.formations,
    stage: deal.stage,
    // Multi-asset grouping. `assetCount` is present on list rows; `parent`/`assets`
    // on the detail. A deal with assets is a "package"; a deal with a parent is a
    // child "asset". Standalone deals have neither.
    parentDealId: deal.parentDealId ?? null,
    parent: deal.parentDeal ? { id: deal.parentDeal.id, name: deal.parentDeal.name } : null,
    assetCount: deal._count?.assets ?? (deal.assets ? deal.assets.length : undefined),
    // Package aggregates (own + children) for display; equal the own values when
    // there are no children. Raw own fields above stay authoritative for editing.
    aggNra: aggNra,
    aggAcreageNma: aggNma,
    aggOurPrice: aggOur,
    aggAskPrice: aggAsk,
    publishedToPortal: deal.publishedToPortal ?? false,
    portalSlug: deal.portalSlug ?? null,
    currentStageEnteredAt: deal.currentStageEnteredAt,
    daysInStage: Math.max(
      0,
      Math.floor((now.getTime() - new Date(deal.currentStageEnteredAt).getTime()) / 86400000),
    ),
    deadReason: deal.deadReason,
    estimatedClosingCosts: deal.estimatedClosingCosts,
    notes: deal.notes,
    // Resolved (effective) dates — the ONLY dates the UI should consume.
    dateUnderContract: dates.dateUnderContract,
    originalClosingDate: dates.originalClosingDate,
    findBuyerByDate: dates.findBuyerByDate,
    finalClosingDate: dates.finalClosingDate,
    findBuyerByIsOverridden: dates.findBuyerByIsOverridden,
    finalClosingIsOverridden: dates.finalClosingIsOverridden,
    findBuyerByAuto: dates.findBuyerByAuto,
    finalClosingAuto: dates.finalClosingAuto,
    // raw override columns (for edit forms)
    findBuyerByDateOverride: deal.findBuyerByDateOverride,
    finalClosingDateOverride: deal.finalClosingDateOverride,
    closedDate: deal.closedDate,
    selectedBuyerId: deal.selectedBuyerId,
    selectedBuyer: deal.selectedBuyer
      ? { id: deal.selectedBuyer.id, name: deal.selectedBuyer.name, companyName: deal.selectedBuyer.companyName }
      : null,
    selectedOfferId: deal.selectedOfferId,
    relationshipOwnerId: deal.relationshipOwnerId,
    relationshipOwner: deal.relationshipOwner
      ? { id: deal.relationshipOwner.id, name: deal.relationshipOwner.name }
      : null,
    assignees: deal.assignees ?? [],
    priority,
    profitEst,
    isOverdue: isOverdue({ ...deal, selectedBuyerId: deal.selectedBuyerId }, now),
    updatedAt: deal.updatedAt,
    createdAt: deal.createdAt,
  };
}

/**
 * Buyer close rate: closed-and-won deals (this buyer is the selected buyer on a
 * CLOSED deal) ÷ deals where this buyer made an offer.
 */
export function computeBuyerCloseRate(params: {
  closedWonCount: number;
  dealsWithOfferCount: number;
}): number {
  return closeRate(params.closedWonCount, params.dealsWithOfferCount);
}

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|inc|l\.l\.c|ltd|lp|llp|co|corp|company|incorporated)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}
