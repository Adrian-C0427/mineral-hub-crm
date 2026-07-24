import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { parse } from "csv-parse/sync";
import { LIST_LIMIT, MAX_CSV_CHARS } from "../config.js";
import type { Contact, ContactActivity, ContactList, User } from "@prisma/client";

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

type ContactWithOwner = Contact & { owner: Pick<User, "id" | "name"> | null; lists?: { id: string }[] };

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
  listIds: (c.lists ?? []).map((l) => l.id),
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

const ownerInclude = { owner: { select: { id: true, name: true } }, lists: { select: { id: true } } } as const;

/** All contacts (org-scoped). Filtering/search is client-side for now. */
contactsRouter.get(
  "/",
  requirePermission("viewContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.contact.findMany({
      where: { organizationId: orgId(req) },
      include: ownerInclude,
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
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

export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;

type ActivityWithAuthor = ContactActivity & {
  createdBy: Pick<User, "id" | "name"> | null;
  assignedTo: Pick<User, "id" | "name"> | null;
};
const serializeActivity = (a: ActivityWithAuthor) => ({
  id: a.id,
  kind: a.kind,
  title: a.title,
  body: a.body,
  disposition: a.disposition,
  durationSeconds: a.durationSeconds,
  dueDate: a.dueDate,
  completedAt: a.completedAt,
  priority: a.priority,
  assignedTo: a.assignedTo ? { id: a.assignedTo.id, name: a.assignedTo.name } : null,
  pinned: a.pinned,
  createdBy: a.createdBy ? { id: a.createdBy.id, name: a.createdBy.name } : null,
  createdAt: a.createdAt,
});

const authorInclude = {
  createdBy: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
} as const;

/** Validate an (optional) task assignee is a member of this organization. */
async function checkAssignee(org: string, userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const u = await prisma.user.findFirst({ where: { id: userId, organizationId: org }, select: { id: true } });
  if (!u) throw new HttpError(400, "Assignee is not in your organization");
}

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
  title: z.string().trim().min(1).max(200).nullish(),
  body: z.string().trim().min(1).max(10_000),
  disposition: z.enum(CALL_DISPOSITIONS).nullish(),
  durationSeconds: z.number().int().min(0).max(86_400).nullish(),
  dueDate: dateField,
  priority: z.enum(TASK_PRIORITIES).nullish(),
  assignedToId: z.string().nullish(),
});

contactsRouter.post(
  "/:id/activities",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const c = await findContact(orgId(req), req.params.id);
    const data = activitySchema.parse(req.body);
    const isDated = data.kind === "TASK" || data.kind === "REMINDER";
    // Notes, tasks, and reminders carry a required concise title above the
    // detailed note; quick call/email/text logs stay single-field.
    if ((data.kind === "NOTE" || isDated) && !data.title) throw new HttpError(400, "Title is required");
    await checkAssignee(orgId(req), data.assignedToId);
    const created = await prisma.contactActivity.create({
      data: {
        organizationId: orgId(req),
        contactId: c.id,
        kind: data.kind,
        title: data.title ?? null,
        body: data.body,
        disposition: data.kind === "CALL" ? data.disposition ?? null : null,
        durationSeconds: data.kind === "CALL" ? data.durationSeconds ?? null : null,
        dueDate: isDated ? data.dueDate : null,
        priority: data.kind === "TASK" ? data.priority ?? "MEDIUM" : null,
        assignedToId: isDated ? data.assignedToId ?? req.user?.id ?? null : null,
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
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().trim().min(1).max(10_000).optional(),
      completed: z.boolean().optional(),
      pinned: z.boolean().optional(),
      dueDate: dateField.optional(),
      priority: z.enum(TASK_PRIORITIES).nullish(),
      assignedToId: z.string().nullish().optional(),
    }).parse(req.body);
    if (data.assignedToId !== undefined) await checkAssignee(orgId(req), data.assignedToId);
    const updated = await prisma.contactActivity.update({
      where: { id: existing.id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.body !== undefined ? { body: data.body } : {}),
        ...(data.completed !== undefined ? { completedAt: data.completed ? new Date() : null } : {}),
        ...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
        ...(data.dueDate !== undefined ? { dueDate: data.dueDate } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        ...(data.assignedToId !== undefined ? { assignedToId: data.assignedToId } : {}),
      },
      include: authorInclude,
    });
    // Completing a task retires its due-alert from every bell immediately.
    if (data.completed) {
      await prisma.notification.deleteMany({
        where: { organizationId: orgId(req), type: "task_due", link: { contains: `task=${existing.id}` } },
      });
    }
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

// ---------------------------------------------------------------------------
// Contact lists — reusable named groupings (m2m membership, computed counts).
// Collection lives at "/lists/all" (two segments) so it can never collide with
// the single-segment "GET /:id" contact route registered above.
// ---------------------------------------------------------------------------

const listInclude = { _count: { select: { members: true } } } as const;
type ListWithCount = ContactList & { _count: { members: number } };
const serializeList = (l: ListWithCount) => ({ id: l.id, name: l.name, count: l._count.members, createdAt: l.createdAt });

contactsRouter.get(
  "/lists/all",
  requirePermission("viewContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.contactList.findMany({ where: { organizationId: orgId(req) }, include: listInclude, orderBy: { name: "asc" } });
    res.json(rows.map(serializeList));
  }),
);

contactsRouter.post(
  "/lists/all",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    const dupe = await prisma.contactList.findFirst({ where: { organizationId: orgId(req), name } });
    if (dupe) throw new HttpError(400, "A list with that name already exists");
    const created = await prisma.contactList.create({ data: { organizationId: orgId(req), name }, include: listInclude });
    res.status(201).json(serializeList(created));
  }),
);

