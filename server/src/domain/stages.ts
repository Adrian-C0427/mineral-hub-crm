import type { PrismaClient, Prisma, PipelineStage, Pipeline } from "@prisma/client";

// The two terminal stages are permanent in EVERY pipeline — they cannot be
// renamed, removed, or reordered, and all terminal behavior (win-rate, dead
// reasons, closed profit) keys on these literal keys regardless of pipeline.
export const TERMINAL_STAGE_KEYS = ["CLOSED", "DEAD"] as const;
export function isTerminalKey(key: string): boolean {
  return (TERMINAL_STAGE_KEYS as readonly string[]).includes(key);
}

// Built-in defaults seeded for every new pipeline (position = array order). The
// five active stages are fully customizable; CLOSED and DEAD are terminal.
// Colors are the app's default stage palette — users can override per stage.
export const DEFAULT_STAGES: { key: string; label: string; isTerminal: boolean; color: string | null }[] = [
  { key: "UNDER_CONTRACT", label: "Under Contract", isTerminal: false, color: "#3b82f6" },
  { key: "PREPARING_PACKAGE", label: "Preparing Package", isTerminal: false, color: "#8b5cf6" },
  { key: "SENT_TO_BUYERS", label: "Sent to Buyers", isTerminal: false, color: "#06b6d4" },
  { key: "NEGOTIATING", label: "Negotiating", isTerminal: false, color: "#f59e0b" },
  { key: "CLOSING", label: "Closing", isTerminal: false, color: "#22c55e" },
  { key: "CLOSED", label: "Closed", isTerminal: true, color: null },
  { key: "DEAD", label: "Dead", isTerminal: true, color: null },
];

// Terminal rows appended to every user-created pipeline no matter what.
export const TERMINAL_STAGES = DEFAULT_STAGES.filter((s) => s.isTerminal);

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Ensure the org has at least its default pipeline; returns it. Adopts any
 * pre-pipeline stage rows (pipelineId null) into the default pipeline, so
 * lazily-created orgs and pre-migration data both converge.
 */
export async function ensureDefaultPipeline(tx: Tx, organizationId: string): Promise<Pipeline> {
  const existing = await tx.pipeline.findFirst({ where: { organizationId, isDefault: true } });
  if (existing) return existing;
  const created = await tx.pipeline.create({ data: { organizationId, name: "Sales Pipeline", isDefault: true, position: 0 } });
  // Adopt orphaned stage rows (created before pipelines existed).
  await tx.pipelineStage.updateMany({ where: { organizationId, pipelineId: null }, data: { pipelineId: created.id } });
  return created;
}

/** All of the org's pipelines, ordered (default first). Seeds the default. */
export async function ensurePipelines(tx: Tx, organizationId: string): Promise<Pipeline[]> {
  await ensureDefaultPipeline(tx, organizationId);
  // User-controlled ordering (Pipeline Settings reorder); position wins.
  return tx.pipeline.findMany({ where: { organizationId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
}

/**
 * Seed a pipeline's stage rows. The org's default pipeline gets the full
 * built-in workflow; user-created pipelines start BLANK — just the permanent
 * Closed/Dead terminals — so users define their own stages from scratch.
 */
export async function seedStages(tx: Tx, organizationId: string, pipelineId: string, blank = false): Promise<void> {
  const rows = blank ? TERMINAL_STAGES : DEFAULT_STAGES;
  await tx.pipelineStage.createMany({
    data: rows.map((s, i) => ({ organizationId, pipelineId, key: s.key, label: s.label, position: i, isTerminal: s.isTerminal, color: s.color })),
    skipDuplicates: true,
  });
}

/**
 * Ensure a pipeline's stage rows exist (seed defaults once); returns them
 * ordered. Omitting pipelineId targets the org's default pipeline — every
 * pre-pipelines call site keeps its behavior.
 */
export async function ensureStages(tx: Tx, organizationId: string, pipelineId?: string | null): Promise<PipelineStage[]> {
  const pid = pipelineId ?? (await ensureDefaultPipeline(tx, organizationId)).id;
  const existing = await tx.pipelineStage.findMany({ where: { organizationId, pipelineId: pid }, orderBy: { position: "asc" } });
  if (existing.length) return existing;
  await seedStages(tx, organizationId, pid);
  return tx.pipelineStage.findMany({ where: { organizationId, pipelineId: pid }, orderBy: { position: "asc" } });
}

/** Ordered keys of a pipeline's active (non-terminal) stages — the board columns. */
export async function activeStageKeys(tx: Tx, organizationId: string, pipelineId?: string | null): Promise<string[]> {
  const stages = await ensureStages(tx, organizationId, pipelineId);
  return stages.filter((s) => !s.isTerminal).map((s) => s.key);
}

/** The stage a brand-new deal enters — the first active stage by position. */
export async function firstActiveStageKey(tx: Tx, organizationId: string, pipelineId?: string | null): Promise<string> {
  const keys = await activeStageKeys(tx, organizationId, pipelineId);
  return keys[0] ?? "UNDER_CONTRACT";
}
