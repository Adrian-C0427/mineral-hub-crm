import { useEffect, useState } from "react";
import { Modal, ConfirmDialog, showToast } from "./ui";
import { api } from "../api/client";
import { stageColor, type PipelineInfo } from "../stages";
import type { PipelineStage } from "../types";

/**
 * Pipeline Settings — the single home for ALL pipeline configuration:
 * create / rename / delete / reorder pipelines, and configure each pipeline's
 * stages (add, rename, reorder, remove, and per-stage colors). Day-to-day
 * board work stays on the Pipeline page; administration lives here.
 */
export function PipelineSettingsModal({ pipelines, initialId, onClose, onChanged }: {
  pipelines: PipelineInfo[];
  /** Pipeline to open with (the board's current selection). */
  initialId: string;
  onClose: () => void;
  /** Reload pipelines/stages/deals after any persisted change. */
  onChanged: () => void;
}) {
  const [selId, setSelId] = useState(initialId || (pipelines[0]?.id ?? ""));
  const sel = pipelines.find((p) => p.id === selId) ?? pipelines[0];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [confirmDeletePipeline, setConfirmDeletePipeline] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  const createPipeline = () => {
    const name = newPipelineName.trim();
    if (!name) return;
    void run(async () => {
      const p = await api.post<{ id: string }>("/pipeline/pipelines", { name });
      setNewPipelineName("");
      setSelId(p.id);
      showToast(`Pipeline "${name}" created — it starts blank; add its stages below.`);
    });
  };

  // Drag-and-drop pipeline ordering (same interaction as the stage editor):
  // drag any row onto another and the list re-saves immediately.
  const [dragPipeline, setDragPipeline] = useState<string | null>(null);
  const [dropPipeline, setDropPipeline] = useState<string | null>(null);
  const reorderPipelines = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const ids = pipelines.map((p) => p.id).filter((id) => id !== fromId);
    ids.splice(ids.indexOf(toId), 0, fromId);
    void run(async () => { await api.post("/pipeline/pipelines/reorder", { order: ids }); });
  };

  return (
    <Modal title="Pipeline settings" onClose={onClose} wide footer={<button className="primary" onClick={onClose}>Done</button>}>
      <div className="pls-grid">
        {/* ------------------------------------------------ pipelines pane */}
        <div className="pls-list">
          <div className="ddx-label" style={{ marginBottom: 8 }}>Pipelines</div>
          {pipelines.map((p) => (
            <div key={p.id}
              className={`pls-row ${p.id === sel?.id ? "active" : ""} ${dropPipeline === p.id ? "drop-target" : ""} ${dragPipeline === p.id ? "dragging" : ""}`}
              onClick={() => setSelId(p.id)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") setSelId(p.id); }}
              draggable={!busy}
              onDragStart={(e) => { setDragPipeline(p.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { if (dragPipeline && dragPipeline !== p.id) { e.preventDefault(); setDropPipeline(p.id); } }}
              onDragLeave={() => setDropPipeline((t) => (t === p.id ? null : t))}
              onDrop={(e) => { e.preventDefault(); setDropPipeline(null); if (dragPipeline) reorderPipelines(dragPipeline, p.id); setDragPipeline(null); }}
              onDragEnd={() => { setDragPipeline(null); setDropPipeline(null); }}
              title="Drag to reorder pipelines"
            >
              <span className="stage-drag" aria-hidden="true">⠿</span>
              <span className="pls-row-dot" style={{ background: stageColor(p.stages, p.stages.find((s) => !s.isTerminal)?.key ?? "") }} />
              <span className="pls-row-name">{p.name}</span>
              {p.isDefault && <span className="pls-default">Default</span>}
            </div>
          ))}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <input value={newPipelineName} onChange={(e) => setNewPipelineName(e.target.value)} placeholder="New pipeline name" disabled={busy}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); createPipeline(); } }} />
            <button type="button" className="small" disabled={!newPipelineName.trim() || busy} onClick={createPipeline}>+ Create</button>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
            New pipelines start blank — Closed and Dead are always included automatically.
          </p>
        </div>

        {/* ------------------------------------------------ selected pipeline */}
        {sel && (
          <StagePane
            key={sel.id}
            pipeline={sel}
            busy={busy}
            setBusy={setBusy}
            setErr={setErr}
            onChanged={onChanged}
            onDeleteRequested={() => setConfirmDeletePipeline(true)}
          />
        )}
      </div>
      {err && <div className="error-text">{err}</div>}

      {confirmDeletePipeline && sel && (
        <ConfirmDialog
          title={`Delete "${sel.name}"?`}
          confirmLabel="Delete pipeline"
          danger
          busy={busy}
          message={<>Deals in this pipeline move to your default pipeline (Closed and Dead deals keep their status; active deals restart in its first stage). This can't be undone.</>}
          onCancel={() => setConfirmDeletePipeline(false)}
          onConfirm={() => {
            setConfirmDeletePipeline(false);
            void run(async () => { await api.del(`/pipeline/pipelines/${sel.id}`); setSelId(""); showToast("Pipeline deleted."); });
          }}
        />
      )}
    </Modal>
  );
}

