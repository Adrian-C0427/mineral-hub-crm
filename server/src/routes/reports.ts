import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { ensureStages } from "../domain/stages.js";
import { netProfit, grossFee, winRate, dealCostBasis } from "../domain/metrics.js";
import { avgMoney, sumMoney } from "../domain/money.js";
import {
  computeKpis, delta, buildMonthlySeries, buildBreakdowns, inRange, realizedClosedAt, countClosedWithoutDate,
  type AnalyticsDeal, type Range,
} from "../domain/analytics.js";

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireOrg, requirePermission("viewReports"));

const periodSchema = z.object({
  from: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
});

/**
 * The deal filter every closed-deal report figure starts from. A deal is "closed
 * in the period" when its Closing date (Deal.originalClosingDate — the Contract
 * Timeline's contracted Closing) falls inside it. The stage-history timestamp
 * of the move to CLOSED and the auto-stamped closedDate are deliberately NOT
 * used: the dashboard keys on originalClosingDate, and a deal with an August 15
 * Closing moved to Closed in October belongs to August.
 */
const CLOSED_OPPORTUNITIES = { recordType: "OPPORTUNITY" as const, stage: "CLOSED" };

/** CLOSED deals with no Closing Date: in the org, but in no period or month
 *  until the date is entered (same rule as the dashboard). */
function closedWithoutDateCount(organizationId: string): Promise<number> {
  return prisma.deal.count({ where: { organizationId, ...CLOSED_OPPORTUNITIES, originalClosingDate: null } });
}

/** Period bound → Date, falling back to `fallback` when absent or unparseable. */
function periodBound(v: string | undefined, fallback: string): Date {
  const d = new Date(v ?? fallback);
  return Number.isNaN(d.getTime()) ? new Date(fallback) : d;
}

