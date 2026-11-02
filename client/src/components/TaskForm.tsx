import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Bell, CalendarDays, Check, ChevronRight, CircleCheck, Clock, Flag, User } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { Modal, Req } from "./ui";
import { Select, type SelectOption } from "./Select";
import { UserAvatar, userOptions } from "./UserAvatar";
import { Segmented } from "./kit";
import { DateField } from "./DateField";
import { taskFormChanged, taskFormMissing, type TaskFormValues, type TaskKind, type TaskPriority } from "../lib/tasks";

/** Priority label, tag tone and dot colour — shared by every task list. */
export const TASK_PRIORITY_META: Record<string, { label: string; tone: "danger" | "warn" | "neutral"; dot: string }> = {
  HIGH: { label: "High", tone: "danger", dot: "var(--danger)" },
  MEDIUM: { label: "Medium", tone: "warn", dot: "var(--warn)" },
  LOW: { label: "Low", tone: "neutral", dot: "var(--ink-3)" },
};
const PRIORITY_CHOICES: { key: TaskPriority; label: string }[] = [
  { key: "LOW", label: "Low" }, { key: "MEDIUM", label: "Medium" }, { key: "HIGH", label: "High" },
];

/**
 * The task form — one modal for creating a task and for editing an existing
 * task or reminder anywhere it appears (Dashboard, task notifications, the
 * contact workspace). Laid out as the design's task composer: the task as a
 * large title with its details underneath, then one labelled row per property
 * (assignee, due date, priority; edit mode adds the status). Reminders keep to
 * the fields they are created with: title, note and date.
 *
 * `onSubmit` saves (and closes on success); an ApiError's message is shown
 * in the form so nothing typed is lost. ⌘/Ctrl+Enter saves too.
 */
