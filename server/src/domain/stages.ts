import type { PrismaClient, Prisma, PipelineStage } from "@prisma/client";

// The two terminal stages are permanent — they cannot be renamed, removed, or
// reordered, and all terminal behavior (win-rate, dead reasons, closed profit)
// keys on these literal keys.
export const TERMINAL_STAGE_KEYS = ["CLOSED", "DEAD"] as const;
export function isTerminalKey(key: string): boolean {
  return (TERMINAL_STAGE_KEYS as readonly string[]).includes(key);
}

// Built-in defaults seeded for every organization (position = array order). The
// five active stages are fully customizable; CLOSED and DEAD are terminal.
export const DEFAULT_STAGES: { key: string; label: string; isTerminal: boolean }[] = [
  { key: "UNDER_CONTRACT", label: "Under Contract", isTerminal: false },
  { key: "PREPARING_PACKAGE", label: "Preparing Package", isTerminal: false },
  { key: "SENT_TO_BUYERS", label: "Sent to Buyers", isTerminal: false },
  { key: "NEGOTIATING", label: "Negotiating", isTerminal: false },
  { key: "CLOSING", label: "Closing", isTerminal: false },
  { key: "CLOSED", label: "Closed", isTerminal: true },
  { key: "DEAD", label: "Dead", isTerminal: true },
];

type Tx = PrismaClient | Prisma.TransactionClient;

/** Ensure the org's stage rows exist (seed defaults once); returns them ordered. */
export async function ensureStages(tx: Tx, organizationId: string): Promise<PipelineStage[]> {
  const existing = await tx.pipelineStage.findMany({ where: { organizationId }, orderBy: { position: "asc" } });
  if (existing.length) return existing;
  await tx.pipelineStage.createMany({
    data: DEFAULT_STAGES.map((s, i) => ({ organizationId, key: s.key, label: s.label, position: i, isTerminal: s.isTerminal })),
    skipDuplicates: true,
  });
  return tx.pipelineStage.findMany({ where: { organizationId }, orderBy: { position: "asc" } });
}

/** Ordered keys of the org's active (non-terminal) stages — the board columns. */
export async function activeStageKeys(tx: Tx, organizationId: string): Promise<string[]> {
  const stages = await ensureStages(tx, organizationId);
  return stages.filter((s) => !s.isTerminal).map((s) => s.key);
}

/** The stage a brand-new deal enters — the first active stage by position. */
export async function firstActiveStageKey(tx: Tx, organizationId: string): Promise<string> {
  const keys = await activeStageKeys(tx, organizationId);
  return keys[0] ?? "UNDER_CONTRACT";
}
