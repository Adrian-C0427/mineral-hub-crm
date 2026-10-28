import { contactName } from "./contactName.js";
import { z } from "zod";
import { parseDayKey } from "./calendar.js";

/**
 * Tasks & reminders — the pure parts (no database). A task is a
 * ContactActivity row of kind TASK (a REMINDER is its lighter sibling): either
 * on a contact, or a standalone Dashboard task (contactId null). Editing, the
 * due alerts the sweep writes, and the "assigned you a task" notice all follow
 * the rules here, so every surface (Dashboard, contact workspace, Calendar
 * links, the bell) agrees.
 *
 * Due dates are CALENDAR DAYS stored at UTC midnight (see domain/calendar.ts).
 */

export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;

/** The activity kinds the task form creates and edits. */
export const isTaskKind = (kind: string): boolean => kind === "TASK" || kind === "REMINDER";

/**
 * An edit from the task form. Every field is optional — only what is sent
 * changes. `details` null/"" clears the details; `dueDate` null clears the
 * date (contact tasks and reminders only: a standalone task always has one);
 * `assignedToId` null means the editor ("Assign to me"), as on create.
 */
export const taskEditSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  details: z.string().trim().max(10_000).nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assignedToId: z.string().min(1).max(200).nullish(),
  completed: z.boolean().optional(),
});
export type TaskEdit = z.infer<typeof taskEditSchema>;

/** The stored fields an edit reads. */
export interface TaskState {
  kind: string;
  contactId: string | null;
  title: string | null;
  body: string;
  dueDate: Date | null;
  priority: string | null;
  assignedToId: string | null;
  createdById: string | null;
  completedAt: Date | null;
}

/** The columns an edit writes (only the ones that change). */
export interface TaskUpdate {
  title?: string;
  body?: string;
  dueDate?: Date | null;
  priority?: string;
  assignedToId?: string;
  completedAt?: Date | null;
}

export type TaskEditPlan =
  | {
      ok: true;
      data: TaskUpdate;
      /** Whose task it is (assignee, else author) before and after the edit. */
      ownerBefore: string | null;
      ownerAfter: string | null;
      /** The due alert's text or recipient depends on something that changed. */
      alertsStale: boolean;
    }
  | { ok: false; error: string };

/** Details: the body when it says more than the title. A standalone task with
 *  no details stores its title as the body; legacy rows have no title. */
export function taskDetails(t: { title: string | null; body: string }): string | null {
  return t.title && t.body && t.body !== t.title ? t.body : null;
}

const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * Validate an edit against the same rules as creating the task, and work out
 * the columns to write. The task's contact link, author and creation time are
 * never touched — an edit cannot move a task to another contact.
 */
export function planTaskEdit(t: TaskState, edit: TaskEdit, ctx: { editorId: string; now: Date }): TaskEditPlan {
  if (!isTaskKind(t.kind)) return { ok: false, error: "Only tasks and reminders can be edited here" };
  const standalone = t.contactId == null;
  const data: TaskUpdate = {};

  // Title + details. A standalone task's details are optional (the title
  // doubles as the body without them); a contact task or reminder carries its
  // own required note, as the contact workspace's composer does.
  const title = edit.title ?? t.title ?? t.body;
  if (edit.title !== undefined && edit.title !== t.title) data.title = edit.title;
  if (standalone) {
    const details = edit.details !== undefined ? edit.details || null : taskDetails(t);
    const body = details ?? title;
    if (body !== t.body) data.body = body;
  } else if (edit.details !== undefined) {
    if (!edit.details) return { ok: false, error: "Details are required" };
    if (edit.details !== t.body) data.body = edit.details;
  }

  // Due date: a calendar day. Required on a standalone task, optional otherwise.
  if (edit.dueDate !== undefined) {
    let due: Date | null = null;
    if (edit.dueDate !== null) {
      due = parseDayKey(edit.dueDate);
      if (!due) return { ok: false, error: "Enter a valid due date" };
    } else if (standalone) {
      return { ok: false, error: "A due date is required" };
    }
    if (!sameTime(due, t.dueDate)) data.dueDate = due;
  }

  // Priority: tasks only — reminders carry none.
  if (edit.priority !== undefined && t.kind === "TASK" && edit.priority !== t.priority) data.priority = edit.priority;

  // Assignee: null = the editor, the same default as creating the task.
  if (edit.assignedToId !== undefined) {
    const next = edit.assignedToId ?? ctx.editorId;
    if (next !== t.assignedToId) data.assignedToId = next;
  }
  const ownerBefore = t.assignedToId ?? t.createdById;
  const ownerAfter = data.assignedToId ?? ownerBefore;

  // Status. A task that stays complete keeps its original completion time.
  if (edit.completed !== undefined) {
    const completedAt = edit.completed ? t.completedAt ?? ctx.now : null;
    if (!sameTime(completedAt, t.completedAt)) data.completedAt = completedAt;
  }

  const alertsStale = "title" in data || "body" in data || "dueDate" in data || "completedAt" in data || ownerAfter !== ownerBefore;
  return { ok: true, data, ownerBefore, ownerAfter, alertsStale };
}

/** In-app link that opens a task: on its contact's workspace, or on the
 *  Dashboard for a standalone task. Carries the id so alerts match exactly. */
export function taskLink(id: string, contactId: string | null): string {
  return contactId ? `/contacts/${contactId}?task=${id}` : `/?task=${id}`;
}

export interface TaskAlertRow {
  id: string;
  title: string | null;
  body: string;
  dueDate: Date | null;
  completedAt: Date | null;
  assignedToId: string | null;
  createdById: string | null;
  contact: { id: string; firstName: string | null; middleName?: string | null; lastName: string | null; entityName: string | null } | null;
}

/**
 * The `task_due` alert a task should have right now — recipient, wording and
 * link — or null when it should have none (complete, undated, or not yet due).
 * The alert sweep writes these; editing a task rewrites or retires its alert
 * with the same function, so the bell never shows a stale date or owner.
 */
export function taskDueNotice(t: TaskAlertRow, now: Date): { userId: string | null; title: string; body: string; link: string } | null {
  if (t.completedAt || !t.dueDate || t.dueDate.getTime() > now.getTime()) return null;
  const who = t.contact ? contactName(t.contact) || "contact" : null;
  const overdueDays = Math.floor((now.getTime() - t.dueDate.getTime()) / 86_400_000);
  const label = (t.title ?? t.body).slice(0, 80);
  const when = overdueDays > 0 ? `${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue.` : "due today.";
  return {
    userId: t.assignedToId ?? t.createdById,
    title: overdueDays > 0 ? `Task overdue: ${label}` : `Task due: ${label}`,
    body: who ? `On ${who} · ${when}` : when[0].toUpperCase() + when.slice(1),
    link: taskLink(t.id, t.contact?.id ?? null),
  };
}

/** The in-app "assigned you a task" notice a teammate gets. */
export function taskAssignedNotice(
  t: { id: string; title: string; priority: string | null; dueDate: Date | null; contactId: string | null },
  actorName: string,
): { type: "task_assigned"; title: string; body: string; link: string } {
  const p = t.priority ?? "MEDIUM";
  const pr = p[0] + p.slice(1).toLowerCase();
  const d = t.dueDate?.toISOString();
  const due = d ? ` · due ${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : "";
  return {
    type: "task_assigned",
    title: `New task: ${t.title.slice(0, 80)}`,
    body: `${actorName} assigned you a task · ${pr} priority${due}.`,
    link: taskLink(t.id, t.contactId),
  };
}
