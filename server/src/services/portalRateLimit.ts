/**
 * Database-backed fixed-window rate limiter for the PUBLIC buyer-portal
 * submission endpoints (lead + offer capture).
 *
 * These endpoints are unauthenticated and write to the CRM, so they need a cap
 * per client IP. A per-process Map would reset on every deploy/restart and, once
 * the API runs more than one instance, each replica would keep its own counter —
 * multiplying the effective limit by the replica count. Persisting the counter
 * to Postgres makes the cap hold across restarts AND across instances.
 *
 * Fixed window: hits are bucketed to the top of the hour. The upsert increments
 * atomically (Postgres row lock on the composite PK), so concurrent submissions
 * can't race past the limit. Stale rows are swept opportunistically so the table
 * never grows unbounded.
 */
import { prisma } from "../db.js";

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = 10; // submissions per IP per window (matches prior cap)

/** Start of the fixed window that `now` falls into. */
function windowStartFor(now: number): Date {
  return new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
}

/**
 * Record a hit for `bucket:ip` and report whether the caller has exceeded the
 * window cap. Fails OPEN (returns false) on any DB error so a transient outage
 * never blocks a legitimate buyer submission.
 */
export async function portalRateLimited(bucket: string, ip: string, now = Date.now()): Promise<boolean> {
  const key = `${bucket}:${ip}`;
  const windowStart = windowStartFor(now);
  try {
    const row = await prisma.portalRateHit.upsert({
      where: { key_windowStart: { key, windowStart } },
      create: { key, windowStart, count: 1 },
      update: { count: { increment: 1 } },
    });
    // Opportunistically clear windows that have fully elapsed (~1% of calls) so
    // the table stays small without a dedicated scheduler.
    if (Math.random() < 0.01) {
      prisma.portalRateHit
        .deleteMany({ where: { windowStart: { lt: new Date(now - WINDOW_MS) } } })
        .catch(() => {});
    }
    return row.count > MAX_PER_WINDOW;
  } catch {
    return false;
  }
}
