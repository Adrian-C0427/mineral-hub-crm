import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { netProfit, grossFee, avg, winRate } from "../domain/metrics.js";
import {
  computeKpis, delta, buildMonthlySeries, buildBreakdowns,
  type AnalyticsDeal, type Range,
} from "../domain/analytics.js";

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireOrg, requirePermission("viewReports"));

const periodSchema = z.object({
  from: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
});

/** Closing date for a deal = timestamp it entered CLOSED (from stage history). */
async function closedAtMap(dealIds: string[]): Promise<Map<string, Date>> {
  const hist = await prisma.dealStageHistory.findMany({
    where: { dealId: { in: dealIds }, toStage: "CLOSED" },
    orderBy: { createdAt: "desc" },
  });
  const map = new Map<string, Date>();
  for (const h of hist) if (!map.has(h.dealId)) map.set(h.dealId, h.createdAt);
  return map;
}

reportsRouter.get(
  "/closed",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = periodSchema.parse(req.query);
    const fromDate = from ? new Date(from) : new Date("1970-01-01");
    const toDate = to ? new Date(to) : new Date("2999-12-31");

    // Closed deals whose CLOSED transition falls in the period.
    const closedDeals = await prisma.deal.findMany({
      where: { stage: "CLOSED", organizationId: orgId(req) },
      include: { selectedOffer: true, selectedBuyer: { select: { name: true, companyName: true } } },
    });
    const closedAt = await closedAtMap(closedDeals.map((d) => d.id));

    const inPeriod = closedDeals.filter((d) => {
      const c = closedAt.get(d.id);
      return c && c >= fromDate && c <= toDate;
    });

    const rows = inPeriod.map((d) => {
      const accepted = d.selectedOffer?.amount ?? null;
      const gross = accepted != null ? grossFee(accepted, d.askPrice) : null;
      const net = accepted != null ? netProfit(accepted, d.askPrice, d.estimatedClosingCosts) : null;
      return {
        id: d.id,
        name: d.name,
        county: d.counties.join(", "),
        state: d.state,
        buyer: d.selectedBuyer?.name ?? null,
        askPrice: d.askPrice,
        acceptedAmount: accepted,
        closingCosts: d.estimatedClosingCosts,
        grossFee: gross,
        netProfit: net,
        closedDate: closedAt.get(d.id),
      };
    });

    const acceptedAmounts = rows.map((r) => r.acceptedAmount).filter((n): n is number => n != null);
    const grossTotal = rows.reduce((s, r) => s + (r.grossFee ?? 0), 0);
    const netTotal = rows.reduce((s, r) => s + (r.netProfit ?? 0), 0);

    // Win rate within period: closed / (closed + dead).
    const deadDeals = await prisma.dealStageHistory.findMany({
      where: { toStage: "DEAD", createdAt: { gte: fromDate, lte: toDate }, deal: { organizationId: orgId(req) } },
      distinct: ["dealId"],
      select: { dealId: true },
    });

    res.json({
      rows,
      totals: {
        dealsClosed: rows.length,
        grossFees: grossTotal,
        netProfit: netTotal,
        avgProfitPerDeal: avg(rows.map((r) => r.netProfit ?? 0)),
        avgDealSize: avg(acceptedAmounts),
      },
      winRate: winRate(rows.length, deadDeals.length),
      deadInPeriod: deadDeals.length,
    });
  }),
);

// ---------------------------------------------------------------------------
// Business analytics dashboard
// ---------------------------------------------------------------------------

/** Read a query param that may be a single value, comma-joined, or repeated. */
function arrParam(v: unknown): string[] {
  if (v == null) return [];
  const raw = Array.isArray(v) ? (v as string[]) : String(v).split(",");
  return raw.map((s) => s.trim()).filter(Boolean);
}
const intersects = (a: string[], b: string[]) => b.length === 0 || a.some((x) => b.includes(x));

/** Load and normalize the org's deals into the analytics shape. */
async function loadAnalyticsDeals(organizationId: string): Promise<AnalyticsDeal[]> {
  const deals = await prisma.deal.findMany({
    where: { organizationId },
    include: {
      selectedOffer: { select: { amount: true } },
      stageHistory: { orderBy: { createdAt: "asc" }, select: { toStage: true, fromStage: true, changedByUserId: true, createdAt: true } },
    },
  });
  return deals.map((d) => {
    // Latest CLOSED / DEAD transitions, and the creator (fromStage === null event).
    let closedAt: Date | null = null, closedByUserId: string | null = null, deadAt: Date | null = null;
    let createdByUserId: string | null = d.relationshipOwnerId;
    for (const h of d.stageHistory) {
      if (h.fromStage === null) createdByUserId = h.changedByUserId ?? createdByUserId;
      if (h.toStage === "CLOSED") { closedAt = h.createdAt; closedByUserId = h.changedByUserId; }
      if (h.toStage === "DEAD") deadAt = h.createdAt;
    }
    return {
      id: d.id,
      createdAt: d.createdAt,
      stage: d.stage,
      counties: d.counties,
      basins: d.basins,
      formations: d.formations,
      assetTypes: d.assetTypes,
      operator: d.operator,
      askPrice: d.askPrice,
      acceptedAmount: d.selectedOffer?.amount ?? null,
      estimatedClosingCosts: d.estimatedClosingCosts,
      relationshipOwnerId: d.relationshipOwnerId,
      selectedBuyerId: d.selectedBuyerId,
      createdByUserId,
      closedByUserId,
      dateUnderContract: d.dateUnderContract,
      closedAt,
      deadAt,
    };
  });
}

