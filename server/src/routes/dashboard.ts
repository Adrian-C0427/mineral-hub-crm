import { Router } from "express";
import { z } from "zod";
import { prisma, withDbRetry } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { serializeDeal } from "../serializers.js";
import { netProfit, avg, profitAtAsk } from "../domain/metrics.js";
import { ensureStages, TERMINAL_STAGE_KEYS } from "../domain/stages.js";

export const dashboardRouter = Router();
// The dashboard surfaces the same sensitive financials as Reports (projected /
// closed profit, average deal size, top buyers by volume), so it must sit
// behind the SAME permission — otherwise removing "View reports" from a role
// leaves the numbers readable here. Keep this gate in lockstep with reports.ts.
dashboardRouter.use(requireAuth, requireOrg, requirePermission("viewReports"));

/**
 * Tasks (the Dashboard Tasks widget, task notifications). Deliberately NOT
 * behind "View reports": tasks carry no financials, and a teammate assigned a
 * task must always be able to open and complete it.
 */
export const tasksRouter = Router();
tasksRouter.use(requireAuth, requireOrg);

const dealInclude = { selectedBuyer: true, relationshipOwner: true } as const;

/** "YYYY-MM-DD" → UTC midnight, or null. Year-guarded (see research.ts lesson:
 * a malformed year like 0202 parses to a valid-but-absurd Date). */
function parseDayUTC(v: unknown): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  const y = d.getUTCFullYear();
  return Number.isNaN(d.getTime()) || y < 1900 || y > 2100 ? null : d;
}

/** Global dashboard date window (default YTD). Upper bound is exclusive. */
export function dashboardWindow(
  period: string | undefined, now: Date, from?: unknown, to?: unknown,
): { start: Date; end: Date; label: string } {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  switch (period) {
    case "THIS_MONTH": return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)), label: "This Month" };
    case "LAST_MONTH": return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)), label: "Last Month" };
    case "THIS_QUARTER": { const q = Math.floor(m / 3) * 3; return { start: new Date(Date.UTC(y, q, 1)), end: new Date(Date.UTC(y, q + 3, 1)), label: "This Quarter" }; }
    case "CUSTOM": {
      const f = parseDayUTC(from), t = parseDayUTC(to);
      // End is exclusive: the chosen "to" day is included in full.
      if (f && t && f.getTime() <= t.getTime()) return { start: f, end: new Date(t.getTime() + 86_400_000), label: "Custom" };
      break; // malformed range → YTD fallback
    }
  }
  return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)), label: "YTD" };
}

/**
 * Time buckets spanning a window: monthly, or yearly when a custom range grows
 * past 24 months (120 bars help nobody). Labels carry the year whenever the
 * bucket isn't in the current calendar year.
 */
export function windowBuckets(win: { start: Date; end: Date }, now: Date): { y: number; m: number | null; label: string; isCurrent: boolean }[] {
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const endT = new Date(win.end.getTime() - 1);
  const months: { y: number; m: number }[] = [];
  for (let y = win.start.getUTCFullYear(), m = win.start.getUTCMonth();
    y < endT.getUTCFullYear() || (y === endT.getUTCFullYear() && m <= endT.getUTCMonth());
    m === 11 ? (m = 0, y++) : m++) months.push({ y, m });
  if (months.length > 24) {
    const years = [...new Set(months.map((x) => x.y))];
    return years.map((y) => ({ y, m: null, label: String(y), isCurrent: y === now.getUTCFullYear() }));
  }
  return months.map(({ y, m }) => ({
    y, m,
    label: y === now.getUTCFullYear() ? monthNames[m] : `${monthNames[m]} '${String(y).slice(2)}`,
    isCurrent: y === now.getUTCFullYear() && m === now.getUTCMonth(),
  }));
}

/** One deal behind a profit-chart bar (powers the click-through drill-down). */
export type BucketDeal = {
  id: string; name: string; stage: string;
  /** closed = realized, projected = has an offer, atAsk = no offer yet (profit at asking price). */
  kind: "closed" | "projected" | "atAsk";
  amount: number | null; profit: number; date: string;
};

/** The scalars the at-asking series needs from an active deal. */
type AtAskDeal = {
  id: string; name: string; stage: string;
  askPrice: number | null; ourPrice: number | null; estimatedClosingCosts: number | null;
  offers: { amount: number }[];
};

/**
 * "Profit at asking price" series — the third, mutually exclusive population
 * next to realized (closed) and projected (active with an offer): active deals
 * with NO offers at all and both prices set (ask − Our Cost − closing costs).
 * `total` is the headline sum over that whole population; the per-bucket maps
 * only hold deals whose resolved closing date lands on the chart's axis (a
 * deal with no resolvable date, or one outside the window, is in the total
 * but on no bar). Pure so it can be unit-tested without a database.
 */
