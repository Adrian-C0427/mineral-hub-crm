import type { Response, NextFunction } from "express";
import type { AuthedRequest } from "./auth.js";

/**
 * Demo guard — the public showcase workspace (Organization.isDemo).
 *
 * Prospects share one login, so the demo must stay presentable for the next
 * visitor and must never reach anything real. Demo users can browse and use
 * the app normally (create and edit deals, buyers, tasks, offers…; the
 * dataset is reseeded nightly).
 *
 * DENY BY DEFAULT: a demo user's write (any method but GET/HEAD/OPTIONS) is
 * refused unless it matches DEMO_WRITE_ALLOWLIST below. A route added later is
 * therefore locked for the demo until someone decides otherwise — and
 * demo.routes.test.ts walks every route the app registers, so that decision is
 * made explicitly in review rather than by accident. Locked, among others:
 *   - deleting records (single or bulk),
 *   - integrations, organization/team/role/invite settings, user management,
 *   - account security (password, 2FA, profile email), joining other orgs,
 *   - file uploads and cloud imports, CSV imports,
 *   - writes to the shared Research / map reference data (read from another
 *     org — see researchOrgId), shapefile imports,
 *   - AI generation (billed per call).
 * Outbound email is suppressed separately (services/email.ts), so "send" flows
 * still work end to end without delivering anything; the demo org's public
 * portal answers only demo sessions (routes/portal.ts), so nothing a visitor
 * writes is ever served to the public.
 *
 * Reads always pass. Non-demo users are never affected.
 */

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const DELETE_MESSAGE = "Deleting is turned off in the demo workspace. Feel free to create and edit instead — the demo resets every night.";
const SETTINGS_MESSAGE = "This setting is locked in the demo workspace.";
const UPLOAD_MESSAGE = "Uploading and importing files is turned off in the demo workspace.";
const REFERENCE_MESSAGE = "Research and map data are read-only in the demo workspace.";
const AI_MESSAGE = "AI drafting is turned off in the demo workspace.";
const LIVE_ONLY_MESSAGE = "SMS performance and HighLevel are available in live workspaces only.";
const DEFAULT_MESSAGE = "This action is turned off in the demo workspace.";

/**
 * Every write a demo user may make, as "METHOD /path" with Express-style
 * :params (one path segment each). Keep it to the visitor's own CRM records.
 */
