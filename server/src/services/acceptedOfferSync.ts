import type { Prisma } from "@prisma/client";
import { askFromAcceptedOffer, legacyCostBasisToKeep, sameAsk, type AskPrices } from "../domain/acceptedOfferPricing.js";
import { money as fmtMoney } from "../domain/format.js";
import { logActivity } from "../services/activityLog.js";

export const ASK_SYNCED_EVENT = "ASK_PRICE_SYNCED";

/**
 * Set the deal's asking price from its controlling accepted offer, inside the
 * caller's transaction. Writes the three asking fields together (always
 * consistent), keeps a legacy deal's cost basis (see legacyCostBasisToKeep),
 * and records the change — previous and new values, the offer and buyer —
 * in the deal's activity as ASK_PRICE_SYNCED. A no-op (already in step)
 * writes nothing. Returns what was written, or null.
 */
export async function syncAskToAcceptedOffer(
  tx: Prisma.TransactionClient,
  p: { dealId: string; offer: { id: string; amount: number; buyerId: string }; organizationId: string; actor: { id: string; name: string } },
): Promise<{ before: AskPrices; after: AskPrices; logId: string } | null> {
  const deal = await tx.deal.findUnique({
    where: { id: p.dealId },
    select: { id: true, name: true, acreageNma: true, nra: true, royaltyRate: true, askPrice: true, askPricePerNma: true, askPricePerNra: true, ourPrice: true, purchasePrice: true },
  });
  if (!deal) return null;
  const before: AskPrices = { askPrice: deal.askPrice, askPricePerNma: deal.askPricePerNma, askPricePerNra: deal.askPricePerNra };
  const after = askFromAcceptedOffer(p.offer.amount, deal);
  if (sameAsk(before, after)) return null;
  const keepCost = legacyCostBasisToKeep(deal);
  await tx.deal.update({ where: { id: deal.id }, data: { ...after, ...(keepCost != null ? { ourPrice: keepCost } : {}) } });
  const buyer = await tx.buyer.findFirst({ where: { id: p.offer.buyerId }, select: { name: true } });
  const log = await logActivity(
    {
      eventType: ASK_SYNCED_EVENT,
      summary: `Asking price on "${deal.name}" set to ${fmtMoney(after.askPrice)} from the accepted offer${buyer ? ` by ${buyer.name}` : ""}${before.askPrice != null ? ` (was ${fmtMoney(before.askPrice)})` : ""}`,
      organizationId: p.organizationId,
      actorUserId: p.actor.id,
      dealId: deal.id,
      buyerId: p.offer.buyerId,
      metadata: { before: { ...before }, after: { ...after }, offerId: p.offer.id, offerAmount: p.offer.amount, buyerId: p.offer.buyerId, ...(keepCost != null ? { ourPriceKeptFromAsk: keepCost } : {}) } as Prisma.InputJsonValue,
    },
    tx,
  );
  return { before, after, logId: log.id };
}
