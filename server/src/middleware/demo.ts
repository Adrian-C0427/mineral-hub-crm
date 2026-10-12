import type { Response, NextFunction } from "express";
import type { AuthedRequest } from "./auth.js";

/**
 * Demo guard — the public showcase workspace (Organization.isDemo).
 *
 * Prospects share one login, so the demo must stay presentable for the next
 * visitor and must never reach anything real. Demo users can browse and use
 * the app normally (create and edit deals, buyers, tasks, offers…; the
 * dataset is reseeded nightly), but these are refused server-side:
 *   - deleting records (single or bulk),
 *   - integrations, organization/team/role/invite settings, user management,
 *   - account security (password, 2FA, profile email), joining other orgs,
 *   - file uploads and cloud imports, CSV imports,
 *   - writes to the shared Research / map reference data (read from another
 *     org — see researchOrgId), shapefile imports,
 *   - AI generation (billed per call).
 * Outbound email is suppressed separately (services/email.ts), so "send" flows
 * still work end to end without delivering anything.
 *
 * Reads (GET/HEAD/OPTIONS) always pass. Non-demo users are never affected.
 */

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const DELETE_MESSAGE = "Deleting is turned off in the demo workspace. Feel free to create and edit instead — the demo resets every night.";
const SETTINGS_MESSAGE = "This setting is locked in the demo workspace.";
const UPLOAD_MESSAGE = "Uploading and importing files is turned off in the demo workspace.";
const REFERENCE_MESSAGE = "Research and map data are read-only in the demo workspace.";
const AI_MESSAGE = "AI drafting is turned off in the demo workspace.";

/** DELETEs a demo user may still make: their own notifications and saved table layouts. */
const DELETE_ALLOWED = [/^\/api\/notifications(\/|$)/, /^\/api\/auth\/table-prefs\//];

/** Mutations a demo user may make under otherwise-locked prefixes. */
const AUTH_ALLOWED = [/^\/api\/auth\/logout$/, /^\/api\/auth\/table-prefs\//, /^\/api\/auth\/preferences$/];
const RESEARCH_ALLOWED = [/^\/api\/research\/relationships\/transactions$/, /^\/api\/research\/buyers\/(preview|commit)$/];

const BLOCKED: { test: RegExp; message: string }[] = [
  { test: /^\/api\/integrations(\/|$)/, message: SETTINGS_MESSAGE },
  { test: /^\/api\/org(\/|$)/, message: SETTINGS_MESSAGE },
  { test: /^\/api\/users(\/|$)/, message: SETTINGS_MESSAGE },
  { test: /^\/api\/ai(\/|$)/, message: AI_MESSAGE },
  { test: /^\/api\/import(\/|$)/, message: UPLOAD_MESSAGE },
  { test: /^\/api\/(buyers|contacts)\/import(\/|$)/, message: UPLOAD_MESSAGE },
  { test: /^\/api\/wells\/import\//, message: UPLOAD_MESSAGE },
  { test: /^\/api\/files\/?$/, message: UPLOAD_MESSAGE },
  { test: /^\/api\/files\/[^/]+\/replace$/, message: UPLOAD_MESSAGE },
  { test: /^\/api\/files\/cloud\//, message: UPLOAD_MESSAGE },
  { test: /^\/api\/map\/tracts\/import$/, message: REFERENCE_MESSAGE },
  { test: /^\/api\/(deals|buyers|contacts)\/bulk-delete$/, message: DELETE_MESSAGE },
];

/**
 * The path as Express ROUTES it, in the form the policy matches. Express
 * matches routes case-insensitively and tolerates trailing slashes, so
 * "/API/Org/invites/" reaches the same handler as "/api/org/invites" — the
 * policy must see them as the same path too, or the guard is bypassed.
 */
function normalizePath(path: string): string {
  const p = path.toLowerCase().replace(/\/{2,}/g, "/");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * Why a demo user's request is refused, or null when it may proceed. Pure, so
 * the policy is unit-tested directly. `path` is the URL path (no query).
 */
export function demoBlockReason(method: string, path: string, body?: unknown): string | null {
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return null;
  const p = normalizePath(path);

  if (m === "DELETE") return DELETE_ALLOWED.some((r) => r.test(p)) ? null : DELETE_MESSAGE;

  if (/^\/api\/auth(\/|$)/.test(p)) return AUTH_ALLOWED.some((r) => r.test(p)) ? null : SETTINGS_MESSAGE;
  if (/^\/api\/research(\/|$)/.test(p)) return RESEARCH_ALLOWED.some((r) => r.test(p)) ? null : REFERENCE_MESSAGE;

  for (const b of BLOCKED) if (b.test.test(p)) return b.message;

  // Bulk endpoints that take an action in the body (expenses: delete | reimburse | …).
  if (/\/bulk$/.test(p) && body && typeof body === "object" && (body as { action?: unknown }).action === "delete") {
    return DELETE_MESSAGE;
  }
  return null;
}

export function demoGuard(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user?.isDemo) return next();
  // baseUrl + path is the parsed pathname Express routes on. originalUrl is the
  // raw request target, which can be absolute-form ("http://host/api/…") and
  // would then match none of the policy's /api patterns.
  const reason = demoBlockReason(req.method, req.baseUrl + req.path, req.body);
  if (!reason) return next();
  res.status(403).json({ error: reason, demo: true });
}

/**
 * Router-level backstop for the locked areas: refuses every non-read request
 * from a demo user whatever URL spelling reached the router, so the lock does
 * not rest on demoGuard's path matching alone. No-op for everyone else.
 */
export function demoReadOnly(message: string = SETTINGS_MESSAGE) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user?.isDemo || READ_METHODS.has(req.method.toUpperCase())) return next();
    res.status(403).json({ error: message, demo: true });
  };
}

/** Same backstop for a single route (account security, uploads). */
export function forbidDemo(message: string = SETTINGS_MESSAGE) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user?.isDemo) return next();
    res.status(403).json({ error: message, demo: true });
  };
}

export const DEMO_MESSAGES = { SETTINGS: SETTINGS_MESSAGE, UPLOAD: UPLOAD_MESSAGE, AI: AI_MESSAGE } as const;
