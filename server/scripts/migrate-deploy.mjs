#!/usr/bin/env node
/**
 * Migration-aware deploy step (replaces `prisma db push` in the start command).
 *
 * - Fresh database            → `prisma migrate deploy` applies 0_init + rest.
 * - Existing pre-migrations DB → the first deploy hits P3005 ("database is not
 *   empty"); we baseline it by marking 0_init as already applied, then run
 *   deploy again for any newer migrations. `db push` kept the DB in sync with
 *   schema.prisma on every deploy, so marking the baseline applied is exact.
 * - Already-baselined DB       → deploy is a no-op unless new migrations exist.
 * - Known transactional migration left in a failed state → clear it and retry
 *   once (see RECOVERABLE below).
 *
 * Never resets or drops anything: `migrate deploy` is strictly forward-only,
 * which is the whole point of moving off `db push` before the data matters.
 */
import { spawnSync } from "node:child_process";

const BASELINE = "0_init";

// Migrations that run entirely inside one transaction, so a failure rolls the
// whole thing back and leaves the schema untouched. If `migrate deploy` reports
// one of these as a failed migration (P3009), clearing its record and
// re-applying is safe. Scoped by exact name so an unrelated failure is never
// auto-cleared — it must still surface and fail the deploy.
const RECOVERABLE = ["20260715180000_buyer_tag_per_org"];

function prisma(args) {
  const r = spawnSync("npx", ["prisma", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  return { status: r.status ?? 1, out };
}

const deploy = () => prisma(["migrate", "deploy"]);

/**
 * If the failure is a P3009 naming a known-transactional migration, mark it
 * rolled-back and retry deploy once. Returns the retry's exit status, or null
 * when this isn't a recoverable failure.
 */
function recoverRolledBack(out) {
  const name = RECOVERABLE.find((n) => out.includes(n));
  if (!out.includes("P3009") || !name) return null;
  console.log(`[migrate-deploy] Clearing rolled-back migration ${name} and retrying…`);
  const resolved = prisma(["migrate", "resolve", "--rolled-back", name]);
  if (resolved.status !== 0) return resolved.status;
  return deploy().status;
}

let res = deploy();
if (res.status === 0) process.exit(0);

if (res.out.includes("P3005")) {
  console.log(`[migrate-deploy] Existing schema without migration history — baselining ${BASELINE}…`);
  const resolved = prisma(["migrate", "resolve", "--applied", BASELINE]);
  if (resolved.status !== 0) process.exit(resolved.status);
  res = deploy();
  if (res.status === 0) process.exit(0);
}

const recovered = recoverRolledBack(res.out);
if (recovered !== null) process.exit(recovered);

process.exit(res.status);
