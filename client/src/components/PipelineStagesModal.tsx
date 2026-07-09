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

  useEffect(() => { api.get<PipelineStage[]>("/pipeline/stages").then(setStages).catch(() => {}); }, []);

  const active = stages.filter((s) => !s.isTerminal);
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
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= active.length || busy) return;
    const order = active.map((s) => s.id);
    [order[i], order[j]] = [order[j], order[i]];
    apply(() => api.post<PipelineStage[]>("/pipeline/stages/reorder", { order }));
  };

  return (
    <Modal title="Customize pipeline stages" onClose={onClose} footer={<button className="primary" onClick={onClose}>Done</button>}>
      <p className="muted" style={{ marginTop: 0 }}>
        Rename, reorder, add, or remove the active pipeline stages. <strong>Closed</strong> and <strong>Dead</strong> are
        permanent system stages and can't be changed.
      </p>
      <div className="stage-editor">
        {active.map((s, i) => (
          <div key={s.id} className="stage-row">
            <span className="stage-move">
              <button type="button" className="icon-btn" disabled={i === 0 || busy} title="Move up" onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="icon-btn" disabled={i === active.length - 1 || busy} title="Move down" onClick={() => move(i, 1)}>↓</button>
            </span>
            <input defaultValue={s.label} disabled={busy} onBlur={(e) => rename(s, e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            <button type="button" className="stage-del" disabled={busy || active.length <= 1}
              title={active.length <= 1 ? "At least one active stage is required" : "Remove stage"}
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
