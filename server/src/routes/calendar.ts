import { Router } from "express";
import { z } from "zod";
import type { CalendarEventType } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { canViewContacts, taskOwnerWhere, taskVisibilityWhere } from "./dashboard.js";
import {
  COLOR_RE, STARTER_TYPES, TIME_RE, closingEntries, dayKeyInRange, eventEntry, eventTimeError, followUpEntry,
  nextTypeColor, parseCalendarRange, parseDayKey, sortEntries, taskEntry, type CalEntry, type LinkVisibility,
} from "../domain/calendar.js";

/**
 * Calendar. Hand-entered events live in CalendarEvent; deal closings, buyer
 * follow-ups and contact tasks/reminders are read live from their own tables
 * and returned alongside as read-only entries (nothing is copied or written
 * outside the two calendar tables).
 */
export const calendarRouter = Router();
// Any member of the organization can read the calendar.
calendarRouter.use(requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const typeOrder = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }, { id: "asc" as const }];

/**
 * The org's event types, creating the starter set the first time it is asked
 * for. Two first requests can race, and the table has no unique key to lean
 * on, so the create runs inside a transaction that first takes a per-org
 * advisory lock and then re-checks: the loser of the race waits, sees the
 * winner's rows, and creates nothing.
 */
async function ensureTypes(org: string): Promise<CalendarEventType[]> {
  const existing = await prisma.calendarEventType.findMany({ where: { organizationId: org }, orderBy: typeOrder });
  if (existing.length > 0) return existing;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`calendar-types:${org}`}))`;
    const again = await tx.calendarEventType.findMany({ where: { organizationId: org }, orderBy: typeOrder });
    if (again.length > 0) return again;
    await tx.calendarEventType.createMany({
      data: STARTER_TYPES.map((t, i) => ({ organizationId: org, name: t.name, color: t.color, systemKey: t.systemKey, sortOrder: i })),
    });
    return tx.calendarEventType.findMany({ where: { organizationId: org }, orderBy: typeOrder });
  });
}

const serializeType = (t: CalendarEventType, eventCount: number) => ({
  id: t.id, name: t.name, color: t.color, sortOrder: t.sortOrder, systemKey: t.systemKey, eventCount,
});

const colorField = z.string().regex(COLOR_RE).transform((c) => c.toUpperCase());
const nameField = z.string().trim().min(1).max(60);

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const eventInclude = {
  deal: { select: { id: true, name: true } },
  buyer: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
} as const;

/** Seeing deals (and so their closings and buyer follow-ups) needs "View deals". */
function canViewDeals(req: AuthedRequest): boolean {
  return req.user?.orgRole === "OWNER" || (req.user?.permissions ?? []).includes("viewDeals");
}

/** Which event links the caller may see by name. */
function linkVisibility(req: AuthedRequest): LinkVisibility {
  return {
    deals: canViewDeals(req),
    buyers: req.user?.orgRole === "OWNER" || (req.user?.permissions ?? []).includes("viewBuyers"),
  };
}

// The deals the Deals list shows: top-level opportunities, plus owned assets
// that are being sold. "Archived" deals are the DEAD stage.
const LISTED_DEALS = {
  parentDealId: null,
  OR: [{ recordType: "OPPORTUNITY" as const }, { recordType: "OWNED_ASSET" as const, assetMode: "SELL" as const }],
};

calendarRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const range = parseCalendarRange(req.query.from, req.query.to);
    if (!range.ok) throw new HttpError(400, range.error);
    const inRange = { gte: range.from, lt: range.endExclusive };
    // Whose tasks/reminders: all users (default), `me`, or one user id — the
    // same choices, and the same owner rule, as the Tasks widget.
    const tasksFor = z.string().min(1).max(200).default("all").parse(req.query.tasksFor);
    const can = linkVisibility(req);
    const seeDeals = can.deals;

    const types = await ensureTypes(org);
    const closingTypeId = types.find((t) => t.systemKey === "closing")?.id ?? null;
    const followTypeId = types.find((t) => t.systemKey === "follow")?.id ?? null;

    const [counts, events, deals, followUps, tasks] = await Promise.all([
      prisma.calendarEvent.groupBy({ by: ["typeId"], where: { organizationId: org, typeId: { not: null } }, _count: { _all: true } }),
      prisma.calendarEvent.findMany({ where: { organizationId: org, date: inRange }, include: eventInclude }),
      // Final Closing is derived (Original + 15 days unless overridden), so the
      // range is applied after resolving it rather than in the query.
      seeDeals
        ? prisma.deal.findMany({
            where: {
              organizationId: org, stage: { not: "DEAD" }, ...LISTED_DEALS,
              AND: [{ OR: [{ originalClosingDate: { not: null } }, { finalClosingDateOverride: { not: null } }] }],
            },
            select: {
              id: true, name: true, stage: true, dateUnderContract: true, originalClosingDate: true,
              findBuyerByDateOverride: true, finalClosingDateOverride: true, daysToClose: true,
            },
          })
        : [],
      seeDeals
        ? prisma.dealBuyerActivity.findMany({
            where: { nextFollowUpDate: inRange, deal: { organizationId: org, stage: { notIn: ["CLOSED", "DEAD"] } } },
            select: {
              id: true, nextFollowUpDate: true,
              deal: { select: { id: true, name: true, stage: true } },
              buyer: { select: { name: true } },
              assignedTeamMember: { select: { id: true, name: true } },
            },
          })
        : [],
      prisma.contactActivity.findMany({
        where: {
          organizationId: org, kind: { in: ["TASK", "REMINDER"] }, completedAt: null, dueDate: inRange,
          AND: [taskOwnerWhere(req.user!.id, tasksFor), taskVisibilityWhere(req.user!.id, canViewContacts(req))],
        },
        select: {
          id: true, kind: true, title: true, body: true, dueDate: true, completedAt: true,
          assignedTo: { select: { id: true, name: true } },
          contact: { select: { id: true, firstName: true, lastName: true, entityName: true } },
        },
      }),
    ]);

    const countOf = new Map(counts.map((c) => [c.typeId, c._count._all]));
    const entries: CalEntry[] = [
      ...events.map((e) => eventEntry(e, can)),
      ...deals.flatMap((d) => closingEntries(d, closingTypeId)).filter((e) => dayKeyInRange(e.date, range.fromKey, range.toKey)),
      ...followUps.map((f) => followUpEntry(f, followTypeId)).filter((e): e is CalEntry => e !== null),
      ...tasks.map((t) => taskEntry(t, followTypeId)).filter((e): e is CalEntry => e !== null),
    ];
    res.json({ types: types.map((t) => serializeType(t, countOf.get(t.id) ?? 0)), events: sortEntries(entries) });
  }),
);

// ---------------------------------------------------------------------------
// Events (hand-entered) — gated like editing a deal
// ---------------------------------------------------------------------------

const idField = z.string().min(1).max(200).nullable();
const timeField = z.string().regex(TIME_RE).nullable();
const eventFields = {
  title: z.string().trim().min(1).max(200),
  typeId: idField,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  allDay: z.boolean(),
  start: timeField,
  end: timeField,
  dealId: idField,
  buyerId: idField,
  assignedToId: idField,
  notes: z.string().trim().max(4000).nullable(),
};
const createEventSchema = z.object({
  ...eventFields,
  typeId: idField.optional(), start: timeField.optional(), end: timeField.optional(),
  dealId: idField.optional(), buyerId: idField.optional(), assignedToId: idField.optional(), notes: eventFields.notes.optional(),
});
const patchEventSchema = z.object(eventFields).partial().extend({ done: z.boolean().optional() });

/** Every id an event points at must belong to the caller's organization. */
async function assertRefsInOrg(org: string, refs: { typeId?: string | null; dealId?: string | null; buyerId?: string | null; assignedToId?: string | null }) {
  const [type, deal, buyer, user] = await Promise.all([
    refs.typeId ? prisma.calendarEventType.findFirst({ where: { id: refs.typeId, organizationId: org }, select: { id: true } }) : true,
    refs.dealId ? prisma.deal.findFirst({ where: { id: refs.dealId, organizationId: org }, select: { id: true } }) : true,
    refs.buyerId ? prisma.buyer.findFirst({ where: { id: refs.buyerId, organizationId: org }, select: { id: true } }) : true,
    refs.assignedToId ? prisma.user.findFirst({ where: { id: refs.assignedToId, organizationId: org }, select: { id: true } }) : true,
  ]);
  if (!type) throw new HttpError(400, "Event type not found");
  if (!deal) throw new HttpError(400, "Deal not found");
  if (!buyer) throw new HttpError(400, "Buyer not found");
  if (!user) throw new HttpError(400, "Assignee is not in your organization");
}

calendarRouter.post(
  "/events",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const data = createEventSchema.parse(req.body);
    const date = parseDayKey(data.date);
    if (!date) throw new HttpError(400, "Enter a valid date");
    const start = data.allDay ? null : data.start ?? null;
    const end = data.allDay ? null : data.end ?? null;
    const timeError = eventTimeError({ allDay: data.allDay, start, end });
    if (timeError) throw new HttpError(400, timeError);
    if (data.dealId && data.buyerId) throw new HttpError(400, "Link an event to a deal or a buyer, not both");
    await assertRefsInOrg(org, data);
    const created = await prisma.calendarEvent.create({
      data: {
        organizationId: org, title: data.title, typeId: data.typeId ?? null, date, allDay: data.allDay, startTime: start, endTime: end,
        dealId: data.dealId ?? null, buyerId: data.buyerId ?? null, assignedToId: data.assignedToId ?? null,
        notes: data.notes || null, createdByUserId: req.user!.id,
      },
      include: eventInclude,
    });
    res.status(201).json(eventEntry(created, linkVisibility(req)));
  }),
);

calendarRouter.patch(
  "/events/:id",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const existing = await prisma.calendarEvent.findFirst({ where: { id: req.params.id, organizationId: org } });
    if (!existing) throw new HttpError(404, "Event not found");
    const data = patchEventSchema.parse(req.body);

    let date: Date | undefined;
    if (data.date !== undefined) {
      const d = parseDayKey(data.date);
      if (!d) throw new HttpError(400, "Enter a valid date");
      date = d;
    }
    // Time rules apply to the event as it will be saved, not just the fields sent.
    const allDay = data.allDay ?? existing.allDay;
    const start = allDay ? null : data.start !== undefined ? data.start : existing.startTime;
    const end = allDay ? null : data.end !== undefined ? data.end : existing.endTime;
    const timeError = eventTimeError({ allDay, start, end });
    if (timeError) throw new HttpError(400, timeError);

    // One link at most: choosing a deal drops a previous buyer link, and vice versa.
    if (data.dealId && data.buyerId) throw new HttpError(400, "Link an event to a deal or a buyer, not both");
    let dealId = data.dealId, buyerId = data.buyerId;
    if (dealId && buyerId === undefined) buyerId = null;
    if (buyerId && dealId === undefined) dealId = null;
    // A link the caller cannot see is sent back to them as "no link", so the
    // form would save it as null and silently unlink it. Leave it as it is.
    const can = linkVisibility(req);
    if ((existing.dealId && !can.deals) || (existing.buyerId && !can.buyers)) {
      dealId = undefined;
      buyerId = undefined;
    }

    await assertRefsInOrg(org, { ...data, dealId, buyerId });
    const updated = await prisma.calendarEvent.update({
      where: { id: existing.id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.typeId !== undefined ? { typeId: data.typeId } : {}),
        ...(date ? { date } : {}),
        allDay, startTime: start, endTime: end,
        ...(dealId !== undefined ? { dealId } : {}),
        ...(buyerId !== undefined ? { buyerId } : {}),
        ...(data.assignedToId !== undefined ? { assignedToId: data.assignedToId } : {}),
        ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
        // Re-marking a done event keeps its original completion time.
        ...(data.done !== undefined ? { completedAt: data.done ? existing.completedAt ?? new Date() : null } : {}),
      },
      include: eventInclude,
    });
    res.json(eventEntry(updated, can));
  }),
);

calendarRouter.delete(
  "/events/:id",
  requirePermission("editDeals"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { count } = await prisma.calendarEvent.deleteMany({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (count === 0) throw new HttpError(404, "Event not found");
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Types — gated like pipeline / stage settings
// ---------------------------------------------------------------------------

calendarRouter.post(
  "/types",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const data = z.object({ name: nameField, color: colorField.nullish() }).parse(req.body);
    const types = await ensureTypes(org);
    const created = await prisma.calendarEventType.create({
      data: {
        organizationId: org, name: data.name,
        color: data.color ?? nextTypeColor(types.map((t) => t.color)),
        sortOrder: types.reduce((m, t) => Math.max(m, t.sortOrder), -1) + 1,
      },
    });
    res.status(201).json(serializeType(created, 0));
  }),
);

calendarRouter.patch(
  "/types/:id",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const data = z.object({ name: nameField.optional(), color: colorField.optional(), sortOrder: z.number().int().min(0).max(10_000).optional() }).parse(req.body);
    const existing = await prisma.calendarEventType.findFirst({ where: { id: req.params.id, organizationId: org }, select: { id: true } });
    if (!existing) throw new HttpError(404, "Event type not found");
    const updated = await prisma.calendarEventType.update({ where: { id: existing.id }, data });
    const eventCount = await prisma.calendarEvent.count({ where: { organizationId: org, typeId: updated.id } });
    res.json(serializeType(updated, eventCount));
  }),
);

// Removing a type keeps its events: they fall back to no type ("Other").
calendarRouter.delete(
  "/types/:id",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const existing = await prisma.calendarEventType.findFirst({ where: { id: req.params.id, organizationId: org }, select: { id: true } });
    if (!existing) throw new HttpError(404, "Event type not found");
    // An org with no types at all is read as "never set up" and would get the
    // starter set back on its next visit, so the last one stays.
    const remaining = await prisma.calendarEventType.count({ where: { organizationId: org } });
    if (remaining <= 1) throw new HttpError(400, "Keep at least one event type");
    await prisma.calendarEventType.delete({ where: { id: existing.id } });
    res.status(204).end();
  }),
);
