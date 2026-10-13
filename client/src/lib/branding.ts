/**
 * Org branding: which logo a branding slot renders, and when to fall back to
 * the default Mineral Hub mark.
 *
 * Logos live on the Organization row as image data URLs and arrive inline
 * with the authenticated /auth/me profile. That makes them always the CURRENT
 * org's (no org-keyed cache to go stale across account switches) and they can
 * never expire (no presigned URL). What CAN go wrong is the value itself — an
 * empty string, a legacy upload the browser can't decode — so every slot
 * resolves through here and skips anything unusable or known-broken.
 *
 * Pure (no React/DOM) so the selection rules are unit-tested.
 */
export type LogoKind = "full" | "compact";

export interface BrandingSource {
  fullLogo?: string | null;
  compactLogo?: string | null;
}

/** Image sources an <img> can be handed: a data URL (what PATCH /org/branding stores) or an http(s)/root-relative URL. */
const USABLE = /^(data:image\/[a-z0-9.+-]+[;,]|https?:\/\/|\/)/i;

/** The logo value when it is worth rendering, else null ("show the default mark"). */
export function usableLogo(value: string | null | undefined, failed?: ReadonlySet<string>): string | null {
  if (typeof value !== "string" || !USABLE.test(value)) return null;
  return failed?.has(value) ? null : value;
}

/**
 * The logo for a slot: the slot's own upload first, then the other one — so an
 * org that uploaded only ONE logo shows it in both sidebar states — skipping
 * sources that already failed to decode. Null → render the default wordmark
 * ("Mineral Hub." / "MH"), never an empty box or broken image.
 */
export function pickLogo(org: BrandingSource | null | undefined, kind: LogoKind, failed?: ReadonlySet<string>): string | null {
  const own = kind === "full" ? org?.fullLogo : org?.compactLogo;
  const other = kind === "full" ? org?.compactLogo : org?.fullLogo;
  return usableLogo(own, failed) ?? usableLogo(other, failed);
}

/**
 * Earlier builds mirrored both logo data URLs (up to ~1.4 MB) into localStorage
 * on every profile load for a "first paint" the shell never used — the sidebar
 * only mounts once /auth/me has answered. A failed write (quota) left the
 * PREVIOUS org's logos behind. Drop it so it can't go stale or crowd out the
 * session token that shares the same storage quota.
 */
export const LEGACY_BRANDING_KEY = "mh-org-branding:v1";

export function purgeLegacyBrandingCache(storage: Pick<Storage, "removeItem"> | null = safeLocalStorage()): void {
  try { storage?.removeItem(LEGACY_BRANDING_KEY); } catch { /* storage blocked — nothing cached either */ }
}

function safeLocalStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
