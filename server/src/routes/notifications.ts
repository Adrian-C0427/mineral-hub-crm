import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, orgId, type AuthedRequest } from "../middleware/auth.js";

/**
 * In-app notifications (portal leads today). A notification is visible to its
 * targeted user; untargeted rows (userId null) are visible to admins/owners so
 * unassigned leads always reach someone.
 */
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth, requireOrg);

function visibleWhere(req: AuthedRequest) {
  const admin = req.user!.role === "OWNER";
  return {
    organizationId: orgId(req),
    OR: admin ? [{ userId: req.user!.id }, { userId: null }] : [{ userId: req.user!.id }],
  };
}

notificationsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const unreadOnly = req.query.unread === "1";
    const rows = await prisma.notification.findMany({
      where: { ...visibleWhere(req), ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const unread = await prisma.notification.count({ where: { ...visibleWhere(req), readAt: null } });
    res.json({ notifications: rows, unread });
  }),
);

notificationsRouter.post(
  "/:id/read",
  asyncHandler(async (req: AuthedRequest, res) => {
    const n = await prisma.notification.findFirst({ where: { id: req.params.id, ...visibleWhere(req) } });
    if (!n) throw new HttpError(404, "Notification not found");
    await prisma.notification.update({ where: { id: n.id }, data: { readAt: new Date() } });
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  "/read-all",
  asyncHandler(async (req: AuthedRequest, res) => {
    await prisma.notification.updateMany({ where: { ...visibleWhere(req), readAt: null }, data: { readAt: new Date() } });
    res.json({ ok: true });
  }),
);
