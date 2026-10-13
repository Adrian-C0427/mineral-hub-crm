import { useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { Modal, Req } from "./ui";
import { Select } from "./Select";
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
 * contact workspace). Edit mode adds the task's status. Reminders keep to the
 * fields they are created with: title, note and date.
 *
 * `onSubmit` saves (and closes on success); an ApiError's message is shown
 * in the form so nothing typed is lost.
 */
export function TaskFormModal({
  mode, kind = "TASK", initial, users, assigneeName, detailsRequired = false, dueRequired = false, subtitle, onClose, onSubmit,
}: {
  mode: "create" | "edit";
  kind?: TaskKind;
  initial: TaskFormValues;
  users: { id: string; name: string }[];
  /** Label for an assignee missing from `users` (e.g. no longer listed). */
  assigneeName?: string | null;
  /** Contact tasks/reminders carry a required note; standalone tasks don't. */
  detailsRequired?: boolean;
  /** Standalone tasks always have a due date. */
  dueRequired?: boolean;
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

  const options = [
    { value: user?.id ?? "", label: `Me (${user?.name ?? "you"})` },
    ...users.filter((u) => u.id !== user?.id).map((u) => ({ value: u.id, label: u.name })),
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

  const due = (
    <div className="field" style={isTask ? undefined : { marginBottom: 0 }}><label>Due date {dueRequired && <Req />}</label>
      <DateField value={v.due} onChange={(d) => set("due", d)} ariaLabel="Due date" />
    </div>
  );
  return (
    <Modal
      title={editing ? `Edit ${noun}` : `New ${noun}`}
      subtitle={subtitle}
      onClose={onClose}
      dirty={taskFormChanged(v, initial)}
      footer={
        <>
          <span className="modal-req-note"><Req /> Required</span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={!ready || busy}>
            {editing ? (busy ? "Saving…" : "Save changes") : (busy ? "Creating…" : `Create ${noun}`)}
          </button>
        </>
      }>
      <div className="field"><label>{isTask ? "Task" : "Reminder"} <Req /></label>
        <input value={v.title} onChange={(e) => set("title", e.target.value)} autoFocus maxLength={200}
          placeholder={isTask ? "e.g. Call the title company about the Leon closing" : "Remind me to…"} />
      </div>
      <div className="field"><label>Details {detailsRequired && <Req />}</label>
        <textarea rows={3} value={v.details} onChange={(e) => set("details", e.target.value)}
          placeholder={isTask ? "Anything the assignee should know" : "Note — details…"} />
      </div>
      {isTask ? (
        <>
          <div className="dash-task-form-row">
            <div className="field"><label>Assign to</label>
              <Select value={v.assignee || user?.id || ""} onChange={(id) => set("assignee", id || user?.id || "")} options={options}
                searchable={options.length > 8} ariaLabel="Assign to" />
            </div>
            {due}
          </div>
          <div className="field" style={editing ? undefined : { marginBottom: 0 }}><label>Priority</label>
            <Segmented accent className="dash-pri-seg" ariaLabel="Priority" value={v.priority} onChange={(p) => set("priority", p)}
              options={PRIORITY_CHOICES.map((p) => ({ value: p.key, label: p.label, dot: TASK_PRIORITY_META[p.key].dot }))} />
          </div>
          {editing && (
            <div className="field" style={{ marginBottom: 0 }}><label>Status</label>
              <Segmented accent className="dash-pri-seg" ariaLabel="Status" value={v.done ? "DONE" : "OPEN"} onChange={(s) => set("done", s === "DONE")}
                options={[{ value: "OPEN", label: "Open", dot: "var(--ink-3)" }, { value: "DONE", label: "Completed", dot: "var(--success)" }]} />
            </div>
          )}
        </>
      ) : due}
      {error && <div className="error-text" style={{ marginTop: 12 }}>{error}</div>}
    </Modal>
  );
}
