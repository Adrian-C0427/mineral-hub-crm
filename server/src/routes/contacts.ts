import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import type { Contact, ContactActivity, User } from "@prisma/client";

/**
 * Acquisitions — Contacts.
 *
 * The sourcing side of the CRM: sellers, prospects, and inbound leads. This
 * router is the module's foundation; outreach campaigns, follow-up sequences,
 * and lead-to-deal conversion will extend it (new endpoints/columns) without
 * structural change. Type/status are string keys validated against the
 * catalogs below — extend the arrays to add workflow states.
 */

export const contactsRouter = Router();
contactsRouter.use(requireAuth, requireOrg);

export const CONTACT_TYPES = ["SELLER", "PROSPECT", "LEAD", "REFERRAL", "OTHER"] as const;
export const CONTACT_STATUSES = ["NEW", "CONTACTED", "ENGAGED", "NEGOTIATING", "CONVERTED", "NOT_INTERESTED"] as const;

type ContactWithOwner = Contact & { owner: Pick<User, "id" | "name"> | null };

const serialize = (c: ContactWithOwner) => ({
  id: c.id,
  firstName: c.firstName,
  lastName: c.lastName,
  name: `${c.firstName} ${c.lastName}`.trim(),
  entityName: c.entityName,
  type: c.type,
  status: c.status,
  source: c.source,
  email: c.email,
  phone: c.phone,
  states: c.states,
  counties: c.counties,
  notes: c.notes,
  tags: c.tags,
  owner: c.owner ? { id: c.owner.id, name: c.owner.name } : null,
  lastContactedAt: c.lastContactedAt,
  nextFollowUpDate: c.nextFollowUpDate,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const dateField = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish()
  .transform((v) => (v ? new Date(v.length === 10 ? `${v}T00:00:00Z` : v) : null));

const upsertSchema = z.object({
  firstName: z.string().trim().min(1).max(200),
  lastName: z.string().trim().min(1).max(200),
  entityName: z.string().trim().max(300).nullish(),
  type: z.enum(CONTACT_TYPES).optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  source: z.string().trim().max(300).nullish(),
  email: z.string().trim().email().max(320).nullish().or(z.literal("").transform(() => null)),
  phone: z.string().trim().max(50).nullish(),
  states: z.array(z.string().max(50)).max(100).optional(),
  counties: z.array(z.string().max(200)).max(500).optional(),
  notes: z.string().max(10_000).nullish(),
  tags: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
  ownerId: z.string().max(200).nullish(),
  lastContactedAt: dateField,
  nextFollowUpDate: dateField,
});

async function validateOwner(org: string, ownerId: string | null | undefined): Promise<string | null> {
  if (!ownerId) return null;
  const u = await prisma.user.findFirst({ where: { id: ownerId, organizationId: org } });
  if (!u) throw new HttpError(400, "Owner must be a member of your organization");
  return u.id;
}

const ownerInclude = { owner: { select: { id: true, name: true } } } as const;

/** All contacts (org-scoped). Filtering/search is client-side for now. */
contactsRouter.get(
  "/",
  requirePermission("viewContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.contact.findMany({
      where: { organizationId: orgId(req) },
      include: ownerInclude,
      orderBy: { createdAt: "desc" },
    });
    res.json(rows.map(serialize));
  }),
);

contactsRouter.post(
  "/",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = upsertSchema.parse(req.body);
    const ownerId = await validateOwner(orgId(req), data.ownerId);
    const created = await prisma.contact.create({
      data: {
        organizationId: orgId(req),
        firstName: data.firstName,
        lastName: data.lastName,
        entityName: data.entityName ?? null,
        type: data.type ?? "PROSPECT",
        status: data.status ?? "NEW",
        source: data.source ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        states: data.states ?? [],
        counties: data.counties ?? [],
        notes: data.notes ?? null,
        tags: data.tags ?? [],
        ownerId,
        lastContactedAt: data.lastContactedAt,
        nextFollowUpDate: data.nextFollowUpDate,
      },
      include: ownerInclude,
    });
    res.status(201).json(serialize(created));
  }),
);

contactsRouter.patch(
  "/:id",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const existing = await prisma.contact.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) throw new HttpError(404, "Contact not found");
    const data = upsertSchema.partial().parse(req.body);
    const ownerId = data.ownerId !== undefined ? await validateOwner(orgId(req), data.ownerId) : undefined;
    const updated = await prisma.contact.update({
      where: { id: existing.id },
      data: {
        ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
        ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
        ...(data.entityName !== undefined ? { entityName: data.entityName ?? null } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.source !== undefined ? { source: data.source ?? null } : {}),
        ...(data.email !== undefined ? { email: data.email ?? null } : {}),
        ...(data.phone !== undefined ? { phone: data.phone ?? null } : {}),
        ...(data.states !== undefined ? { states: data.states } : {}),
        ...(data.counties !== undefined ? { counties: data.counties } : {}),
        ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
        ...(data.tags !== undefined ? { tags: data.tags } : {}),
        ...(ownerId !== undefined ? { ownerId } : {}),
        ...(data.lastContactedAt !== undefined ? { lastContactedAt: data.lastContactedAt } : {}),
        ...(data.nextFollowUpDate !== undefined ? { nextFollowUpDate: data.nextFollowUpDate } : {}),
      },
      include: ownerInclude,
    });
    res.json(serialize(updated));
  }),
);