export function profitAtAskSeries<T extends AtAskDeal>(
  deals: T[],
  closingDateOf: (d: T) => Date | string | null | undefined,
  bucketIdx: (dt: Date) => number,
): { total: number; byBucket: Map<number, number>; bucketDeals: { i: number; entry: BucketDeal }[] } {
  let total = 0;
  const byBucket = new Map<number, number>();
  const bucketDeals: { i: number; entry: BucketDeal }[] = [];
  for (const d of deals) {
    if (d.offers.length) continue; // has an offer → it's in Projected, never here
    const profit = profitAtAsk(d.askPrice, d.ourPrice, d.estimatedClosingCosts);
    if (profit == null) continue;
    total += profit;
    const when = closingDateOf(d);
    if (!when) continue;
    const dt = new Date(when);
    const i = bucketIdx(dt);
    if (i < 0) continue;
    byBucket.set(i, (byBucket.get(i) ?? 0) + profit);
    bucketDeals.push({ i, entry: { id: d.id, name: d.name, stage: d.stage, kind: "atAsk", amount: d.askPrice, profit, date: dt.toISOString().slice(0, 10) } });
  }
  return { total, byBucket, bucketDeals };
}

dashboardRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const now = new Date();
    const win = dashboardWindow(req.query.period as string | undefined, now, req.query.from, req.query.to);
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
    // Retry only transient Neon reconnect blips (P1001/P1017) on this hot,
    // authenticated read batch (Sentry MINERAL-HUB-API-6). Happy path unchanged.
    const [allActive, closedDeals, activeOffers] = await withDbRetry(() =>
      Promise.all([
        prisma.deal.findMany({ where: { stage: { notIn: [...TERMINAL_STAGE_KEYS] }, organizationId: org, ...IN_PIPELINE }, include: { ...dealInclude, offers: true } }),
        prisma.deal.findMany({
          where: { stage: "CLOSED", organizationId: org, ...IN_PIPELINE },
          include: { ...dealInclude, selectedOffer: true },
        }),
        // "Offers Pending" = active offers on deals that haven't accepted one
        // yet. Once a deal selects its offer, the losing ACTIVE offers are no
        // longer pending decisions and must drop out of the KPI.
        prisma.offer.count({ where: { status: "ACTIVE", deal: { organizationId: org, selectedOfferId: null, ...IN_PIPELINE } } }),
      ]),
    );

    // Metrics row
    const activeDeals = allActive.length;

    // Under Contract: what we're currently committed to pay sellers — the
    // acquisition cost (Our Price) of every active seller deal. Owned assets
    // marketed for sale are already ours (no seller contract), so they're
    // excluded; child assets count individually (each carries its own cost).
    const underContract = allActive
      .filter((d) => d.recordType === "OPPORTUNITY")
      .reduce((sum, d) => sum + (d.ourPrice ?? 0), 0);

    // Projected profit: best offer − ask − costs across active deals that have
    // offers. A deal with an ACCEPTED offer projects THAT offer (same rule as
    // the monthly chart and the deal serializer), never a higher rejected one.
    const projectedProfit = allActive.reduce((sum, d) => {
      const accepted = d.offers.find((o) => o.id === d.selectedOfferId) ?? d.offers.find((o) => o.status === "ACCEPTED");
      const best = accepted?.amount ?? d.offers.reduce<number | null>((m, o) => (m == null || o.amount > m ? o.amount : m), null);
      if (best == null) return sum;
      return sum + netProfit(best, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts);
    }, 0);

    // Every closed-deal metric keys EXCLUSIVELY on the Contract Timeline's
    // Closed Date (Deal.closedDate) — never the stage-transition timestamp or
    // updatedAt. A closed deal with no Closed Date set is deliberately absent
    // from period-scoped reporting until the date is entered.
    const closedInWindow = closedDeals.filter((d) => d.closedDate && inWindow(d.closedDate));
    const closedProfitYtd = closedInWindow.reduce(
      (sum, d) => sum + (d.selectedOffer ? netProfit(d.selectedOffer.amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts) : 0),
      0,
    );
    const closedDealsCount = closedInWindow.length;

    // Prior-period baselines for the KPI deltas: the window of EQUAL length
    // immediately before the selected one, keyed on the same Closed Date. This
    // is what the ▲/▼ percentages compare against, so they always answer "vs
    // the previous equivalent period" for whatever range the user picked.
    const prevStart = new Date(win.start.getTime() - (win.end.getTime() - win.start.getTime()));
    const inPrevWindow = (d: Date) => d.getTime() >= prevStart.getTime() && d.getTime() < win.start.getTime();
    const closedInPrev = closedDeals.filter((d) => d.closedDate && inPrevWindow(d.closedDate));
    const closedProfitPrev = closedInPrev.reduce(
      (sum, d) => sum + (d.selectedOffer ? netProfit(d.selectedOffer.amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts) : 0),
      0,
    );
    const closedDealsPrev = closedInPrev.length;
    // Average realized profit per closed deal in the window (same population
    // and Closed Date keying as the Closed profit KPI above).
    const avgProfitPerDeal = avg(
      closedInWindow.map((d) => (d.selectedOffer ? netProfit(d.selectedOffer.amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts) : null)).filter((n): n is number => n != null),
    );
    const avgProfitPrev = avg(
      closedInPrev.map((d) => (d.selectedOffer ? netProfit(d.selectedOffer.amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts) : null)).filter((n): n is number => n != null),
    );

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

    // Top buyers by closed volume within the selected window
    const topBuyersMap = new Map<string, { name: string; companyName: string; volume: number }>();
    for (const d of closedInWindow) {
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

    // Profit by month — realized profit bucketed by the Contract Timeline's
    // Closed Date, spanning the SELECTED window (yearly buckets for very long
    // custom ranges). Projected profit shares the same axis.
    const buckets = windowBuckets(win, now);
    const bucketIdx = (dt: Date): number => buckets.findIndex((b) =>
      b.m === null ? dt.getUTCFullYear() === b.y : dt.getUTCFullYear() === b.y && dt.getUTCMonth() === b.m);
    // Per-bucket deal lists power the chart's click-through drill-down: the
    // user goes straight from a bar to the deals behind it.
    const bucketDeals = new Map<number, BucketDeal[]>();
    const pushBucketDeal = (i: number, entry: BucketDeal) => {
      const list = bucketDeals.get(i) ?? [];
      list.push(entry);
      bucketDeals.set(i, list);
    };
    const monthly = new Map<number, number>();
    for (const d of closedInWindow) {
      const i = bucketIdx(d.closedDate!);
      if (i < 0) continue;
      const profit = d.selectedOffer ? netProfit(d.selectedOffer.amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts) : 0;
      monthly.set(i, (monthly.get(i) ?? 0) + profit);
      pushBucketDeal(i, {
        id: d.id, name: d.name, stage: d.stage, kind: "closed",
        amount: d.selectedOffer?.amount ?? null, profit, date: d.closedDate!.toISOString().slice(0, 10),
      });
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
      const i = bucketIdx(new Date(s.finalClosingDate));
      if (i < 0) continue;
      const profit = netProfit(amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts);
      monthlyProjected.set(i, (monthlyProjected.get(i) ?? 0) + profit);
      pushBucketDeal(i, {
        id: d.id, name: d.name, stage: d.stage, kind: "projected",
        amount, profit, date: new Date(s.finalClosingDate).toISOString().slice(0, 10),
      });
    }
    // Profit at asking price by month — the active deals the Projected series
    // leaves out (no offer yet), bucketed by the SAME resolved closing date.
    // Realized / Projected / At-asking never overlap, so the three stack.
    const atAsk = profitAtAskSeries(allActive, (d) => serializeDeal(d, now).finalClosingDate, bucketIdx);
    for (const { i, entry } of atAsk.bucketDeals) pushBucketDeal(i, entry);
    const kindOrder: Record<BucketDeal["kind"], number> = { closed: 0, projected: 1, atAsk: 2 };
    const profitByMonth = buckets.map((b, i) => ({
      month: b.label, isCurrent: b.isCurrent,
      profit: monthly.get(i) ?? 0, projected: monthlyProjected.get(i) ?? 0, atAsk: atAsk.byBucket.get(i) ?? 0,
      deals: (bucketDeals.get(i) ?? []).sort((a, b2) => (a.kind === b2.kind ? b2.profit - a.profit : kindOrder[a.kind] - kindOrder[b2.kind])),
    }));

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

    // Avg profit per deal as a running average across closes (last 8 points),
    // ordered by the same Contract Timeline Closed Date as everything else.
    const closesAsc = closedDeals
      .filter((d) => d.selectedOffer && d.closedDate)
      .sort((a, b) => a.closedDate!.getTime() - b.closedDate!.getTime());
    let closeSum = 0;
    const avgProfitTrend = closesAsc.map((d, i) => {
      closeSum += netProfit(d.selectedOffer!.amount, d.ourPrice ?? d.askPrice, d.estimatedClosingCosts);
      return closeSum / (i + 1);
    }).slice(-8);

    // Closed deals per week (8 weeks) by Closed Date — sparkline for the
    // Closed Deals KPI.
    const closedWeekly = weekMarks.map((t, i) => {
      const from = i === 0 ? new Date(t.getTime() - weekMs) : weekMarks[i - 1];
      return closedDeals.filter((d) => d.closedDate && d.closedDate > from && d.closedDate <= t).length;
    });

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

    const dueSoonTasks = await dueSoonTasksFor(org, req.user!.id, String(req.query.tasksFor ?? "me"), canManageTasks(req), canViewContacts(req), now);

    res.json({
      metrics: {
        activeDeals,
        projectedProfit,
        closedProfitYtd,
        closedDealsCount,
        avgProfitPerDeal,
        offersPending: activeOffers,
        underContract,
        // Profit at asking price: active deals with no offer yet, if they sold
        // at our ask (ask − Our Cost − closing costs). Separate from projected.
        profitAtAsk: atAsk.total,
        periodLabel: win.label,
        // Prior equal-length window (Closed Date keyed) — delta baselines.
        closedProfitPrev,
        closedDealsPrev,
        avgProfitPrev,
      },
      tasks: dueSoonTasks,
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
      trends: { activeDealsWeekly, avgProfitPerDeal: avgProfitTrend, closedWeekly, offersWeekly },
    });
  }),
);

