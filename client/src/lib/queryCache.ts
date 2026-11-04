import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";

/**
 * A small read cache for GET requests, shared by every page.
 *
 * Why: each page used to fetch everything it shows from scratch on every
 * visit, so going Deals → Dashboard → Deals meant three round trips to a
 * database 2,000 miles away each time, a spinner, and the same `/users`
 * list four times a minute. Now a response is kept in memory for the
 * session: a revisit renders what it had at once and refreshes in the
 * background ("stale-while-revalidate"); concurrent callers of the same
 * path share one request; and anything that writes can `invalidate()` a
 * path so the next read is fresh.
 *
 * Nothing here changes what the server returns — only when it is asked.
 * Data never outlives the signed-in session (`clearQueryCache` on sign-out)
 * and is never written to storage.
 */

interface Entry { data: unknown; at: number; inflight: Promise<unknown> | null; error: unknown }
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

/** How long a cached response is served without a background refresh. Lists
 *  that change as people work refresh after 15 s; lookups that change only
 *  when an administrator acts are kept for 5 minutes. */
const FRESH_MS = 15_000;
const FRESH_BY_PATH: Record<string, number> = { "/users": 5 * 60_000, "/pipeline/pipelines": 5 * 60_000, "/auth/table-prefs": 5 * 60_000 };
const freshFor = (path: string) => FRESH_BY_PATH[path.split("?")[0]] ?? FRESH_MS;

function notify(path: string) {
  for (const fn of listeners.get(path) ?? []) fn();
}

function entry(path: string): Entry {
  let e = entries.get(path);
  if (!e) { e = { data: undefined, at: 0, inflight: null, error: null }; entries.set(path, e); }
  return e;
}

/** Fetch `path`, sharing an in-flight request for the same path. */
export function fetchQuery<T>(path: string, opts: { force?: boolean } = {}): Promise<T> {
  const e = entry(path);
  if (e.inflight) return e.inflight as Promise<T>;
  if (!opts.force && e.data !== undefined && Date.now() - e.at < freshFor(path)) return Promise.resolve(e.data as T);
  const p = api.get<T>(path)
    .then((data) => { e.data = data; e.at = Date.now(); e.error = null; e.inflight = null; notify(path); return data; })
    .catch((err) => { e.inflight = null; e.error = err; notify(path); throw err; });
  e.inflight = p;
  return p;
}

/** What the cache holds for `path` right now (undefined when nothing yet). */
export function peekQuery<T>(path: string): T | undefined {
  return entries.get(path)?.data as T | undefined;
}

/** Put a response in the cache (e.g. a list the caller already has). */
export function primeQuery<T>(path: string, data: T): void {
  const e = entry(path); e.data = data; e.at = Date.now(); e.error = null; notify(path);
}

/** Mark paths stale so their next read refetches; `prefix` matches every path
 *  starting with it (e.g. "/deals" after a deal is edited). Subscribed
 *  components refetch at once. */
export function invalidateQueries(prefix: string): void {
  for (const [path, e] of entries) {
    if (path === prefix || path.startsWith(prefix.endsWith("?") ? prefix : `${prefix}?`) || path.startsWith(`${prefix}/`)) {
      e.at = 0;
      if ((listeners.get(path)?.size ?? 0) > 0) void fetchQuery(path, { force: true }).catch(() => {});
    }
  }
}

/** Drop everything (sign-out, account switch). */
export function clearQueryCache(): void {
  entries.clear();
}

/** Warm the cache without rendering anything (sidebar hover, after sign-in). */
export function prefetchQuery(path: string): void {
  void fetchQuery(path).catch(() => {});
}

export interface QueryState<T> {
  data: T | undefined;
  /** True only while there is nothing to show yet (first load). */
  loading: boolean;
  /** True while a background refresh is running. */
  refreshing: boolean;
  error: ApiError | null;
  /** Refetch now (after a write, or a Refresh button). */
  reload: () => Promise<void>;
}

/**
 * Subscribe a component to a cached GET. Renders cached data immediately
 * (no spinner on a revisit) and refreshes in the background when the entry
 * is older than FRESH_MS. Pass `null` to pause (e.g. until an id is known).
 */
export function useQuery<T>(path: string | null, opts: { refreshOnFocus?: boolean } = {}): QueryState<T> {
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(() => !!path && peekQuery(path) === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = useCallback(async (force: boolean) => {
    if (!path) return;
    const had = peekQuery(path) !== undefined;
    if (mounted.current) { if (had) setRefreshing(true); else setLoading(true); }
    try { await fetchQuery(path, { force }); }
    catch { /* surfaced through state.error */ }
    finally { if (mounted.current) { setLoading(false); setRefreshing(false); } }
  }, [path]);

  useEffect(() => {
    if (!path) { setLoading(false); return; }
    const fn = () => { if (mounted.current) bump((n) => n + 1); };
    const set = listeners.get(path) ?? new Set();
    set.add(fn); listeners.set(path, set);
    void run(false);
    const onVisible = () => { if (opts.refreshOnFocus && document.visibilityState === "visible") void run(true); };
    if (opts.refreshOnFocus) { document.addEventListener("visibilitychange", onVisible); window.addEventListener("focus", onVisible); }
    return () => {
      set.delete(fn);
      if (opts.refreshOnFocus) { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, run]);

  const e = path ? entries.get(path) : undefined;
  const data = path ? (peekQuery<T>(path)) : undefined;
  return {
    data,
    loading: !!path && data === undefined && (loading || !!e?.inflight),
    refreshing,
    error: e?.error instanceof ApiError ? e.error : null,
    reload: () => run(true),
  };
}
