import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyFetch, beginFetch, beginMove, boardRows, failFetch, initialBoard, isLatestMove, settleMove, upsertRow,
  type BoardRow, type BoardState,
} from "./boardSync";

/** How often an open, visible board picks up other users' changes. */
const REFRESH_MS = 30_000;
/** One channel for every board: a move in one tab refreshes the same board in the others. */
const CHANNEL = "mh-board-sync";

/** What a move's caller learns once it is over. `latest` = it was still the
 *  newest intent for the card (a superseded move needs no toast either way). */
export type MoveOutcome<R> =
  | { status: "saved"; result: R; latest: boolean }
  | { status: "failed"; error: unknown; latest: boolean }
  /** Replaced by a newer move of the same card before its request went out. */
  | { status: "superseded" };

interface Job<T, R> {
  seq: number;
  send: () => Promise<R>;
  reconcile: (row: T, result: R) => T;
  done: (o: MoveOutcome<R>) => void;
}

/**
 * Drives a Pipeline board's rows through the pure rules in boardSync.ts:
 * optimistic moves, per-card request sequencing (one request in flight per
 * card; further moves of that card coalesce so the last intent wins), refetch
 * ordering, and keeping the board current — on window focus / tab visibility,
 * on a modest interval while visible, and when another tab moves a card.
 * Background refreshes wait while `paused` (a card is being dragged) and run
 * once it ends.
 */
export function useBoardSync<T extends BoardRow>({ scope, fetchRows, enabled = true, paused = false, onFetchError }: {
  /** Identity of the list (e.g. "opps:<pipelineId>"): a change starts over. */
  scope: string;
  fetchRows: () => Promise<T[]>;
  /** False while the board isn't shown (no background refreshes). */
  enabled?: boolean;
  paused?: boolean;
  /** `initial`: the board had nothing to show yet (later failures keep the rows on screen). */
  onFetchError?: (err: unknown, initial: boolean) => void;
}) {
  const stateRef = useRef<BoardState<T>>(initialBoard<T>());
  const [version, setVersion] = useState(0);
  const update = useCallback((fn: (s: BoardState<T>) => BoardState<T>) => {
    stateRef.current = fn(stateRef.current);
    setVersion((v) => v + 1);
  }, []);
  // Latest callbacks/flags for the long-lived listeners below.
  const fetchRef = useRef(fetchRows); fetchRef.current = fetchRows;
  const errRef = useRef(onFetchError); errRef.current = onFetchError;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const fetching = useRef(0);
  const missed = useRef(false);
  // Per card: whether a request is in flight, and the move queued behind it.
  const flights = useRef(new Map<string, { queued: Job<T, unknown> | null }>());

  const reload = useCallback(() => {
    const forScope = scopeRef.current;
    let ticket = 0;
    update((s) => { const [n, t] = beginFetch(s); ticket = t; return n; });
    fetching.current++;
    fetchRef.current()
      .then((rows) => { if (scopeRef.current === forScope) update((s) => applyFetch(s, ticket, rows)); })
      .catch((err) => {
        if (scopeRef.current !== forScope) return;
        const initial = stateRef.current.base == null;
        update(failFetch);
        errRef.current?.(err, initial);
      })
      .finally(() => { fetching.current--; });
  }, [update]);

  /** Background refresh: skipped mid-drag (run when it ends) or when one is already running. */
  const refresh = useCallback(() => {
    if (pausedRef.current) { missed.current = true; return; }
    if (fetching.current > 0) return;
    reload();
  }, [reload]);

  // Tell the other tabs a card moved.
  const channel = useRef<BroadcastChannel | null>(null);
  const announce = useCallback(() => {
    try { channel.current?.postMessage({ scope: scopeRef.current }); } catch { /* closed */ }
  }, []);

  // A new scope starts from an empty board (the clock keeps counting, so a
  // straggling ticket from before can never outrank a newer one).
  useEffect(() => {
    stateRef.current = { ...initialBoard<T>(), clock: stateRef.current.clock };
    flights.current = new Map();
    setVersion((v) => v + 1);
    reload();
  }, [scope, reload]);

  useEffect(() => {
    if (!enabled) return;
    // Shown again after being hidden (e.g. switching back from another board): catch up.
    if (stateRef.current.base) refresh();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, REFRESH_MS);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (e: MessageEvent<{ scope?: string }>) => { if (e.data?.scope === scopeRef.current) refresh(); };
    } catch { /* unsupported: focus + interval still apply */ }
    channel.current = bc;
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
      bc?.close();
      channel.current = null;
    };
  }, [enabled, refresh]);

  // A refresh skipped during a drag runs as soon as the drag ends.
  useEffect(() => {
    if (!paused && missed.current) { missed.current = false; refresh(); }
  }, [paused, refresh]);

  /** Run a card's request; then whatever was queued behind it. */
  const run = useCallback((id: string, job: Job<T, unknown>) => {
    const forScope = scopeRef.current;
    flights.current.set(id, { queued: null });
    job.send().then(
      (result) => {
        if (scopeRef.current !== forScope) return;
        const latest = isLatestMove(stateRef.current, id, job.seq);
        update((s) => settleMove(s, id, job.seq, (row) => job.reconcile(row, result)));
        announce();
        job.done({ status: "saved", result, latest });
      },
      (error) => {
        if (scopeRef.current !== forScope) return;
        const latest = isLatestMove(stateRef.current, id, job.seq);
        update((s) => settleMove(s, id, job.seq));
        job.done({ status: "failed", error, latest });
      },
    ).finally(() => {
      if (scopeRef.current !== forScope) return;
      const next = flights.current.get(id)?.queued;
      if (next) run(id, next);
      else flights.current.delete(id);
    });
  }, [update, announce]);

  /**
   * Move a card to `stage` now; `send` persists it, `reconcile` folds the
   * server's answer into the row. While an earlier request for the card is in
   * flight the move waits behind it, and a later move replaces it (last intent wins).
   */
  const move = useCallback(<R,>(id: string, stage: string, send: () => Promise<R>, reconcile: (row: T, result: R) => T): Promise<MoveOutcome<R>> => {
    let seq = 0;
    update((s) => { const [n, q] = beginMove(s, id, stage); seq = q; return n; });
    return new Promise<MoveOutcome<R>>((resolve) => {
      const job: Job<T, R> = { seq, send, reconcile, done: resolve };
      const flight = flights.current.get(id);
      if (flight) {
        flight.queued?.done({ status: "superseded" });
        flight.queued = job as unknown as Job<T, unknown>;
      } else {
        run(id, job as unknown as Job<T, unknown>);
      }
    });
  }, [update, run]);

  /** Put a known-fresh server copy of a row on the board (a modal's result, a new record). */
  const upsert = useCallback((row: T, merge?: (prev: T, row: T) => T) => {
    update((s) => upsertRow(s, row, merge));
    announce();
  }, [update, announce]);

  const rows = useMemo(() => boardRows(stateRef.current), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, reload, move, upsert };
}
