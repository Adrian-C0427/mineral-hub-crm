import { useLayoutEffect } from "react";

/**
 * A list page's scroll position, remembered when the user leaves for a record
 * and put back when they come Back. Kept per tab (sessionStorage) under the
 * page's key and used once, so opening the page fresh later starts at the top.
 * (The Pipeline board has its own richer version in boardScroll.ts.)
 */
const storageKey = (page: string) => `mh-page-scroll:${page}`;

export function rememberPageScroll(page: string): void {
  try { sessionStorage.setItem(storageKey(page), String(window.scrollY)); } catch { /* storage unavailable */ }
}

/** Restore once `ready` (the rows have rendered); the remembered value is consumed. */
export function usePageScrollRestore(page: string, ready: boolean): void {
  useLayoutEffect(() => {
    if (!ready) return;
    let y = 0;
    try { y = Number(sessionStorage.getItem(storageKey(page)) ?? 0); sessionStorage.removeItem(storageKey(page)); } catch { return; }
    if (y > 0) window.scrollTo(0, y);
  }, [page, ready]);
}
