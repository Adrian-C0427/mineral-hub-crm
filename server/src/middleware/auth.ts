import type { Request, Response, NextFunction } from "express";
import { env } from "../config.js";
import { verifySession } from "../auth/session.js";
import { prisma } from "../db.js";
import { resolvePermissions, type OrgRole, type Permission } from "../domain/permissions.js";

export interface AuthedRequest extends Request {
  user?: {
    id: string;
    role: "OWNER" | "ASSOCIATE";
    name: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    organizationId: string | null;
    orgRole: OrgRole | null;
    permissions: Permission[];
    mustChangePassword: boolean;
  };
}

// Refresh lastActiveAt at most this often, to avoid a write on every request.
const ACTIVITY_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Populates req.user from the session token if valid. Does not block.
 * Also resolves the caller's effective permissions and (throttled) updates
 * their last-activity timestamp.
 */
export async function attachUser(req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> {
  // Prefer the Authorization: Bearer header (works cross-site; not blocked like
  // third-party cookies on public-suffix hosts such as *.up.railway.app).
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
  const token = bearer || req.cookies?.[env.COOKIE_NAME];
  if (token) {
    const session = verifySession(token);
    if (session) {
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (user && user.status === "ACTIVE") {
        // Effective permissions = role defaults merged with any org override.
        let permissions: Permission[] = [];
        if (user.organizationId && user.orgRole) {
          const override = await prisma.rolePermissions.findUnique({
            where: { organizationId_role: { organizationId: user.organizationId, role: user.orgRole } },
            select: { permissions: true },
          });
          permissions = resolvePermissions(user.orgRole as OrgRole, override?.permissions ?? null);
        }
        req.user = {
          id: user.id,
          role: user.role,
          name: user.name,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          organizationId: user.organizationId,
          orgRole: user.orgRole as OrgRole | null,
          permissions,
          mustChangePassword: user.mustChangePassword,
        };

        // Throttled last-activity update (fire-and-forget).
        const stale = !user.lastActiveAt || Date.now() - user.lastActiveAt.getTime() > ACTIVITY_THROTTLE_MS;
        if (stale) {
          prisma.user
            .update({ where: { id: user.id }, data: { lastActiveAt: new Date() } })
            .catch(() => {});
        }
      }
    }
  }
  next();
}

/**
 * Permission gate — enforced SERVER-SIDE. OWNER passes everything. Others must
 * hold the named permission (role defaults + org overrides, resolved in
 * attachUser).
 */
export function requirePermission(permission: Permission) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (req.user.orgRole === "OWNER" || req.user.permissions.includes(permission)) {
      next();
      return;
    }
    res.status(403).json({ error: "You do not have permission to perform this action" });
  };
}

/** Hard auth gate. 401 if not logged in. */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

/**
 * Role gate — enforced SERVER-SIDE (never just hidden in UI).
 * Owner-only actions: deleting records, managing users.
 */
export function requireOwner(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (req.user.role !== "OWNER") {
    res.status(403).json({ error: "Owner role required for this action" });
    return;
  }
  next();
}

/**
 * Requires the user to belong to an organization, and exposes it as
 * req.orgId for scoping. All record routes use this.
 */
export function requireOrg(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (!req.user.organizationId) {
    res.status(403).json({ error: "You must belong to an organization" });
    return;
  }
  next();
}

/** Organization-owner gate: managing members and invite codes. */
export function requireOrgOwner(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (!req.user.organizationId || req.user.orgRole !== "OWNER") {
    res.status(403).json({ error: "Only the organization owner can perform this action" });
    return;
  }
  next();
}

/** Convenience: the caller's organization id (throws-safe after requireOrg). */
export function orgId(req: AuthedRequest): string {
  return req.user!.organizationId as string;
}
