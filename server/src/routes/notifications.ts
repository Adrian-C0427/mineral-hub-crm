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
  // Gate on the RBAC field (orgRole), NOT the legacy per-account `role` — that
  // field was historically OWNER for every workspace creator and stays OWNER
  // even after a demotion, so it must never grant admin-level visibility.
  const admin = req.user!.orgRole === "OWNER";
  return {
    organizationId: orgId(req),
    OR: admin ? [{ userId: req.user!.id }, { userId: null }] : [{ userId: req.user!.id }],
  };
}

/**
 * Notification type catalog — every type any service creates, with the label
 * shown in Settings. Muting hides a type from the bell and its unread count;
 * rows are still written (a preference change instantly un-hides history).
 */
export const NOTIFICATION_TYPES = [
  { key: "portal_lead", label: "Portal leads", description: "A buyer submits their acquisition criteria on your marketplace" },
  { key: "portal_offer", label: "Portal offers", description: "A buyer submits an offer on a published listing" },
  { key: "email_reply", label: "Email replies", description: "A buyer replies to a deal email (Gmail/Outlook sync)" },
] as const;

async function mutedTypesFor(userId: string): Promise<string[]> {
  const pref = await prisma.notificationPreference.findUnique({ where: { userId } });
  return pref?.mutedTypes ?? [];
}

notificationsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const unreadOnly = req.query.unread === "1";
    const muted = await mutedTypesFor(req.user!.id);
    const mutedFilter = muted.length ? { type: { notIn: muted } } : {};
    const rows = await prisma.notification.findMany({
      where: { ...visibleWhere(req), ...mutedFilter, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const unread = await prisma.notification.count({ where: { ...visibleWhere(req), ...mutedFilter, readAt: null } });
    res.json({ notifications: rows, unread });
  }),
);

notificationsRouter.get(
  "/preferences",
  asyncHandler(async (req: AuthedRequest, res) => {
    const muted = await mutedTypesFor(req.user!.id);
    res.json({ types: NOTIFICATION_TYPES, mutedTypes: muted });
  }),
);

notificationsRouter.put(
  "/preferences",
  asyncHandler(async (req: AuthedRequest, res) => {
    const known = new Set(NOTIFICATION_TYPES.map((t) => t.key as string));
    const raw = (req.body as { mutedTypes?: unknown }).mutedTypes;
    if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string" || !known.has(t))) {
      throw new HttpError(400, "mutedTypes must be an array of known notification types");
    }
    const mutedTypes = [...new Set(raw as string[])];
    await prisma.notificationPreference.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, mutedTypes },
      update: { mutedTypes },
    });
    res.json({ ok: true, mutedTypes });
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
