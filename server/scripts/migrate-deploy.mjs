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
 *
 * Never resets or drops anything: `migrate deploy` is strictly forward-only,
 * which is the whole point of moving off `db push` before the data matters.
 */
import { spawnSync } from "node:child_process";

const BASELINE = "0_init";

function prisma(args) {
  const r = spawnSync("npx", ["prisma", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  return { status: r.status ?? 1, out };
}

const first = prisma(["migrate", "deploy"]);
if (first.status === 0) process.exit(0);

if (first.out.includes("P3005")) {
  console.log(`[migrate-deploy] Existing schema without migration history — baselining ${BASELINE}…`);
  const resolve = prisma(["migrate", "resolve", "--applied", BASELINE]);
  if (resolve.status !== 0) process.exit(resolve.status);
  const second = prisma(["migrate", "deploy"]);
  process.exit(second.status);
}

process.exit(first.status);