/** Right pane: name, delete, and the stage editor (labels, order, colors). */
function StagePane({ pipeline, busy, setBusy, setErr, onChanged, onDeleteRequested }: {
  pipeline: PipelineInfo;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setErr: (e: string | null) => void;
  onChanged: () => void;
  onDeleteRequested: () => void;
}) {
  const pid = pipeline.id;
  const [stages, setStages] = useState<PipelineStage[]>(pipeline.stages);
  const [name, setName] = useState(pipeline.name);
  const [newLabel, setNewLabel] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<PipelineStage | null>(null);
  // Local active-stage order so drag reordering feels instant; persisted on drop.
  const [order, setOrder] = useState<PipelineStage[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

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
  const recolor = (s: PipelineStage, color: string) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(color) || color === s.color) return;
    // Optimistic: the swatch reflects immediately; the board refreshes on save.
    setStages((prev) => prev.map((x) => (x.id === s.id ? { ...x, color } : x)));
    apply(() => api.patch<PipelineStage[]>(`/pipeline/stages/${s.id}`, { color }));
  };
  const add = () => {
    if (!newLabel.trim()) return;
    apply(async () => { const r = await api.post<PipelineStage[]>("/pipeline/stages", { label: newLabel.trim(), pipelineId: pid }); setNewLabel(""); return r; });
  };
  function commitReorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length || busy) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    apply(() => api.post<PipelineStage[]>("/pipeline/stages/reorder", { order: next.map((s) => s.id), pipelineId: pid }));
  }
  function onDrop(target: number) {
    if (dragIdx != null) commitReorder(dragIdx, target);
    setDragIdx(null); setOverIdx(null);
  }

  return (
    <div className="pls-pane">
      <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 14 }}>
        <label style={{ margin: 0, whiteSpace: "nowrap" }}>Pipeline name</label>
        <input value={name} disabled={busy} onChange={(e) => setName(e.target.value)}
          onBlur={(e) => renamePipeline(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} style={{ maxWidth: 240 }} />
        {!pipeline.isDefault && (
          <button type="button" className="small danger" disabled={busy} onClick={onDeleteRequested} style={{ marginLeft: "auto" }}>
            Delete pipeline
          </button>
        )}
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        Rename, reorder (drag by the <span aria-hidden="true">⠿</span> handle), recolor, add, or remove this pipeline's
        active stages. Closed and Dead are always present and cannot be changed.
      </p>
      {order.length === 0 && (
        <p className="muted" style={{ margin: "4px 0 10px" }}>
          This pipeline is blank — add your first stage below. Closed and Dead are already included.
        </p>
      )}
      <div className="stage-editor">
        {order.map((s, i) => (
          <div key={s.id}
            onDragOver={(e) => { if (dragIdx == null) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overIdx !== i) setOverIdx(i); }}
            onDrop={(e) => { e.preventDefault(); onDrop(i); }}
            className={`stage-row ${dragIdx === i ? "dragging" : ""} ${overIdx === i && dragIdx !== null && dragIdx !== i ? "drop-over" : ""}`}
          >
            <span className="stage-drag" title="Drag to reorder" aria-label="Drag to reorder"
              draggable={!busy}
              onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
            >⠿</span>
            {/* Per-stage color — reflected on the board, cards, badges, and
                dashboards immediately after save. */}
            <input type="color" className="stage-color" disabled={busy}
              value={s.color ?? stageColor(stages, s.key)}
              title="Stage color"
              aria-label={`${s.label} color`}
              onChange={(e) => recolor(s, e.target.value)} />
            <input defaultValue={s.label} disabled={busy} onBlur={(e) => rename(s, e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            <button type="button" className="stage-del" disabled={busy || (pipeline.isDefault && order.length <= 1)}
              title={pipeline.isDefault && order.length <= 1 ? "The default pipeline needs at least one active stage" : "Remove stage"}
              onClick={() => setConfirmDelete(s)}>×</button>
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="New stage name" disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} style={{ maxWidth: 240 }} />
        <button type="button" className="small" disabled={!newLabel.trim() || busy} onClick={add}>+ Add stage</button>
      </div>

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
    </div>
  );
}
