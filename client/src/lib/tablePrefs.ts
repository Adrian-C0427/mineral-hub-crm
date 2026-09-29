import { api } from "../api/client";

/**
 * Customize View layouts saved to the user's profile (GET/PUT
 * /auth/table-prefs). Loaded once per user per session; saves are debounced
 * per table. Only tables the user actually customized are ever stored.
 */
export interface SavedColPrefs { order: string[]; hidden: string[]; pinned: string[]; known?: string[] }

let cacheUser: string | null = null;
let cache: Record<string, SavedColPrefs> | null = null;
let inflight: Promise<Record<string, SavedColPrefs>> | null = null;

export function loadProfileTablePrefs(userId: string): Promise<Record<string, SavedColPrefs>> {
  if (cacheUser !== userId) { cacheUser = userId; cache = null; inflight = null; }
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api.get<Record<string, SavedColPrefs>>("/auth/table-prefs")
      .then((m) => { if (cacheUser === userId) cache = m ?? {}; return m ?? {}; })
      .catch(() => { inflight = null; return {}; }); // retry on the next table mount
  }
  return inflight;
}

const timers = new Map<string, number>();
/** Persist one table's layout (null = back to the default layout). */
export function saveProfileTablePrefs(userId: string, tableId: string, prefs: SavedColPrefs | null): void {
  if (cacheUser === userId && cache) {
    if (prefs) cache[tableId] = prefs; else delete cache[tableId];
  }
  const t = timers.get(tableId);
  if (t) window.clearTimeout(t);
  timers.set(tableId, window.setTimeout(() => {
    timers.delete(tableId);
    void api.put(`/auth/table-prefs/${encodeURIComponent(tableId)}`, { prefs }).catch(() => { /* local copy still applies */ });
  }, 400));
}