/**
 * Whose tasks a caller is looking at — `me`, `all` users, or one user id — as a
 * ContactActivity filter. Shared with the Calendar so both apply one rule.
 */
export function taskOwnerWhere(meId: string, whose: string) {
  const owner = whose === "all" ? null : whose === "me" ? meId : whose;
  return owner ? { OR: [{ assignedToId: owner }, { assignedToId: null, createdById: owner }] } : {};
}

/** "View contacts" (or owner) — what the Contacts pages require. */
export function canViewContacts(req: AuthedRequest): boolean {
  return req.user?.orgRole === "OWNER" || (req.user?.permissions ?? []).includes("viewContacts");
}

/**
 * Which tasks a caller may see at all. A contact task carries the contact's
 * name and notes about them, so without "View contacts" a caller sees only the
 * contact tasks that are theirs (assigned to them, or written by them) — what
 * they need to do their own work. Standalone Dashboard tasks hold no contact
 * data and stay visible to everyone, as before. Shared with the Calendar.
 */
export function taskVisibilityWhere(meId: string, seeContacts: boolean) {
  return seeContacts ? {} : { OR: [{ contactId: null }, { assignedToId: meId }, { createdById: meId }] };
}

/**
 * Tasks widget feed: incomplete tasks (contact tasks and standalone Dashboard
 * tasks) that are overdue, due today, or coming due within the next 7 days
 * (the same near-future horizon the notification sweep leads into), soonest
 * first — for `me` (default), `all` users, or one user id. A task belongs to
 * its assignee, or to its author when unassigned (the same owner the due-task
 * notification goes to).
 */