contactsRouter.patch(
  "/lists/:listId",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    const l = await prisma.contactList.findFirst({ where: { id: req.params.listId, organizationId: orgId(req) } });
    if (!l) throw new HttpError(404, "List not found");
    const updated = await prisma.contactList.update({ where: { id: l.id }, data: { name }, include: listInclude });
    res.json(serializeList(updated));
  }),
);

contactsRouter.delete(
  "/lists/:listId",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const l = await prisma.contactList.findFirst({ where: { id: req.params.listId, organizationId: orgId(req) } });
    if (!l) throw new HttpError(404, "List not found");
    await prisma.contactList.delete({ where: { id: l.id } }); // membership rows cascade
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

const idsSchema = z.object({ ids: z.array(z.string().max(200)).min(1).max(10_000) });

/** Resolve the caller's ids to contacts THEY own (org-scoped). */
async function ownedIds(org: string, ids: string[]): Promise<string[]> {
  const rows = await prisma.contact.findMany({ where: { id: { in: ids }, organizationId: org }, select: { id: true } });
  return rows.map((r) => r.id);
}

contactsRouter.post(
  "/bulk-delete",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { ids } = idsSchema.parse(req.body);
    const mine = await ownedIds(orgId(req), ids);
    await prisma.contact.deleteMany({ where: { id: { in: mine } } });
    res.json({ ok: true, deleted: mine.length });
  }),
);

// Bulk edit: apply any provided field to every selected contact (status
// updates, team-member assignment, type/source/follow-up changes).
contactsRouter.post(
  "/bulk-update",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = idsSchema.extend({
      status: z.enum(CONTACT_STATUSES).optional(),
      type: z.enum(CONTACT_TYPES).optional(),
      ownerId: z.string().max(200).nullish(),
      source: z.string().trim().max(300).nullish(),
      nextFollowUpDate: dateField.optional(),
      addTags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    }).parse(req.body);
    const mine = await ownedIds(orgId(req), data.ids);
    const ownerId = data.ownerId !== undefined ? await validateOwner(orgId(req), data.ownerId) : undefined;
    const patch: Record<string, unknown> = {
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.type !== undefined ? { type: data.type } : {}),
      ...(ownerId !== undefined ? { ownerId } : {}),
      ...(data.source !== undefined ? { source: data.source ?? null } : {}),
      ...(data.nextFollowUpDate !== undefined ? { nextFollowUpDate: data.nextFollowUpDate } : {}),
    };
    if (Object.keys(patch).length) await prisma.contact.updateMany({ where: { id: { in: mine } }, data: patch });
    if (data.addTags?.length) {
      // Tag merge must be per-row (array union).
      const rows = await prisma.contact.findMany({ where: { id: { in: mine } }, select: { id: true, tags: true } });
      await prisma.$transaction(rows.map((r) =>
        prisma.contact.update({ where: { id: r.id }, data: { tags: [...new Set([...r.tags, ...data.addTags!])] } })));
    }
    res.json({ ok: true, updated: mine.length });
  }),
);

