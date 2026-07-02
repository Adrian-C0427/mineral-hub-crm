import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireOrg, orgId, type AuthedRequest } from "../middleware/auth.js";
import { serializeDeal } from "../serializers.js";
import { netProfit, avg } from "../domain/metrics.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireOrg);

const dealInclude = { selectedBuyer: true, relationshipOwner: true } as const;
const ACTIVE_STAGES = ["UNDER_CONTRACT", "PREPARING_PACKAGE", "SENT_TO_BUYERS", "NEGOTIATING", "CLOSING"] as const;

dashboardRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const now = new Date();
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const org = orgId(req);

    const [allActive, closedDeals, activeOffers] = await Promise.all([
      prisma.deal.findMany({ where: { stage: { in: [...ACTIVE_STAGES] }, organizationId: org }, include: { ...dealInclude, offers: true } }),
      prisma.deal.findMany({
        where: { stage: "CLOSED", organizationId: org },
        include: { ...dealInclude, selectedOffer: true, stageHistory: { where: { toStage: "CLOSED" }, orderBy: { createdAt: "desc" }, take: 1 } },
      }),
      prisma.offer.count({ where: { status: "ACTIVE", deal: { organizationId: org } } }),
    ]);

    // Metrics row
    const activeDeals = allActive.length;

    // Projected profit: best offer − ask − costs across active deals that have offers.
    const projectedProfit = allActive.reduce((sum, d) => {
      const best = d.offers.reduce<number | null>((m, o) => (m == null || o.amount > m ? o.amount : m), null);
      if (best == null) return sum;
      return sum + netProfit(best, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts);
    }, 0);

    const closedYtd = closedDeals.filter((d) => (d.stageHistory[0]?.createdAt ?? d.updatedAt) >= yearStart);
    const closedProfitYtd = closedYtd.reduce(
      (sum, d) => sum + (d.selectedOffer ? netProfit(d.selectedOffer.amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts) : 0),
      0,
    );
    const avgDealSize = avg(closedDeals.map((d) => d.selectedOffer?.amount).filter((n): n is number => n != null));

    // Overdue alert (active, no buyer, past find-buyer-by)
    const overdue = allActive
      .map((d) => serializeDeal(d, now))
      .filter((d) => d.isOverdue);

    // Active deals by stage — name, stage, profit est. (NO priority badges here)
    const byStage = allActive.map((d) => {
      const s = serializeDeal(d, now);
      const best = d.offers.reduce<number | null>((m, o) => (m == null || o.amount > m ? o.amount : m), null);
      const profitEst = best != null ? netProfit(best, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts) : null;
      return { id: s.id, name: s.name, stage: s.stage, profitEst };
    });

    // Upcoming follow-ups (from buyer activity nextFollowUpDate)
    const followUps = await prisma.dealBuyerActivity.findMany({
      where: { nextFollowUpDate: { gte: now }, deal: { organizationId: org } },
      orderBy: { nextFollowUpDate: "asc" },
      take: 10,
      include: { buyer: { select: { name: true } }, deal: { select: { name: true } } },
    });

    // Recent activity feed
    const recent = await prisma.activityLog.findMany({ where: { organizationId: org }, orderBy: { createdAt: "desc" }, take: 15 });

    // Top buyers YTD by closed volume
    const topBuyersMap = new Map<string, { name: string; companyName: string; volume: number }>();
    for (const d of closedYtd) {
      if (d.selectedBuyer && d.selectedOffer) {
        const cur = topBuyersMap.get(d.selectedBuyer.id) ?? { name: d.selectedBuyer.name, companyName: d.selectedBuyer.companyName, volume: 0 };
        cur.volume += d.selectedOffer.amount;
        topBuyersMap.set(d.selectedBuyer.id, cur);
      }
    }
    const topBuyers = [...topBuyersMap.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 5);

    // Profit by month (YTD, by CLOSED transition month)
    const monthly = new Map<number, number>();
    for (const d of closedYtd) {
      const closedAt = d.stageHistory[0]?.createdAt ?? d.updatedAt;
      const m = closedAt.getUTCMonth();
      const profit = d.selectedOffer ? netProfit(d.selectedOffer.amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts) : 0;
      monthly.set(m, (monthly.get(m) ?? 0) + profit);
    }
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const profitByMonth = monthNames.map((label, i) => ({ month: label, profit: monthly.get(i) ?? 0 }));

    res.json({
      metrics: {
        activeDeals,
        projectedProfit,
        closedProfitYtd,
        avgDealSize,
        offersPending: activeOffers,
      },
      overdue: overdue.map((d) => ({ id: d.id, name: d.name, findBuyerByDate: d.findBuyerByDate })),
      activeByStage: byStage,
      upcomingFollowUps: followUps.map((f) => ({
        dealId: f.dealId,
        buyerName: f.buyer.name,
        dealName: f.deal.name,
        date: f.nextFollowUpDate,
      })),
      recentActivity: recent.map((r) => ({ id: r.id, summary: r.summary, eventType: r.eventType, createdAt: r.createdAt, dealId: r.dealId, buyerId: r.buyerId })),
      topBuyers,
      profitByMonth,
    });
  }),
);
