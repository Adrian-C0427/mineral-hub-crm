/**
 * GET /api/records/search?q=… — find a record to link an email or drive file
 * to. Searches only the caller's organization and only the record types their
 * role can see (deals/opportunities → viewDeals, contacts → viewContacts,
 * buyers → viewBuyers). Mineral assets are deals (recordType OWNED_ASSET).
 */
import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { hasPermission, orgId, requireAuth, requireOrg, type AuthedRequest } from "../middleware/auth.js";
import { contactName } from "../domain/contactName.js";

export const recordSearchRouter = Router();
recordSearchRouter.use(requireAuth, requireOrg);

const TAKE = 6;

recordSearchRouter.get(
  "/search",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    if (q.length < 2) return res.json([]);
    const org = orgId(req);
    const has = { contains: q, mode: "insensitive" as const };
    const out: { type: string; id: string; name: string; detail: string | null }[] = [];
    if (hasPermission(req, "viewDeals")) {
      const deals = await prisma.deal.findMany({ where: { organizationId: org, name: has }, select: { id: true, name: true, recordType: true, counties: true }, take: TAKE, orderBy: { updatedAt: "desc" } });
      for (const d of deals) out.push({ type: "deal", id: d.id, name: d.name, detail: `${d.recordType === "OWNED_ASSET" ? "Mineral asset" : "Deal"}${d.counties.length ? ` · ${d.counties.join(", ")}` : ""}` });
      const opps = await prisma.opportunity.findMany({ where: { organizationId: org, name: has }, select: { id: true, name: true }, take: TAKE, orderBy: { updatedAt: "desc" } });
      for (const o of opps) out.push({ type: "opportunity", id: o.id, name: o.name, detail: "Opportunity" });
    }
    if (hasPermission(req, "viewContacts")) {
      const contacts = await prisma.contact.findMany({
        where: { organizationId: org, OR: [{ firstName: has }, { lastName: has }, { entityName: has }, { email: has }] },
        select: { id: true, firstName: true, middleName: true, lastName: true, entityName: true, email: true }, take: TAKE, orderBy: { updatedAt: "desc" },
      });
      for (const c of contacts) out.push({ type: "contact", id: c.id, name: contactName(c) || "Contact", detail: c.email ? `Contact · ${c.email}` : "Contact" });
    }
    if (hasPermission(req, "viewBuyers")) {
      const buyers = await prisma.buyer.findMany({
        where: { organizationId: org, OR: [{ name: has }, { companyName: has }, { email: has }] },
        select: { id: true, name: true, companyName: true, email: true }, take: TAKE, orderBy: { updatedAt: "desc" },
      });
      for (const b of buyers) out.push({ type: "buyer", id: b.id, name: b.name, detail: `Buyer${b.companyName && b.companyName !== b.name ? ` · ${b.companyName}` : ""}` });
    }
    res.json(out);
  }),
);
