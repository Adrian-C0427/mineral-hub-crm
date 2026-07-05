import { Router } from "express";
import { z } from "zod";
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
  orgRole: z.enum(["ADMIN", "MANAGER", "MEMBER", "VIEWER"]).optional(),
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
  requirePermission("manageRoles"),
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
  requirePermission("manageRoles"),
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
  requirePermission("manageRoles"),
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