export function TaskFormModal({
  mode, kind = "TASK", initial, users, assigneeName, detailsRequired = false, dueRequired = false, notifyAssignee = false, subtitle, onClose, onSubmit,
}: {
  mode: "create" | "edit";
  kind?: TaskKind;
  initial: TaskFormValues;
  users: { id: string; name: string; firstName?: string | null }[];
  /** Label for an assignee missing from `users` (e.g. no longer listed). */
  assigneeName?: string | null;
  /** Contact tasks/reminders carry a required note; standalone tasks don't. */
  detailsRequired?: boolean;
  /** Standalone tasks always have a due date. */
  dueRequired?: boolean;
  /** Saving notifies a teammate the task is newly assigned to (standalone
   *  Dashboard tasks) — the footer says who. */
  notifyAssignee?: boolean;
  /** Context line for the footer (e.g. the contact the task is on). */
  subtitle?: ReactNode;
  onClose: () => void;
  onSubmit: (values: TaskFormValues) => Promise<void>;
}) {
  const { user } = useAuth();
  const [v, setV] = useState<TaskFormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof TaskFormValues>(k: K, val: TaskFormValues[K]) => setV((cur) => ({ ...cur, [k]: val }));
  const isTask = kind === "TASK";
  const editing = mode === "edit";
  const noun = isTask ? "task" : "reminder";
  const ready = taskFormMissing(v, { detailsRequired, dueRequired }) == null;

  const options: SelectOption[] = [
    { value: user?.id ?? "", label: `${user?.name ?? "Me"} (you)`, icon: <UserAvatar user={user} size={18} /> },
    ...userOptions(users.filter((u) => u.id !== user?.id)),
  ];
  if (v.assignee && !options.some((o) => o.value === v.assignee)) options.push({ value: v.assignee, label: assigneeName ?? "Current assignee" });

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(v);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `Could not ${editing ? "save" : "create"} the ${noun}`);
    } finally { setBusy(false); }
  }

  // Footer line: who a save notifies (the same rule as the server — a
  // standalone task newly assigned to someone else), else the caller's context.
  const meId = user?.id ?? "";
  const assignee = v.assignee || meId;
  const newlyAssigned = assignee !== meId && (!editing || assignee !== (initial.assignee || meId));
  const assigneeFirst = (() => {
    const u = users.find((x) => x.id === assignee);
    return u?.firstName?.trim() || (u?.name ?? assigneeName ?? "").trim().split(/\s+/)[0] || "Your teammate";
  })();
  const note: { icon: ReactNode; text: ReactNode } | null =
    isTask && notifyAssignee && newlyAssigned ? { icon: <Bell size={13} />, text: `${assigneeFirst} will be notified when you ${editing ? "save" : "create"} this` }
    : isTask && notifyAssignee && !editing ? { icon: <User size={13} />, text: "On your task list — no one is notified" }
    : subtitle ? { icon: null, text: subtitle }
    : null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
  };
  const crumb = (
    <span className="tf-crumb">
      <span className="tf-crumb-ico" aria-hidden="true">{isTask ? <Check size={13} strokeWidth={2.4} /> : <Clock size={13} strokeWidth={2.2} />}</span>
      <span className="tf-crumb-root">{isTask ? "Tasks" : "Reminders"}</span>
      <ChevronRight size={13} className="tf-crumb-sep" aria-hidden="true" />
      <span className="tf-crumb-leaf">{editing ? `Edit ${noun}` : `New ${noun}`}</span>
    </span>
  );
  return (
    <Modal
      title={crumb}
      onClose={onClose}
      dirty={taskFormChanged(v, initial)}
      footer={
        <>
          <span className="tf-note">{note && <>{note.icon}<span>{note.text}</span></>}</span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={!ready || busy}>
            {editing ? (busy ? "Saving…" : "Save changes") : (busy ? "Creating…" : `Create ${noun}`)}
          </button>
        </>
      }>
      <div className="tf-dlg" onKeyDown={onKeyDown}>
        <div className="tf-write">
          <input className="tf-title" value={v.title} onChange={(e) => set("title", e.target.value)} autoFocus maxLength={200}
            placeholder={isTask ? "What needs to be done?" : "Remind me to…"} aria-label={isTask ? "Task" : "Reminder"} aria-required="true" />
          <textarea className="tf-details" rows={3} value={v.details} onChange={(e) => set("details", e.target.value)}
            placeholder={isTask ? `Add details, context or links for the assignee…${detailsRequired ? " (required)" : ""}` : "Add a note… (required)"}
            aria-label="Details" aria-required={detailsRequired || undefined} />
        </div>
        <div className="tf-props">
          {isTask && (
            <div className="tf-prop">
              <span className="tf-prop-label"><User size={14} aria-hidden="true" />Assignee</span>
              <Select value={v.assignee || user?.id || ""} onChange={(id) => set("assignee", id || user?.id || "")} options={options}
                searchable={options.length > 8} ariaLabel="Assignee" />
            </div>
          )}
          <div className="tf-prop">
            <span className="tf-prop-label"><CalendarDays size={14} aria-hidden="true" />Due date {dueRequired && <Req />}</span>
            <DateField value={v.due} onChange={(d) => set("due", d)} ariaLabel="Due date" placeholder="Select date" />
          </div>
          {isTask && (
            <div className="tf-prop">
              <span className="tf-prop-label"><Flag size={14} aria-hidden="true" />Priority</span>
              <Segmented className="tf-seg" ariaLabel="Priority" value={v.priority} onChange={(p) => set("priority", p)}
                options={PRIORITY_CHOICES.map((p) => ({ value: p.key, label: p.label, dot: TASK_PRIORITY_META[p.key].dot }))} />
            </div>
          )}
          {isTask && editing && (
            <div className="tf-prop">
              <span className="tf-prop-label"><CircleCheck size={14} aria-hidden="true" />Status</span>
              <Segmented className="tf-seg" ariaLabel="Status" value={v.done ? "DONE" : "OPEN"} onChange={(st) => set("done", st === "DONE")}
                options={[{ value: "OPEN", label: "Open", dot: "var(--ink-3)" }, { value: "DONE", label: "Completed", dot: "var(--success)" }]} />
            </div>
          )}
          {error && <div className="error-text tf-error">{error}</div>}
        </div>
      </div>
    </Modal>
  );
}
