/**
 * Pipeline board drag-and-drop ordering rules (client/src/lib/boardSync.ts):
 * optimistic moves, per-card last-intent-wins, failure reverts, and refetches
 * that can never snap a card back to a stage it already left.
 *
 * Kept outside src/ so the client build's typecheck never needs vitest.
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import {
  applyFetch, beginFetch, beginMove, boardRows, failFetch, initialBoard, isLatestMove, settleMove, upsertRow,
  type BoardState,
} from "../src/lib/boardSync";

interface Card { id: string; stage: string; name: string; days: number }

const card = (id: string, stage: string, days = 5): Card => ({ id, stage, name: id.toUpperCase(), days });
/** Server answer for a move: the saved stage resets days in stage. */
const saved = (stage: string) => (row: Card): Card => ({ ...row, stage, days: 0 });
const stageOf = (s: BoardState<Card>, id: string) => boardRows(s)?.find((r) => r.id === id)?.stage;

function loaded(rows: Card[]): BoardState<Card> {
  const [s, t] = beginFetch(initialBoard<Card>());
  return applyFetch(s, t, rows);
}

describe("boardSync — optimistic moves", () => {
  it("shows nothing until the first load, then the fetched rows", () => {
    expect(boardRows(initialBoard<Card>())).toBeNull();
    expect(boardRows(loaded([card("a", "S1")]))).toEqual([card("a", "S1")]);
  });

  it("moves the card at once and keeps it there once saved", () => {
    let s = loaded([card("a", "S1"), card("b", "S1")]);
    let seq: number;
    [s, seq] = beginMove(s, "a", "S2");
    expect(stageOf(s, "a")).toBe("S2");
    expect(stageOf(s, "b")).toBe("S1");
    s = settleMove(s, "a", seq, saved("S2"));
    expect(s.pending).toEqual({});
    expect(boardRows(s)?.find((r) => r.id === "a")).toEqual({ ...card("a", "S2"), days: 0 });
  });

  it("reverts to the server's stage when the newest move fails", () => {
    let s = loaded([card("a", "S1")]);
    let seq: number;
    [s, seq] = beginMove(s, "a", "S2");
    s = settleMove(s, "a", seq); // failure
    expect(stageOf(s, "a")).toBe("S1");
    expect(s.pending).toEqual({});
  });

  it("renders unmoved rows by identity (no needless re-render churn)", () => {
    let s = loaded([card("a", "S1"), card("b", "S1")]);
    const before = boardRows(s)!;
    [s] = beginMove(s, "a", "S2");
    expect(boardRows(s)![1]).toBe(before[1]);
  });
});

describe("boardSync — rapid consecutive moves (last intent wins)", () => {
  it("an older move's success never clears a newer intent", () => {
    let s = loaded([card("a", "S1")]);
    let first: number, second: number;
    [s, first] = beginMove(s, "a", "S2");
    [s, second] = beginMove(s, "a", "S3");
    expect(isLatestMove(s, "a", first)).toBe(false);
    s = settleMove(s, "a", first, saved("S2"));
    expect(stageOf(s, "a")).toBe("S3"); // still the newest intent
    expect(s.base![0].stage).toBe("S2"); // but server truth advanced
    s = settleMove(s, "a", second, saved("S3"));
    expect(stageOf(s, "a")).toBe("S3");
    expect(s.pending).toEqual({});
  });

  it("an older move's failure is moot while a newer one is pending", () => {
    let s = loaded([card("a", "S1")]);
    let first: number, second: number;
    [s, first] = beginMove(s, "a", "S2");
    [s, second] = beginMove(s, "a", "S3");
    s = settleMove(s, "a", first);
    expect(stageOf(s, "a")).toBe("S3");
    s = settleMove(s, "a", second, saved("S3"));
    expect(stageOf(s, "a")).toBe("S3");
  });

  it("when the newest move fails after an older one saved, the card falls back to the saved stage", () => {
    let s = loaded([card("a", "S1")]);
    let first: number, second: number;
    [s, first] = beginMove(s, "a", "S2");
    [s, second] = beginMove(s, "a", "S3");
    s = settleMove(s, "a", first, saved("S2"));
    s = settleMove(s, "a", second);
    expect(stageOf(s, "a")).toBe("S2");
  });

  it("a response that arrives after a newer one for the same card does not overwrite it", () => {
    let s = loaded([card("a", "S1")]);
    let first: number, second: number;
    [s, first] = beginMove(s, "a", "S2");
    [s, second] = beginMove(s, "a", "S3");
    s = settleMove(s, "a", second, saved("S3"));
    s = settleMove(s, "a", first, saved("S2")); // late straggler
    expect(stageOf(s, "a")).toBe("S3");
    expect(s.base![0].stage).toBe("S3");
  });

  it("moves of different cards are independent", () => {
    let s = loaded([card("a", "S1"), card("b", "S1")]);
    let ma: number, mb: number;
    [s, ma] = beginMove(s, "a", "S2");
    [s, mb] = beginMove(s, "b", "S3");
    s = settleMove(s, "b", mb); // b fails
    expect(stageOf(s, "a")).toBe("S2");
    expect(stageOf(s, "b")).toBe("S1");
    s = settleMove(s, "a", ma, saved("S2"));
    expect(stageOf(s, "a")).toBe("S2");
  });
});

