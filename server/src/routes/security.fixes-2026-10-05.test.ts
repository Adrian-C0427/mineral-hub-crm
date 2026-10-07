/**
 * Regression tests for the 2026-10-05 audit fixes:
 *  - Calendar events no longer name a linked deal / buyer to a caller who
 *    cannot see deals / buyers, and editing such an event leaves the hidden
 *    link alone instead of clearing it.
 *  - Contact tasks (Calendar, Tasks widget, single task) are limited to the
 *    caller's own without "View contacts"; standalone tasks are unaffected.
 *  - Clearing a shared (untargeted) notification hides it for the caller only
 *    instead of deleting it for every admin/owner.
 *
 * The routers run against a fake Prisma client that records what it was asked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

const db = vi.hoisted(() => {
  const calls: Record<string, unknown[]> = {};
  const results: Record<string, unknown> = {};
  const record = (key: string) => async (args: unknown) => {
    (calls[key] ??= []).push(args);
    const r = results[key];
    return typeof r === "function" ? (r as (a: unknown) => unknown)(args) : r;
  };
  const model = (name: string, methods: string[]) =>
    Object.fromEntries(methods.map((m) => [m, record(`${name}.${m}`)]));
  const prisma = {
    calendarEventType: model("calendarEventType", ["findMany", "findFirst"]),
    calendarEvent: model("calendarEvent", ["findMany", "findFirst", "groupBy", "update"]),
    deal: model("deal", ["findMany", "findFirst"]),
    buyer: model("buyer", ["findFirst"]),
    user: model("user", ["findFirst"]),
    dealBuyerActivity: model("dealBuyerActivity", ["findMany"]),
    contactActivity: model("contactActivity", ["findMany", "findFirst"]),
    notification: model("notification", ["deleteMany", "updateMany"]),
    notificationPreference: model("notificationPreference", ["findUnique"]),
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return { calls, results, prisma };
});

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));

import { calendarRouter } from "./calendar.js";
import { tasksRouter, taskVisibilityWhere } from "./dashboard.js";
import { notificationsRouter } from "./notifications.js";
import { errorHandler } from "../middleware/errors.js";
import { eventEntry } from "../domain/calendar.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { OrgRole, Permission } from "../domain/permissions.js";

type Caller = { id: string; orgRole: OrgRole; permissions: Permission[] };
const EDITOR_NO_VIEW: Caller = { id: "u_ed", orgRole: "MEMBER", permissions: ["editDeals"] };
const VIEWER_NO_CONTACTS: Caller = { id: "u_v", orgRole: "VIEWER", permissions: ["viewDeals", "viewBuyers"] };
const ADMIN: Caller = { id: "u_admin", orgRole: "ADMIN", permissions: [] };

async function call(caller: Caller, method: string, path: string, body?: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req: AuthedRequest, _res, next) => {
    req.user = {
      id: caller.id, role: "ASSOCIATE", name: "Test", email: "t@local.test", firstName: null, lastName: null, phone: null,
      organizationId: "org_a", orgRole: caller.orgRole, permissions: caller.permissions, mustChangePassword: false, isDemo: false, referenceOrgId: null,
    };
    next();
  });
  app.use("/api/calendar", calendarRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

const eventRow = (over: Record<string, unknown> = {}) => ({
  id: "ev_1", organizationId: "org_a", title: "Title call", typeId: null, date: new Date("2026-10-10T00:00:00Z"), allDay: true,
  startTime: null, endTime: null, notes: null, completedAt: null, dealId: "deal_1", buyerId: null, assignedToId: null,
  deal: { id: "deal_1", name: "Smith #3 – Freestone" }, buyer: null, assignedTo: null, ...over,
});

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
  Object.assign(db.results, {
    "calendarEventType.findMany": [{ id: "t1", name: "Closing", color: "#22C55E", sortOrder: 0, systemKey: "closing" }],
    "calendarEvent.groupBy": [],
    "calendarEvent.findMany": [],
    "deal.findMany": [],
    "dealBuyerActivity.findMany": [],
    "contactActivity.findMany": [],
    "notificationPreference.findUnique": null,
    "notification.deleteMany": { count: 0 },
    "notification.updateMany": { count: 0 },
  });
});

describe("calendar event links", () => {
  it("drops deal and buyer names the caller cannot see (pure mapping)", () => {
    const row = { ...eventRow(), buyer: null };
    expect(eventEntry(row, { deals: false, buyers: true }).link).toBeNull();
    expect(eventEntry({ ...row, deal: null, buyer: { id: "b1", name: "Basin Peak" } }, { deals: true, buyers: false }).link).toBeNull();
    expect(eventEntry(row).link).toEqual({ kind: "deal", id: "deal_1", label: "Smith #3 – Freestone" });
  });

  it("GET /calendar hides a linked deal from a caller without View deals", async () => {
    db.results["calendarEvent.findMany"] = [eventRow()];
    const res = await call(EDITOR_NO_VIEW, "GET", "/api/calendar?from=2026-10-01&to=2026-10-31");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].title).toBe("Title call");
    expect(res.body.events[0].link).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("Smith #3");
  });

  it("GET /calendar still shows the deal to a caller who can view deals", async () => {
    db.results["calendarEvent.findMany"] = [eventRow()];
    const res = await call({ ...EDITOR_NO_VIEW, permissions: ["editDeals", "viewDeals"] }, "GET", "/api/calendar?from=2026-10-01&to=2026-10-31");
    expect(res.body.events[0].link).toEqual({ kind: "deal", id: "deal_1", label: "Smith #3 – Freestone" });
  });

  it("PATCH keeps a hidden deal link instead of clearing it", async () => {
    db.results["calendarEvent.findFirst"] = eventRow();
    db.results["calendarEvent.update"] = (args: { data: Record<string, unknown> }) => ({ ...eventRow(), ...args.data });
    // What the form sends: the link it was shown ("none") comes back as nulls.
    const res = await call(EDITOR_NO_VIEW, "PATCH", "/api/calendar/events/ev_1", { title: "Renamed", dealId: null, buyerId: null });
    expect(res.status).toBe(200);
    const { data } = db.calls["calendarEvent.update"][0] as { data: Record<string, unknown> };
    expect(data.title).toBe("Renamed");
    expect(data).not.toHaveProperty("dealId");
    expect(data).not.toHaveProperty("buyerId");
    expect(res.body.link).toBeNull();
  });

  it("PATCH still lets a caller who can see the link clear it", async () => {
    db.results["calendarEvent.findFirst"] = eventRow();
    db.results["calendarEvent.update"] = (args: { data: Record<string, unknown> }) => ({ ...eventRow(), deal: null, ...args.data });
    await call({ ...EDITOR_NO_VIEW, permissions: ["editDeals", "viewDeals"] }, "PATCH", "/api/calendar/events/ev_1", { dealId: null, buyerId: null });
    const { data } = db.calls["calendarEvent.update"][0] as { data: Record<string, unknown> };
    expect(data.dealId).toBeNull();
  });
});

describe("contact task visibility", () => {
  it("is unrestricted with View contacts, own-or-standalone without it", () => {
    expect(taskVisibilityWhere("u1", true)).toEqual({});
    expect(taskVisibilityWhere("u1", false)).toEqual({ OR: [{ contactId: null }, { assignedToId: "u1" }, { createdById: "u1" }] });
  });

  it("GET /calendar limits contact tasks for a caller without View contacts", async () => {
    await call(VIEWER_NO_CONTACTS, "GET", "/api/calendar?from=2026-10-01&to=2026-10-31&tasksFor=all");
    const { where } = db.calls["contactActivity.findMany"][0] as { where: { AND: unknown[] } };
    expect(where.AND).toContainEqual(taskVisibilityWhere(VIEWER_NO_CONTACTS.id, false));
  });

  it("GET /calendar does not restrict a caller with View contacts", async () => {
    const caller = { ...VIEWER_NO_CONTACTS, permissions: [...VIEWER_NO_CONTACTS.permissions, "viewContacts" as Permission] };
    await call(caller, "GET", "/api/calendar?from=2026-10-01&to=2026-10-31&tasksFor=all");
    const { where } = db.calls["contactActivity.findMany"][0] as { where: { AND: unknown[] } };
    expect(where.AND).toEqual([{}, {}]);
  });

  it("GET /tasks applies the same rule", async () => {
    await call(VIEWER_NO_CONTACTS, "GET", "/api/tasks?assignee=all");
    const { where } = db.calls["contactActivity.findMany"][0] as { where: { AND: unknown[] } };
    expect(where.AND).toContainEqual(taskVisibilityWhere(VIEWER_NO_CONTACTS.id, false));
  });

  it("GET /tasks/:id 404s on someone else's contact task", async () => {
    db.results["contactActivity.findFirst"] = null;
    const res = await call(VIEWER_NO_CONTACTS, "GET", "/api/tasks/task_1");
    expect(res.status).toBe(404);
    const { where } = db.calls["contactActivity.findFirst"][0] as { where: Record<string, unknown> };
    expect(where.OR).toEqual(taskVisibilityWhere(VIEWER_NO_CONTACTS.id, false).OR);
  });
});

describe("clearing shared notifications", () => {
  it("Clear all deletes the caller's own rows and only hides shared ones", async () => {
    db.results["notification.deleteMany"] = { count: 2 };
    db.results["notification.updateMany"] = { count: 3 };
    const res = await call(ADMIN, "DELETE", "/api/notifications");
    expect(res.body).toEqual({ ok: true, cleared: 5 });
    const del = db.calls["notification.deleteMany"][0] as { where: { AND: unknown[] } };
    expect(del.where.AND).toContainEqual({ userId: ADMIN.id });
    const upd = db.calls["notification.updateMany"][0] as { where: { AND: unknown[] }; data: unknown };
    expect(upd.where.AND).toContainEqual({ userId: null });
    expect(upd.data).toEqual({ hiddenForUserIds: { push: ADMIN.id } });
  });

  it("clearing one shared row hides it rather than deleting it", async () => {
    db.results["notification.updateMany"] = { count: 1 };
    const res = await call(ADMIN, "DELETE", "/api/notifications/n_1");
    expect(res.status).toBe(200);
    const del = db.calls["notification.deleteMany"][0] as { where: { AND: unknown[] } };
    expect(del.where.AND).toContainEqual({ userId: ADMIN.id });
    expect(db.calls["notification.updateMany"][0]).toMatchObject({ data: { hiddenForUserIds: { push: ADMIN.id } } });
  });

  it("a row the caller cannot see is still a 404", async () => {
    const res = await call(ADMIN, "DELETE", "/api/notifications/n_other");
    expect(res.status).toBe(404);
  });
});