// Bulk add/remove list memberships.
contactsRouter.post(
  "/bulk-lists",
  requirePermission("manageContacts"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = idsSchema.extend({
      addListIds: z.array(z.string().max(200)).max(100).optional(),
      removeListIds: z.array(z.string().max(200)).max(100).optional(),
    }).parse(req.body);
    const org = orgId(req);
    const mine = await ownedIds(org, data.ids);
    const validLists = await prisma.contactList.findMany({
      where: { id: { in: [...(data.addListIds ?? []), ...(data.removeListIds ?? [])] }, organizationId: org },
      select: { id: true },
    });
    const valid = new Set(validLists.map((l) => l.id));
    const add = (data.addListIds ?? []).filter((i) => valid.has(i));
    const remove = (data.removeListIds ?? []).filter((i) => valid.has(i));
    await prisma.$transaction(mine.map((id) =>
      prisma.contact.update({
        where: { id },
        data: {
          lists: {
            ...(add.length ? { connect: add.map((i) => ({ id: i })) } : {}),
            ...(remove.length ? { disconnect: remove.map((i) => ({ id: i })) } : {}),
          },
        },
      })));
    res.json({ ok: true, updated: mine.length });
  }),
);

// ---------------------------------------------------------------------------
// CSV import: analyze (headers + suggested mapping) → preview (dedupe classes)
// → commit (insert new, fill-in-update duplicates, report errors).
// ---------------------------------------------------------------------------

const CONTACT_IMPORT_FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: "firstName", label: "First Name", required: true },
  { key: "lastName", label: "Last Name", required: true },
  { key: "entityName", label: "Company / Entity" },
  { key: "type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "source", label: "Source" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "states", label: "State(s)" },
  { key: "counties", label: "County(ies)" },
  { key: "tags", label: "Tags" },
  { key: "notes", label: "Notes" },
];

const MAX_CONTACT_IMPORT_ROWS = 20_000;

/**
 * Raw-body ceiling, applied BEFORE the parse. MAX_CONTACT_IMPORT_ROWS bounds the
 * result, but it can only be checked once csv-parse has already materialised
 * every record — so without this the row cap was paid for by parsing whatever
 * fit inside the 25 MB JSON body limit first. Matches the cap the other three
 * importers already apply (routes/import.ts, wells.ts, research.ts).
 */
const csvField = z.string().min(1).max(MAX_CSV_CHARS, "CSV file is too large");

/**
 * Import replays are the heaviest thing `manageContacts` can trigger: a full
 * parse plus a scan of every contact in the org. /analyze and /preview write
 * nothing, so they are free for the caller to repeat — cap them. Mounted on the
 * import paths only, so ordinary contact CRUD is unaffected.
 */
const importLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many import requests. Wait a few minutes and try again." },
});

function parseContactsCsv(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
  if (records.length > MAX_CONTACT_IMPORT_ROWS) {
    throw new HttpError(400, `This file has too many rows (${records.length}). Split it into files of ${MAX_CONTACT_IMPORT_ROWS.toLocaleString()} rows or fewer.`);
  }
  return { headers: records.length ? Object.keys(records[0]) : [], rows: records };
}

