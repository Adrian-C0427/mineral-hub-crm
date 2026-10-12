import { Prisma } from "@prisma/client";

/**
 * Prisma error codes for a connection that couldn't be reached or was dropped
 * mid-flight. Neon's serverless Postgres occasionally rejects a connection
 * during a cold-start or a brief reconnect; the failure is transient and a
 * single retry with a short backoff clears it. These are the only codes we
 * retry — anything else (a real query error, a constraint violation) must
 * surface immediately.
 *   P1001 — can't reach database server
 *   P1017 — server has closed the connection
 *   P2024 — timed out fetching a connection from the pool. Fired when Neon
 *           terminates connections en masse (E57P01, "administrator command":
 *           an autosuspend or maintenance restart) and a request briefly finds
 *           the pool drained. It is transient like the two above, and the
 *           exponential backoff in withDbRetry is what makes retrying it safe —
 *           the retry lands *after* the churn window, once connections free up,
 *           rather than piling more concurrent demand onto an exhausted pool.
 *
 * Kept out of db.ts (which constructs the PrismaClient) so the error handler
 * can classify these without importing — or being broken by mocks of — db.ts.
 */
const TRANSIENT_DB_ERROR_CODES = new Set(["P1001", "P1017", "P2024"]);

/** True for a Prisma error meaning the database was briefly unreachable. */
export function isTransientDbError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && TRANSIENT_DB_ERROR_CODES.has(err.code);
}
