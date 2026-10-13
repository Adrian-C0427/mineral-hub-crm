/**
 * Editing existing tasks — both write paths (PATCH /api/tasks/:id for the
 * Dashboard, PATCH /api/contacts/:id/activities/:aid for the contact
 * workspace) run the same validation, permission and org scoping as creating
 * a task, keep the task's contact link, and keep its due alert in step.
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
    user: model("user", ["findFirst"]),
    contact: model("contact", ["findFirst"]),
    contactActivity: model("contactActivity", ["findFirst", "update"]),
    notification: model("notification", ["create", "deleteMany", "updateMany"]),
  };
  return { calls, results, prisma };
});

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));

import { tasksRouter } from "./dashboard.js";
import { contactsRouter } from "./contacts.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { OrgRole, Permission } from "../domain/permissions.js";

type Caller = { id: string; name: string; orgRole: OrgRole; permissions: Permission[] };
const ME: Caller = { id: "u_me", name: "Adrian", orgRole: "MEMBER", permissions: [] };
const STRANGER: Caller = { id: "u_x", name: "Pat", orgRole: "MEMBER", permissions: [] };
const MANAGER: Caller = { id: "u_mgr", name: "Grace", orgRole: "MEMBER", permissions: ["viewContacts", "manageContacts"] };

async function call(caller: Caller, method: string, path: string, body?: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req: AuthedRequest, _res, next) => {
    req.user = {
      id: caller.id, role: "ASSOCIATE", name: caller.name, email: "t@local.test", firstName: null, lastName: null, phone: null,
      organizationId: "org_a", orgRole: caller.orgRole, permissions: caller.permissions, mustChangePassword: false, isDemo: false, referenceOrgId: null,
    };
    next();
  });
  app.use("/api/tasks", tasksRouter);
  app.use("/api/contacts", contactsRouter);
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

const day = (k: string) => new Date(`${k}T00:00:00Z`);
const todayKey = new Date().toISOString().slice(0, 10);
const people: Record<string, { id: string; name: string }> = {
  u_me: { id: "u_me", name: "Adrian" }, u_elena: { id: "u_elena", name: "Elena" }, u_mgr: { id: "u_mgr", name: "Grace" },
};

/** A standalone Dashboard task, as the tasks router selects it. */
const standaloneRow = (over: Record<string, unknown> = {}) => ({
  id: "t_1", kind: "TASK", title: "Prep pipeline review", body: "Prep pipeline review", dueDate: day("2026-10-01"), priority: "MEDIUM",
  completedAt: null, createdAt: day("2026-09-28"), contactId: null, assignedToId: "u_me", createdById: "u_me",
  assignedTo: people.u_me, createdBy: people.u_me, contact: null, ...over,
});
/** The fake update echoes the row with the written columns applied. */
const echoUpdate = (row: Record<string, unknown>) => (args: { data: Record<string, unknown> }) => {
  const next = { ...row, ...args.data };
  if ("assignedToId" in args.data) next.assignedTo = people[args.data.assignedToId as string] ?? null;
  return next;
};
const updateData = () => (db.calls["contactActivity.update"]?.[0] as { data: Record<string, unknown> } | undefined)?.data;

beforeEach(() => {
  for (const k of Object.keys(db.calls)) delete db.calls[k];
  for (const k of Object.keys(db.results)) delete db.results[k];
  Object.assign(db.results, {
    "user.findFirst": (args: { where: { id: string } }) => people[args.where.id] ? { id: args.where.id } : null,
    "notification.create": {},
    "notification.deleteMany": { count: 1 },
    "notification.updateMany": { count: 1 },
  });
});

