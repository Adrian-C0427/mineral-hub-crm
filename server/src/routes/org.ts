import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requireOrgOwner, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { generateInviteCode } from "../services/org.js";
import {
  ASSIGNABLE_ROLES, ALL_ROLES, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_META,
  OWNER_ONLY_ACTIONS, resolvePermissions, type OrgRole,
} from "../domain/permissions.js";

export const orgRouter = Router();
orgRouter.use(requireAuth, requireOrg);

// Current organization info (any member). Includes the caller's effective
// permissions so the UI can gate controls (server still enforces).
orgRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: orgId(req) },
      select: { id: true, name: true, teamId: true, createdAt: true, fullLogo: true, compactLogo: true },
    });
    const memberCount = await prisma.user.count({ where: { organizationId: orgId(req) } });
    res.json({ ...org, memberCount, yourRole: req.user!.orgRole, yourPermissions: req.user!.permissions });
  }),
);

// --- Company branding (logos) ---
// Logos are stored as data URLs (no object storage configured). Validate the
// declared MIME type and cap the encoded size so the org profile stays small.
const LOGO_MAX_BYTES = 512 * 1024; // ~512 KB decoded
const LOGO_MIME = /^data:image\/(png|svg\+xml|jpeg|jpg|webp);base64,/;
const logoField = z.string().refine(
  (s) => LOGO_MIME.test(s) && (s.length * 3) / 4 <= LOGO_MAX_BYTES,
  "Logo must be a PNG, SVG, JPG, or WebP under 512 KB",
).nullable();

orgRouter.patch(
  "/branding",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    // Each field is optional; provide a value to set, null to revert to default.
    const body = z.object({ fullLogo: logoField.optional(), compactLogo: logoField.optional() }).parse(req.body);
    const data: { fullLogo?: string | null; compactLogo?: string | null } = {};
    if (body.fullLogo !== undefined) data.fullLogo = body.fullLogo;
    if (body.compactLogo !== undefined) data.compactLogo = body.compactLogo;
    const org = await prisma.organization.update({
      where: { id: orgId(req) },
      data,
      select: { id: true, name: true, teamId: true, fullLogo: true, compactLogo: true },
    });
    res.json(org);
  }),
);

// --- Buyer Offering Portal settings -----------------------------------------
const portalSettingsSelect = {
  portalSlug: true, portalEnabled: true, portalContactName: true,
  portalContactEmail: true, portalContactPhone: true, portalOfficeLocation: true,
} as const;

orgRouter.get(
  "/portal-settings",
  requirePermission("managePortal"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = await prisma.organization.findUnique({ where: { id: orgId(req) }, select: portalSettingsSelect });
    res.json(org);
  }),
);

orgRouter.patch(
  "/portal-settings",
  requirePermission("managePortal"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z.object({
      enabled: z.boolean().optional(),
      // URL key for the public marketplace (/portal/:slug). Lowercase, url-safe.
      slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,60}$/, "3-60 chars: letters, numbers, dashes").optional(),
      contactName: z.string().trim().max(120).nullish(),
      contactEmail: z.string().trim().email().max(200).nullish().or(z.literal("").transform(() => null)),
      contactPhone: z.string().trim().max(40).nullish(),
      officeLocation: z.string().trim().max(200).nullish(),
    }).parse(req.body);
    const data: Record<string, unknown> = {};
    if (body.enabled !== undefined) data.portalEnabled = body.enabled;
    if (body.slug !== undefined) data.portalSlug = body.slug;
    if (body.contactName !== undefined) data.portalContactName = body.contactName;
    if (body.contactEmail !== undefined) data.portalContactEmail = body.contactEmail;
    if (body.contactPhone !== undefined) data.portalContactPhone = body.contactPhone;
    if (body.officeLocation !== undefined) data.portalOfficeLocation = body.officeLocation;
    try {
      const org = await prisma.organization.update({ where: { id: orgId(req) }, data, select: portalSettingsSelect });
      res.json(org);
    } catch (e) {
      // Unique violation on portalSlug — another org already claimed it.
      if (String(e).includes("portalSlug")) throw new HttpError(409, "That portal URL is already taken");
      throw e;
    }
  }),
);

// --- Buyer Portal contacts (multi-contact) ----------------------------------
// Optional headshot, same data-URL rules as the org logos but smaller.
const PHOTO_MAX_BYTES = 512 * 1024;
const photoField = z.string().refine(
  (s) => LOGO_MIME.test(s) && (s.length * 3) / 4 <= PHOTO_MAX_BYTES,
  "Photo must be a PNG, JPG, or WebP under 512 KB",
).nullable();

