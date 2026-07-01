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
}> & { offers?: { amount: number }[] };

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
  return {
    id: deal.id,
    name: deal.name,
    sellerNames: deal.sellerNames,
    counties: deal.counties,
    state: deal.state,
    acreageNma: deal.acreageNma,
    nra: deal.nra,
    abstractIds: deal.abstractIds,
    operator: deal.operator,
    askPrice: deal.askPrice,
    ourPrice: deal.ourPrice,
    assetTypes: deal.assetTypes,
    basins: deal.basins,
    formations: deal.formations,
    stage: deal.stage,
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
    selectedBuyerId: deal.selectedBuyerId,
    selectedBuyer: deal.selectedBuyer
      ? { id: deal.selectedBuyer.id, name: deal.selectedBuyer.name, companyName: deal.selectedBuyer.companyName }
      : null,
    selectedOfferId: deal.selectedOfferId,
    relationshipOwnerId: deal.relationshipOwnerId,
    relationshipOwner: deal.relationshipOwner
      ? { id: deal.relationshipOwner.id, name: deal.relationshipOwner.name }
      : null,
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