contactsRouter.delete(
  "/:id",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const existing = await prisma.contact.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!existing) throw new HttpError(404, "Contact not found");
    await prisma.contact.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Contact activities — the workspace timeline: internal notes, logged calls /
// emails / texts, tasks, and reminders.
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ["NOTE", "CALL", "EMAIL", "SMS", "TASK", "REMINDER"] as const;
export const CALL_DISPOSITIONS = ["Connected", "No Answer", "Voicemail", "Bad Number", "Callback Requested"] as const;

type ActivityWithAuthor = ContactActivity & { createdBy: Pick<User, "id" | "name"> | null };
const serializeActivity = (a: ActivityWithAuthor) => ({
  id: a.id,
  kind: a.kind,
  body: a.body,
  disposition: a.disposition,
  durationSeconds: a.durationSeconds,
  dueDate: a.dueDate,
  completedAt: a.completedAt,
  pinned: a.pinned,
  createdBy: a.createdBy ? { id: a.createdBy.id, name: a.createdBy.name } : null,
  createdAt: a.createdAt,
});

const authorInclude = { createdBy: { select: { id: true, name: true } } } as const;

async function findContact(org: string, id: string): Promise<Contact> {
  const c = await prisma.contact.findFirst({ where: { id, organizationId: org } });
  if (!c) throw new HttpError(404, "Contact not found");
  return c;
}

/** Single contact (workspace header + detail pane). */
contactsRouter.get(
  "/:id",
  requirePermission("viewContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const c = await prisma.contact.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, include: ownerInclude });
    if (!c) throw new HttpError(404, "Contact not found");
    res.json(serialize(c));
  }),
);

contactsRouter.get(
  "/:id/activities",
  requirePermission("viewContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const c = await findContact(orgId(req), req.params.id);
    const rows = await prisma.contactActivity.findMany({
      where: { contactId: c.id },
      include: authorInclude,
      orderBy: { createdAt: "asc" },
    });
    res.json(rows.map(serializeActivity));
  }),
);

const activitySchema = z.object({
  kind: z.enum(ACTIVITY_KINDS),
  body: z.string().trim().min(1).max(10_000),
  disposition: z.enum(CALL_DISPOSITIONS).nullish(),
  durationSeconds: z.number().int().min(0).max(86_400).nullish(),
  dueDate: dateField,
});

contactsRouter.post(
  "/:id/activities",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const c = await findContact(orgId(req), req.params.id);
    const data = activitySchema.parse(req.body);
    const created = await prisma.contactActivity.create({
      data: {
        organizationId: orgId(req),
        contactId: c.id,
        kind: data.kind,
        body: data.body,
        disposition: data.kind === "CALL" ? data.disposition ?? null : null,
        durationSeconds: data.kind === "CALL" ? data.durationSeconds ?? null : null,
        dueDate: data.kind === "TASK" || data.kind === "REMINDER" ? data.dueDate : null,
        createdById: req.user?.id ?? null,
      },
      include: authorInclude,
    });
    // Logged outreach naturally advances "last contacted".
    if (data.kind === "CALL" || data.kind === "EMAIL" || data.kind === "SMS") {
      await prisma.contact.update({ where: { id: c.id }, data: { lastContactedAt: new Date() } });
    }
    res.status(201).json(serializeActivity(created));
  }),
);

// Toggle completion (tasks) / pin, or edit the body.
contactsRouter.patch(
  "/:id/activities/:aid",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const c = await findContact(orgId(req), req.params.id);
    const existing = await prisma.contactActivity.findFirst({ where: { id: req.params.aid, contactId: c.id } });
    if (!existing) throw new HttpError(404, "Activity not found");
    const data = z.object({
      body: z.string().trim().min(1).max(10_000).optional(),
      completed: z.boolean().optional(),
      pinned: z.boolean().optional(),
      dueDate: dateField.optional(),
    }).parse(req.body);
    const updated = await prisma.contactActivity.update({
      where: { id: existing.id },
      data: {
        ...(data.body !== undefined ? { body: data.body } : {}),
        ...(data.completed !== undefined ? { completedAt: data.completed ? new Date() : null } : {}),
        ...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
        ...(data.dueDate !== undefined ? { dueDate: data.dueDate } : {}),
      },
      include: authorInclude,
    });
    res.json(serializeActivity(updated));
  }),
);

contactsRouter.delete(
  "/:id/activities/:aid",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const c = await findContact(orgId(req), req.params.id);
    const existing = await prisma.contactActivity.findFirst({ where: { id: req.params.aid, contactId: c.id } });
    if (!existing) throw new HttpError(404, "Activity not found");
    await prisma.contactActivity.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);