const contactSelect = {
  id: true, name: true, title: true, email: true, phone: true,
  department: true, photo: true, isPrimary: true, published: true, sortOrder: true,
} as const;

const contactOrder: Prisma.PortalContactOrderByWithRelationInput[] = [{ isPrimary: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }];

/**
 * One-time migration of the legacy single-contact org fields into a first
 * PortalContact row, so existing orgs keep their published contact when the
 * multi-contact UI first loads. Idempotent: only fires when the org has no
 * contacts yet and at least one legacy field is populated.
 */
async function backfillPortalContacts(organizationId: string): Promise<void> {
  const count = await prisma.portalContact.count({ where: { organizationId } });
  if (count > 0) return;
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { portalContactName: true, portalContactEmail: true, portalContactPhone: true, portalOfficeLocation: true },
  });
  if (!org) return;
  const name = org.portalContactName?.trim();
  if (!name && !org.portalContactEmail && !org.portalContactPhone) return;
  await prisma.portalContact.create({
    data: {
      organizationId,
      name: name || "Primary Contact",
      email: org.portalContactEmail,
      phone: org.portalContactPhone,
      department: org.portalOfficeLocation, // office location → department, closest existing field
      isPrimary: true, published: true, sortOrder: 0,
    },
  });
}

orgRouter.get(
  "/portal-contacts",
  requirePermission("managePortal"),
  asyncHandler(async (req: AuthedRequest, res) => {
    await backfillPortalContacts(orgId(req));
    const contacts = await prisma.portalContact.findMany({
      where: { organizationId: orgId(req) }, orderBy: contactOrder, select: contactSelect,
    });
    res.json(contacts);
  }),
);

const contactBodySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  title: z.string().trim().max(120).nullish(),
  email: z.string().trim().email().max(200).nullish().or(z.literal("").transform(() => null)),
  phone: z.string().trim().max(40).nullish(),
  department: z.string().trim().max(120).nullish(),
  photo: photoField.optional(),
  isPrimary: z.boolean().optional(),
  published: z.boolean().optional(),
});

orgRouter.post(
  "/portal-contacts",
  requirePermission("managePortal"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = contactBodySchema.parse(req.body);
    const org = orgId(req);
    const agg = await prisma.portalContact.aggregate({ where: { organizationId: org }, _max: { sortOrder: true }, _count: true });
    const isPrimary = body.isPrimary ?? agg._count === 0; // first contact is primary by default
    const contact = await prisma.$transaction(async (tx) => {
      if (isPrimary) await tx.portalContact.updateMany({ where: { organizationId: org }, data: { isPrimary: false } });
      return tx.portalContact.create({
        data: {
          organizationId: org,
          name: body.name, title: body.title ?? null, email: body.email ?? null,
          phone: body.phone ?? null, department: body.department ?? null, photo: body.photo ?? null,
          isPrimary, published: body.published ?? true,
          sortOrder: (agg._max.sortOrder ?? -1) + 1,
        },
        select: contactSelect,
      });
    });
    res.status(201).json(contact);
  }),
);

orgRouter.patch(
  "/portal-contacts/:id",
  requirePermission("managePortal"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = contactBodySchema.partial().parse(req.body);
    const org = orgId(req);
    const existing = await prisma.portalContact.findFirst({ where: { id: req.params.id, organizationId: org }, select: { id: true } });
    if (!existing) throw new HttpError(404, "Contact not found");
    const data: Record<string, unknown> = {};
    for (const k of ["name", "title", "email", "phone", "department", "photo", "published"] as const) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    const contact = await prisma.$transaction(async (tx) => {
      // Promoting to primary demotes the current primary; you cannot un-set the
      // only primary from here (designate another one instead).
      if (body.isPrimary === true) await tx.portalContact.updateMany({ where: { organizationId: org, id: { not: existing.id } }, data: { isPrimary: false } });
      if (body.isPrimary !== undefined) data.isPrimary = body.isPrimary;
      return tx.portalContact.update({ where: { id: existing.id }, data, select: contactSelect });
    });
    res.json(contact);
  }),
);

orgRouter.delete(
  "/portal-contacts/:id",
  requirePermission("managePortal"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const existing = await prisma.portalContact.findFirst({ where: { id: req.params.id, organizationId: org } });
    if (!existing) throw new HttpError(404, "Contact not found");
    await prisma.portalContact.delete({ where: { id: existing.id } });
    // If we removed the primary, promote the next contact so one always leads.
    if (existing.isPrimary) {
      const next = await prisma.portalContact.findFirst({ where: { organizationId: org }, orderBy: contactOrder, select: { id: true } });
      if (next) await prisma.portalContact.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    res.json({ ok: true });
  }),
);

