import { prisma } from "../db.js";

/**
 * Demo / showcase workspace helpers shared by the auth routes, the email
 * service and the nightly reset. The demo org is Organization.isDemo; its
 * people all use this (non-deliverable) email domain.
 */
export const DEMO_EMAIL_DOMAIN = "brazosridge.demo";
export const DEFAULT_DEMO_USER_EMAIL = `demo@${DEMO_EMAIL_DOMAIN}`;

export function isDemoEmail(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}

/** The demo login. One-click "Explore the demo" is opt-in (DEMO_PUBLIC_LOGIN=true). */
export function demoLoginConfig(): { publicLogin: boolean; email: string } {
  const email = (process.env.DEMO_USER_EMAIL || DEFAULT_DEMO_USER_EMAIL).trim().toLowerCase();
  return { publicLogin: process.env.DEMO_PUBLIC_LOGIN === "true" && isDemoEmail(email), email };
}

// isDemo never flips for a live org in practice; a short cache spares a
// lookup on every outbound email without ever being stale for long.
const CACHE_MS = 60_000;
const demoOrgCache = new Map<string, { isDemo: boolean; at: number }>();

export async function isDemoOrg(organizationId: string | null | undefined): Promise<boolean> {
  if (!organizationId) return false;
  const hit = demoOrgCache.get(organizationId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.isDemo;
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { isDemo: true } });
  const isDemo = org?.isDemo === true;
  demoOrgCache.set(organizationId, { isDemo, at: Date.now() });
  return isDemo;
}
