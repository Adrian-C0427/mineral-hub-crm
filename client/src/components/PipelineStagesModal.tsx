import { useEffect, useState } from "react";
import { Modal, ConfirmDialog } from "./ui";
import { api } from "../api/client";
import type { PipelineInfo } from "../stages";
import type { PipelineStage } from "../types";

/**
 * Admin editor for ONE pipeline: rename the pipeline itself, rename/reorder/
 * add/remove its active stages, and delete the pipeline (user-created only).
 * Closed and Dead are permanent system stages in every pipeline (shown locked).
 * Every change persists immediately and refreshes the board via onChanged.
 */
export function PipelineStagesModal({ pipeline, onClose, onChanged, onPipelineDeleted }: {
  pipeline: PipelineInfo;
  onClose: () => void;
  onChanged: () => void;
  onPipelineDeleted: () => void;
}) {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [name, setName] = useState(pipeline.name);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PipelineStage | null>(null);
  const [confirmDeletePipeline, setConfirmDeletePipeline] = useState(false);
  // Local active-stage order so drag reordering feels instant; persisted on drop.
  const [order, setOrder] = useState<PipelineStage[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const pid = pipeline.id;
  useEffect(() => { api.get<PipelineStage[]>(`/pipeline/stages?pipelineId=${encodeURIComponent(pid)}`).then(setStages).catch(() => {}); }, [pid]);
  useEffect(() => { setOrder(stages.filter((s) => !s.isTerminal)); }, [stages]);

  async function apply(fn: () => Promise<PipelineStage[]>) {
    setBusy(true); setErr(null);
    try { setStages(await fn()); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  const renamePipeline = async (value: string) => {
    const v = value.trim();
    if (!v || v === pipeline.name) return;
    setBusy(true); setErr(null);
    try { await api.patch(`/pipeline/pipelines/${pid}`, { name: v }); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  };

  const rename = (s: PipelineStage, label: string) => {
    const v = label.trim();
    if (!v || v === s.label) return;
    apply(() => api.patch<PipelineStage[]>(`/pipeline/stages/${s.id}`, { label: v }));
  };
  const add = () => {
    if (!newLabel.trim()) return;
    apply(async () => { const r = await api.post<PipelineStage[]>("/pipeline/stages", { label: newLabel.trim(), pipelineId: pid }); setNewLabel(""); return r; });
  };
  // Drag a stage to a new position (reorder the active stages) and persist.
  function commitReorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length || busy) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next); // optimistic — the board updates instantly, then we persist
    apply(() => api.post<PipelineStage[]>("/pipeline/stages/reorder", { order: next.map((s) => s.id), pipelineId: pid }));
  }
  function onDrop(target: number) {
    if (dragIdx != null) commitReorder(dragIdx, target);
    setDragIdx(null); setOverIdx(null);
  }

  return (
    <Modal title="Customize pipeline" onClose={onClose} footer={<button className="primary" onClick={onClose}>Done</button>}>
      {/* The pipeline itself: rename any pipeline; delete only user-created ones. */}
      <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 14 }}>
        <label style={{ margin: 0, whiteSpace: "nowrap" }}>Pipeline name</label>
        <input value={name} disabled={busy} onChange={(e) => setName(e.target.value)}
          onBlur={(e) => renamePipeline(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} style={{ maxWidth: 260 }} />
        {!pipeline.isDefault && (
          <button type="button" className="small danger" disabled={busy} onClick={() => setConfirmDeletePipeline(true)} style={{ marginLeft: "auto" }}>
            Delete pipeline
          </button>
        )}
      </div>

      {/* Closed and Dead are permanent system stages — they keep working as
          always but are deliberately absent here since they can't be modified. */}
      <p className="muted" style={{ marginTop: 0 }}>
        Rename, reorder (drag by the <span aria-hidden="true">⠿</span> handle), add, or remove this pipeline's active stages.
        Closed and Dead are always present and cannot be changed.
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

      {confirmDeletePipeline && (
        <ConfirmDialog
          title={`Delete "${pipeline.name}"?`}
          confirmLabel="Delete pipeline"
          danger
          busy={busy}
          message={<>Deals in this pipeline move to your default pipeline (Closed and Dead deals keep their status; active deals restart in its first stage). This can't be undone.</>}
          onCancel={() => setConfirmDeletePipeline(false)}
          onConfirm={async () => {
            setBusy(true); setErr(null);
            try { await api.del(`/pipeline/pipelines/${pid}`); setConfirmDeletePipeline(false); onPipelineDeleted(); }
            catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); setBusy(false); setConfirmDeletePipeline(false); }
          }}
        />
      )}
    </Modal>
  );
}