async function dueSoonTasksFor(org: string, meId: string, whose: string, manageAll: boolean, seeContacts: boolean, now: Date = new Date()) {
  const taskHorizon = new Date(now.getTime() + 7 * 86_400_000);
  const taskRows = await prisma.contactActivity.findMany({
    where: {
      organizationId: org, kind: "TASK", completedAt: null, dueDate: { not: null, lte: taskHorizon },
      AND: [taskOwnerWhere(meId, whose), taskVisibilityWhere(meId, seeContacts)],
    },
    select: taskSelect,
    orderBy: { dueDate: "asc" },
    take: 50,
  });
  return taskRows.map((t) => serializeTask(t, meId, manageAll));
}

const taskSelect = {
  id: true, title: true, body: true, dueDate: true, priority: true, completedAt: true, createdAt: true,
  assignedTo: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  contact: { select: { id: true, firstName: true, lastName: true, entityName: true } },
} as const;
type TaskRow = {
  id: string; title: string | null; body: string; dueDate: Date | null; priority: string | null; completedAt: Date | null; createdAt: Date;
  assignedTo: { id: string; name: string } | null; createdBy: { id: string; name: string } | null;
  contact: { id: string; firstName: string | null; lastName: string | null; entityName: string | null } | null;
};
function serializeTask(t: TaskRow, meId: string, manageAll: boolean) {
  const owner = t.assignedTo ?? t.createdBy;
  return {
    id: t.id,
    title: t.title ?? t.body,
    // The title doubles as the body when no details were given.
    details: t.title && t.body && t.body !== t.title ? t.body : null,
    dueDate: t.dueDate,
    priority: t.priority ?? "MEDIUM",
    assignedTo: owner,
    createdBy: t.createdBy,
    completedAt: t.completedAt,
    createdAt: t.createdAt,
    contactId: t.contact?.id ?? null,
    contactName: t.contact ? [t.contact.firstName, t.contact.lastName].filter(Boolean).join(" ") || t.contact.entityName || "Contact" : null,
    // Anyone who manages contacts can close any task; otherwise only its owner or author.
    canComplete: manageAll || owner?.id === meId || t.createdBy?.id === meId,
  };
}