reportsRouter.get(
  "/analytics",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const q = req.query;
    const now = new Date();
    const from = q.from ? new Date(String(q.from)) : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const to = q.to ? new Date(`${String(q.to)}T23:59:59.999Z`) : new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59));
    const range: Range = { from, to };
    const compare: Range | null =
      q.compareFrom && q.compareTo
        ? { from: new Date(String(q.compareFrom)), to: new Date(`${String(q.compareTo)}T23:59:59.999Z`) }
        : null;

    const filters = {
      counties: arrParam(q.counties),
      basins: arrParam(q.basins),
      formations: arrParam(q.formations),
      assetTypes: arrParam(q.assetTypes),
      operators: arrParam(q.operators),
      stages: arrParam(q.stages),
      users: arrParam(q.users),
      buyers: arrParam(q.buyers),
    };

    const [allDeals, expensesRaw, buyersRaw, activitiesRaw, usersRaw] = await Promise.all([
      loadAnalyticsDeals(org),
      prisma.expense.findMany({ where: { organizationId: org }, select: { amount: true, date: true, reimbursed: true } }),
      prisma.buyer.findMany({ where: { organizationId: org }, select: { id: true, name: true, createdAt: true, active: true } }),
      prisma.dealBuyerActivity.findMany({
        where: { deal: { organizationId: org } },
        select: { dateSent: true, lastActivityDate: true, createdAt: true, sentByUserId: true },
      }),
      prisma.user.findMany({ where: { organizationId: org }, select: { id: true, name: true } }),
    ]);

    // Apply deal-characteristic filters in memory (org deal volumes are small).
    const deals = allDeals.filter(
      (d) =>
        intersects(d.counties, filters.counties) &&
        intersects(d.basins, filters.basins) &&
        intersects(d.formations, filters.formations) &&
        intersects(d.assetTypes, filters.assetTypes) &&
        (filters.operators.length === 0 || (d.operator != null && filters.operators.includes(d.operator))) &&
        (filters.stages.length === 0 || filters.stages.includes(d.stage)) &&
        (filters.users.length === 0 || (d.relationshipOwnerId != null && filters.users.includes(d.relationshipOwnerId))) &&
        (filters.buyers.length === 0 || (d.selectedBuyerId != null && filters.buyers.includes(d.selectedBuyerId))),
    );

    const expenses = expensesRaw.map((e) => ({ amount: e.amount, date: e.date, reimbursed: e.reimbursed }));
    const buyers = buyersRaw.map((b) => ({ id: b.id, createdAt: b.createdAt, active: b.active }));
    const activities = activitiesRaw.map((a) => ({ date: a.dateSent ?? a.lastActivityDate ?? a.createdAt, sentByUserId: a.sentByUserId }));
    const userName = new Map(usersRaw.map((u) => [u.id, u.name]));

    const kpis = computeKpis(deals, expenses, buyers, activities, range);
    const prevKpis = compare ? computeKpis(deals, expenses, buyers, activities, compare) : null;
    const deltas = prevKpis
      ? Object.fromEntries((Object.keys(kpis) as (keyof typeof kpis)[]).map((k) => [k, delta(kpis[k], prevKpis[k])]))
      : null;

    const series = buildMonthlySeries(deals, expenses, range, 3);
    const breakdowns = buildBreakdowns(deals, activities, range);
    const perUser = breakdowns.perUser
      .map((u) => ({ ...u, name: userName.get(u.userId) ?? "Unknown" }))
      .sort((a, b) => b.created + b.closed + b.activity - (a.created + a.closed + a.activity));

    res.json({
      range: { from, to },
      compare,
      kpis,
      previous: prevKpis,
      deltas,
      series,
      breakdowns: { ...breakdowns, perUser },
    });
  }),
);

reportsRouter.get(
  "/filters",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const [deals, buyers, users] = await Promise.all([
      prisma.deal.findMany({
        where: { organizationId: org },
        select: { counties: true, basins: true, formations: true, assetTypes: true, operator: true },
      }),
      prisma.buyer.findMany({ where: { organizationId: org }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.user.findMany({ where: { organizationId: org }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean))).sort();
    res.json({
      counties: uniq(deals.flatMap((d) => d.counties)),
      basins: uniq(deals.flatMap((d) => d.basins)),
      formations: uniq(deals.flatMap((d) => d.formations)),
      assetTypes: uniq(deals.flatMap((d) => d.assetTypes)),
      operators: uniq(deals.map((d) => d.operator ?? "").filter(Boolean)),
      buyers,
      users,
      stages: ["UNDER_CONTRACT", "PREPARING_PACKAGE", "SENT_TO_BUYERS", "NEGOTIATING", "CLOSING", "CLOSED", "DEAD"],
    });
  }),
);