// Persist a new display order (array of contact ids, top to bottom).
orgRouter.post(
  "/portal-contacts/reorder",
  requirePermission("managePortal"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { ids } = z.object({ ids: z.array(z.string()).max(200) }).parse(req.body);
    const org = orgId(req);
    const owned = await prisma.portalContact.findMany({ where: { organizationId: org }, select: { id: true } });
    const ownedIds = new Set(owned.map((c) => c.id));
    if (!ids.every((id) => ownedIds.has(id))) throw new HttpError(400, "Unknown contact in ordering");
    await prisma.$transaction(ids.map((id, i) => prisma.portalContact.update({ where: { id }, data: { sortOrder: i } })));
    const contacts = await prisma.portalContact.findMany({ where: { organizationId: org }, orderBy: contactOrder, select: contactSelect });
    res.json(contacts);
  }),
);

// Edit organization info (name).
orgRouter.patch(
  "/",
  requirePermission("manageOrgSettings"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name } = z.object({ name: z.string().trim().min(1, "Company name is required") }).parse(req.body);
    const org = await prisma.organization.update({
      where: { id: orgId(req) },
      data: { name },
      select: { id: true, name: true, teamId: true },
    });
    res.json(org);
  }),
);

// --- Members ---
orgRouter.get(
  "/members",
  requirePermission("manageMembers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const members = await prisma.user.findMany({
      where: { organizationId: orgId(req) },
      select: { id: true, name: true, email: true, phone: true, orgRole: true, status: true, lastActiveAt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(members);
  }),
);

const memberPatchSchema = z.object({
  // MANAGER is retired — no longer assignable (existing MANAGER users are
  // reassigned to one of these by the owner).
  orgRole: z.enum(["ADMIN", "MEMBER", "VIEWER"]).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});

// Change a member's role and/or activation status.
orgRouter.patch(
  "/members/:userId",
  requirePermission("manageMembers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { orgRole, status } = memberPatchSchema.parse(req.body);
    const target = await prisma.user.findFirst({ where: { id: req.params.userId, organizationId: orgId(req) } });
    if (!target) throw new HttpError(404, "Member not found in your organization");

    const callerIsOwner = req.user!.orgRole === "OWNER";
    if (target.id === req.user!.id && (orgRole || status)) {
      throw new HttpError(400, "You cannot change your own role or status");
    }
    // Only the owner can modify an owner, promote to admin, or (de)activate admins.
    if (target.orgRole === "OWNER" && !callerIsOwner) throw new HttpError(403, "Only the owner can modify the owner");
    if (orgRole === "ADMIN" && !callerIsOwner) throw new HttpError(403, "Only the owner can designate administrators");
    if (target.orgRole === "ADMIN" && !callerIsOwner) throw new HttpError(403, "Only the owner can modify administrators");

    const data: Record<string, unknown> = {};
    if (orgRole) data.orgRole = orgRole;
    if (status) data.status = status;
    const updated = await prisma.user.update({
      where: { id: target.id },
      data,
      select: { id: true, name: true, email: true, phone: true, orgRole: true, status: true, lastActiveAt: true },
    });
    res.json(updated);
  }),
);

orgRouter.delete(
  "/members/:userId",
  requirePermission("inviteRemoveUsers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.params.userId === req.user!.id) {
      throw new HttpError(400, "You cannot remove yourself from the organization");
    }
    const member = await prisma.user.findFirst({
      where: { id: req.params.userId, organizationId: orgId(req) },
    });
    if (!member) throw new HttpError(404, "Member not found in your organization");
    if (member.orgRole === "OWNER") throw new HttpError(403, "The organization owner cannot be removed");
    if (member.orgRole === "ADMIN" && req.user!.orgRole !== "OWNER") {
      throw new HttpError(403, "Only the owner can remove an administrator");
    }
    // Removing a member detaches them; their org-scoped records stay with the org.
    await prisma.user.update({
      where: { id: member.id },
      data: { organizationId: null, orgRole: null },
    });
    res.json({ ok: true });
  }),
);

// --- Roles & permissions ---
orgRouter.get(
  "/roles",
  requireOrgOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    const overrides = await prisma.rolePermissions.findMany({ where: { organizationId: orgId(req) } });
    const overrideMap = new Map(overrides.map((o) => [o.role, o.permissions]));
    const roles = ALL_ROLES.map((role) => ({
      role,
      // OWNER is always all-permissions and not editable.
      permissions: resolvePermissions(role, role === "OWNER" ? null : overrideMap.get(role) ?? null),
      defaults: role === "OWNER" ? [...PERMISSIONS] : DEFAULT_ROLE_PERMISSIONS[role],
      editable: role !== "OWNER",
      customized: overrideMap.has(role),
    }));
    res.json({
      roles,
      permissions: PERMISSIONS.map((key) => ({ key, ...PERMISSION_META[key] })),
      ownerOnlyActions: OWNER_ONLY_ACTIONS,
    });
  }),
);

