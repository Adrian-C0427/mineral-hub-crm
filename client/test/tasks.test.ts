/**
 * The task form's values and edit body (client/src/lib/tasks.ts): one form
 * creates tasks and edits tasks / reminders everywhere they appear, so what it
 * opens with and what it sends must match both task endpoints.
 *
 * Kept outside src/ so the client build's typecheck never needs vitest.
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import { contactTaskValues, dashTaskValues, newTaskValues, taskEditBody, taskFormChanged, taskFormMissing } from "../src/lib/tasks";

describe("form values from a stored task", () => {
  it("a Dashboard task keeps its day key, details and owner", () => {
    expect(dashTaskValues({
      title: "Prep pipeline review", details: null, dueDate: "2026-10-14T00:00:00.000Z", priority: "HIGH",
      assignedTo: { id: "u_elena" }, completedAt: null,
    })).toEqual({ title: "Prep pipeline review", details: "", due: "2026-10-14", priority: "HIGH", assignee: "u_elena", done: false });
  });

  it("a contact task's note is its body; an unassigned one belongs to its author", () => {
    expect(contactTaskValues({
      title: "Send offer letter", body: "Use the Leon template", dueDate: null, priority: null,
      assignedTo: null, createdBy: { id: "u_ben" }, completedAt: "2026-10-02T15:00:00.000Z",
    })).toEqual({ title: "Send offer letter", details: "Use the Leon template", due: "", priority: "MEDIUM", assignee: "u_ben", done: true });
  });

  it("an older contact task without a title uses its body as the title", () => {
    const v = contactTaskValues({ title: null, body: "Call back", dueDate: null, priority: "LOW", assignedTo: { id: "u_me" }, createdBy: null, completedAt: null });
    expect([v.title, v.details]).toEqual(["Call back", "Call back"]);
  });
});

describe("taskEditBody", () => {
  const v = { title: "  Send revised offer ", details: "  ", due: "", priority: "LOW" as const, assignee: "", done: true };

  it("sends every task field, trimmed; blanks become null", () => {
    expect(taskEditBody("TASK", v)).toEqual({ title: "Send revised offer", details: null, dueDate: null, priority: "LOW", assignedToId: null, completed: true });
  });

  it("leaves a reminder's priority, assignee and status alone", () => {
    expect(taskEditBody("REMINDER", { ...v, due: "2026-11-01", details: "After the meeting" })).toEqual({
      title: "Send revised offer", details: "After the meeting", dueDate: "2026-11-01",
    });
  });
});

describe("form state", () => {
  it("knows what a save still needs", () => {
    const blank = newTaskValues("u_me");
    expect(taskFormMissing(blank, {})).toBe("title");
    const titled = { ...blank, title: "Call" };
    expect(taskFormMissing(titled, {})).toBeNull();
    expect(taskFormMissing(titled, { dueRequired: true })).toBe("due date");
    expect(taskFormMissing(titled, { detailsRequired: true })).toBe("details");
  });

  it("only counts real changes as unsaved", () => {
    const a = newTaskValues("u_me");
    expect(taskFormChanged(a, { ...a, title: "  " })).toBe(false);
    expect(taskFormChanged(a, { ...a, done: true })).toBe(true);
    expect(taskFormChanged(a, { ...a, assignee: "u_elena" })).toBe(true);
  });
});
