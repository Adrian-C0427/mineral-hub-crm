import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Modal, ConfirmDialog, showToast } from "./ui";
import { FormSection, Segmented } from "./kit";
import { Select } from "./Select";
import { api } from "../api/client";
import { stageColor, isOpportunityPipeline, type PipelineInfo } from "../stages";
import type { ConvertMode, PipelineKind, PipelineStage } from "../types";

const KIND_LABEL: Record<PipelineKind, string> = { OPPORTUNITIES: "Opportunities", DEALS: "Deals" };

/** Stage colour swatches offered by the colour picker (any #rrggbb is still
 *  accepted through "Custom colour", so existing colours are never lost). */
const SWATCHES = ["#3B82F6", "#8B5CF6", "#06B6D4", "#22C55E", "#F59E0B", "#EC4899", "#EF4444", "#A6A6A6"];

const Icon = ({ size = 13, sw = 1.8, children }: { size?: number; sw?: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const PlusIcon = () => <Icon sw={2}><path d="M12 5v14M5 12h14" /></Icon>;
const PencilIcon = () => <Icon><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></Icon>;
const CloseIcon = () => <Icon size={14} sw={2}><path d="M6 6l12 12M18 6L6 18" /></Icon>;
const CheckIcon = () => <Icon size={12} sw={2.8}><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>;
const LockIcon = () => <Icon><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Icon>;
const GripIcon = () => (
  <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="3" r="1.4" /><circle cx="8.5" cy="3" r="1.4" /><circle cx="3.5" cy="8" r="1.4" />
    <circle cx="8.5" cy="8" r="1.4" /><circle cx="3.5" cy="13" r="1.4" /><circle cx="8.5" cy="13" r="1.4" />
  </svg>
);

/** Enter saves, Escape cancels — and Escape stops there instead of closing the dialog. */
const editKeys = (save: () => void, cancel: () => void) => (e: ReactKeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") { e.preventDefault(); save(); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
};

/**
 * Pipeline Settings — the single home for ALL pipeline configuration:
 * create / rename / delete / reorder pipelines, and configure each pipeline's
 * stages (add, rename, reorder, remove, and per-stage colors). Day-to-day
 * board work stays on the Pipeline page; administration lives here.
 */
export function PipelineSettingsModal({ pipelines, initialId, stageCount, onClose, onChanged }: {
  pipelines: PipelineInfo[];
  /** Pipeline to open with (the board's current selection). */
  initialId: string;
  /** Records currently in a pipeline's stage (shown beside each stage); null
   *  when the caller can't count that pipeline (no label is shown). */
  stageCount?: (pipelineId: string, stageKey: string) => number | null;
  onClose: () => void;
  /** Reload pipelines/stages/deals after any persisted change. */
  onChanged: () => void;
}) {
  const [selId, setSelId] = useState(initialId || (pipelines[0]?.id ?? ""));
  const sel = pipelines.find((p) => p.id === selId) ?? pipelines[0];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addingPipeline, setAddingPipeline] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  // New pipelines default to Opportunities (prospects); Deals is the original board.
  const [newPipelineKind, setNewPipelineKind] = useState<PipelineKind>("OPPORTUNITIES");
  const [newPipelineDesc, setNewPipelineDesc] = useState("");
  const [confirmDeletePipeline, setConfirmDeletePipeline] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  const cancelNewPipeline = () => { setAddingPipeline(false); setNewPipelineName(""); setNewPipelineDesc(""); setNewPipelineKind("OPPORTUNITIES"); };
  const createPipeline = () => {
    const name = newPipelineName.trim();
    if (!name) return;
    const kind = newPipelineKind;
    void run(async () => {
      const p = await api.post<{ id: string }>("/pipeline/pipelines", { name, kind, description: newPipelineDesc.trim() || null });
      cancelNewPipeline();
      setSelId(p.id);
      showToast(kind === "OPPORTUNITIES"
        ? `Pipeline "${name}" created with the opportunity stages — adjust them below.`
        : `Pipeline "${name}" created — it starts blank; add its stages below.`);
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
      <div className="pset">
        {/* ------------------------------------------------ pipelines pane */}
        <div className="pset-list">
          <div className="pset-label">Pipelines</div>
          <div className="pset-rows">
            {pipelines.map((p) => {
              const active = p.stages.filter((s) => !s.isTerminal).length;
              return (
                <div key={p.id}
                  className={`pset-row ${p.id === sel?.id ? "active" : ""} ${dropPipeline === p.id ? "drop-target" : ""} ${dragPipeline === p.id ? "dragging" : ""}`}
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
                  <span className="pset-grip" aria-hidden="true"><GripIcon /></span>
                  <span className="pset-row-text">
                    <span className="pset-row-name">{p.name}</span>
                    <span className="pset-row-sub">{KIND_LABEL[p.kind ?? "DEALS"]} · {active} active stage{active === 1 ? "" : "s"}</span>
                  </span>
                  {p.isDefault && <span className="pset-badge">Default</span>}
                </div>
              );
            })}
          </div>
          <div className="pset-sep" />
          <div className="pset-new">
            {addingPipeline ? (
              <div className="pset-new-form">
                <input autoFocus value={newPipelineName} onChange={(e) => setNewPipelineName(e.target.value)} placeholder="Pipeline name" disabled={busy}
                  aria-label="New pipeline name" onKeyDown={editKeys(createPipeline, cancelNewPipeline)} />
                <Segmented accent className="pset-kind" ariaLabel="Pipeline kind" value={newPipelineKind} onChange={setNewPipelineKind}
                  options={[{ value: "OPPORTUNITIES", label: "Opportunities" }, { value: "DEALS", label: "Deals" }]} />
                <input value={newPipelineDesc} onChange={(e) => setNewPipelineDesc(e.target.value)} placeholder="Description (optional)" disabled={busy}
                  aria-label="New pipeline description" onKeyDown={editKeys(createPipeline, cancelNewPipeline)} />
                <div className="pset-actions">
                  <button type="button" className="primary" disabled={!newPipelineName.trim() || busy} onClick={createPipeline}>Create</button>
                  <button type="button" onClick={cancelNewPipeline}>Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" className="pset-dashed" disabled={busy} onClick={() => setAddingPipeline(true)}><PlusIcon />New pipeline</button>
            )}
            <p className="pset-note">
              {addingPipeline && newPipelineKind === "DEALS"
                ? "A Deals pipeline starts blank. Closed and Dead are always included automatically."
                : "An Opportunities pipeline holds prospects and starts with New Opportunity → Negotiating plus Passed and Lost. Convert an opportunity to create a deal."}
            </p>
          </div>
        </div>

        {/* ------------------------------------------------ selected pipeline */}
        {sel && (
          <StagePane
            key={sel.id}
            pipeline={sel}
            dealPipelines={pipelines.filter((p) => !isOpportunityPipeline(p))}
            busy={busy}
            setBusy={setBusy}
            err={err}
            setErr={setErr}
            stageCount={stageCount}
            onChanged={onChanged}
            onDeleteRequested={() => setConfirmDeletePipeline(true)}
          />
        )}
      </div>

      {confirmDeletePipeline && sel && (
        <ConfirmDialog
          title={`Delete "${sel.name}"?`}
          confirmLabel="Delete pipeline"
          danger
          busy={busy}
          message={isOpportunityPipeline(sel)
            ? <>A pipeline that still holds opportunities can't be deleted — move or delete them first. This can't be undone.</>
            : <>Deals in this pipeline move to your default pipeline (Closed and Dead deals keep their status; active deals restart in its first stage). This can't be undone.</>}
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

/** Stage colour button with a swatch popover (plus a custom colour fallback). */
function SwatchPicker({ color, label, disabled, onPick }: { color: string; label: string; disabled: boolean; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    // Capture + stop: Escape closes just the swatches, never the dialog.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  const current = color.toLowerCase();
  // The native picker needs a hex value; non-hex fallbacks start it at the first swatch.
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : SWATCHES[0];
  return (
    <div className="pset-swatch" ref={ref}>
      <button type="button" className={`pset-swatch-btn ${open ? "open" : ""}`} disabled={disabled} title="Stage color"
        aria-label={`${label} color`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span style={{ background: color }} />
      </button>
      {open && (
        <div className="pset-swatch-pop" role="listbox" aria-label={`${label} color`}>
          {SWATCHES.map((c) => (
            <button key={c} type="button" role="option" aria-selected={c.toLowerCase() === current} aria-label={c}
              className={`pset-swatch-opt ${c.toLowerCase() === current ? "on" : ""}`} style={{ background: c, color: c }}
              onClick={() => { setOpen(false); onPick(c); }} />
          ))}
          <label className="pset-swatch-custom" title="Custom color">
            <span>Custom color</span>
            <input type="color" value={hex} aria-label={`${label} custom color`}
              onChange={(e) => onPick(e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );
}

/** Right pane: name, delete, and the stage editor (labels, order, colors). */
function StagePane({ pipeline, dealPipelines, busy, setBusy, err, setErr, stageCount, onChanged, onDeleteRequested }: {
  pipeline: PipelineInfo;
  /** DEALS-kind pipelines (conversion targets). */
  dealPipelines: PipelineInfo[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  err: string | null;
  setErr: (e: string | null) => void;
  stageCount?: (pipelineId: string, stageKey: string) => number | null;
  onChanged: () => void;
  onDeleteRequested: () => void;
}) {
  const pid = pipeline.id;
  const opp = isOpportunityPipeline(pipeline);
  const [stages, setStages] = useState<PipelineStage[]>(pipeline.stages);
  const [name, setName] = useState(pipeline.name);
  // Opportunity pipelines: description + conversion settings (saved on change).
  const [desc, setDesc] = useState(pipeline.description ?? "");
  useEffect(() => { setDesc(pipeline.description ?? ""); }, [pipeline.description]);
  const saveSettings = async (patch: { description?: string | null; convertStageKey?: string | null; convertMode?: ConvertMode; convertToPipelineId?: string | null }) => {
    setBusy(true); setErr(null);
    try { await api.patch(`/pipeline/pipelines/${pid}`, patch); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  };
  // One inline edit at a time: "name" (pipeline), a stage id, or "add" (new stage).
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<PipelineStage | null>(null);
  // Local active-stage order so drag reordering feels instant; persisted on drop.
  const [order, setOrder] = useState<PipelineStage[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  useEffect(() => { api.get<PipelineStage[]>(`/pipeline/stages?pipelineId=${encodeURIComponent(pid)}`).then(setStages).catch(() => {}); }, [pid]);
  useEffect(() => { setOrder(stages.filter((s) => !s.isTerminal)); }, [stages]);
  useEffect(() => { setName(pipeline.name); }, [pipeline.name]);

  async function apply(fn: () => Promise<PipelineStage[]>) {
    setBusy(true); setErr(null);
    try { setStages(await fn()); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  const startEdit = (key: string, value: string) => { setEditing(key); setDraft(value); };
  const cancelEdit = () => { setEditing(null); setDraft(""); };

  const renamePipeline = async (value: string) => {
    const v = value.trim();
    if (!v) return;
    if (v === pipeline.name) { cancelEdit(); return; }
    setBusy(true); setErr(null);
    try { await api.patch(`/pipeline/pipelines/${pid}`, { name: v }); setName(v); cancelEdit(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  };

  const rename = (s: PipelineStage, label: string) => {
    const v = label.trim();
    if (!v) return;
    if (v === s.label) { cancelEdit(); return; }
    apply(async () => { const r = await api.patch<PipelineStage[]>(`/pipeline/stages/${s.id}`, { label: v }); cancelEdit(); return r; });
  };
  const recolor = (s: PipelineStage, color: string) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(color) || color === s.color) return;
    // Optimistic: the swatch reflects immediately; the board refreshes on save.
    setStages((prev) => prev.map((x) => (x.id === s.id ? { ...x, color } : x)));
    apply(() => api.patch<PipelineStage[]>(`/pipeline/stages/${s.id}`, { color }));
  };
  const cancelAdd = () => { cancelEdit(); setNewLabel(""); };
  const add = () => {
    if (!newLabel.trim()) return;
    apply(async () => { const r = await api.post<PipelineStage[]>("/pipeline/stages", { label: newLabel.trim(), pipelineId: pid }); cancelAdd(); return r; });
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
  const countLabel = (key: string) => {
    if (!stageCount) return null;
    const n = stageCount(pid, key);
    if (n == null) return null;
    const noun = opp ? "opportunit" + (n === 1 ? "y" : "ies") : "deal" + (n === 1 ? "" : "s");
    return n ? `${n} ${noun}` : "Empty";
  };
  const terminal = stages.filter((s) => s.isTerminal);

  return (
    <div className="pset-pane">
      {err && <div className="error-text pset-error">{err}</div>}
      <div className="pset-head">
        <div className="pset-name-block">
          <label>Pipeline name</label>
          {editing === "name" ? (
            <div className="pset-edit">
              <input autoFocus value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} placeholder="Pipeline name"
                aria-label="Pipeline name" onKeyDown={editKeys(() => void renamePipeline(draft), cancelEdit)} />
              <button type="button" className="primary" disabled={!draft.trim() || busy} onClick={() => void renamePipeline(draft)}>Save</button>
              <button type="button" onClick={cancelEdit}>Cancel</button>
            </div>
          ) : (
            <div className="pset-name-view">
              <span className="pset-name">{name}</span>
              <button type="button" className="pset-ghost" disabled={busy} title="Rename pipeline" aria-label="Rename pipeline"
                onClick={() => startEdit("name", name)}><PencilIcon />Rename</button>
            </div>
          )}
        </div>
        {pipeline.isDefault ? (
          <span className="pset-default-pill"><CheckIcon />Default pipeline</span>
        ) : (
          <button type="button" className="danger pset-delete" disabled={busy} onClick={onDeleteRequested}>Delete pipeline</button>
        )}
      </div>

      <FormSection title="Stages">
        <p className="pset-desc">
          Rename, reorder (drag by the <span aria-hidden="true">⠿</span> handle), recolor, add, or remove this pipeline's
          active stages. {opp ? "Its two terminal stages can be renamed and recolored but not removed." : "Closed and Dead are always present and cannot be changed."}
        </p>
        <div className="stage-editor pset-stages">
          {order.map((s, i) => {
            const color = s.color ?? stageColor(stages, s.key);
            const lastOfDefault = pipeline.isDefault && order.length <= 1;
            return (
              <div key={s.id}
                onDragOver={(e) => { if (dragIdx == null) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overIdx !== i) setOverIdx(i); }}
                onDrop={(e) => { e.preventDefault(); onDrop(i); }}
                className={`pset-stage ${dragIdx === i ? "dragging" : ""} ${overIdx === i && dragIdx !== null && dragIdx !== i ? "drop-over" : ""}`}
              >
                <span className="pset-grip pset-handle" title="Drag to reorder" aria-label="Drag to reorder"
                  draggable={!busy}
                  onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                ><GripIcon /></span>
                {/* Per-stage color — reflected on the board, cards, badges, and
                    dashboards immediately after save. */}
                <SwatchPicker color={color} label={s.label} disabled={busy} onPick={(c) => recolor(s, c)} />
                {editing === s.id ? (
                  <div className="pset-edit">
                    <input autoFocus value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} placeholder="Stage name"
                      aria-label={`Rename ${s.label}`} onKeyDown={editKeys(() => rename(s, draft), cancelEdit)} />
                    <button type="button" className="primary" disabled={!draft.trim() || busy} onClick={() => rename(s, draft)}>Save</button>
                    <button type="button" onClick={cancelEdit}>Cancel</button>
                  </div>
                ) : (
                  <div className="pset-stage-name">
                    <span title={s.label}>{s.label}</span>
                    <button type="button" className="pset-icon-btn" disabled={busy} title="Rename stage" aria-label={`Rename ${s.label}`}
                      onClick={() => startEdit(s.id, s.label)}><PencilIcon /></button>
                  </div>
                )}
                <span className="pset-count" title={stageCount ? "Records currently in this stage" : undefined}>{countLabel(s.key)}</span>
                <button type="button" className="pset-del" disabled={busy || lastOfDefault}
                  title={lastOfDefault ? "The default pipeline needs at least one active stage" : "Remove stage"}
                  aria-label={`Remove ${s.label}`}
                  onClick={() => setConfirmDelete(s)}><CloseIcon /></button>
              </div>
            );
          })}
          {order.length === 0 && <div className="pset-empty">No active stages yet. Add the first one below.</div>}
          {editing === "add" ? (
            <div className="pset-edit pset-add-form">
              <input autoFocus value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Stage name" disabled={busy}
                aria-label="New stage name" onKeyDown={editKeys(add, cancelAdd)} />
              <button type="button" className="primary" disabled={!newLabel.trim() || busy} onClick={add}>Add</button>
              <button type="button" onClick={cancelAdd}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="pset-dashed pset-add" disabled={busy} onClick={() => { setNewLabel(""); setEditing("add"); }}><PlusIcon />Add stage</button>
          )}
        </div>

        {terminal.length > 0 && (
          <div className="pset-locked">
            <div className="pset-locked-label"><span>{opp ? "Terminal stages" : "Always included"}</span><i /></div>
            {terminal.map((s) => opp ? (
              // Opportunity pipelines: Passed / Lost can be renamed and recolored (never removed).
              <div key={s.id} className="pset-stage">
                <span className="pset-grip pset-lock" aria-hidden="true"><LockIcon /></span>
                <SwatchPicker color={s.color ?? stageColor(stages, s.key)} label={s.label} disabled={busy} onPick={(c) => recolor(s, c)} />
                {editing === s.id ? (
                  <div className="pset-edit">
                    <input autoFocus value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} placeholder="Stage name"
                      aria-label={`Rename ${s.label}`} onKeyDown={editKeys(() => rename(s, draft), cancelEdit)} />
                    <button type="button" className="primary" disabled={!draft.trim() || busy} onClick={() => rename(s, draft)}>Save</button>
                    <button type="button" onClick={cancelEdit}>Cancel</button>
                  </div>
                ) : (
                  <div className="pset-stage-name">
                    <span title={s.label}>{s.label}</span>
                    <button type="button" className="pset-icon-btn" disabled={busy} title="Rename stage" aria-label={`Rename ${s.label}`}
                      onClick={() => startEdit(s.id, s.label)}><PencilIcon /></button>
                  </div>
                )}
                <span className="pset-count">{countLabel(s.key)}</span>
                <span className="pset-del-slot" />
              </div>
            ) : (
              <div key={s.id} className="pset-stage locked">
                <span className="pset-grip pset-lock" aria-hidden="true"><LockIcon /></span>
                <span className="pset-swatch-btn static" aria-hidden="true"><span style={{ background: stageColor(stages, s.key) }} /></span>
                <div className="pset-stage-name locked"><span>{s.label}</span></div>
                <span className="pset-count dim">{s.key === "DEAD" ? "Archived" : "Closed"}</span>
                <span className="pset-del-slot" />
              </div>
            ))}
          </div>
        )}
      </FormSection>

      {opp && (
        <FormSection title="Conversion" hint="How opportunities in this pipeline become deals.">
          <div className="pset-conv">
            <div className="pset-conv-field pset-conv-wide">
              <label>Description</label>
              <input value={desc} disabled={busy} placeholder="What this pipeline is for (optional)" aria-label="Pipeline description"
                onChange={(e) => setDesc(e.target.value)}
                onBlur={() => { if ((desc.trim() || null) !== (pipeline.description ?? null)) void saveSettings({ description: desc.trim() || null }); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
            </div>
            <div className="pset-conv-field">
              <label>Convert at stage</label>
              <Select value={pipeline.convertStageKey ?? ""} disabled={busy} ariaLabel="Convert at stage" placeholder="Manual only"
                onChange={(v) => void saveSettings({ convertStageKey: v || null, ...(v ? {} : { convertMode: "MANUAL" as ConvertMode }) })}
                options={[{ value: "", label: "Manual only" }, ...order.map((s) => ({ value: s.key, label: s.label }))]} />
            </div>
            <div className="pset-conv-field">
              <label>Mode</label>
              <Select value={pipeline.convertStageKey ? (pipeline.convertMode ?? "MANUAL") : "MANUAL"} disabled={busy || !pipeline.convertStageKey} ariaLabel="Conversion mode"
                onChange={(v) => void saveSettings({ convertMode: v as ConvertMode })}
                options={[{ value: "MANUAL", label: "Manual", hint: "Convert to deal button" }, { value: "AUTO", label: "Automatic", hint: "when the stage is reached" }]} />
            </div>
            <div className="pset-conv-field">
              <label>Create deals in</label>
              <Select value={pipeline.convertToPipelineId ?? ""} disabled={busy} ariaLabel="Target deal pipeline"
                onChange={(v) => void saveSettings({ convertToPipelineId: v || null })}
                options={[{ value: "", label: "Default pipeline" }, ...dealPipelines.filter((p) => !p.isDefault).map((p) => ({ value: p.id, label: p.name }))]} />
            </div>
          </div>
          <p className="pset-desc pset-conv-note">
            {pipeline.convertStageKey && pipeline.convertMode === "AUTO"
              ? <>Reaching <strong>{order.find((s) => s.key === pipeline.convertStageKey)?.label ?? "the stage"}</strong> creates the deal automatically; "Convert to deal" still works earlier.</>
              : "Opportunities become deals only when someone clicks “Convert to deal”. The deal starts in the target pipeline's first stage."}
          </p>
        </FormSection>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Remove "${confirmDelete.label}"?`}
          confirmLabel="Remove stage"
          danger
          busy={busy}
          message={<>Any {opp ? "opportunities" : "deals"} currently in <strong>{confirmDelete.label}</strong> move to the first active stage. This can't be undone.</>}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => { await apply(() => api.del<PipelineStage[]>(`/pipeline/stages/${confirmDelete.id}`)); setConfirmDelete(null); }}
        />
      )}
    </div>
  );
}