export const DEMO_WRITE_ALLOWLIST: readonly string[] = [
  // Session + personal UI state.
  "POST /api/auth/logout",
  "PUT /api/auth/table-prefs/:tableId",
  "PATCH /api/auth/preferences",
  "PUT /api/notifications/preferences",
  "POST /api/notifications/:id/read",
  "POST /api/notifications/read-all",
  "DELETE /api/notifications",
  "DELETE /api/notifications/:id",

  // Pipelines (no deletes).
  "POST /api/pipeline/pipelines",
  "POST /api/pipeline/pipelines/reorder",
  "PATCH /api/pipeline/pipelines/:id",
  "POST /api/pipeline/stages",
  "PATCH /api/pipeline/stages/:id",
  "POST /api/pipeline/stages/reorder",

  // Deals.
  "POST /api/deals",
  "PATCH /api/deals/:id",
  "POST /api/deals/:id/email", // delivery suppressed for the demo org
  "PATCH /api/deals/:id/portal", // demo portal is visible to demo sessions only
  "POST /api/deals/:id/extend",
  "POST /api/deals/:id/stage",
  "POST /api/deals/:id/stage/undo",
  "POST /api/deals/:id/activity",
  "POST /api/deals/:id/activity/:buyerId/messages",
  "PATCH /api/deals/:id/activity/:buyerId/messages/:messageId",
  "POST /api/deals/:id/contact-bulk",
  "POST /api/deals/:id/accept-offer",
  "POST /api/deals/:id/sellers",
  "PATCH /api/deals/:id/sellers/:sellerId",
  "POST /api/deals/:id/convert",
  "POST /api/deals/:id/asset-mode",
  "POST /api/deals/:id/revenue",
  "POST /api/deals/:id/doc-folders",
  "POST /api/deals/bulk-assign",
  "POST /api/deals/bulk-archive",

  // Opportunities.
  "POST /api/opportunities",
  "PATCH /api/opportunities/:id",
  "POST /api/opportunities/:id/stage",
  "POST /api/opportunities/:id/convert",
  "POST /api/opportunities/:id/activities",
  "POST /api/opportunities/:id/doc-folders",

  // Buyers.
  "POST /api/buyers",
  "PATCH /api/buyers/:id",
  "POST /api/buyers/:id/aliases",
  "POST /api/buyers/:id/merge",
  "POST /api/buyers/merge-undo/:logId",
  "POST /api/buyers/:id/alias-dismissals",
  "POST /api/buyers/bulk-assign",

  // Contacts.
  "POST /api/contacts",
  "PATCH /api/contacts/:id",
  "POST /api/contacts/:id/activities",
  "PATCH /api/contacts/:id/activities/:aid",
  "POST /api/contacts/lists/all",
  "PATCH /api/contacts/lists/:listId",
  "POST /api/contacts/bulk-update",
  "POST /api/contacts/bulk-lists",

  // Offers, tasks, calendar, templates, expenses.
  "POST /api/offers",
  "PATCH /api/offers/:id",
  "POST /api/tasks",
  "PATCH /api/tasks/:id",
  "POST /api/calendar/events",
  "PATCH /api/calendar/events/:id",
  "POST /api/calendar/types",
  "PATCH /api/calendar/types/:id",
  "POST /api/email-templates",
  "PATCH /api/email-templates/:id",
  "POST /api/expenses",
  "PATCH /api/expenses/:id",
  "POST /api/expenses/bulk", // except action "delete" (see demoBlockReason)
  "POST /api/expenses/categories",
  "PATCH /api/expenses/categories/:id",
  "POST /api/expenses/categories/reorder",

  // Files: rename / move / buyer visibility only — no uploads.
  "PATCH /api/files/:id",

  // Research: buyer discovery into the demo's OWN buyer list (reads reference data).
  "POST /api/research/relationships/transactions",
  "POST /api/research/buyers/preview",
  "POST /api/research/buyers/commit",

  // Well analysis on the demo's own wells (public state data cache fills).
  "POST /api/wells",
  "PATCH /api/wells/:id",
  "POST /api/wells/import-rrc",
  "POST /api/wells/import-sonris",
  "POST /api/wells/analyze",
  "POST /api/wells/analyses",
  "PATCH /api/wells/analyses/:id",

  // Public buyer-portal forms (open to everyone; demo sessions are no different).
  "POST /api/portal/:orgSlug/leads",
  "POST /api/portal/offering/:slug/offers",
];

type Rule = { method: string; re: RegExp };

function compile(entry: string): Rule {
  const [method, path] = entry.split(" ");
  const body = path
    .toLowerCase()
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")))
    .join("/");
  return { method, re: new RegExp(`^${body}$`) };
}

const RULES: Rule[] = DEMO_WRITE_ALLOWLIST.map(compile);

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

/** The refusal message a visitor sees — grouped by area, for the toast. */
function refusalMessage(method: string, p: string): string {
  if (method === "DELETE" || /\/bulk-delete$|\/delete$/.test(p)) return DELETE_MESSAGE;
  if (/^\/api\/ai(\/|$)/.test(p)) return AI_MESSAGE;
  if (/\/import(\/|$)|^\/api\/files(\/|$)/.test(p)) return UPLOAD_MESSAGE;
  if (/^\/api\/(research|map)(\/|$)/.test(p)) return REFERENCE_MESSAGE;
  if (/^\/api\/(auth|org|users|integrations)(\/|$)/.test(p)) return SETTINGS_MESSAGE;
  return DEFAULT_MESSAGE;
}

/**
 * Why a demo user's request is refused, or null when it may proceed. Pure, so
 * the policy is unit-tested directly. `path` is the URL path (no query).
 */
export function demoBlockReason(method: string, path: string, body?: unknown): string | null {
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return null;
  const p = normalizePath(path);

  if (!RULES.some((r) => r.method === m && r.re.test(p))) return refusalMessage(m, p);

  // Bulk endpoints that take an action in the body (expenses: delete | reimburse | …).
  if (/\/bulk$/.test(p) && body && typeof body === "object" && String((body as { action?: unknown }).action).toLowerCase() === "delete") {
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

export const DEMO_MESSAGES = { SETTINGS: SETTINGS_MESSAGE, UPLOAD: UPLOAD_MESSAGE, AI: AI_MESSAGE, LIVE_ONLY: LIVE_ONLY_MESSAGE } as const;
