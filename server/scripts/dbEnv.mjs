/**
 * Shared connection-URL rules for the Prisma CLI steps (generate + migrate).
 *
 * schema.prisma splits the two endpoints: `url` (DATABASE_URL) is the pooled
 * pgbouncer connection the app runs on, `directUrl` (DIRECT_URL) is the
 * un-pooled one the CLI migrates over. Prisma resolves BOTH env vars whenever
 * it loads the schema — including `prisma generate` during the build — so a
 * deploy that hasn't added DIRECT_URL yet would fail at build time on a var it
 * doesn't actually need to generate a client.
 *
 * Defaulting DIRECT_URL to DATABASE_URL keeps that case working and reproduces
 * the exact pre-pooling behavior (one URL for everything), so the code change
 * can ship before the environment is switched over, in either order.
 */
export function ensureDirectUrl() {
  if (!process.env.DIRECT_URL) {
    if (process.env.DATABASE_URL) {
      process.env.DIRECT_URL = process.env.DATABASE_URL;
      console.log("[db-env] DIRECT_URL unset — using DATABASE_URL for Prisma CLI steps.");
    }
    return;
  }
  // Migrating through the pooler defeats the split: `migrate deploy` takes a
  // session-scoped advisory lock that transaction-mode pgbouncer won't hold
  // across statements. Warn loudly rather than fail — a non-Neon Postgres may
  // legitimately have "-pooler" nowhere near its hostname semantics.
  if (process.env.DIRECT_URL.includes("-pooler.")) {
    console.warn("[db-env] WARNING: DIRECT_URL points at a -pooler host; migrations want the direct endpoint.");
  }
}