/** Split into fixed-size batches so a large import never builds one giant statement. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const splitMulti = (v: string): string[] => v.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
const normPhone = (v: string): string => v.replace(/\D/g, "");

function buildContact(row: Record<string, string>, mapping: Record<string, string>) {
  const get = (f: string): string => (mapping[f] ? (row[mapping[f]] ?? "").trim() : "");
  const type = get("type").toUpperCase().replace(/\s+/g, "_");
  const status = get("status").toUpperCase().replace(/\s+/g, "_");
  return {
    firstName: get("firstName"),
    lastName: get("lastName"),
    entityName: get("entityName") || null,
    type: (CONTACT_TYPES as readonly string[]).includes(type) ? type : "PROSPECT",
    status: (CONTACT_STATUSES as readonly string[]).includes(status) ? status : "NEW",
    source: get("source") || null,
    email: get("email").toLowerCase() || null,
    phone: get("phone") || null,
    states: mapping.states ? splitMulti(get("states")).map((s) => s.toUpperCase()) : [],
    counties: mapping.counties ? splitMulti(get("counties")) : [],
    tags: mapping.tags ? splitMulti(get("tags")) : [],
    notes: get("notes") || null,
  };
}

contactsRouter.post(
  "/import/analyze",
  requirePermission("manageContacts"),
  importLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { csv } = z.object({ csv: csvField }).parse(req.body);
    const { headers, rows } = parseContactsCsv(csv);
    const suggestedMapping: Record<string, string> = {};
    const SYNONYMS: Record<string, string[]> = {
      firstName: ["first name", "firstname", "first"],
      lastName: ["last name", "lastname", "last", "surname"],
      entityName: ["company", "entity", "trust", "organization"],
      type: ["type", "contact type"],
      status: ["status", "stage"],
      source: ["source", "lead source"],
      email: ["email", "e-mail", "email address"],
      phone: ["phone", "phone number", "mobile", "cell"],
      states: ["state", "states"],
      counties: ["county", "counties"],
      tags: ["tags", "labels"],
      notes: ["notes", "comments"],
    };
    for (const f of CONTACT_IMPORT_FIELDS) {
      const hit = headers.find((h) => {
        const n = h.toLowerCase().trim();
        return n === f.key.toLowerCase() || (SYNONYMS[f.key] ?? []).includes(n);
      });
      if (hit) suggestedMapping[f.key] = hit;
    }
    res.json({ headers, fields: CONTACT_IMPORT_FIELDS, suggestedMapping, rowCount: rows.length });
  }),
);

/** Classify each row: New / Duplicate (existing contact matched) / Error. */
async function classifyContactRows(org: string, csv: string, mapping: Record<string, string>) {
  const { rows } = parseContactsCsv(csv);
  const existing = await prisma.contact.findMany({
    where: { organizationId: org },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  });
  const byEmail = new Map<string, string>();
  const byNamePhone = new Map<string, string>();
  for (const c of existing) {
    if (c.email) byEmail.set(c.email.toLowerCase(), c.id);
    if (c.phone) byNamePhone.set(`${c.firstName.toLowerCase()}|${c.lastName.toLowerCase()}|${normPhone(c.phone)}`, c.id);
  }
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const c = buildContact(row, mapping);
    if (!c.firstName || !c.lastName) {
      return { index, status: "Error" as const, reason: "Missing first or last name", contact: c, matchId: null };
    }
    const emailKey = c.email ?? "";
    const npKey = c.phone ? `${c.firstName.toLowerCase()}|${c.lastName.toLowerCase()}|${normPhone(c.phone)}` : "";
    const fileKey = emailKey || npKey || `${c.firstName.toLowerCase()}|${c.lastName.toLowerCase()}`;
    if (seen.has(fileKey)) {
      return { index, status: "Error" as const, reason: "Duplicate row within this file", contact: c, matchId: null };
    }
    seen.add(fileKey);
    const matchId = (emailKey && byEmail.get(emailKey)) || (npKey && byNamePhone.get(npKey)) || null;
    if (matchId) return { index, status: "Duplicate" as const, reason: emailKey && byEmail.get(emailKey) ? "Email matches an existing contact" : "Name + phone match an existing contact", contact: c, matchId };
    return { index, status: "New" as const, reason: "", contact: c, matchId: null };
  });
}