reportsRouter.get(
  "/closed",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = periodSchema.parse(req.query);
    const fromDate = periodBound(from, "1970-01-01");
    const toDate = periodBound(to, "2999-12-31");

    // The period is applied in SQL on the Closing date, so only the deals it
    // selects are loaded (never the tenant's entire closed history).
    const [inPeriod, closedWithoutDate] = await Promise.all([
      prisma.deal.findMany({
        where: { organizationId: orgId(req), ...CLOSED_OPPORTUNITIES, originalClosingDate: { gte: fromDate, lte: toDate } },
        include: { selectedOffer: true, selectedBuyer: { select: { name: true, companyName: true } } },
      }),
      closedWithoutDateCount(orgId(req)),
    ]);

    const rows = inPeriod.map((d) => {
      const accepted = d.selectedOffer?.amount ?? null;
      const costBasis = dealCostBasis(d);
      const gross = accepted != null ? grossFee(accepted, costBasis) : null;
      const net = accepted != null ? netProfit(accepted, costBasis, d.estimatedClosingCosts) : null;
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
        closedDate: d.closedDate,
      };
    });

    const acceptedAmounts = rows.map((r) => r.acceptedAmount).filter((n): n is number => n != null);
    const grossTotal = sumMoney(rows.map((r) => r.grossFee));
    const netTotal = sumMoney(rows.map((r) => r.netProfit));

    // Win rate within period: closed / (closed + dead). Dead/lost has no
    // manual date, so it still keys on the stage-history timestamp.
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
        // Over the deals that closed WITH an accepted offer — the same
        // population as the dashboard's Avg profit per deal (a deal closed
        // without a price has no realized profit, it is not a $0 deal).
        avgProfitPerDeal: avgMoney(rows.map((r) => r.netProfit).filter((n): n is number => n != null)),
        avgDealSize: avgMoney(acceptedAmounts),
      },
      winRate: winRate(rows.length, deadDeals.length),
      deadInPeriod: deadDeals.length,
      closedWithoutDate,
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
    where: { organizationId, recordType: "OPPORTUNITY" },
    include: {
      selectedOffer: { select: { amount: true } },
      // Analytics reads three event kinds from the history (creation, who
      // moved the deal to CLOSED, DEAD) — no need to ship every intermediate
      // stage move for every deal. WHEN a deal closed comes from originalClosingDate.
      stageHistory: {
        where: { OR: [{ fromStage: null }, { toStage: { in: ["CLOSED", "DEAD"] } }] },
        orderBy: { createdAt: "asc" },
        select: { toStage: true, fromStage: true, changedByUserId: true, createdAt: true },
      },
    },
  });
  return deals.map((d) => {
    // Who closed it (latest CLOSED transition), the latest DEAD transition, and
    // the creator (fromStage === null event).
    let closedByUserId: string | null = null, deadAt: Date | null = null;
    let createdByUserId: string | null = d.relationshipOwnerId;
    for (const h of d.stageHistory) {
      if (h.fromStage === null) createdByUserId = h.changedByUserId ?? createdByUserId;
      if (h.toStage === "CLOSED") closedByUserId = h.changedByUserId;
      if (h.toStage === "DEAD") deadAt = h.createdAt;
    }
    // The month/period a closed deal lands in is its Closing date — the same
    // rule as the dashboard. No date → the deal is in no period (counted by
    // countClosedWithoutDate so the UI can say so).
    const closedAt = realizedClosedAt(d);
    return {
      id: d.id,
      createdAt: d.createdAt,
      stage: d.stage,
      states: d.states.length ? d.states : d.state ? [d.state] : [],
      counties: d.counties,
      basins: d.basins,
      formations: d.formations,
      assetTypes: d.assetTypes,
      operator: d.operator,
      askPrice: d.askPrice,
      ourPrice: d.ourPrice,
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

// Parse a caller-supplied day as UTC, rejecting malformed/array-valued input
// (a bare `new Date("garbage")` yields an Invalid Date that silently makes
// every comparison false and returns misleading empty analytics).
function parseDay(v: unknown, endOfDay = false): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return isNaN(d.getTime()) ? null : d;
}

/** The report's period (default: this calendar year), comparison window and
 *  deal filters — shared by every analytics endpoint so they always agree. */
function analyticsQuery(q: AuthedRequest["query"]) {
  const now = new Date();
  const from = parseDay(q.from) ?? new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const to = parseDay(q.to, true) ?? new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59));
  const range: Range = { from, to };
  const cmpFrom = parseDay(q.compareFrom), cmpTo = parseDay(q.compareTo, true);
  const compare: Range | null = cmpFrom && cmpTo ? { from: cmpFrom, to: cmpTo } : null;
  const filters = {
    states: arrParam(q.states),
    counties: arrParam(q.counties),
    basins: arrParam(q.basins),
    formations: arrParam(q.formations),
    assetTypes: arrParam(q.assetTypes),
    operators: arrParam(q.operators),
    stages: arrParam(q.stages),
    users: arrParam(q.users),
    buyers: arrParam(q.buyers),
  };
  return { range, compare, filters };
}
type AnalyticsFilters = ReturnType<typeof analyticsQuery>["filters"];

/** Apply deal-characteristic filters in memory (org deal volumes are small). */
function filterDeals(all: AnalyticsDeal[], filters: AnalyticsFilters): AnalyticsDeal[] {
  return all.filter(
    (d) =>
      intersects(d.states, filters.states) &&
      intersects(d.counties, filters.counties) &&
      intersects(d.basins, filters.basins) &&
      intersects(d.formations, filters.formations) &&
      intersects(d.assetTypes, filters.assetTypes) &&
      (filters.operators.length === 0 || (d.operator != null && filters.operators.includes(d.operator))) &&
      (filters.stages.length === 0 || filters.stages.includes(d.stage)) &&
      (filters.users.length === 0 || (d.relationshipOwnerId != null && filters.users.includes(d.relationshipOwnerId))) &&
      (filters.buyers.length === 0 || (d.selectedBuyerId != null && filters.buyers.includes(d.selectedBuyerId))),
  );
}

