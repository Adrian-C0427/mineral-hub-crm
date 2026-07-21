import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api/client";
import { prettyStage } from "./lib/format";
import type { PipelineStage } from "./types";

// Fallback used before the org's stages load (and for any non-provider render).
const DEFAULT_STAGES: PipelineStage[] = [
  { id: "d0", key: "UNDER_CONTRACT", label: "Under Contract", position: 0, isTerminal: false },
  { id: "d1", key: "PREPARING_PACKAGE", label: "Preparing Package", position: 1, isTerminal: false },
  { id: "d2", key: "SENT_TO_BUYERS", label: "Sent to Buyers", position: 2, isTerminal: false },
  { id: "d3", key: "NEGOTIATING", label: "Negotiating", position: 3, isTerminal: false },
  { id: "d4", key: "CLOSING", label: "Closing", position: 4, isTerminal: false },
  { id: "d5", key: "CLOSED", label: "Closed", position: 5, isTerminal: true },
  { id: "d6", key: "DEAD", label: "Dead", position: 6, isTerminal: true },
];

export interface PipelineInfo {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  stages: PipelineStage[];
}

const FALLBACK_PIPELINE: PipelineInfo = { id: "", name: "Sales Pipeline", isDefault: true, position: 0, stages: DEFAULT_STAGES };

const SELECTED_KEY = "mh-pipeline-selected";

/** Default stage color palette, cycled by board position when a stage has no
 *  stored color. Closed/Dead always resolve to the app's green/red. */
export const STAGE_PALETTE = ["#3b82f6", "#8b5cf6", "#06b6d4", "#f59e0b", "#22c55e", "#ec4899", "#14b8a6", "#f97316"];

/** Resolve a stage's display color within an ordered stage list. */
export function stageColor(stages: PipelineStage[], key: string): string {
  if (key === "CLOSED") return "var(--green)";
  if (key === "DEAD") return "var(--red)";
  const active = stages.filter((s) => !s.isTerminal);
  const i = active.findIndex((s) => s.key === key);
  const stage = i >= 0 ? active[i] : undefined;
  return stage?.color ?? STAGE_PALETTE[(i >= 0 ? i : 0) % STAGE_PALETTE.length];
}

interface StagesCtx {
  /** All of the org's pipelines with their stage sets (default first). */
  pipelines: PipelineInfo[];
  /** The pipeline currently selected on the Pipeline board. */
  selectedId: string;
  setSelectedId: (id: string) => void;
  selected: PipelineInfo;
  /** Stage rows of the SELECTED pipeline (board consumers). */
  stages: PipelineStage[];
  active: PipelineStage[];   // board columns, in order
  terminal: PipelineStage[]; // Closed / Dead
  /** Stages of a specific pipeline; null/undefined/unknown → default pipeline. */
  stagesOf: (pipelineId?: string | null) => PipelineStage[];
  /** Display label for a stage key — selected pipeline first, then any pipeline. */
  label: (key: string) => string;
  /** Display color for a stage key — selected pipeline first, then any pipeline. */
  colorOf: (key: string, pipelineId?: string | null) => string;
  reload: () => void;
}

const Ctx = createContext<StagesCtx>({
  pipelines: [FALLBACK_PIPELINE],
  selectedId: "",
  setSelectedId: () => {},
  selected: FALLBACK_PIPELINE,
  stages: DEFAULT_STAGES,
  active: DEFAULT_STAGES.filter((s) => !s.isTerminal),
  terminal: DEFAULT_STAGES.filter((s) => s.isTerminal),
  stagesOf: () => DEFAULT_STAGES,
  label: (k) => DEFAULT_STAGES.find((s) => s.key === k)?.label ?? prettyStage(k),
  colorOf: (k) => stageColor(DEFAULT_STAGES, k),
  reload: () => {},
});

/**
 * Provides the organization's pipelines (each with its own customizable stage
 * set) to the whole app, so stage badges, the board, the dashboard, and the
 * move-stage modal all render the right stage names. Falls back to a single
 * built-in pipeline until the fetch resolves.
 */
export function StagesProvider({ children }: { children: ReactNode }) {
  const [pipelines, setPipelines] = useState<PipelineInfo[]>([FALLBACK_PIPELINE]);
  const [selectedId, setSelectedIdState] = useState<string>(() => {
    try { return localStorage.getItem(SELECTED_KEY) ?? ""; } catch { return ""; }
  });
  const load = useCallback(() => {
    api.get<PipelineInfo[]>("/pipeline/pipelines").then((ps) => { if (ps.length) setPipelines(ps); }).catch(() => { /* keep defaults */ });
  }, []);
  useEffect(() => { load(); }, [load]);

  const setSelectedId = useCallback((id: string) => {
    setSelectedIdState(id);
    try { localStorage.setItem(SELECTED_KEY, id); } catch { /* storage off */ }
  }, []);

  const value = useMemo<StagesCtx>(() => {
    const def = pipelines.find((p) => p.isDefault) ?? pipelines[0] ?? FALLBACK_PIPELINE;
    const selected = pipelines.find((p) => p.id === selectedId) ?? def;
    const stages = selected.stages.length ? selected.stages : DEFAULT_STAGES;
    const byKey = new Map(stages.map((s) => [s.key, s]));
    // Global fallback: a stage key from ANY pipeline still labels correctly
    // (Deals table, dashboard, buyer profiles show deals across pipelines).
    const globalByKey = new Map<string, PipelineStage>();
    for (const p of pipelines) for (const s of p.stages) if (!globalByKey.has(s.key)) globalByKey.set(s.key, s);
    return {
      pipelines,
      selectedId: selected.id,
      setSelectedId,
      selected,
      stages,
      active: stages.filter((s) => !s.isTerminal),
      terminal: stages.filter((s) => s.isTerminal),
      stagesOf: (pid) => {
        const p = (pid ? pipelines.find((x) => x.id === pid) : def) ?? def;
        return p.stages.length ? p.stages : DEFAULT_STAGES;
      },
      label: (k) => byKey.get(k)?.label ?? globalByKey.get(k)?.label ?? prettyStage(k),
      colorOf: (k, pid) => {
        // Resolve within the deal's own pipeline when given; otherwise the
        // selected pipeline; otherwise whichever pipeline defines the key.
        const inP = (p: PipelineInfo | undefined) => p && p.stages.some((s) => s.key === k) ? p : undefined;
        const host = inP(pid ? pipelines.find((x) => x.id === pid) : undefined)
          ?? inP(selected) ?? pipelines.find((p) => p.stages.some((s) => s.key === k));
        return stageColor(host?.stages ?? stages, k);
      },
      reload: load,
    };
  }, [pipelines, selectedId, setSelectedId, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStages() { return useContext(Ctx); }
