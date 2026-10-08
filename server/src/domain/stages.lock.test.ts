/**
 * lockStageRow — the row lock that serializes concurrent stage moves of one
 * deal / opportunity (rapid drags on the Pipeline board, two users at once).
 */
import { describe, it, expect } from "vitest";
import type { Prisma } from "@prisma/client";
import { lockStageRow } from "./stages.js";

function fakeTx() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return [];
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, calls };
}

describe("lockStageRow", () => {
  it("takes a FOR UPDATE lock on the deal row, with the id bound (never interpolated)", async () => {
    const { tx, calls } = fakeTx();
    await lockStageRow(tx, "Deal", "deal_1'; DROP TABLE x; --");
    expect(calls).toEqual([{ sql: 'SELECT id FROM "Deal" WHERE id = ? FOR UPDATE', values: ["deal_1'; DROP TABLE x; --"] }]);
  });

  it("locks the opportunity table for opportunities", async () => {
    const { tx, calls } = fakeTx();
    await lockStageRow(tx, "Opportunity", "opp_1");
    expect(calls).toEqual([{ sql: 'SELECT id FROM "Opportunity" WHERE id = ? FOR UPDATE', values: ["opp_1"] }]);
  });
});
