import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { netProfit, grossFee, avg, winRate } from "../domain/metrics.js";

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

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
  asyncHandler(async (req, res) => {
    const { from, to } = periodSchema.parse(req.query);
    const fromDate = from ? new Date(from) : new Date("1970-01-01");
    const toDate = to ? new Date(to) : new Date("2999-12-31");

    // Closed deals whose CLOSED transition falls in the period.
    const closedDeals = await prisma.deal.findMany({
      where: { stage: "CLOSED" },
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
        county: d.county,
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
      where: { toStage: "DEAD", createdAt: { gte: fromDate, lte: toDate } },
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