/**
 * SECURITY guards for role customization: a non-owner with manageRoles must
 * not be able to (a) rewrite their OWN role's permission set (self-escalation)
 * or (b) touch the ADMIN role (designating/limiting administrators is an
 * owner-only concern, mirroring the member-management rules).
 */
function assertCanEditRole(req: AuthedRequest, role: OrgRole): void {
  if (req.user!.orgRole === "OWNER") return;
  if (role === req.user!.orgRole) {
    throw new HttpError(403, "You cannot change your own role's permissions");
  }
  if (role === "ADMIN") {
    throw new HttpError(403, "Only the organization owner can change administrator permissions");
  }
}

orgRouter.patch(
  "/roles/:role",
  requireOrgOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    const role = req.params.role as OrgRole;
    if (!ASSIGNABLE_ROLES.includes(role)) throw new HttpError(400, "That role cannot be customized");
    assertCanEditRole(req, role);
    const { permissions } = z.object({ permissions: z.array(z.string()) }).parse(req.body);
    // Only known permission keys are stored; owner-only actions are not part of
    // PERMISSIONS so they can never be granted here.
    const clean = permissions.filter((p) => (PERMISSIONS as readonly string[]).includes(p));
    const saved = await prisma.rolePermissions.upsert({
      where: { organizationId_role: { organizationId: orgId(req), role } },
      create: { organizationId: orgId(req), role, permissions: clean },
      update: { permissions: clean },
    });
    res.json({ role: saved.role, permissions: saved.permissions });
  }),
);

// Reset a role to its code-defined defaults (removes the override row).
orgRouter.delete(
  "/roles/:role",
  requireOrgOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    const role = req.params.role as OrgRole;
    if (!ASSIGNABLE_ROLES.includes(role)) throw new HttpError(400, "That role cannot be customized");
    assertCanEditRole(req, role);
    await prisma.rolePermissions.deleteMany({ where: { organizationId: orgId(req), role } });
    res.json({ ok: true, role, permissions: DEFAULT_ROLE_PERMISSIONS[role] });
  }),
);

// --- Ownership transfer (owner only) ---
orgRouter.post(
  "/transfer-ownership",
  requireOrgOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    if (userId === req.user!.id) throw new HttpError(400, "You already own this organization");
    const target = await prisma.user.findFirst({ where: { id: userId, organizationId: orgId(req) } });
    if (!target) throw new HttpError(404, "Member not found in your organization");
    // Atomic swap: promote target to OWNER, demote current owner to ADMIN.
    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { orgRole: "OWNER" } }),
      prisma.user.update({ where: { id: req.user!.id }, data: { orgRole: "ADMIN" } }),
    ]);
    res.json({ ok: true });
  }),
);

// --- Invite codes ---
orgRouter.get(
  "/invites",
  requirePermission("inviteRemoveUsers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const invites = await prisma.inviteCode.findMany({
      where: { organizationId: orgId(req) },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      invites.map((i) => ({
        id: i.id,
        code: i.code,
        reusable: i.reusable,
        active: i.active,
        maxUses: i.maxUses,
        uses: i.uses,
        createdAt: i.createdAt,
      })),
    );
  }),
);

const createInviteSchema = z.object({
  reusable: z.boolean().default(false),
  maxUses: z.number().int().positive().nullish(),
});

orgRouter.post(
  "/invites",
  requirePermission("inviteRemoveUsers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { reusable, maxUses } = createInviteSchema.parse(req.body);
    const invite = await prisma.inviteCode.create({
      data: {
        organizationId: orgId(req),
        code: await generateInviteCode(),
        reusable,
        // Single-use codes are capped at 1; reusable codes honor an optional cap.
        maxUses: reusable ? maxUses ?? null : 1,
        createdByUserId: req.user!.id,
      },
    });
    res.status(201).json(invite);
  }),
);

orgRouter.patch(
  "/invites/:id",
  requirePermission("inviteRemoveUsers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const invite = await prisma.inviteCode.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
    });
    if (!invite) throw new HttpError(404, "Invite code not found");
    const updated = await prisma.inviteCode.update({ where: { id: invite.id }, data: { active } });
    res.json(updated);
  }),
);

orgRouter.delete(
  "/invites/:id",
  requirePermission("inviteRemoveUsers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const invite = await prisma.inviteCode.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
    });
    if (!invite) throw new HttpError(404, "Invite code not found");
    await prisma.inviteCode.delete({ where: { id: invite.id } });
    res.json({ ok: true });
  }),
);
