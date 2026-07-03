/**
 * AI assistance routes (Claude). Deal summarization and buyer-outreach drafting,
 * powered by the org's connected Claude key. Read-permission gated (viewDeals),
 * rate-limited because each call spends the org's Anthropic budget, and
 * audit-logged.
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { serializeDeal } from "../serializers.js";
import { logActivity } from "../services/activityLog.js";
import { summarizeDeal, draftOutreach, aiSandbox, type DealContext } from "../services/ai.js";

export const aiRouter = Router();
aiRouter.use(requireAuth, requireOrg, requirePermission("viewDeals"));

// AI calls cost money and hit provider rate limits — cap per user/IP.
aiRouter.use(rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many AI requests. Wait a few minutes and try again." },
}));

const dealInclude = { selectedBuyer: true, relationshipOwner: true, offers: { select: { amount: true } } } as const;

async function loadDealContext(req: AuthedRequest, dealId: string): Promise<{ name: string; ctx: DealContext }> {
  const deal = await prisma.deal.findFirst({ where: { id: dealId, organizationId: orgId(req) }, include: dealInclude });
  if (!deal) throw new HttpError(404, "Deal not found");
  const s = serializeDeal(deal);
  return {
    name: s.name,
    ctx: {
      name: s.name, stage: s.stage, recordType: s.recordType,
      state: s.state, states: s.states, counties: s.counties,
      operator: s.operator, assetTypes: s.assetTypes, basins: s.basins, formations: s.formations,
      acreageNma: s.acreageNma, nra: s.nra,
      askPrice: s.askPrice, ourPrice: s.ourPrice, estimatedClosingCosts: s.estimatedClosingCosts,
      sellerNames: s.sellerNames, selectedBuyer: s.selectedBuyer ? { name: s.selectedBuyer.name } : null,
      dateUnderContract: s.dateUnderContract, originalClosingDate: s.originalClosingDate,
      findBuyerByDate: s.findBuyerByDate, finalClosingDate: s.finalClosingDate, notes: s.notes,
    },
  };
}

aiRouter.post(
  "/deals/:id/summary",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name, ctx } = await loadDealContext(req, req.params.id);
    const summary = await summarizeDeal(orgId(req), ctx);
    await logActivity({
      eventType: "ai.deal_summary", summary: `AI summary generated for deal "${name}"`,
      organizationId: orgId(req), actorUserId: req.user?.id ?? null, dealId: req.params.id,
    });
    res.json({ text: summary, sandbox: aiSandbox() });
  }),
);

const draftSchema = z.object({ buyerId: z.string().min(1), instructions: z.string().max(1000).optional() });

aiRouter.post(
  "/deals/:id/draft-email",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { buyerId, instructions } = draftSchema.parse(req.body);
    const { name, ctx } = await loadDealContext(req, req.params.id);
    const buyer = await prisma.buyer.findFirst({
      where: { id: buyerId, organizationId: orgId(req) },
      include: { buyBox: true },
    });
    if (!buyer) throw new HttpError(404, "Buyer not found");
    const box = buyer.buyBox;
    const focus = box
      ? [...box.states, ...box.counties, ...box.basins, ...box.formations, ...box.assetTypes].filter(Boolean).join(", ")
      : "";
    const draft = await draftOutreach(orgId(req), ctx, { name: buyer.name, companyName: buyer.companyName, focus }, instructions);
    await logActivity({
      eventType: "ai.draft_email", summary: `AI outreach drafted for "${buyer.companyName}" on deal "${name}"`,
      organizationId: orgId(req), actorUserId: req.user?.id ?? null, dealId: req.params.id, buyerId,
    });
    res.json({ text: draft, sandbox: aiSandbox() });
  }),
);