describe("PATCH /api/tasks/:id — editing from the Dashboard", () => {
  it("saves every field of the task form", async () => {
    const row = standaloneRow();
    db.results["contactActivity.findFirst"] = row;
    db.results["contactActivity.update"] = echoUpdate(row);
    const res = await call(ME, "PATCH", "/api/tasks/t_1", {
      title: "Prep Monday pipeline review", details: "Bring the Leon numbers", dueDate: "2099-01-15", priority: "HIGH", assignedToId: "u_me", completed: false,
    });
    expect(res.status).toBe(200);
    expect(updateData()).toEqual({
      title: "Prep Monday pipeline review", body: "Bring the Leon numbers", dueDate: day("2099-01-15"), priority: "HIGH",
    });
    expect(res.body).toMatchObject({
      id: "t_1", title: "Prep Monday pipeline review", details: "Bring the Leon numbers", priority: "HIGH", contactId: null, canEdit: true, notified: false,
    });
    expect(res.body.dueDate.slice(0, 10)).toBe("2099-01-15");
  });

  it("scopes the lookup to the caller's org, task kind and visibility", async () => {
    db.results["contactActivity.findFirst"] = null;
    const res = await call(ME, "PATCH", "/api/tasks/t_other", { title: "x" });
    expect(res.status).toBe(404);
    const { where } = db.calls["contactActivity.findFirst"][0] as { where: Record<string, unknown> };
    expect(where).toMatchObject({ id: "t_other", organizationId: "org_a", kind: "TASK" });
    expect(db.calls["contactActivity.update"]).toBeUndefined();
  });

  it("lets only the owner, the author or a contact manager change it", async () => {
    db.results["contactActivity.findFirst"] = standaloneRow();
    db.results["contactActivity.update"] = echoUpdate(standaloneRow());
    expect((await call(STRANGER, "PATCH", "/api/tasks/t_1", { title: "Mine now" })).status).toBe(403);
    expect(db.calls["contactActivity.update"]).toBeUndefined();
    expect((await call(MANAGER, "PATCH", "/api/tasks/t_1", { title: "Fixed typo" })).status).toBe(200);
  });

  it("validates like create: due date required, assignee inside the org", async () => {
    db.results["contactActivity.findFirst"] = standaloneRow();
    db.results["contactActivity.update"] = echoUpdate(standaloneRow());
    const noDue = await call(ME, "PATCH", "/api/tasks/t_1", { dueDate: null });
    expect(noDue).toMatchObject({ status: 400, body: { error: "A due date is required" } });
    const outsider = await call(ME, "PATCH", "/api/tasks/t_1", { assignedToId: "u_other_org" });
    expect(outsider).toMatchObject({ status: 400, body: { error: "Assignee is not in your organization" } });
    const where = (db.calls["user.findFirst"][0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ id: "u_other_org", organizationId: "org_a" });
    expect((await call(ME, "PATCH", "/api/tasks/t_1", { priority: "URGENT" })).status).toBe(400);
    expect(db.calls["contactActivity.update"]).toBeUndefined();
  });

  it("reassigning to a teammate notifies them and hands them the due alert", async () => {
    const row = standaloneRow();
    db.results["contactActivity.findFirst"] = row;
    db.results["contactActivity.update"] = echoUpdate(row);
    const res = await call(ME, "PATCH", "/api/tasks/t_1", { assignedToId: "u_elena" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ notified: true, assignedTo: { id: "u_elena" } });
    expect(db.calls["notification.create"]).toHaveLength(1);
    expect(db.calls["notification.create"][0]).toMatchObject({
      data: { organizationId: "org_a", userId: "u_elena", type: "task_assigned", link: "/?task=t_1", title: "New task: Prep pipeline review" },
    });
    // The overdue task's existing alert moves to the new owner (no second row).
    expect(db.calls["notification.updateMany"][0]).toMatchObject({
      where: { organizationId: "org_a", type: "task_due", link: { contains: "task=t_1" } },
      data: { userId: "u_elena", readAt: null, title: "Task overdue: Prep pipeline review" },
    });
    expect(db.calls["notification.deleteMany"]).toBeUndefined();
  });

  it("moving the due date out retires the due alert; moving it within 'due' rewrites it", async () => {
    const row = standaloneRow();
    db.results["contactActivity.findFirst"] = row;
    db.results["contactActivity.update"] = echoUpdate(row);
    await call(ME, "PATCH", "/api/tasks/t_1", { dueDate: "2099-01-15" });
    expect(db.calls["notification.deleteMany"][0]).toMatchObject({ where: { type: "task_due", link: { contains: "task=t_1" } } });
    expect(db.calls["notification.updateMany"]).toBeUndefined();

    delete db.calls["notification.deleteMany"];
    await call(ME, "PATCH", "/api/tasks/t_1", { dueDate: todayKey });
    expect(db.calls["notification.updateMany"][0]).toMatchObject({ data: { title: "Task due: Prep pipeline review", body: "Due today." } });
    expect(db.calls["notification.updateMany"][0]).not.toHaveProperty("data.readAt");
    expect(db.calls["notification.deleteMany"]).toBeUndefined();
  });

  it("a priority-only edit leaves alerts and notifications alone", async () => {
    db.results["contactActivity.findFirst"] = standaloneRow();
    db.results["contactActivity.update"] = echoUpdate(standaloneRow());
    await call(ME, "PATCH", "/api/tasks/t_1", { priority: "LOW" });
    expect(updateData()).toEqual({ priority: "LOW" });
    expect(db.calls["notification.updateMany"]).toBeUndefined();
    expect(db.calls["notification.deleteMany"]).toBeUndefined();
    expect(db.calls["notification.create"]).toBeUndefined();
  });

  it("the widget checkbox still completes a task and retires its alert", async () => {
    db.results["contactActivity.findFirst"] = standaloneRow();
    db.results["contactActivity.update"] = echoUpdate(standaloneRow());
    const res = await call(ME, "PATCH", "/api/tasks/t_1", { completed: true });
    expect(res.status).toBe(200);
    expect(updateData()).toHaveProperty("completedAt");
    expect(res.body.completedAt).not.toBeNull();
    expect(db.calls["notification.deleteMany"]).toHaveLength(1);
  });
});

