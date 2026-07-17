import { useState, type ReactNode } from "react";
import { api } from "../api/client";
import { ConfirmDelete, ConfirmDialog, Modal, Banner } from "./ui";
import { AssigneePicker } from "./AssigneePicker";
import type { UserLite } from "../types";

/** Row-selection state shared by every bulk-enabled list. */
export function useRowSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = (ids: string[]) =>
    setSelected((p) => (ids.length > 0 && ids.every((i) => p.has(i))
      ? new Set([...p].filter((i) => !ids.includes(i)))   // all shown selected → clear them
      : new Set([...p, ...ids])));                          // else select all shown
  const clear = () => setSelected(new Set());
  return { selected, toggle, toggleAll, clear };
}

/** Floating action bar shown when one or more rows are selected. */
export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="bulk-bar">
      <strong>{count} selected</strong>
      <span className="spacer" />
      {children}
      <button className="small" onClick={onClear}>Deselect all</button>
    </div>
  );
}

/**
 * Standard bulk-actions bar for a list. Renders only the actions whose endpoints
 * are provided. Assign posts { ids, [assignKey]: ids }; delete uses the shared
 * type-DELETE confirmation stating the count.
 */
export function BulkActionsBar({
  selectedIds, onClear, onDone, users, itemLabel, deleteUrl, assign, archiveUrl, onExport,
}: {
  selectedIds: string[];
  onClear: () => void;
  onDone: () => void;
  users: UserLite[];
  itemLabel: string;
  deleteUrl?: string;
  assign?: { url: string; key: string };
  archiveUrl?: string;
  onExport?: () => void;
}) {
  const [modal, setModal] = useState<"delete" | "assign" | "archive" | null>(null);
  const [assignIds, setAssignIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = selectedIds.length;

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); setModal(null); onClear(); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
    finally { setBusy(false); }
  }

  return (
    <>
      <BulkBar count={count} onClear={onClear}>
        {assign && <button className="small" onClick={() => { setAssignIds([]); setModal("assign"); }}>Assign users</button>}
        {onExport && <button className="small" onClick={onExport}>Export</button>}
        {archiveUrl && <button className="small" onClick={() => setModal("archive")}>Archive</button>}
        {deleteUrl && <button className="small danger" onClick={() => setModal("delete")}>Delete</button>}
      </BulkBar>

      {modal === "delete" && deleteUrl && (
        <ConfirmDelete
          count={count} itemLabel={itemLabel} busy={busy}
          onCancel={() => setModal(null)}
          onConfirm={() => run(async () => { await api.post(deleteUrl, { ids: selectedIds }); })}
        />
      )}
      {modal === "archive" && archiveUrl && (
        <ConfirmDialog
          title="Archive records?"
          message={<p style={{ margin: 0 }}>Move <strong>{count} {itemLabel}{count === 1 ? "" : "s"}</strong> to Archived (Dead)?</p>}
          confirmLabel="Archive" busy={busy}
          onCancel={() => setModal(null)}
          onConfirm={() => run(async () => { await api.post(archiveUrl, { ids: selectedIds }); })}
        />
      )}
      {modal === "assign" && assign && (
        <Modal
          title={`Assign ${count} ${itemLabel}${count === 1 ? "" : "s"}`}
          onClose={() => setModal(null)}
          footer={<><button className="small" onClick={() => setModal(null)}>Cancel</button>
            <button className="primary" disabled={busy} onClick={() => run(async () => { await api.post(assign.url, { ids: selectedIds, [assign.key]: assignIds }); })}>Apply</button></>}
        >
          <p className="muted" style={{ marginTop: 0 }}>Set the assigned team members for all selected records. This replaces existing assignments.</p>
          <AssigneePicker users={users} value={assignIds} onChange={setAssignIds} />
          {error && <Banner kind="error">{error}</Banner>}
        </Modal>
      )}
      {error && modal !== "assign" && <Banner kind="error">{error}</Banner>}
    </>
  );
}
