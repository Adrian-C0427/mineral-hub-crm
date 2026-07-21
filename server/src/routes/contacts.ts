import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import type { Contact, User } from "@prisma/client";

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
