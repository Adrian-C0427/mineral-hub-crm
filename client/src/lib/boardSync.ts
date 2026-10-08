/**
 * Board sync — the pure state behind the Pipeline boards' drag-and-drop.
 *
 * A board shows server rows (deals / opportunities) that the user moves
 * between stages optimistically. Three things race on that list: the user's
 * moves, each move's request, and full-list refetches (initial load, window
 * focus, a background interval, another tab). Without ordering, a refetch that
 * started before a move committed lands after it and snaps the card back, and
 * a slow response for an older move overwrites a newer one.
 *
 * The rules, all enforced here (no React, no I/O — see useBoardSync for the
 * hook that drives it):
 *  - `base` is the last known server truth; unsettled moves live in `pending`
 *    and are drawn over it, so no refetch can move a card the user is moving.
 *  - Every move gets a sequence number; only the newest intent for a card
 *    decides what it shows. An older response still updates `base` (it is
 *    server truth) but never clears a newer intent; an older failure is moot.
 *  - Every refetch gets a ticket from the same logical clock. A refetch older
 *    than one already applied is dropped, and a row written locally after a
 *    refetch started (a settled move, a modal's result) keeps its local copy —
 *    that refetch read the database before the write.
 */

export interface BoardRow { id: string; stage: string }

export interface BoardState<T extends BoardRow> {
  /** Last known server truth (null until the first load). */
  base: T[] | null;
  /** Unsettled local moves by row id: the stage the user asked for + its seq. */
  pending: Record<string, { stage: string; seq: number }>;
  /** Logical clock shared by moves, settles, writes and fetch tickets. */
  clock: number;
  /** Clock value at which each row was last written locally (settle / upsert). */
  writtenAt: Record<string, number>;
  /** Newest move seq whose response has been folded into `base`, per row. */
  settledSeq: Record<string, number>;
  /** Ticket of the newest refetch applied (older responses are dropped). */
  appliedFetch: number;
}

export function initialBoard<T extends BoardRow>(): BoardState<T> {
  return { base: null, pending: {}, clock: 0, writtenAt: {}, settledSeq: {}, appliedFetch: 0 };
}

/** The rows to render: server truth with unsettled moves drawn on top. */
export function boardRows<T extends BoardRow>(s: BoardState<T>): T[] | null {
  if (!s.base) return null;
  if (!Object.keys(s.pending).length) return s.base;
  return s.base.map((r) => {
    const p = s.pending[r.id];
    return p && p.stage !== r.stage ? { ...r, stage: p.stage } : r;
  });
}

/** Optimistic move: the card shows `stage` at once. Returns the move's seq. */
export function beginMove<T extends BoardRow>(s: BoardState<T>, id: string, stage: string): [BoardState<T>, number] {
  const seq = s.clock + 1;
  return [{ ...s, clock: seq, pending: { ...s.pending, [id]: { stage, seq } } }, seq];
}

/** Is `seq` still the newest intent for this row? */
export function isLatestMove<T extends BoardRow>(s: BoardState<T>, id: string, seq: number): boolean {
  return s.pending[id]?.seq === seq;
}

/**
 * A move's request finished. `reconcile` (success) folds the server's answer
 * into the row; omit it for a failure. The newest intent's settle clears its
 * overlay — on success the row now carries the saved stage, on failure the card
 * falls back to the last server truth (the intentional revert).
 */
export function settleMove<T extends BoardRow>(
  s: BoardState<T>, id: string, seq: number, reconcile?: (row: T) => T,
): BoardState<T> {
  const latest = isLatestMove(s, id, seq);
  let next = s;
  if (latest) {
    const { [id]: _done, ...pending } = s.pending;
    next = { ...next, pending };
  }
  // Fold a success into server truth unless a newer response already did.
  if (reconcile && seq > (s.settledSeq[id] ?? 0) && s.base) {
    const clock = next.clock + 1;
    next = {
      ...next,
      clock,
      base: s.base.map((r) => (r.id === id ? reconcile(r) : r)),
      writtenAt: { ...next.writtenAt, [id]: clock },
      settledSeq: { ...next.settledSeq, [id]: seq },
    };
  }
  return next;
}

/** Insert or replace a row with a known-fresh server copy (a modal's result, a
 *  newly created record). New rows go first, like the server's newest-first lists. */
export function upsertRow<T extends BoardRow>(s: BoardState<T>, row: T, merge: (prev: T, row: T) => T = (_p, r) => r): BoardState<T> {
  const clock = s.clock + 1;
  const base = s.base ?? [];
  const exists = base.some((r) => r.id === row.id);
  return {
    ...s,
    clock,
    base: exists ? base.map((r) => (r.id === row.id ? merge(r, row) : r)) : [row, ...base],
    writtenAt: { ...s.writtenAt, [row.id]: clock },
  };
}

/** A refetch is starting: its ticket orders it against moves and other fetches. */
export function beginFetch<T extends BoardRow>(s: BoardState<T>): [BoardState<T>, number] {
  const ticket = s.clock + 1;
  return [{ ...s, clock: ticket }, ticket];
}

/**
 * A refetch returned. Dropped when a newer refetch was already applied; rows
 * written locally after this one started keep their local copy (and rows it
 * could not have seen yet stay). Pending moves stay drawn on top regardless.
 */
export function applyFetch<T extends BoardRow>(s: BoardState<T>, ticket: number, rows: T[]): BoardState<T> {
  if (ticket < s.appliedFetch) return s;
  const local = new Map((s.base ?? []).map((r) => [r.id, r]));
  const newer = (id: string) => (s.writtenAt[id] ?? 0) > ticket;
  const seen = new Set<string>();
  const base = rows.map((r) => {
    seen.add(r.id);
    return newer(r.id) ? local.get(r.id) ?? r : r;
  });
  const kept = (s.base ?? []).filter((r) => !seen.has(r.id) && newer(r.id));
  // Bookkeeping older than this snapshot is no longer needed.
  const writtenAt: Record<string, number> = {};
  for (const [id, at] of Object.entries(s.writtenAt)) if (at > ticket) writtenAt[id] = at;
  return { ...s, base: kept.length ? [...kept, ...base] : base, writtenAt, appliedFetch: ticket };
}

/** A failed refetch: the first load falls back to an empty board, later ones keep what is shown. */
export function failFetch<T extends BoardRow>(s: BoardState<T>): BoardState<T> {
  return s.base ? s : { ...s, base: [] };
}