contactsRouter.post(
  "/import/preview",
  requirePermission("manageContacts"),
  importLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { csv, mapping } = z.object({ csv: csvField, mapping: z.record(z.string()) }).parse(req.body);
    const classified = await classifyContactRows(orgId(req), csv, mapping);
    res.json({
      rows: classified.slice(0, 500).map((r) => ({
        index: r.index, status: r.status, reason: r.reason,
        name: `${r.contact.firstName} ${r.contact.lastName}`.trim(), email: r.contact.email, phone: r.contact.phone,
      })),
      counts: {
        new: classified.filter((r) => r.status === "New").length,
        duplicate: classified.filter((r) => r.status === "Duplicate").length,
        error: classified.filter((r) => r.status === "Error").length,
      },
    });
  }),
);

contactsRouter.post(
  "/import/commit",
  requirePermission("manageContacts"),
  importLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { csv, mapping, updateDuplicates, listId } = z.object({
      csv: csvField,
      mapping: z.record(z.string()),
      // When true, matched duplicates get blank fields filled in (never
      // overwriting existing data) and are counted as "updated".
      updateDuplicates: z.boolean().optional(),
      // Optionally drop every imported (new + updated) contact into a list.
      listId: z.string().max(200).nullish(),
    }).parse(req.body);
    const org = orgId(req);
    const classified = await classifyContactRows(org, csv, mapping);
    const list = listId ? await prisma.contactList.findFirst({ where: { id: listId, organizationId: org } }) : null;

    const errors = classified.filter((r) => r.status === "Error").length;
    const toInsert = classified.filter((r) => r.status === "New");
    const toUpdate = updateDuplicates
      ? classified.filter((r): r is typeof r & { matchId: string } => r.status === "Duplicate" && Boolean(r.matchId))
      : [];
    const skipped = classified.filter((r) => r.status === "Duplicate").length - toUpdate.length;

    // All-or-nothing, and batched. The previous shape fired one create per row
    // (plus a findUnique + update per duplicate) sequentially and outside any
    // transaction, so a file at the 20,000-row ceiling issued tens of thousands
    // of round trips on a single request and a mid-run failure left the import
    // half-applied with no way to roll back. The generous timeout mirrors
    // routes/import.ts: a legitimate large file needs longer than Prisma's 5s
    // interactive default, which a few thousand rows blow straight through.
    const touched: string[] = [];
    let inserted = 0, updated = 0;
    await prisma.$transaction(async (tx) => {
      // One batched read of the duplicates being filled in, replacing the
      // findUnique that previously ran once per duplicate row. Inside the
      // transaction so each merge below is computed from the row it writes to,
      // and scoped to the org so a matchId can never reach across tenants.
      const existingById = new Map(
        toUpdate.length
          ? (await tx.contact.findMany({ where: { organizationId: org, id: { in: toUpdate.map((r) => r.matchId) } } }))
            .map((c) => [c.id, c] as const)
          : [],
      );

      for (const batch of chunk(toInsert, 1000)) {
        // createManyAndReturn (Postgres) gets the ids back in one statement —
        // they are needed below to add every imported contact to the list.
        const rows = await tx.contact.createManyAndReturn({
          data: batch.map((r) => ({ organizationId: org, ...r.contact })),
          select: { id: true },
        });
        inserted += rows.length;
        for (const row of rows) touched.push(row.id);
      }
      for (const r of toUpdate) {
        const ex = existingById.get(r.matchId);
        if (!ex) continue;
        await tx.contact.update({
          where: { id: ex.id },
          data: {
            entityName: ex.entityName ?? r.contact.entityName,
            source: ex.source ?? r.contact.source,
            email: ex.email ?? r.contact.email,
            phone: ex.phone ?? r.contact.phone,
            notes: ex.notes ?? r.contact.notes,
            states: ex.states.length ? ex.states : r.contact.states,
            counties: ex.counties.length ? ex.counties : r.contact.counties,
            tags: [...new Set([...ex.tags, ...r.contact.tags])],
          },
        });
        updated++; touched.push(ex.id);
      }
      if (list && touched.length) {
        for (const ids of chunk(touched, 1000)) {
          await tx.contactList.update({ where: { id: list.id }, data: { members: { connect: ids.map((id) => ({ id })) } } });
        }
      }
    }, { maxWait: 10_000, timeout: 5 * 60_000 });

    res.json({ inserted, updated, skipped, errors });
  }),
);
