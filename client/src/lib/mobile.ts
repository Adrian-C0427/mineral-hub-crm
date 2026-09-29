import { useSyncExternalStore } from "react";

/**
 * Compact-phone layouts. Desktop never matches either query, so everything
 * keyed off them leaves the desktop experience untouched.
 *
 *  - PHONE: any phone — portrait (≤760px wide) or a touch device held in
 *    landscape (short viewport, e.g. iPhone 17 Pro Max at 956×440). Drives the
 *    app shell: drawer navigation, compact top bar, full-screen sheets.
 *  - PHONE_PORTRAIT: the narrow single-column content layout.
 *
 * Keep in step with the @media blocks in mobile.css.
 */
export const PHONE_QUERY = "(max-width: 760px), (pointer: coarse) and (max-height: 500px)";
export const PHONE_PORTRAIT_QUERY = "(max-width: 760px)";

function subscribeQuery(query: string) {
  return (onChange: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  };
}
const snapshot = (query: string) => () => window.matchMedia(query).matches;
const subPhone = subscribeQuery(PHONE_QUERY), getPhone = snapshot(PHONE_QUERY);
const subPortrait = subscribeQuery(PHONE_PORTRAIT_QUERY), getPortrait = snapshot(PHONE_PORTRAIT_QUERY);

/** True on phones (portrait or landscape); updates on rotation/resize. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subPhone, getPhone, () => false);
}
/** True on narrow (portrait) phone layouts. */
export function useIsPhonePortrait(): boolean {
  return useSyncExternalStore(subPortrait, getPortrait, () => false);
}

// --- Drawer navigation open state (shared by TopBar's menu button + Sidebar) ---
let navOpen = false;
const navListeners = new Set<() => void>();
export function setMobileNavOpen(open: boolean): void {
  if (navOpen === open) return;
  navOpen = open;
  navListeners.forEach((l) => l());
}
function subNav(l: () => void) { navListeners.add(l); return () => { navListeners.delete(l); }; }
export function useMobileNavOpen(): boolean {
  return useSyncExternalStore(subNav, () => navOpen, () => false);
}

/**
 * Phones: tab strips and segmented controls scroll sideways instead of
 * wrapping, so bring each strip's selected item into view (e.g. a default
 * "This Year" period that sits past the right edge). Runs a few times after a
 * route change to catch strips that render once their data arrives.
 */
export function revealActiveStripItems(): () => void {
  if (!window.matchMedia(PHONE_QUERY).matches) return () => {};
  const run = () => {
    document.querySelectorAll<HTMLElement>(".seg-control, .tab-row, .asset-tabs").forEach((strip) => {
      if (strip.scrollWidth <= strip.clientWidth + 1) return;
      const active = strip.querySelector<HTMLElement>(".active, [aria-selected='true'], [aria-pressed='true']");
      if (!active) return;
      const a = active.getBoundingClientRect(), s = strip.getBoundingClientRect();
      if (a.left < s.left || a.right > s.right) strip.scrollLeft += a.left - s.left - (s.width - a.width) / 2;
    });
  };
  const timers = [60, 500, 1400].map((ms) => window.setTimeout(run, ms));
  return () => timers.forEach((t) => window.clearTimeout(t));
}
