/**
 * Deterministic avatar background color derived from a name.
 *
 * Initials avatars (seller, contact, …) get an automatically-assigned color
 * from this curated palette instead of everyone sharing one blue. The mapping
 * is stable (same name → same color across the app and across reloads) via a
 * simple string hash. Every color is dark enough to carry white initials.
 */
export const AVATAR_COLORS = [
  "#2563eb", // blue
  "#4f46e5", // indigo
  "#7c3aed", // violet
  "#9333ea", // purple
  "#0d9488", // teal
  "#0891b2", // cyan
  "#0f766e", // deep teal
  "#b45309", // amber
  "#be123c", // rose
  "#db2777", // pink
  "#4d7c0f", // olive
  "#475569", // slate
];

export function avatarColor(name: string | null | undefined): string {
  const s = (name ?? "").trim();
  if (!s) return AVATAR_COLORS[0];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/**
 * Color for a USER's initials avatar: their explicitly chosen color when set
 * (User.avatarColor, threaded through API payloads), else the stable name-hash
 * fallback — so every render site shows the same color for the same person.
 */
export function userAvatarColor(u: { name?: string | null; avatarColor?: string | null } | null | undefined): string {
  if (u?.avatarColor && /^#[0-9a-fA-F]{6}$/.test(u.avatarColor)) return u.avatarColor;
  return avatarColor(u?.name);
}

/** Initials for an avatar chip — first letters of the first two name words. */
export function initialsOf(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}
