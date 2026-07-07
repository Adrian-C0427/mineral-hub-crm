import { prisma } from "../db.js";

/**
 * Tiny in-process TTL cache for per-org role permission overrides.
 *
 * attachUser used to hit rolePermissions on EVERY authenticated request —
 * one extra round-trip per API call for data that only changes when an owner
 * edits the Roles & Permissions matrix. Overrides are cached for a short TTL
 * and invalidated explicitly on write, so a matrix edit still applies
 * immediately on this instance (and within TTL on any other instance).
 */
const TTL_MS = 60_000;

type Entry = { at: number; permissions: string[] | null };
const cache = new Map<string, Entry>();

const key = (organizationId: string, role: string) => `${organizationId}:${role}`;

export async function getRoleOverride(organizationId: string, role: string): Promise<string[] | null> {
  const k = key(organizationId, role);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.permissions;
  const row = await prisma.rolePermissions.findUnique({
    where: { organizationId_role: { organizationId, role: role as never } },
    select: { permissions: true },
  });
  const permissions = row?.permissions ?? null;
  cache.set(k, { at: Date.now(), permissions });
  return permissions;
}

/** Drop all cached overrides for an org — call after any roles-matrix write. */
export function invalidateRoleCache(organizationId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${organizationId}:`)) cache.delete(k);
}
