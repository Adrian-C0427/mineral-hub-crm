import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/password.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import crypto from "node:crypto";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { normalizePhone } from "../domain/phone.js";

export const usersRouter = Router();

usersRouter.use(requireAuth, requireOrg);

usersRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    // Users within the caller's organization (for owner-attribution dropdowns),
    // never password hashes.
    const users = await prisma.user.findMany({
      where: { organizationId: orgId(req) },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
      orderBy: { name: "asc" },
    });
    res.json(users);
  }),
);

/**
 * SECURITY: these mutating routes are authorized by the RBAC permission
 * system (orgRole + RolePermissions), NOT the legacy account Role — the
 * legacy role was historically "OWNER" for every signup and must never
 * grant access. Target guards mirror routes/org.ts: only the org owner
 * may touch the owner or administrators.
 */
function assertCanTouchTarget(req: AuthedRequest, target: { id: string; orgRole: string | null }): void {
  const callerIsOrgOwner = req.user!.orgRole === "OWNER";
  if (target.orgRole === "OWNER" && target.id !== req.user!.id) {
    throw new HttpError(403, "Only the organization owner can modify the owner's account");
  }
  if (target.orgRole === "ADMIN" && !callerIsOrgOwner && target.id !== req.user!.id) {
    throw new HttpError(403, "Only the organization owner can modify an administrator");
  }
}

// Account creation requires all profile fields.
const createSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  phone: z.string().trim().min(1, "Phone number is required").transform(normalizePhone),
  email: z.string().email(),
  password: z.string().min(8),
});

usersRouter.post(
  "/",
  requirePermission("manageMembers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = createSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
    if (exists) throw new HttpError(409, "A user with that email already exists");
    const user = await prisma.user.create({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        name: `${data.firstName} ${data.lastName}`,
        email: data.email.toLowerCase(),
        passwordHash: await hashPassword(data.password),
        // New accounts always start as standard members; promotion happens
        // through the org member-management routes, never at creation.
        role: "ASSOCIATE",
        organizationId: orgId(req),
        orgRole: "MEMBER",
      },
      select: { id: true, name: true, email: true, role: true, status: true },
    });
    res.status(201).json(user);
  }),
);

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  password: z.string().min(8).optional(),
});

usersRouter.patch(
  "/:id",
  requirePermission("manageMembers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = updateSchema.parse(req.body);
    const target = await prisma.user.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!target) throw new HttpError(404, "User not found in your organization");
    assertCanTouchTarget(req, target);
    // Resetting someone else's password is an owner-only action (self-service
    // password changes go through PATCH /auth/me).
    if (data.password && target.id !== req.user!.id && req.user!.orgRole !== "OWNER") {
      throw new HttpError(403, "Only the organization owner can reset another user's password");
    }
    const patch: Record<string, unknown> = {};
    if (data.name) patch.name = data.name;
    if (data.status) patch.status = data.status;
    if (data.password) patch.passwordHash = await hashPassword(data.password);
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: patch,
      select: { id: true, name: true, email: true, role: true, status: true },
    });
    res.json(user);
  }),
);

/**
 * Owner-only password reset for another user. Either generates a temporary
 * password or sets one the owner supplies; the affected user must change it at
 * next login (mustChangePassword). Returns the temporary password once so the
 * owner can relay it.
 */
const resetPasswordSchema = z
  .object({
    mode: z.enum(["temp", "manual"]),
    password: z.string().min(8, "Password must be at least 8 characters").optional(),
  })
  .refine((d) => d.mode === "temp" || (d.password && d.password.length >= 8), {
    message: "A new password (min 8 characters) is required for manual mode",
    path: ["password"],
  });

/** Readable temporary password, e.g. "Mineral-7f3a92". */
function generateTempPassword(): string {
  return `Mineral-${crypto.randomBytes(4).toString("hex")}`;
}

usersRouter.post(
  "/:id/reset-password",
  asyncHandler(async (req: AuthedRequest, res) => {
    // Available only to the organization owner.
    if (req.user!.orgRole !== "OWNER") throw new HttpError(403, "Only the organization owner can reset another user's password");
    const { mode, password } = resetPasswordSchema.parse(req.body);
    const target = await prisma.user.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!target) throw new HttpError(404, "User not found in your organization");
    if (target.id === req.user!.id) throw new HttpError(400, "Use your account settings to change your own password");

    const temporaryPassword = mode === "temp" ? generateTempPassword() : password!;
    await prisma.user.update({
      where: { id: target.id },
      data: { passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true },
    });
    // Only echo a generated temp password; never echo an owner-supplied one back.
    res.json({ ok: true, ...(mode === "temp" ? { temporaryPassword } : {}) });
  }),
);

usersRouter.delete(
  "/:id",
  requirePermission("inviteRemoveUsers"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.params.id === req.user!.id) throw new HttpError(400, "You cannot delete your own account");
    const target = await prisma.user.findFirst({ where: { id: req.params.id, organizationId: orgId(req) } });
    if (!target) throw new HttpError(404, "User not found in your organization");
    if (target.orgRole === "OWNER") throw new HttpError(403, "The organization owner cannot be deleted");
    if (target.orgRole === "ADMIN" && req.user!.orgRole !== "OWNER") {
      throw new HttpError(403, "Only the organization owner can delete an administrator");
    }
    // Detach the member rather than hard-deleting the account: their org-scoped
    // records (deals, activity, documents) stay attributed to the org instead of
    // being null'd/cascade-deleted. Mirrors DELETE /org/members/:userId.
    await prisma.user.update({
      where: { id: req.params.id },
      data: { organizationId: null, orgRole: null },
    });
    res.json({ ok: true });
  }),
);
