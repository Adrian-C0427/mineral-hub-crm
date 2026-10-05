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

export function visibleWhere(req: AuthedRequest) {
  // Gate on the RBAC field (orgRole), NOT the legacy per-account `role` — that
  // field was historically OWNER for every workspace creator and stays OWNER
  // even after a demotion, so it must never grant admin-level visibility.
  //
  // ADMIN counts alongside OWNER, as the comment on this router always said it
  // did: untargeted rows (userId null) are the unassigned portal leads, and the
  // promise is that they always reach someone. Checking OWNER alone meant an
  // org whose owner was inactive silently accumulated leads no one could see.
  // ADMIN holds every permission by default (DEFAULT_ROLE_PERMISSIONS), so this
  // grants no visibility that role didn't already have everywhere else.
  //
  // A shared row someone has cleared stays visible to everyone else who sees it.
  const me = req.user!.id;
  const admin = req.user!.orgRole === "OWNER" || req.user!.orgRole === "ADMIN";
  return {
    organizationId: orgId(req),
    OR: admin ? [{ userId: me }, { userId: null, NOT: { hiddenForUserIds: { has: me } } }] : [{ userId: me }],
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
  { key: "email_reply", label: "Email replies", description: "A buyer replies to a deal email (Outlook inbox sync)" },
  { key: "deal_overdue", label: "Overdue deals", description: "An active deal passes its Find Buyer By date with no buyer selected" },
  { key: "follow_up_due", label: "Follow-up reminders", description: "A scheduled buyer follow-up date arrives" },
  { key: "task_due", label: "Task reminders", description: "A task you're assigned reaches its due date (or is overdue)" },
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
    // Who else has cleared a shared row is not the caller's business.
    res.json({ notifications: rows.map(({ hiddenForUserIds: _hidden, ...n }) => n), unread });
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

/**
 * Clearing, scoped by the same visibility rule as reading. A row targeted at
 * the caller is deleted. An untargeted row (userId null) is one shared row for
 * every admin/owner, so it is only hidden for the caller: deleting it would
 * take an unassigned portal lead out of everyone else's bell before they saw
 * it. (Read state stays shared, as before.)
 */
notificationsRouter.delete(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    // "Clear all" clears what the bell lists: muted types are hidden there, so
    // they are left alone (un-muting a type still brings its history back).
    // ?read=1 keeps the unread ones.
    const readOnly = req.query.read === "1";
    const muted = await mutedTypesFor(req.user!.id);
    const mutedFilter = muted.length ? { type: { notIn: muted } } : {};
    const me = req.user!.id;
    const where = { ...visibleWhere(req), ...mutedFilter, ...(readOnly ? { readAt: { not: null } } : {}) };
    const [own, shared] = await prisma.$transaction([
      prisma.notification.deleteMany({ where: { AND: [where, { userId: me }] } }),
      prisma.notification.updateMany({ where: { AND: [where, { userId: null }] }, data: { hiddenForUserIds: { push: me } } }),
    ]);
    res.json({ ok: true, cleared: own.count + shared.count });
  }),
);

notificationsRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    // deleteMany / updateMany so the org + visibility scope is part of the write itself.
    const me = req.user!.id;
    const where = { id: req.params.id, ...visibleWhere(req) };
    let { count } = await prisma.notification.deleteMany({ where: { AND: [where, { userId: me }] } });
    if (!count) {
      ({ count } = await prisma.notification.updateMany({ where: { AND: [where, { userId: null }] }, data: { hiddenForUserIds: { push: me } } }));
    }
    if (!count) throw new HttpError(404, "Notification not found");
    res.json({ ok: true });
  }),
);
