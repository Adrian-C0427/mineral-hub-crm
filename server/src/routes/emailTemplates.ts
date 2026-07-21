import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";

export const emailTemplatesRouter = Router();
emailTemplatesRouter.use(requireAuth, requireOrg, requirePermission("sendEmail"));

emailTemplatesRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const templates = await prisma.emailTemplate.findMany({
      where: { organizationId: orgId(req) },
      orderBy: { name: "asc" },
    });
    res.json(templates);
  }),
);

const upsert = z.object({
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(2_000),
  body: z.string().min(1).max(200_000),
});

emailTemplatesRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = upsert.parse(req.body);
    const t = await prisma.emailTemplate.create({ data: { ...data, organizationId: orgId(req) } });
    res.status(201).json(t);
  }),
);

emailTemplatesRouter.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = upsert.partial().parse(req.body);
    const existing = await prisma.emailTemplate.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) throw new HttpError(404, "Template not found");
    const t = await prisma.emailTemplate.update({ where: { id: existing.id }, data });
    res.json(t);
  }),
);

emailTemplatesRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const existing = await prisma.emailTemplate.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) throw new HttpError(404, "Template not found");
    await prisma.emailTemplate.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);
