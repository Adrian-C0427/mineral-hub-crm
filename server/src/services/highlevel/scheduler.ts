/**
 * When HighLevel syncs run. Production's database (Neon free plan) suspends
 * after 5 idle minutes and caps compute hours, so nothing here polls the
 * database on its own short interval:
 *  - LIVE orgs sync every 15 minutes from the existing integration
 *    scheduler's 15-minute tick (integrationSync.ts calls highLevelTick with
 *    the rows that tick already loaded) — no extra database wake-ups.
 *  - IMPORTING orgs run back to back (each run starts when the previous one
 *    ends) until the import reaches live, and so do live orgs while a
 *    "Re-read tags now" runs or CRM tags are waiting to be written or
 *    removed. Those catch-ups may keep the database awake; each stops by
 *    itself.
 *  - At boot, one query resumes any import a restart interrupted (each run
 *    picks up from the persisted checkpoint).
 * Waits between import runs (backoff, HighLevel rate-limit pauses) are kept in
 * memory. Like the other schedulers this assumes a single API instance.
 */
import type { Integration } from "@prisma/client";
import { prisma } from "../../db.js";
import { runHighLevelSync, needsReconnect, HIGHLEVEL } from "./sync.js";
import { readSyncState, isPaused, tagRefreshRunning, type HlSyncState } from "./mapping.js";

/** Per-run time budget for scheduled and import runs (a run stops between pages and the next resumes). */
export const RUN_BUDGET_MS = 50_000;
/** "Sync now" — bounded so the request returns promptly. */
export const MANUAL_BUDGET_MS = 25_000;
/** Longest in-memory wait inside an import loop; longer pauses are left to the 15-minute tick. */
const MAX_LOOP_WAIT_MS = 15 * 60_000;
const LOOP_GIVE_UP_AFTER = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

const importLoops = new Set<string>();

/** Runs go back to back: the first import, a tag re-read, or CRM tags waiting to be written / removed. */
const catchingUp = (s: HlSyncState) =>
  s.phase === "importing" || (s.phase === "live" && (tagRefreshRunning(s) || !!s.crmTags?.backlog));

/** Start the back-to-back catch-up runs for an org — import or tag re-read (no-op if already running or in tests). */
export function ensureImportLoop(organizationId: string): void {
  if (process.env.NODE_ENV === "test" || importLoops.has(organizationId)) return;
  importLoops.add(organizationId);
  void importLoop(organizationId)
    .catch((e) => console.error(`[highlevel] import loop failed for org ${organizationId}:`, e instanceof Error ? e.message : e))
    .finally(() => importLoops.delete(organizationId));
}

async function importLoop(organizationId: string): Promise<void> {
  let failures = 0;
  for (;;) {
    const row = await prisma.integration.findUnique({ where: { organizationId_provider: { organizationId, provider: HIGHLEVEL } } });
    if (!row || row.status === "NOT_CONNECTED" || needsReconnect(row)) return;
    const state = readSyncState(row.config);
    if (!catchingUp(state)) return; // import reached live / tag re-read finished (or neither started)
    if (isPaused(state, Date.now())) {
      const wait = Date.parse(state.pausedUntil!) - Date.now();
      if (wait > MAX_LOOP_WAIT_MS) return; // the 15-minute tick resumes it
      await sleep(wait + 1_000);
      continue;
    }
    const r = await runHighLevelSync(row, { budgetMs: RUN_BUDGET_MS, reason: state.phase === "importing" ? "import" : "scheduled" });
    if (r.skipped) { await sleep(5_000); continue; } // a manual run was in flight
    if (r.ok) { failures = 0; continue; }
    if (++failures >= LOOP_GIVE_UP_AFTER) return; // ERROR now; the 15-minute tick retries
    await sleep(30_000 * failures);
  }
}

/**
 * Called from the integration scheduler's 15-minute tick with the HighLevel
 * rows it already loaded: live orgs get their 15-minute sync; importing orgs
 * whose loop stopped (errors, long pause, restart) get it restarted.
 */
export async function highLevelTick(rows: readonly Integration[]): Promise<void> {
  const now = Date.now();
  for (const row of rows) {
    if (row.provider !== HIGHLEVEL || row.status === "NOT_CONNECTED" || needsReconnect(row)) continue;
    const state = readSyncState(row.config);
    if (isPaused(state, now)) continue;
    if (catchingUp(state)) { ensureImportLoop(row.organizationId); continue; }
    if (state.phase !== "live") continue;
    try {
      await runHighLevelSync(row, { budgetMs: RUN_BUDGET_MS, reason: "scheduled" });
      await continueCatchUp(row.organizationId);
    } catch (e) {
      console.error(`[highlevel] scheduled sync failed for org ${row.organizationId}:`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * After a single run (Sync now, the 15-minute tick, a settings kick): if it
 * left catch-up work — CRM tags still to write, a tag re-read, the import —
 * carry on back to back now instead of waiting for the next tick.
 */
export async function continueCatchUp(organizationId: string): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  const row = await prisma.integration.findUnique({ where: { organizationId_provider: { organizationId, provider: HIGHLEVEL } } });
  if (row && row.status !== "NOT_CONNECTED" && !needsReconnect(row) && catchingUp(readSyncState(row.config))) ensureImportLoop(organizationId);
}

/** A one-off background run outside the schedule (e.g. after the response window or Minerals filter changes). */
export function kickHighLevelRun(row: Integration, reason: "settings" | "manual"): void {
  if (process.env.NODE_ENV === "test") return;
  const state = readSyncState(row.config);
  if (catchingUp(state)) { ensureImportLoop(row.organizationId); return; }
  if (state.phase !== "live" || needsReconnect(row)) return;
  void runHighLevelSync(row, { budgetMs: RUN_BUDGET_MS, reason })
    .then(() => continueCatchUp(row.organizationId))
    .catch((e) => console.error(`[highlevel] background sync failed for org ${row.organizationId}:`, e instanceof Error ? e.message : e));
}

/** Boot: resume imports and tag re-reads a restart interrupted (one query, once). No-op in tests. */
export function startHighLevelScheduler(): void {
  if (process.env.NODE_ENV === "test") return;
  setTimeout(() => {
    prisma.integration.findMany({ where: { provider: HIGHLEVEL, status: { in: ["CONNECTED", "ERROR"] } } })
      .then((rows) => {
        for (const row of rows) {
          if (!needsReconnect(row) && catchingUp(readSyncState(row.config))) ensureImportLoop(row.organizationId);
        }
      })
      .catch((e) => console.error("[highlevel] resume check failed:", e instanceof Error ? e.message : e));
  }, 10_000).unref();
}
