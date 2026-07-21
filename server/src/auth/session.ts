import jwt from "jsonwebtoken";
import type { Response } from "express";
import { env } from "../config.js";

export interface SessionPayload {
  userId: string;
  role: "OWNER" | "ASSOCIATE";
  /**
   * The user's sessionEpoch at issue time. attachUser compares this against the
   * current column and rejects the token if it's behind, so a password change
   * invalidates every outstanding session.
   *
   * Optional on the way IN: tokens minted before this field existed carry no
   * epoch, and User.sessionEpoch defaults to 0 — so they normalize to 0 and keep
   * working until their natural expiry rather than mass-logging-out on deploy.
   */
  epoch?: number;
}

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: `${env.SESSION_TTL_HOURS}h` });
}

export function verifySession(token: string): Required<SessionPayload> | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload & SessionPayload;
    if (!decoded.userId || !decoded.role) return null;
    return { userId: decoded.userId, role: decoded.role, epoch: decoded.epoch ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Cross-subdomain Railway services are cross-origin from the browser's view, so
 * the cookie must be SameSite=None; Secure in production. Lax silently breaks auth.
 */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(env.COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.COOKIE_CROSS_SITE, // must be true when SameSite=None
    sameSite: env.COOKIE_CROSS_SITE ? "none" : "lax",
    maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(env.COOKIE_NAME, {
    httpOnly: true,
    secure: env.COOKIE_CROSS_SITE,
    sameSite: env.COOKIE_CROSS_SITE ? "none" : "lax",
    path: "/",
  });
}
