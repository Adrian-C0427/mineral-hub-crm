/**
 * The task form's values and the request bodies built from them — shared by
 * the Dashboard (standalone tasks, PATCH /tasks/:id) and the contact workspace
 * (contact tasks and reminders, PATCH /contacts/:id/activities/:aid), which
 * accept the same edit body (server/src/domain/tasks.ts).
 */

export type TaskPriority = "LOW" | "MEDIUM" | "HIGH";
export type TaskKind = "TASK" | "REMINDER";

export interface TaskFormValues {
  title: string;
  details: string;
  /** "YYYY-MM-DD" or "". */
  due: string;
  priority: TaskPriority;
  /** User id; "" = the person saving ("Assign to me"). */
  assignee: string;
  /** Status: complete (edit mode only). */
  done: boolean;
}

const PRIORITIES: readonly string[] = ["LOW", "MEDIUM", "HIGH"];
const asPriority = (p: string | null | undefined): TaskPriority => (p && PRIORITIES.includes(p) ? (p as TaskPriority) : "MEDIUM");
/** Due dates are calendar days stored at UTC midnight: keep the day key. */
const dueKey = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");

/** Blank form for a new task. */
export function newTaskValues(meId: string): TaskFormValues {
  return { title: "", details: "", due: "", priority: "MEDIUM", assignee: meId, done: false };
}

/** A Dashboard task (GET /tasks/:id) as form values. */
export function dashTaskValues(t: {
  title: string; details?: string | null; dueDate: string | null; priority: string | null;
  assignedTo: { id: string } | null; completedAt?: string | null;
}): TaskFormValues {
  return {
    title: t.title, details: t.details ?? "", due: dueKey(t.dueDate), priority: asPriority(t.priority),
    assignee: t.assignedTo?.id ?? "", done: !!t.completedAt,
  };
}

/** A contact task / reminder (GET /contacts/:id/activities) as form values.
 *  Its note is always the body; older rows without a title use it as one. */
export function contactTaskValues(a: {
  title: string | null; body: string; dueDate: string | null; priority: string | null;
  assignedTo: { id: string } | null; createdBy: { id: string } | null; completedAt: string | null;
}): TaskFormValues {
  return {
    title: a.title ?? a.body, details: a.body, due: dueKey(a.dueDate), priority: asPriority(a.priority),
    // Unassigned rows belong to their author (the same owner rule as the server).
    assignee: a.assignedTo?.id ?? a.createdBy?.id ?? "", done: !!a.completedAt,
  };
}

/** The edit body both task endpoints accept. Reminders carry no priority,
 *  assignee or status in the form, so those stay untouched. */
export function taskEditBody(kind: TaskKind, v: TaskFormValues): Record<string, unknown> {
  return {
    title: v.title.trim(),
    details: v.details.trim() || null,
    dueDate: v.due || null,
    ...(kind === "TASK" ? { priority: v.priority, assignedToId: v.assignee || null, completed: v.done } : {}),
  };
}

/** Whether the form differs from what it opened with (unsaved changes). */
export function taskFormChanged(a: TaskFormValues, b: TaskFormValues): boolean {
  return a.title.trim() !== b.title.trim() || a.details.trim() !== b.details.trim() || a.due !== b.due
    || a.priority !== b.priority || a.assignee !== b.assignee || a.done !== b.done;
}

/** What a save still needs, or null when the form can be saved. */
export function taskFormMissing(v: TaskFormValues, rules: { detailsRequired?: boolean; dueRequired?: boolean }): string | null {
  if (!v.title.trim()) return "title";
  if (rules.detailsRequired && !v.details.trim()) return "details";
  if (rules.dueRequired && !v.due) return "due date";
  return null;
}
