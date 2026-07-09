import { PrismaClient, Prisma } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/**
 * Prisma error codes for a connection that couldn't be reached or was dropped
 * mid-flight. Neon's serverless Postgres occasionally rejects a connection
 * during a cold-start or a brief reconnect; the failure is transient and a
 * single retry with a short backoff clears it. These are the only codes we
 * retry — anything else (a real query error, a constraint violation) must
 * surface immediately.
 *   P1001 — can't reach database server
 *   P1017 — server has closed the connection
 */
const RETRYABLE_DB_ERROR_CODES = new Set(["P1001", "P1017"]);

/**
 * Run a DB operation, retrying only on transient connection errors. The happy
 * path is unchanged (the op runs once and returns); retries kick in solely for
 * the Neon reconnect blips seen on hot, unauthenticated routes (the vector-tile
 * fetch). Backoff is exponential from `baseDelayMs` (100ms, 200ms by default).
 */
export async function withDbRetry<T>(
  op: () => Promise<T>,
  retries = 2,
  baseDelayMs = 100,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const code =
        err instanceof Prisma.PrismaClientKnownRequestError ? err.code : undefined;
      if (attempt >= retries || !code || !RETRYABLE_DB_ERROR_CODES.has(code)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
}