/** Contact managers (and owners) can complete anyone's task. */
function canManageTasks(req: AuthedRequest): boolean {
  return req.user?.orgRole === "OWNER" || (req.user?.permissions ?? []).includes("manageContacts");
}

const tasksForSchema = z.object({ assignee: z.string().min(1).max(200).default("me") });

/** The Tasks widget's user filter: Me (default), All users, or one user. */
tasksRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { assignee } = tasksForSchema.parse(req.query);
    res.json(await dueSoonTasksFor(orgId(req), req.user!.id, assignee, canManageTasks(req), canViewContacts(req)));
  }),
);

const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;
const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().max(10_000).nullish(),
  priority: z.enum(TASK_PRIORITIES).default("MEDIUM"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Omitted/null = the creator's own task. */
  assignedToId: z.string().min(1).max(200).nullish(),
});

/**
 * Create a standalone task from the Dashboard — for yourself or assigned to a
 * teammate. Assigning it to someone else notifies them in-app with a link that
 * opens the task (`/?task=<id>`).
 */
tasksRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const me = req.user!;
    const data = createTaskSchema.parse(req.body);
    const due = parseDayUTC(data.dueDate);
    if (!due) throw new HttpError(400, "Enter a valid due date");
    const assigneeId = data.assignedToId || me.id;
    const assignee = await prisma.user.findFirst({ where: { id: assigneeId, organizationId: org }, select: { id: true, name: true } });
    if (!assignee) throw new HttpError(400, "Assignee is not in your organization");
    const created = await prisma.contactActivity.create({
      data: {
        organizationId: org,
        contactId: null,
        kind: "TASK",
        title: data.title,
        body: data.details || data.title,
        dueDate: due,
        priority: data.priority,
        assignedToId: assignee.id,
        createdById: me.id,
      },
      select: taskSelect,
    });
    let notified = false;
    if (assignee.id !== me.id) {
      const pr = data.priority[0] + data.priority.slice(1).toLowerCase();
      await prisma.notification.create({
        data: {
          organizationId: org,
          userId: assignee.id,
          type: "task_assigned",
          title: `New task: ${data.title.slice(0, 80)}`,
          body: `${me.name} assigned you a task · ${pr} priority · due ${data.dueDate.slice(5, 7)}/${data.dueDate.slice(8, 10)}/${data.dueDate.slice(0, 4)}.`,
          link: `/?task=${created.id}`,
        },
      });
      notified = true;
    }
    res.status(201).json({ ...serializeTask(created, me.id, canManageTasks(req)), notified });
  }),
);

async function findTask(req: AuthedRequest, id: string) {
  const t = await prisma.contactActivity.findFirst({
    where: { id, organizationId: orgId(req), kind: "TASK", ...taskVisibilityWhere(req.user!.id, canViewContacts(req)) },
    select: taskSelect,
  });
  if (!t) throw new HttpError(404, "Task not found");
  return t;
}

/** One task — what a task notification opens. */
tasksRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(serializeTask(await findTask(req, req.params.id), req.user!.id, canManageTasks(req)));
  }),
);

/** Complete / reopen a task from the Dashboard (contact or standalone). */
tasksRouter.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const { completed } = z.object({ completed: z.boolean() }).parse(req.body);
    const t = await findTask(req, req.params.id);
    const view = serializeTask(t, req.user!.id, canManageTasks(req));
    if (!view.canComplete) throw new HttpError(403, "Only the task's owner or a contact manager can complete it");
    const updated = await prisma.contactActivity.update({
      where: { id: t.id },
      data: { completedAt: completed ? new Date() : null },
      select: taskSelect,
    });
    // Completing a task retires its due-alert from every bell immediately.
    if (completed) {
      await prisma.notification.deleteMany({ where: { organizationId: org, type: "task_due", link: { contains: `task=${t.id}` } } });
    }
    res.json(serializeTask(updated, req.user!.id, canManageTasks(req)));
  }),
);