reportsRouter.get(
  "/analytics",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { range, compare, filters } = analyticsQuery(req.query);
    const { from, to } = range;

    // NOTE: these four loads are deliberately uncapped. They feed org-wide
    // aggregates (KPIs, deltas, breakdowns), so a `take` would not bound the
    // work — it would silently return WRONG financials, which is worse than a
    // slow report. Bounding this properly means pre-aggregating in SQL rather
    // than filtering in memory; until then the cost scales with tenant size.
    // The period filter IS pushed down where it can be (see /closed above).
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

    const deals = filterDeals(allDeals, filters);

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
      // Org-wide (not narrowed by the filters): closed deals that no period can show.
      closedWithoutDate: countClosedWithoutDate(allDeals),
    });
  }),
);

/**
 * The records behind Cost per Deal and ROI for the report's period + filters:
 * every closed deal (its revenue, closing costs, contribution) and every
 * expense, with the totals computed by the SAME computeKpis the KPI tiles use.
 * Realized results only — open deals and forecasts are never included.
 */
reportsRouter.get(
  "/analytics/financials",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { range, filters } = analyticsQuery(req.query);
    // Individual expense rows (notes, submitter) are gated by manageExpenses
    // everywhere else; viewReports alone only earns the totals.
    const canSeeExpenses = req.user!.orgRole === "OWNER" || req.user!.permissions.includes("manageExpenses");
    const [allDeals, expensesRaw] = await Promise.all([
      loadAnalyticsDeals(org),
      prisma.expense.findMany({
        where: { organizationId: org, date: { gte: range.from, lte: range.to } },
        select: {
          id: true, date: true, amount: true, notes: true, reimbursed: true,
          category: { select: { name: true } }, user: { select: { name: true } },
        },
        orderBy: { date: "desc" },
      }),
    ]);
    const deals = filterDeals(allDeals, filters);
    const expenses = expensesRaw.filter((e) => inRange(e.date, range));
    const kpis = computeKpis(deals, expenses.map((e) => ({ amount: e.amount, date: e.date, reimbursed: e.reimbursed })), [], [], range);

    const closed = deals.filter((d) => inRange(d.closedAt, range));
    const names = new Map((await prisma.deal.findMany({
      where: { id: { in: closed.map((d) => d.id) }, organizationId: org },
      select: { id: true, name: true },
    })).map((d) => [d.id, d.name]));
    const closedDeals = closed
      .map((d) => {
        const costBasis = dealCostBasis(d);
        // Same per-deal math as computeKpis: revenue = accepted − cost basis.
        const revenue = d.acceptedAmount != null ? grossFee(d.acceptedAmount, costBasis) : null;
        return {
          id: d.id,
          name: names.get(d.id) ?? "Deal",
          closedAt: d.closedAt,
          counties: d.counties,
          acceptedAmount: d.acceptedAmount,
          costBasis,
          revenue,
          closingCosts: d.estimatedClosingCosts,
          grossProfit: d.acceptedAmount != null ? netProfit(d.acceptedAmount, costBasis, d.estimatedClosingCosts) : null,
        };
      })
      .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));

    res.json({
      range,
      totals: {
        revenue: kpis.revenue, closingCosts: kpis.closingCosts, grossProfit: kpis.grossProfit,
        expenses: kpis.expenses, netProfit: kpis.netProfit, dealsClosed: kpis.dealsClosed,
        costPerDeal: kpis.costPerDeal, roiMultiple: kpis.roiMultiple, closedWithoutPrice: kpis.closedWithoutPrice,
        closedWithoutDate: countClosedWithoutDate(allDeals),
      },
      closedDeals,
      expenses: !canSeeExpenses ? null : expenses.map((e) => ({
        id: e.id, date: e.date, amount: e.amount, category: e.category?.name ?? null,
        notes: e.notes, submittedBy: e.user?.name ?? null, reimbursed: e.reimbursed,
      })),
    });
  }),
);

reportsRouter.get(
  "/filters",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const [deals, buyers, users, orgStages] = await Promise.all([
      prisma.deal.findMany({
        where: { organizationId: org },
        select: { counties: true, basins: true, formations: true, assetTypes: true, operator: true },
      }),
      prisma.buyer.findMany({ where: { organizationId: org }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.user.findMany({ where: { organizationId: org }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      ensureStages(prisma, org),
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
      stages: orgStages.map((s) => s.key),
    });
  }),
);
