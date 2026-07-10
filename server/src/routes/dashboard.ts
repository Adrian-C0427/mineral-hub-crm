import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireOrg, orgId, type AuthedRequest } from "../middleware/auth.js";
import { serializeDeal } from "../serializers.js";
import { netProfit, avg } from "../domain/metrics.js";
import { ensureStages, TERMINAL_STAGE_KEYS } from "../domain/stages.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireOrg);

const dealInclude = { selectedBuyer: true, relationshipOwner: true } as const;

/** Global dashboard date window (default YTD). Upper bound is exclusive. */
function dashboardWindow(period: string | undefined, now: Date): { start: Date; end: Date; label: string } {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  switch (period) {
    case "THIS_MONTH": return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)), label: "This Month" };
    case "LAST_MONTH": return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)), label: "Last Month" };
    case "THIS_QUARTER": { const q = Math.floor(m / 3) * 3; return { start: new Date(Date.UTC(y, q, 1)), end: new Date(Date.UTC(y, q + 3, 1)), label: "This Quarter" }; }
    default: return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)), label: "YTD" };
  }
}

dashboardRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const now = new Date();
    const win = dashboardWindow(req.query.period as string | undefined, now);
    const inWindow = (d: Date) => d.getTime() >= win.start.getTime() && d.getTime() < win.end.getTime();
    const org = orgId(req);

    // The dashboard reports on the acquisition pipeline: opportunities plus any
    // owned asset actively marketed for sale (assetMode SELL). HOLD assets stay
    // in their own module and are never counted here.
    // Child assets are counted individually here (each carries its own value), so
    // a package's assets roll up naturally into the totals — no parentDealId
    // filter. Each deal contributes its OWN stored value, so nothing double-counts.
    const IN_PIPELINE = { OR: [{ recordType: "OPPORTUNITY" as const }, { recordType: "OWNED_ASSET" as const, assetMode: "SELL" as const }] };
    // Active = any non-terminal stage. The stage distribution uses the org's own
    // ordered active stages (custom pipeline).
    const activeStageKeys = (await ensureStages(prisma, org)).filter((s) => !s.isTerminal).map((s) => s.key);
    const [allActive, closedDeals, activeOffers] = await Promise.all([
      prisma.deal.findMany({ where: { stage: { notIn: [...TERMINAL_STAGE_KEYS] }, organizationId: org, ...IN_PIPELINE }, include: { ...dealInclude, offers: true } }),
      prisma.deal.findMany({
        where: { stage: "CLOSED", organizationId: org, ...IN_PIPELINE },
        include: { ...dealInclude, selectedOffer: true, stageHistory: { where: { toStage: "CLOSED" }, orderBy: { createdAt: "desc" }, take: 1 } },
      }),
      prisma.offer.count({ where: { status: "ACTIVE", deal: { organizationId: org, ...IN_PIPELINE } } }),
    ]);

    // Metrics row
    const activeDeals = allActive.length;

    // Projected profit: best offer − ask − costs across active deals that have offers.
    const projectedProfit = allActive.reduce((sum, d) => {
      const best = d.offers.reduce<number | null>((m, o) => (m == null || o.amount > m ? o.amount : m), null);
      if (best == null) return sum;
      return sum + netProfit(best, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts);
    }, 0);

    // Closed profit + average size are scoped to the selected dashboard window;
    // the year-view widgets (Top Buyers, Profit by Month) stay YTD.
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const closedYtd = closedDeals.filter((d) => (d.stageHistory[0]?.createdAt ?? d.updatedAt) >= yearStart);
    const closedInWindow = closedDeals.filter((d) => inWindow(d.stageHistory[0]?.createdAt ?? d.updatedAt));
    const closedProfitYtd = closedInWindow.reduce(
      (sum, d) => sum + (d.selectedOffer ? netProfit(d.selectedOffer.amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts) : 0),
      0,
    );
    const avgDealSize = avg(closedInWindow.map((d) => d.selectedOffer?.amount).filter((n): n is number => n != null));

    // Overdue alert (active, no buyer, past find-buyer-by)
    const overdue = allActive
      .map((d) => serializeDeal(d, now))
      .filter((d) => d.isOverdue);

    // Active deals by stage — now a high-level count per pipeline stage rather
    // than per-deal rows. Every active stage is present (0 when empty) so the
    // dashboard shows the full pipeline distribution at a glance; drill-down
    // lives on the Pipeline / Deals pages.
    const stageCountMap = new Map<string, number>(activeStageKeys.map((s) => [s, 0]));
    for (const d of allActive) stageCountMap.set(d.stage, (stageCountMap.get(d.stage) ?? 0) + 1);
    const stageCounts = activeStageKeys.map((stage) => ({ stage, count: stageCountMap.get(stage) ?? 0 }));

    // Upcoming follow-ups (from buyer activity nextFollowUpDate)
    const followUps = await prisma.dealBuyerActivity.findMany({
      where: { nextFollowUpDate: { gte: now }, deal: { organizationId: org, recordType: "OPPORTUNITY" } },
      orderBy: { nextFollowUpDate: "asc" },
      take: 10,
      include: { buyer: { select: { name: true } }, deal: { select: { name: true } } },
    });

    // Recent activity feed — business events only. Integration plumbing events
    // (connect/disconnect/test) stay in the audit log but would be noise here.
    const recent = await prisma.activityLog.findMany({
      where: { organizationId: org, NOT: { eventType: { startsWith: "integration." } } },
      orderBy: { createdAt: "desc" },
      take: 15,
    });

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
    // Projected profit by month — SAME population as the Projected Profit KPI
    // above (any active deal with at least one offer; accepted offer wins over
    // best offer), bucketed by the deal's anticipated closing month. The KPI
    // and this chart must never disagree: a user who sees "$30K projected"
    // up top has to find that $30K on this axis.
    const monthlyProjected = new Map<number, number>();
    for (const d of allActive) {
      const selOffer = d.selectedOfferId ? d.offers.find((o) => o.id === d.selectedOfferId) : undefined;
      const best = d.offers.reduce<number | null>((m, o) => (m == null || o.amount > m ? o.amount : m), null);
      const amount = selOffer?.amount ?? best;
      if (amount == null) continue;
      const s = serializeDeal(d, now);
      if (!s.finalClosingDate) continue;
      const close = new Date(s.finalClosingDate);
      if (close.getUTCFullYear() !== now.getUTCFullYear()) continue;
      const profit = netProfit(amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts);
      const m = close.getUTCMonth();
      monthlyProjected.set(m, (monthlyProjected.get(m) ?? 0) + profit);
    }
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const profitByMonth = monthNames.map((label, i) => ({ month: label, profit: monthly.get(i) ?? 0, projected: monthlyProjected.get(i) ?? 0 }));

    // --- KPI trends (sparkline series — real history, never fabricated) ------
    const weekMs = 7 * 24 * 3600 * 1000;
    const weekMarks = Array.from({ length: 8 }, (_, i) => new Date(now.getTime() - (7 - i) * weekMs));

    // Active deals over the last 8 weeks: a deal counts as active from creation
    // until its FIRST Closed/Dead transition. (A re-opened deal approximates as
    // inactive after that first exit — fine for a trend line.)
    const pipelineHistory = await prisma.deal.findMany({
      where: { organizationId: org, ...IN_PIPELINE },
      select: {
        createdAt: true,
        stageHistory: { where: { toStage: { in: ["CLOSED", "DEAD"] } }, orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } },
      },
    });
    const activeDealsWeekly = weekMarks.map(
      (t) => pipelineHistory.filter((d) => d.createdAt <= t && !(d.stageHistory[0] && d.stageHistory[0].createdAt <= t)).length,
    );

    // Avg deal size as a running average across closes (last 8 points).
    const closesAsc = closedDeals
      .filter((d) => d.selectedOffer)
      .sort((a, b) => (a.stageHistory[0]?.createdAt ?? a.updatedAt).getTime() - (b.stageHistory[0]?.createdAt ?? b.updatedAt).getTime());
    let closeSum = 0;
    const avgDealSizeTrend = closesAsc.map((d, i) => { closeSum += d.selectedOffer!.amount; return closeSum / (i + 1); }).slice(-8);

    // Offers RECEIVED per week (pending-status history isn't stored, so the
    // honest series for the offers card is submission volume).
    const offersRecent = await prisma.offer.findMany({
      where: { deal: { organizationId: org, ...IN_PIPELINE }, dateSubmitted: { gte: new Date(now.getTime() - 8 * weekMs) } },
      select: { dateSubmitted: true },
    });
    const offersWeekly = weekMarks.map((t, i) => {
      const from = i === 0 ? new Date(t.getTime() - weekMs) : weekMarks[i - 1];
      return offersRecent.filter((o) => o.dateSubmitted > from && o.dateSubmitted <= t).length;
    });

    res.json({
      metrics: {
        activeDeals,
        projectedProfit,
        closedProfitYtd,
        avgDealSize,
        offersPending: activeOffers,
        periodLabel: win.label,
      },
      overdue: overdue.map((d) => ({ id: d.id, name: d.name, findBuyerByDate: d.findBuyerByDate })),
      stageCounts,
      upcomingFollowUps: followUps.map((f) => ({
        dealId: f.dealId,
        buyerName: f.buyer.name,
        dealName: f.deal.name,
        date: f.nextFollowUpDate,
      })),
      recentActivity: recent.map((r) => ({ id: r.id, summary: r.summary, eventType: r.eventType, createdAt: r.createdAt, dealId: r.dealId, buyerId: r.buyerId })),
      topBuyers,
      profitByMonth,
      trends: { activeDealsWeekly, avgDealSize: avgDealSizeTrend, offersWeekly },
    });
  }),
);
