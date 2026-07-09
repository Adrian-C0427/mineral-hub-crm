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

interface StagesCtx {
  stages: PipelineStage[];
  active: PipelineStage[];   // board columns, in order
  terminal: PipelineStage[]; // Closed / Dead
  label: (key: string) => string;
  reload: () => void;
}

const Ctx = createContext<StagesCtx>({
  stages: DEFAULT_STAGES,
  active: DEFAULT_STAGES.filter((s) => !s.isTerminal),
  terminal: DEFAULT_STAGES.filter((s) => s.isTerminal),
  label: (k) => DEFAULT_STAGES.find((s) => s.key === k)?.label ?? prettyStage(k),
  reload: () => {},
});

/**
 * Provides the organization's customizable pipeline stages (labels + order) to
 * the whole app, so stage badges, the board, the dashboard, and the move-stage
 * modal all render the org's own stage names. Falls back to the seven built-in
 * defaults until the fetch resolves.
 */
export function StagesProvider({ children }: { children: ReactNode }) {
  const [stages, setStages] = useState<PipelineStage[]>(DEFAULT_STAGES);
  const load = useCallback(() => {
    api.get<PipelineStage[]>("/pipeline/stages").then((s) => { if (s.length) setStages(s); }).catch(() => { /* keep defaults */ });
  }, []);
  useEffect(() => { load(); }, [load]);

  const value = useMemo<StagesCtx>(() => {
    const byKey = new Map(stages.map((s) => [s.key, s]));
    return {
      stages,
      active: stages.filter((s) => !s.isTerminal),
      terminal: stages.filter((s) => s.isTerminal),
      label: (k) => byKey.get(k)?.label ?? prettyStage(k),
      reload: load,
    };
  }, [stages, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStages() { return useContext(Ctx); }
