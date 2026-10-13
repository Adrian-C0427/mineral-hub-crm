import { prisma } from "../db.js";
import { HttpError } from "../middleware/errors.js";
import {
  planTaskEdit, taskAssignedNotice, taskDueNotice,
  type TaskAlertRow, type TaskEdit, type TaskState, type TaskUpdate,
} from "../domain/tasks.js";

/**
 * Apply an edit from the task form to one task or reminder — the single write
 * path behind both PATCH /api/tasks/:id (Dashboard) and PATCH
 * /api/contacts/:id/activities/:aid (contact workspace). The caller has
 * already found the row inside its org and checked the caller may change it;
 * `save` writes the planned columns with the caller's own select/include so
 * each route answers in its usual shape.
 *
 * Side effects, kept consistent with the edit:
 *  - the task's `task_due` alert (written by the alert sweep) is rewritten in
 *    place for a new title / date / owner, or retired once the task is
 *    complete or no longer due — never duplicated, never left pointing at the
 *    old date or the old owner;
 *  - reassigning a standalone task to a teammate notifies them, as creating
 *    one does (contact tasks never notified on create, so they don't here).
 */
export async function editTask<T>(args: {
  org: string;
  editor: { id: string; name: string };
  task: TaskState & Pick<TaskAlertRow, "id" | "contact">;
  edit: TaskEdit;
  save: (data: TaskUpdate) => Promise<T>;
  now?: Date;
}): Promise<{ saved: T; notified: boolean }> {
  const { org, editor, task, edit } = args;
  const now = args.now ?? new Date();
  const plan = planTaskEdit(task, edit, { editorId: editor.id, now });
  if (!plan.ok) throw new HttpError(400, plan.error);
  if (plan.data.assignedToId) {
    const u = await prisma.user.findFirst({ where: { id: plan.data.assignedToId, organizationId: org }, select: { id: true } });
    if (!u) throw new HttpError(400, "Assignee is not in your organization");
  }

  const saved = await args.save(plan.data);
  const after = { ...task, ...plan.data };
  const ownerChanged = plan.ownerAfter !== plan.ownerBefore;

  // Only TASK rows get due alerts (see services/dealAlerts.ts).
  if (task.kind === "TASK" && plan.alertsStale) {
    const where = { organizationId: org, type: "task_due", link: { contains: `task=${task.id}` } };
    const notice = taskDueNotice(after, now);
    if (!notice) {
      await prisma.notification.deleteMany({ where });
    } else {
      // Rewrite the existing alert (if the sweep has written one) rather than
      // adding another; a new owner sees it as unread.
      await prisma.notification.updateMany({
        where,
        data: { title: notice.title, body: notice.body, userId: notice.userId, ...(ownerChanged ? { readAt: null, hiddenForUserIds: [] } : {}) },
      });
    }
  }

  let notified = false;
  if (task.kind === "TASK" && task.contactId == null && ownerChanged && plan.ownerAfter && plan.ownerAfter !== editor.id) {
    const n = taskAssignedNotice({ id: task.id, title: after.title ?? after.body, priority: after.priority, dueDate: after.dueDate, contactId: null }, editor.name);
    await prisma.notification.create({ data: { organizationId: org, userId: plan.ownerAfter, ...n } });
    notified = true;
  }
  return { saved, notified };
}
