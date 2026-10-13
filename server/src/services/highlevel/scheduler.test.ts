/**
 * The 15-minute tick's HighLevel pass (it shares the integration scheduler's
 * tick so the database gets no extra wake-ups): live rows sync; rows waiting
 * on a new key, paused by HighLevel, or not yet importing are left alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Integration } from "@prisma/client";

const run = vi.hoisted(() => vi.fn(async () => ({ ok: true, message: "ok", phase: "live" })));
vi.mock("../../db.js", () => ({ prisma: {} }));
vi.mock("./sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sync.js")>()),
  runHighLevelSync: run,
}));

import { highLevelTick, RUN_BUDGET_MS } from "./scheduler.js";
import { HL_AUTH_MESSAGE } from "./client.js";

const row = (id: string, hlSync: Record<string, unknown>, over: Partial<Integration> = {}): Integration => ({
  id, organizationId: `org_${id}`, provider: "highlevel", status: "CONNECTED", config: { hlSync } as never,
  connectedAt: null, lastSyncAt: null, lastError: null, createdAt: new Date(), updatedAt: new Date(), ...over,
});

beforeEach(() => run.mockClear());

describe("highLevelTick", () => {
  it("syncs live rows (including ones in a transient ERROR) with the scheduled budget", async () => {
    await highLevelTick([
      row("a", { phase: "live" }),
      row("b", { phase: "live" }, { status: "ERROR", lastError: "HighLevel is having trouble right now." }),
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), { budgetMs: RUN_BUDGET_MS, reason: "scheduled" });
  });

  it("skips rows that need a new key, are paused, disconnected, previewing, or not HighLevel", async () => {
    await highLevelTick([
      row("auth", { phase: "live" }, { status: "ERROR", lastError: HL_AUTH_MESSAGE }),
      row("paused", { phase: "live", pausedUntil: new Date(Date.now() + 60_000).toISOString() }),
      row("off", { phase: "live" }, { status: "NOT_CONNECTED" }),
      row("preview", { phase: "preview" }),
      row("importing", { phase: "importing" }), // handed to the import loop (inert under test)
      row("other", { phase: "live" }, { provider: "resend" }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });
});
