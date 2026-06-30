import type { Request, Response, NextFunction } from "express";
import { env } from "../config.js";
import { verifySession } from "../auth/session.js";
import { prisma } from "../db.js";

export interface AuthedRequest extends Request {
  user?: { id: string; role: "OWNER" | "ASSOCIATE"; name: string; email: string };
}

/**
 * Populates req.user from the session cookie if valid. Does not block.
 */
export async function attachUser(req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[env.COOKIE_NAME];
  if (token) {
    const session = verifySession(token);
    if (session) {
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (user && user.status === "ACTIVE") {
        req.user = { id: user.id, role: user.role, name: user.name, email: user.email };
      }
    }
  }
  next();
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
