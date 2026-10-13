import { describe, it, expect } from "vitest";
import { planTaskEdit, taskAssignedNotice, taskDetails, taskDueNotice, taskEditSchema, taskLink, type TaskState } from "./tasks.js";

const day = (k: string) => new Date(`${k}T00:00:00Z`);
const NOW = new Date("2026-10-12T15:00:00Z");
const ctx = { editorId: "u_me", now: NOW };

/** A standalone Dashboard task with no details (the title doubles as the body). */
const standalone = (over: Partial<TaskState> = {}): TaskState => ({
  kind: "TASK", contactId: null, title: "Call the title company", body: "Call the title company", dueDate: day("2026-10-14"),
  priority: "MEDIUM", assignedToId: "u_me", createdById: "u_me", completedAt: null, ...over,
});
const contactTask = (over: Partial<TaskState> = {}): TaskState =>
  standalone({ contactId: "c_1", title: "Send offer letter", body: "Use the Leon template", ...over });

const plan = (t: TaskState, edit: Parameters<typeof planTaskEdit>[1]) => {
  const p = planTaskEdit(t, taskEditSchema.parse(edit), ctx);
  if (!p.ok) throw new Error(p.error);
  return p;
};
const error = (t: TaskState, edit: Parameters<typeof planTaskEdit>[1]) => {
  const p = planTaskEdit(t, taskEditSchema.parse(edit), ctx);
  return p.ok ? null : p.error;
};

describe("planTaskEdit — title and details", () => {
  it("renaming a standalone task without details moves the body with the title", () => {
    expect(plan(standalone(), { title: "Call Stewart Title" }).data).toEqual({ title: "Call Stewart Title", body: "Call Stewart Title" });
  });

  it("renaming a standalone task keeps its details", () => {
    const t = standalone({ body: "Ask about the Leon closing" });
    expect(plan(t, { title: "Call Stewart Title" }).data).toEqual({ title: "Call Stewart Title" });
  });

  it("adding and clearing standalone details", () => {
    expect(plan(standalone(), { details: "Ask about the Leon closing" }).data).toEqual({ body: "Ask about the Leon closing" });
    const withDetails = standalone({ body: "Ask about the Leon closing" });
    expect(plan(withDetails, { details: null }).data).toEqual({ body: "Call the title company" });
    expect(plan(withDetails, { details: "  " }).data).toEqual({ body: "Call the title company" });
  });

  it("a contact task's details stay required, as on create", () => {
    expect(error(contactTask(), { details: "" })).toBe("Details are required");
    expect(error(contactTask(), { details: null })).toBe("Details are required");
    expect(plan(contactTask(), { details: "Use the Robertson template" }).data).toEqual({ body: "Use the Robertson template" });
    // Renaming leaves a contact task's note alone.
    expect(plan(contactTask(), { title: "Send revised offer" }).data).toEqual({ title: "Send revised offer" });
  });

  it("rejects a blank title", () => {
    expect(() => taskEditSchema.parse({ title: "   " })).toThrow();
  });

  it("taskDetails hides a body that only repeats the title", () => {
    expect(taskDetails({ title: "A", body: "A" })).toBeNull();
    expect(taskDetails({ title: "A", body: "B" })).toBe("B");
    expect(taskDetails({ title: null, body: "Legacy" })).toBeNull();
  });
});