describe("boardSync — refetches never snap a card back", () => {
  it("a refetch that returns while a move is in flight keeps the moved card", () => {
    let s = loaded([card("a", "S1")]);
    let t: number;
    [s, t] = beginFetch(s);
    [s] = beginMove(s, "a", "S2");
    s = applyFetch(s, t, [card("a", "S1")]);
    expect(stageOf(s, "a")).toBe("S2");
  });

  it("a refetch that started before a move saved (but lands after) keeps the saved stage", () => {
    let s = loaded([card("a", "S1"), card("b", "S1")]);
    let t: number, seq: number;
    [s, seq] = beginMove(s, "a", "S2");
    [s, t] = beginFetch(s); // e.g. window focus while the move's request is out
    s = settleMove(s, "a", seq, saved("S2"));
    // The database read for this refetch predates the move's commit.
    s = applyFetch(s, t, [card("a", "S1"), card("b", "S4")]);
    expect(stageOf(s, "a")).toBe("S2");
    expect(stageOf(s, "b")).toBe("S4"); // other cards still pick up the refetch
  });

  it("a refetch that started after the move saved is taken as is", () => {
    let s = loaded([card("a", "S1")]);
    let seq: number, t: number;
    [s, seq] = beginMove(s, "a", "S2");
    s = settleMove(s, "a", seq, saved("S2"));
    [s, t] = beginFetch(s);
    // Another user moved it on since: the board follows.
    s = applyFetch(s, t, [card("a", "S5")]);
    expect(stageOf(s, "a")).toBe("S5");
    expect(s.writtenAt).toEqual({});
  });

  it("drops a refetch older than one already applied", () => {
    let s = loaded([card("a", "S1")]);
    let older: number, newer: number;
    [s, older] = beginFetch(s);
    [s, newer] = beginFetch(s);
    s = applyFetch(s, newer, [card("a", "S3")]);
    s = applyFetch(s, older, [card("a", "S2")]);
    expect(stageOf(s, "a")).toBe("S3");
  });

  it("keeps a row created locally after the refetch started", () => {
    let s = loaded([card("a", "S1")]);
    let t: number;
    [s, t] = beginFetch(s);
    s = upsertRow(s, card("n", "S1"));
    s = applyFetch(s, t, [card("a", "S1")]);
    expect(boardRows(s)?.map((r) => r.id)).toEqual(["n", "a"]);
  });

  it("drops rows the server no longer returns (deleted elsewhere)", () => {
    let s = loaded([card("a", "S1"), card("b", "S1")]);
    let t: number;
    [s, t] = beginFetch(s);
    s = applyFetch(s, t, [card("a", "S1")]);
    expect(boardRows(s)?.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("boardSync — modal results and load failures", () => {
  it("upsert merges a known-fresh copy into the existing card", () => {
    let s = loaded([card("a", "S1", 9)]);
    s = upsertRow(s, card("a", "CLOSED", 0), (prev, row) => ({ ...prev, stage: row.stage }));
    expect(boardRows(s)?.[0]).toEqual({ ...card("a", "CLOSED"), days: 9 });
  });

  it("a failed first load shows an empty board; a failed refresh keeps the rows", () => {
    expect(boardRows(failFetch(initialBoard<Card>()))).toEqual([]);
    const s = loaded([card("a", "S1")]);
    expect(failFetch(s)).toBe(s);
  });
});
