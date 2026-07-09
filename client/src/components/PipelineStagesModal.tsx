import { useEffect, useState } from "react";
import { Modal, ConfirmDialog } from "./ui";
import { api } from "../api/client";
import type { PipelineStage } from "../types";

/**
 * Admin editor for the org's pipeline stages: rename, reorder, add, and remove
 * the active stages. Closed and Dead are permanent system stages (shown locked).
 * Every change persists immediately and refreshes the board via onChanged.
 */
export function PipelineStagesModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PipelineStage | null>(null);
  // Local active-stage order so drag reordering feels instant; persisted on drop.
  const [order, setOrder] = useState<PipelineStage[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  useEffect(() => { api.get<PipelineStage[]>("/pipeline/stages").then(setStages).catch(() => {}); }, []);
  useEffect(() => { setOrder(stages.filter((s) => !s.isTerminal)); }, [stages]);

  const terminal = stages.filter((s) => s.isTerminal);

  async function apply(fn: () => Promise<PipelineStage[]>) {
    setBusy(true); setErr(null);
    try { setStages(await fn()); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  const rename = (s: PipelineStage, label: string) => {
    const v = label.trim();
    if (!v || v === s.label) return;
    apply(() => api.patch<PipelineStage[]>(`/pipeline/stages/${s.id}`, { label: v }));
  };
  const add = () => {
    if (!newLabel.trim()) return;
    apply(async () => { const r = await api.post<PipelineStage[]>("/pipeline/stages", { label: newLabel.trim() }); setNewLabel(""); return r; });
  };
  // Drag a stage to a new position (reorder the active stages) and persist.
  function commitReorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length || busy) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next); // optimistic — the board updates instantly, then we persist
    apply(() => api.post<PipelineStage[]>("/pipeline/stages/reorder", { order: next.map((s) => s.id) }));
  }
  function onDrop(target: number) {
    if (dragIdx != null) commitReorder(dragIdx, target);
    setDragIdx(null); setOverIdx(null);
  }

  return (
    <Modal title="Customize pipeline stages" onClose={onClose} footer={<button className="primary" onClick={onClose}>Done</button>}>
      <p className="muted" style={{ marginTop: 0 }}>
        Rename, reorder (drag by the <span aria-hidden="true">⠿</span> handle), add, or remove the active pipeline stages.
        <strong> Closed</strong> and <strong>Dead</strong> are permanent system stages and can't be changed.
      </p>
      <div className="stage-editor">
        {order.map((s, i) => (
          <div key={s.id}
            onDragOver={(e) => { if (dragIdx == null) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overIdx !== i) setOverIdx(i); }}
            onDrop={(e) => { e.preventDefault(); onDrop(i); }}
            className={`stage-row ${dragIdx === i ? "dragging" : ""} ${overIdx === i && dragIdx !== null && dragIdx !== i ? "drop-over" : ""}`}
          >
            {/* Only the handle is draggable, so clicking into the rename field
                never starts a drag. */}
            <span className="stage-drag" title="Drag to reorder" aria-label="Drag to reorder"
              draggable={!busy}
              onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
            >⠿</span>
            <input defaultValue={s.label} disabled={busy} onBlur={(e) => rename(s, e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            <button type="button" className="stage-del" disabled={busy || order.length <= 1}
              title={order.length <= 1 ? "At least one active stage is required" : "Remove stage"}
              onClick={() => setConfirmDelete(s)}>×</button>
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="New stage name" disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} style={{ maxWidth: 240 }} />
        <button type="button" className="small" disabled={!newLabel.trim() || busy} onClick={add}>+ Add stage</button>
      </div>
      <div className="stage-terminal">
        {terminal.map((s) => <span key={s.id} className="badge resp-pending">{s.label} · permanent</span>)}
      </div>
      {err && <div className="error-text">{err}</div>}

      {confirmDelete && (
        <ConfirmDialog
          title={`Remove "${confirmDelete.label}"?`}
          confirmLabel="Remove stage"
          danger
          busy={busy}
          message={<>Any deals currently in <strong>{confirmDelete.label}</strong> move to the first active stage. This can't be undone.</>}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => { await apply(() => api.del<PipelineStage[]>(`/pipeline/stages/${confirmDelete.id}`)); setConfirmDelete(null); }}
        />
      )}
    </Modal>
  );
}