describe("planTaskEdit — due date", () => {
  it("stores a calendar day at UTC midnight", () => {
    expect(plan(standalone(), { dueDate: "2026-11-02" }).data.dueDate?.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });

  it("ignores an unchanged date", () => {
    expect(plan(standalone(), { dueDate: "2026-10-14" }).data).toEqual({});
  });

  it("rejects impossible and malformed days", () => {
    expect(error(standalone(), { dueDate: "2026-02-31" })).toBe("Enter a valid due date");
    expect(() => taskEditSchema.parse({ dueDate: "11/02/2026" })).toThrow();
  });

  it("a standalone task must keep a due date; a contact task or reminder may clear it", () => {
    expect(error(standalone(), { dueDate: null })).toBe("A due date is required");
    expect(plan(contactTask(), { dueDate: null }).data).toEqual({ dueDate: null });
    expect(plan(contactTask({ kind: "REMINDER", priority: null }), { dueDate: null }).data).toEqual({ dueDate: null });
  });
});

describe("planTaskEdit — priority, assignee, status", () => {
  it("sets priority on tasks only", () => {
    expect(plan(standalone(), { priority: "HIGH" }).data).toEqual({ priority: "HIGH" });
    expect(plan(contactTask({ kind: "REMINDER", priority: null }), { priority: "HIGH" }).data).toEqual({});
  });

  it("reassigns, and an empty assignee means the editor (as on create)", () => {
    const p = plan(standalone(), { assignedToId: "u_elena" });
    expect(p.data).toEqual({ assignedToId: "u_elena" });
    expect([p.ownerBefore, p.ownerAfter]).toEqual(["u_me", "u_elena"]);
    expect(plan(standalone({ assignedToId: "u_elena" }), { assignedToId: null }).data).toEqual({ assignedToId: "u_me" });
  });

  it("naming the author of an unassigned task is not a change of owner", () => {
    const p = plan(standalone({ assignedToId: null, createdById: "u_ben" }), { assignedToId: "u_ben" });
    expect(p.data).toEqual({ assignedToId: "u_ben" });
    expect(p.ownerAfter).toBe(p.ownerBefore);
    expect(p.alertsStale).toBe(false);
  });

  it("completes and reopens; a task that stays complete keeps its completion time", () => {
    expect(plan(standalone(), { completed: true }).data).toEqual({ completedAt: NOW });
    const done = standalone({ completedAt: day("2026-10-01") });
    expect(plan(done, { completed: true }).data).toEqual({});
    expect(plan(done, { completed: false }).data).toEqual({ completedAt: null });
  });

  it("an unchanged form changes nothing and leaves the alert alone", () => {
    const p = plan(standalone(), { title: "Call the title company", details: null, dueDate: "2026-10-14", priority: "MEDIUM", assignedToId: "u_me", completed: false });
    expect(p.data).toEqual({});
    expect(p.alertsStale).toBe(false);
  });

  it("flags the due alert as stale when its wording, date, owner or status changes — not for priority", () => {
    expect(plan(standalone(), { priority: "LOW" }).alertsStale).toBe(false);
    expect(plan(standalone(), { title: "New" }).alertsStale).toBe(true);
    expect(plan(standalone(), { dueDate: "2026-10-20" }).alertsStale).toBe(true);
    expect(plan(standalone(), { assignedToId: "u_elena" }).alertsStale).toBe(true);
    expect(plan(standalone(), { completed: true }).alertsStale).toBe(true);
  });

  it("refuses non-task activities", () => {
    expect(error(standalone({ kind: "NOTE" }), { title: "x" })).toMatch(/Only tasks and reminders/);
  });
});

describe("task notices", () => {
  const row = {
    id: "t_1", title: "Send offer letter", body: "Use the Leon template", dueDate: day("2026-10-12"), completedAt: null,
    assignedToId: "u_elena", createdById: "u_me", contact: { id: "c_1", firstName: "Ruth", lastName: "Hale", entityName: null },
  };

  it("links a task where it lives", () => {
    expect(taskLink("t_1", "c_1")).toBe("/contacts/c_1?task=t_1");
    expect(taskLink("t_1", null)).toBe("/?task=t_1");
  });

  it("is due today, then overdue, for the assignee", () => {
    expect(taskDueNotice(row, NOW)).toEqual({
      userId: "u_elena", title: "Task due: Send offer letter", body: "On Ruth Hale · due today.", link: "/contacts/c_1?task=t_1",
    });
    expect(taskDueNotice({ ...row, dueDate: day("2026-10-09") }, NOW)?.body).toBe("On Ruth Hale · 3 days overdue.");
    expect(taskDueNotice({ ...row, dueDate: day("2026-10-11"), contact: null }, NOW)).toMatchObject({
      title: "Task overdue: Send offer letter", body: "1 day overdue.", link: "/?task=t_1",
    });
  });

  it("falls back to the author when unassigned", () => {
    expect(taskDueNotice({ ...row, assignedToId: null }, NOW)?.userId).toBe("u_me");
  });

  it("has no alert when complete, undated or not yet due", () => {
    expect(taskDueNotice({ ...row, completedAt: NOW }, NOW)).toBeNull();
    expect(taskDueNotice({ ...row, dueDate: null }, NOW)).toBeNull();
    expect(taskDueNotice({ ...row, dueDate: day("2026-10-13") }, NOW)).toBeNull();
  });

  it("words the assignment notice like task creation always has", () => {
    expect(taskAssignedNotice({ id: "t_1", title: "Prep pipeline review", priority: "HIGH", dueDate: day("2026-10-14"), contactId: null }, "Adrian")).toEqual({
      type: "task_assigned", title: "New task: Prep pipeline review",
      body: "Adrian assigned you a task · High priority · due 10/14/2026.", link: "/?task=t_1",
    });
  });
});