describe("PATCH /api/contacts/:id/activities/:aid — editing from the contact workspace", () => {
  const contact = { id: "c_1", organizationId: "org_a", firstName: "Ruth", lastName: "Hale", entityName: null };
  const taskRow = (over: Record<string, unknown> = {}) => ({
    id: "a_1", organizationId: "org_a", contactId: "c_1", kind: "TASK", title: "Send offer letter", body: "Use the Leon template",
    disposition: null, durationSeconds: null, dueDate: day("2026-10-01"), completedAt: null, priority: "MEDIUM",
    assignedToId: "u_me", createdById: "u_me", pinned: false, color: null, createdAt: day("2026-09-20"), updatedAt: day("2026-09-20"),
    createdBy: people.u_me, assignedTo: people.u_me, ...over,
  });

  beforeEach(() => {
    db.results["contact.findFirst"] = contact;
  });

  it("needs Manage contacts", async () => {
    expect((await call(ME, "PATCH", "/api/contacts/c_1/activities/a_1", { title: "x" })).status).toBe(403);
  });

  it("saves every task field and keeps the contact link", async () => {
    const row = taskRow();
    db.results["contactActivity.findFirst"] = row;
    db.results["contactActivity.update"] = echoUpdate(row);
    const res = await call(MANAGER, "PATCH", "/api/contacts/c_1/activities/a_1", {
      title: "Send revised offer", details: "Use the Robertson template", dueDate: null, priority: "LOW", assignedToId: "u_elena", completed: true,
    });
    expect(res.status).toBe(200);
    const data = updateData()!;
    expect(data).toMatchObject({ title: "Send revised offer", body: "Use the Robertson template", dueDate: null, priority: "LOW", assignedToId: "u_elena" });
    expect(data).toHaveProperty("completedAt");
    expect(data).not.toHaveProperty("contactId");
    expect(res.body).toMatchObject({ id: "a_1", kind: "TASK", title: "Send revised offer", body: "Use the Robertson template", priority: "LOW" });
    // Scoped through the contact, which is scoped to the org.
    expect((db.calls["contact.findFirst"][0] as { where: unknown }).where).toEqual({ id: "c_1", organizationId: "org_a" });
    expect((db.calls["contactActivity.findFirst"][0] as { where: unknown }).where).toEqual({ id: "a_1", contactId: "c_1" });
    // Completed → its due alert is retired; contact tasks never sent an assignment notice.
    expect(db.calls["notification.deleteMany"]).toHaveLength(1);
    expect(db.calls["notification.create"]).toBeUndefined();
  });

  it("keeps a contact task's details required", async () => {
    db.results["contactActivity.findFirst"] = taskRow();
    const res = await call(MANAGER, "PATCH", "/api/contacts/c_1/activities/a_1", { details: "" });
    expect(res).toMatchObject({ status: 400, body: { error: "Details are required" } });
  });

  it("edits a reminder's title, note and date (no priority)", async () => {
    const row = taskRow({ kind: "REMINDER", priority: null, title: "Call back", body: "After the family meeting" });
    db.results["contactActivity.findFirst"] = row;
    db.results["contactActivity.update"] = echoUpdate(row);
    const res = await call(MANAGER, "PATCH", "/api/contacts/c_1/activities/a_1", { title: "Call back Ruth", details: "After the meeting", dueDate: "2099-02-01", priority: "HIGH" });
    expect(res.status).toBe(200);
    expect(updateData()).toEqual({ title: "Call back Ruth", body: "After the meeting", dueDate: day("2099-02-01") });
    // Reminders have no due alerts to keep in step.
    expect(db.calls["notification.deleteMany"]).toBeUndefined();
    expect(db.calls["notification.updateMany"]).toBeUndefined();
  });

  it("notes keep their own pin / colour / text edits", async () => {
    const row = taskRow({ kind: "NOTE", dueDate: null, priority: null, assignedToId: null, assignedTo: null });
    db.results["contactActivity.findFirst"] = row;
    db.results["contactActivity.update"] = echoUpdate(row);
    const res = await call(MANAGER, "PATCH", "/api/contacts/c_1/activities/a_1", { pinned: true, color: "blue", dueDate: "2099-01-01" });
    expect(res.status).toBe(200);
    expect(updateData()).toEqual({ pinned: true, color: "blue" });
  });
});
