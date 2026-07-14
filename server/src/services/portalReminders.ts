/**
 * Buyer-portal reminder digest.
 *
 * A lightweight in-process scheduler (same shape as the integration sync loop)
 * that emails an org's OWNERS a periodic reminder of UNACTIONED portal activity
 * — new buyer offers and leads that haven't been reviewed. It reads the same
 * `portal_offer` / `portal_lead` notifications the portal routes create, so a
 * submission that sits unread eventually turns into a nudge instead of being
 * missed.
 *
 * Recipients are internal users (owner emails already on file), so there is no
 * external-email opt-in/unsubscribe surface and no schema change. Sends are
 * throttled per org so a chatty tick or a restart can't spam.
 */
import { prisma } from "../db.js";
import { env } from "../config.js";
import { sendEmail } from "./email.js";

const TICK_MS = 6 * 60 * 60 * 1000; // check every 6 hours
const THROTTLE_MS = 20 * 60 * 60 * 1000; // at most one digest per org per ~day
const lastSent = new Map<string, number>();

function digestHtml(orgName: string, offers: number, leads: number): string {
  const parts: string[] = [];
  if (offers) parts.push(`<strong>${offers}</strong> new offer${offers === 1 ? "" : "s"}`);
  if (leads) parts.push(`<strong>${leads}</strong> new buyer lead${leads === 1 ? "" : "s"}`);
  const summary = parts.join(" and ");
  const appUrl = env.APP_URL;
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1a2129">
      <p>You have ${summary} from the ${orgName} buyer portal awaiting review.</p>
      <p>
        <a href="${appUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600">Open Mineral Hub</a>
      </p>
      <p style="color:#5b6875;font-size:13px">Offers appear on their deal; leads on the buyer's profile. This reminder repeats until the items are reviewed (marked read).</p>
    </div>`;
}

/** One pass: email each eligible org's owners a digest of unread portal items. */
export async function runPortalReminderTick(now = Date.now()): Promise<void> {
  // No instance-wide transport is fine — orgs with Resend connected still
  // send (sendEmail resolves per-org); orgs without any transport just log.
  const unread = await prisma.notification.findMany({
    where: { readAt: null, type: { in: ["portal_offer", "portal_lead"] } },
    select: { organizationId: true, type: true },
  });
  if (!unread.length) return;

  // Tally per org.
  const byOrg = new Map<string, { offers: number; leads: number }>();
  for (const n of unread) {
    const t = byOrg.get(n.organizationId) ?? { offers: 0, leads: 0 };
    if (n.type === "portal_offer") t.offers++; else t.leads++;
    byOrg.set(n.organizationId, t);
  }

  const orgIds = [...byOrg.keys()].filter((id) => now - (lastSent.get(id) ?? 0) >= THROTTLE_MS);
  if (!orgIds.length) return;

  const orgs = await prisma.organization.findMany({
    where: { id: { in: orgIds }, portalEnabled: true },
    select: {
      id: true, name: true,
      users: { where: { orgRole: "OWNER", status: "ACTIVE", email: { not: "" } }, select: { email: true } },
    },
  });

  for (const org of orgs) {
    const counts = byOrg.get(org.id)!;
    const recipients = [...new Set(org.users.map((u) => u.email).filter(Boolean))];
    if (!recipients.length) continue;
    const subject = `Portal activity: ${counts.offers + counts.leads} item${counts.offers + counts.leads === 1 ? "" : "s"} awaiting review`;
    const html = digestHtml(org.name, counts.offers, counts.leads);
    for (const to of recipients) {
      try { await sendEmail({ to, subject, html, organizationId: org.id }); }
      catch (e) { console.error(`Portal reminder email failed for ${to}:`, e instanceof Error ? e.message : e); }
    }
    lastSent.set(org.id, now);
  }
}

/** Start the background reminder loop (call once at boot; no-op in tests). */
export function startPortalReminderScheduler(): void {
  if (process.env.NODE_ENV === "test") return;
  setInterval(() => void runPortalReminderTick().catch(() => {}), TICK_MS).unref();
}
