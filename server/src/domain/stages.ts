import type { PrismaClient, Prisma, PipelineStage, Pipeline } from "@prisma/client";

// A pipeline is one of two kinds: DEALS (the original board — deals in their
// stages; every pre-existing pipeline) or OPPORTUNITIES (lightweight prospects,
// see domain/opportunities.ts). The kind is fixed at creation.
export const PIPELINE_KINDS = ["DEALS", "OPPORTUNITIES"] as const;
export type PipelineKind = (typeof PIPELINE_KINDS)[number];
export function isOpportunityPipeline(p: { kind: string }): boolean {
  return p.kind === "OPPORTUNITIES";
}

// The two terminal stages are permanent in EVERY deals pipeline — they cannot
// be renamed, removed, or reordered, and all terminal behavior (win-rate, dead
// reasons, closed profit) keys on these literal keys regardless of pipeline.
export const TERMINAL_STAGE_KEYS = ["CLOSED", "DEAD"] as const;
export function isTerminalKey(key: string): boolean {
  return (TERMINAL_STAGE_KEYS as readonly string[]).includes(key);
}

// Opportunity pipelines end in Passed / Lost instead. Unlike Closed/Dead these
// may be renamed and recoloured (never removed); nothing keys on their labels.
export const OPPORTUNITY_TERMINAL_STAGE_KEYS = ["PASSED", "LOST"] as const;

/** The terminal stage keys a pipeline of this kind carries. */
export function terminalKeysForKind(kind: string): readonly string[] {
  return kind === "OPPORTUNITIES" ? OPPORTUNITY_TERMINAL_STAGE_KEYS : TERMINAL_STAGE_KEYS;
}
export function isTerminalKeyForKind(kind: string, key: string): boolean {
  return terminalKeysForKind(kind).includes(key);
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

// Starter stages of a new OPPORTUNITIES pipeline (position = array order).
export const OPPORTUNITY_DEFAULT_STAGES: { key: string; label: string; isTerminal: boolean; color: string | null }[] = [
  { key: "NEW_OPPORTUNITY", label: "New Opportunity", isTerminal: false, color: "#3b82f6" },
  { key: "RESEARCHING", label: "Researching", isTerminal: false, color: "#8b5cf6" },
  { key: "CONTACTED", label: "Contacted", isTerminal: false, color: "#06b6d4" },
  { key: "INTERESTED", label: "Interested", isTerminal: false, color: "#f59e0b" },
  { key: "NEGOTIATING", label: "Negotiating", isTerminal: false, color: "#22c55e" },
  { key: "PASSED", label: "Passed", isTerminal: true, color: null },
  { key: "LOST", label: "Lost", isTerminal: true, color: null },
];

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
 * built-in workflow; user-created DEALS pipelines start BLANK — just the
 * permanent Closed/Dead terminals — so users define their own stages from
 * scratch. An OPPORTUNITIES pipeline always gets the opportunity starter set
 * (New Opportunity … Negotiating + Passed/Lost); `blank` does not apply.
 */
export async function seedStages(tx: Tx, organizationId: string, pipelineId: string, blank = false, kind: PipelineKind = "DEALS"): Promise<void> {
  const rows = kind === "OPPORTUNITIES" ? OPPORTUNITY_DEFAULT_STAGES : blank ? TERMINAL_STAGES : DEFAULT_STAGES;
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
  // Seed by the pipeline's kind (DEALS pipelines seed exactly as before).
  const p = await tx.pipeline.findUnique({ where: { id: pid }, select: { kind: true } });
  await seedStages(tx, organizationId, pid, false, p?.kind === "OPPORTUNITIES" ? "OPPORTUNITIES" : "DEALS");
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
