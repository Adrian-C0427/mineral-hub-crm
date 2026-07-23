#!/usr/bin/env node
/**
 * `prisma <args…>` with the DIRECT_URL fallback applied first (see dbEnv.mjs).
 *
 * Every Prisma CLI command resolves both datasource env vars when it loads the
 * schema, so `generate` — which needs no database at all — would otherwise fail
 * a build on a deploy that hasn't added DIRECT_URL yet. Routing the npm scripts
 * through here keeps the code deployable before the environment is switched to
 * the pooled endpoint, and after.
 */
import { spawnSync } from "node:child_process";
import { ensureDirectUrl } from "./dbEnv.mjs";

ensureDirectUrl();

const r = spawnSync("prisma", process.argv.slice(2), { stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
