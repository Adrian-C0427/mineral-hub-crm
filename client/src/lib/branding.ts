/**
 * Cached org branding (name + logo data URLs).
 *
 * The sidebar logo must be visible from the FIRST paint of every page load,
 * but the org (and its logos) only arrives with /auth/me — which can be slow
 * on a serverless cold start or fail transiently. Caching the branding locally
 * lets the sidebar render the real logo synchronously at boot; the live
 * profile refreshes/overwrites it as soon as /auth/me lands. Cleared on
 * logout so another account never sees a stale mark.
 */
export interface OrgBranding {
  name: string;
  fullLogo: string | null;
  compactLogo: string | null;
}

const KEY = "mh-org-branding:v1";

export function loadBranding(): OrgBranding | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as OrgBranding;
    return typeof b?.name === "string" ? b : null;
  } catch {
    return null;
  }
}

export function saveBranding(b: OrgBranding | null): void {
  try {
    if (b && (b.fullLogo || b.compactLogo)) localStorage.setItem(KEY, JSON.stringify(b));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — the live profile still renders */
  }
}
