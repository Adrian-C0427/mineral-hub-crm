/**
 * The unattended RRC refresh cycle — everything after the raw files are on
 * disk, and the checklist of what to download before that.
 *
 *   npx tsx src/scripts/rrcRefreshCycle.ts plan  [--date YYYY-MM-DD]
 *   npx tsx src/scripts/rrcRefreshCycle.ts check --data-dir <dir>
 *   npx tsx src/scripts/rrcRefreshCycle.ts run   --data-dir <dir> [--merge] [--date YYYY-MM-DD]
 *
 * `plan` creates the dated data directory under $RRC_REFRESH_HOME/data and
 * prints which file to take from which RRC transfer-portal folder (the portal
 * only serves files to a browser session, so a person — or a scheduled task
 * driving a browser — does the clicking). `check` verifies every expected file
 * is present and intact. `run` does the rest with no judgment calls:
 *
 *   1. resets this clone to origin/main, installs dependencies, generates Prisma
 *   2. builds the bundles with buildRrcRefresh.ts (snapshot dates come from the
 *      files themselves: the gzip headers of dbf900/uif700a/ledgers)
 *   3. nothing changed → removes the raw files and stops; otherwise:
 *   4. compares the new statuses with the live database (read-only) and
 *      applies the safety gates below, runs the refresh tests
 *   5. bumps the map tile version, commits, pushes rrc-refresh/<date>, opens
 *      the PR; with --merge and all gates green, merges it
 *   6. waits for the deploy to load the new bundle versions (polls the
 *      database's dataset_version markers), verifies the loaded counts
 *   7. writes a removal log and deletes the raw files
 *
 * Gates (any failure leaves the PR open, keeps the raw files, exits 2): no
 * county may lose more than 10 % of its wells, more than 5 % may be retired,
 * more than 30 % may change status, and the tests must pass.
 *
 * Lives in $RRC_REFRESH_HOME/repo (a clone kept outside iCloud-synced folders);
 * reads DATABASE_URL from $RRC_REFRESH_HOME/.env.
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { ABSTRACTS_DATASET, PRODUCTION_DATASET, WELLS_DATASET, parseAbstractsDataset, parseProductionDataset, parseWellsDataset } from "../ingest/refresh/dataset.js";
import { REFRESH_COUNTIES, REFRESH_LEDGERS } from "../ingest/refresh/scope.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOME = (process.env.RRC_REFRESH_HOME ?? path.join(os.homedir(), "rrc-refresh")).replace(/\/$/, "");
const SERVER = path.join(ROOT, "server");
const BUNDLE_DIR = path.join(SERVER, "data/rrc");
const MAP_LAYERS = path.join(ROOT, "client/src/lib/mapLayers.ts");
const MFT = "https://mft.rrc.texas.gov/link/";

/** Where each raw file comes from on RRC's transfer portal (public folder links; the file name inside is what to click). */
const FOLDERS = [
  { name: "RRC Well Layers by County", url: `${MFT}d551fb20-442e-4b67-84fa-ac3f23ecabb4`, files: REFRESH_COUNTIES.map((c) => `well${c.code}.zip`), minBytes: 100_000 },
  { name: "RRC Survey Layers by County", url: `${MFT}7bee2b33-4d7c-45a6-b3bc-61215f214c3c`, files: REFRESH_COUNTIES.map((c) => `surv${c.code}.zip`), minBytes: 100_000 },
  { name: "Wellbore Query Data (newest OG_WELLBORE_EWA_Report_<date>.csv)", url: `${MFT}650649b7-e019-4d77-a8e0-d118d6455381`, files: ["OG_WELLBORE_EWA_Report_<newest date>.csv"], minBytes: 300_000_000 },
  { name: "Full Wellbore (the .gz, never the frozen .ebc)", url: `${MFT}b070ce28-5c58-4fe2-9eb7-8b70befb7af9`, files: ["dbf900.ebc.gz"], minBytes: 300_000_000 },
  { name: "UIC database", url: `${MFT}d2438c05-b42f-45a8-b0c6-edceb0912767`, files: ["uif700a.txt.gz"], minBytes: 150_000_000 },
  { name: "Production Data Query dump", url: `${MFT}1f5ddb8d-329a-4459-b7f8-177b4f5ee60d`, files: ["PDQ_DSV.zip"], minBytes: 2_000_000_000 },
  { name: "Drilling Permit Master and Trailer (the .gz, never the frozen .txt)", url: `${MFT}beeeab0c-7d07-4111-af88-783c93677b2c`, files: ["daf802.txt.gz"], minBytes: 100_000_000 },
  { name: "Gas Ledger (districts 4–6)", url: `${MFT}c45ee840-9d50-4a74-b6b0-dba0cb4954b7`, files: [...REFRESH_LEDGERS.gas], minBytes: 1_000_000 },
  { name: "Oil Ledgers (districts 3, 5–6)", url: `${MFT}c5081c77-d32c-4ded-9b33-5aca3833306c`, files: [...REFRESH_LEDGERS.oil], minBytes: 500_000 },
];

const GATES = { minWellsRatio: 0.9, maxRetiredRatio: 0.05, maxStatusChangeRatio: 0.3 };
const DEPLOY_TIMEOUT_MS = 40 * 60_000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const log = (m: string) => console.log(`[cycle ${new Date().toISOString().slice(11, 19)}] ${m}`);
const today = () => new Date().toISOString().slice(0, 10);
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name: string, fallback?: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const flag = (name: string) => argv.includes(`--${name}`);

function sh(command: string, args: string[], opts: { cwd?: string; quiet?: boolean; env?: NodeJS.ProcessEnv } = {}): string {
  const r = spawnSync(command, args, { cwd: opts.cwd ?? ROOT, encoding: "utf8", env: { ...process.env, ...opts.env }, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${r.status}):\n${(r.stderr || r.stdout || "").slice(-4000)}`);
  if (!opts.quiet && r.stderr) process.stderr.write(r.stderr.slice(-2000));
  return r.stdout;
}
const git = (...args: string[]) => sh("git", args, { quiet: true }).trim();

/** Modification time from a gzip header (bytes 4–7, little-endian seconds) → YYYY-MM-DD. */
function gzipDate(file: string): string {
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(8);
  fs.readSync(fd, b, 0, 8, 0);
  fs.closeSync(fd);
  if (b[0] !== 0x1f || b[1] !== 0x8b) throw new Error(`${path.basename(file)} is not gzip`);
  const t = b.readUInt32LE(4);
  if (!t) throw new Error(`${path.basename(file)} carries no timestamp in its gzip header`);
  return new Date(t * 1000).toISOString().slice(0, 10);
}

/**
 * Hash of what a bundle would change in the database: its rows, without the
 * build time, the version, the source snapshot dates or the report summary.
 * RRC re-exports its GIS layers twice a week and a rebuild always carries a
 * new build time, so comparing whole files would deploy "changes" that move
 * no well, abstract or production row.
 */
function materialHash(bundle: string): string {
  const o = JSON.parse(zlib.gunzipSync(fs.readFileSync(bundle)).toString("utf8")) as Record<string, unknown>;
  for (const k of ["builtAt", "version", "sources", "source", "summary"]) delete o[k];
  return crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
}
const human = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`;

function expectedFiles(dataDir: string): { name: string; minBytes: number; folder: string }[] {
  const out: { name: string; minBytes: number; folder: string }[] = [];
  for (const f of FOLDERS) for (const name of f.files) {
    if (name.startsWith("OG_WELLBORE_EWA_Report_")) {
      const have = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((x) => /^OG_WELLBORE_EWA_Report_\d{4}-\d{2}-\d{2}\.csv$/.test(x)).sort().at(-1) : undefined;
      out.push({ name: have ?? name, minBytes: f.minBytes, folder: f.name });
    } else out.push({ name, minBytes: f.minBytes, folder: f.name });
  }
  return out;
}

async function db(): Promise<{ query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>; close(): Promise<void> }> {
  const envFile = path.join(HOME, ".env");
  if (!process.env.DATABASE_URL) {
    if (!fs.existsSync(envFile)) throw new Error(`no DATABASE_URL and no ${envFile}`);
    const m = fs.readFileSync(envFile, "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error(`${envFile} has no DATABASE_URL line`);
    process.env.DATABASE_URL = m[1].trim().replace(/^"(.*)"$/, "$1");
  }
  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient({ log: [] });
  return {
    query: <T,>(sql: string, params: unknown[] = []) => p.$queryRawUnsafe(sql, ...params) as Promise<T[]>,
    close: () => p.$disconnect(),
  };
}

// ---------------------------------------------------------------------------
// plan / check
// ---------------------------------------------------------------------------

function plan(): void {
  const date = arg("date", today())!;
  const dataDir = path.join(HOME, "data", date);
  fs.mkdirSync(dataDir, { recursive: true });
  const present = new Set(fs.readdirSync(dataDir));
  const stale = fs.readdirSync(path.join(HOME, "data")).filter((d) => d !== date && fs.statSync(path.join(HOME, "data", d)).isDirectory());
  const out = {
    dataDir,
    downloadsFolder: path.join(os.homedir(), "Downloads"),
    folders: FOLDERS.map((f) => ({ name: f.name, url: f.url, files: f.files, alreadyPresent: f.files.filter((n) => present.has(n)) })),
    staleDataDirs: stale.map((d) => path.join(HOME, "data", d)),
  };
  console.log(JSON.stringify(out, null, 2));
}

function check(dataDir: string): boolean {
  const problems: string[] = [];
  for (const f of expectedFiles(dataDir)) {
    const p = path.join(dataDir, f.name);
    if (!fs.existsSync(p)) { problems.push(`missing: ${f.name} (${f.folder})`); continue; }
    const size = fs.statSync(p).size;
    if (size < f.minBytes) { problems.push(`too small: ${f.name} is ${human(size)}, expected at least ${human(f.minBytes)}`); continue; }
    try {
      if (f.name.endsWith(".gz")) sh("gzip", ["-t", p], { quiet: true });
      else if (f.name.endsWith(".zip")) sh("unzip", ["-tq", p], { quiet: true });
      else if (f.name.endsWith(".csv")) { const head = fs.readFileSync(p, { encoding: "latin1", flag: "r" }).slice(0, 2000); if (!/\d{2},\d{3},\d{8}/.test(head.replace(/"/g, ""))) problems.push(`unexpected content: ${f.name}`); }
    } catch (e) { problems.push(`corrupt: ${f.name} — ${(e as Error).message.split("\n")[0]}`); }
  }
  for (const p of problems) console.log(`PROBLEM ${p}`);
  if (!problems.length) console.log(`OK all ${expectedFiles(dataDir).length} files present and intact in ${dataDir}`);
  return problems.length === 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface CountyCounts { county: string; n: number }

function removeRawFiles(dataDir: string, date: string, reason: string): string {
  const files = fs.readdirSync(dataDir).map((n) => ({ n, size: fs.statSync(path.join(dataDir, n)).size }));
  const total = files.reduce((a, f) => a + f.size, 0);
  const logFile = path.join(HOME, "logs", `removal-${date}.md`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, [`# RRC raw data removal — ${new Date().toISOString()}`, "", reason, "", `## ${dataDir} (${human(total)})`, ...files.map((f) => `- ${f.n}  ${f.size} bytes`), ""].join("\n"));
  fs.rmSync(dataDir, { recursive: true, force: true });
  return logFile;
}

async function run(): Promise<void> {
  const dataDir = path.resolve(arg("data-dir") ?? "");
  if (!arg("data-dir") || !fs.existsSync(dataDir)) throw new Error("run needs --data-dir <existing directory>");
  const date = arg("date", today())!;
  const merge = flag("merge");
  const runLog = path.join(HOME, "logs", `run-${date}.md`);
  fs.mkdirSync(path.dirname(runLog), { recursive: true });
  const notes: string[] = [`# RRC refresh cycle — ${date}`, "", `Data: ${dataDir}`, `Started: ${new Date().toISOString()}`, ""];
  const note = (m: string) => { notes.push(`- ${m}`); log(m); fs.writeFileSync(runLog, notes.join("\n") + "\n"); };
  const finish = (summary: Record<string, unknown>) => { notes.push("", "```json", JSON.stringify(summary, null, 2), "```"); fs.writeFileSync(runLog, notes.join("\n") + "\n"); console.log("CYCLE_RESULT " + JSON.stringify(summary)); };

  if (!check(dataDir)) throw new Error("raw files are missing or corrupt (see PROBLEM lines)");
  const ewa = expectedFiles(dataDir).find((f) => f.name.startsWith("OG_WELLBORE_EWA_Report_"))!.name;

  // 1. Clean clone on origin/main with current dependencies.
  note("resetting clone to origin/main");
  git("fetch", "-q", "origin");
  git("checkout", "-q", "-B", "main", "origin/main");
  git("reset", "-q", "--hard", "origin/main");
  git("clean", "-fdq");
  sh("npm", ["install", "--no-audit", "--no-fund"], { quiet: true });
  git("checkout", "--", "package-lock.json");
  sh("npx", ["prisma", "generate"], { cwd: SERVER, quiet: true });
  const head = git("rev-parse", "--short", "HEAD");
  note(`main at ${head}`);

  // 2. Build.
  const before = Object.fromEntries([WELLS_DATASET.file, ABSTRACTS_DATASET.file, PRODUCTION_DATASET.file].map((f) => [f, fs.existsSync(path.join(BUNDLE_DIR, f)) ? materialHash(path.join(BUNDLE_DIR, f)) : ""]));
  const dates = {
    dbf900: gzipDate(path.join(dataDir, "dbf900.ebc.gz")),
    uic: gzipDate(path.join(dataDir, "uif700a.txt.gz")),
    ledgers: [...REFRESH_LEDGERS.gas, ...REFRESH_LEDGERS.oil].map((f) => gzipDate(path.join(dataDir, f))).sort().at(-1)!,
  };
  note(`building (EWA ${ewa}, dbf900 ${dates.dbf900}, UIC ${dates.uic}, ledgers ${dates.ledgers})`);
  const buildLog = path.join(HOME, "logs", `build-${date}.log`);
  const build = spawnSync("npx", ["tsx", "src/scripts/buildRrcRefresh.ts", "--data-dir", dataDir, "--as-of", date, "--dbf900-date", dates.dbf900, "--uic-date", dates.uic, "--ledger-date", dates.ledgers],
    { cwd: SERVER, encoding: "utf8", maxBuffer: 1 << 28 });
  fs.writeFileSync(buildLog, (build.stdout ?? "") + "\n" + (build.stderr ?? ""));
  if (build.status !== 0) throw new Error(`build failed — see ${buildLog}\n${(build.stderr ?? "").slice(-3000)}`);
  note(`build finished (log ${buildLog})`);

  // 3. Anything new?
  const after = Object.fromEntries(Object.keys(before).map((f) => [f, materialHash(path.join(BUNDLE_DIR, f))]));
  const changed = Object.keys(before).filter((f) => before[f] !== after[f]);
  if (!changed.length) {
    note("bundles carry the same wells, abstracts and production as main — RRC's data has not changed since the last refresh (only snapshot dates / build time differ)");
    git("checkout", "--", ".");
    git("clean", "-fdq");
    const removal = removeRawFiles(dataDir, date, "No change in RRC's data since the last refresh; nothing to deploy.");
    finish({ outcome: "no-change", head, removalLog: removal, runLog });
    return;
  }
  const wells = parseWellsDataset(zlib.gunzipSync(fs.readFileSync(path.join(BUNDLE_DIR, WELLS_DATASET.file))));
  const abstracts = parseAbstractsDataset(zlib.gunzipSync(fs.readFileSync(path.join(BUNDLE_DIR, ABSTRACTS_DATASET.file))));
  const production = parseProductionDataset(zlib.gunzipSync(fs.readFileSync(path.join(BUNDLE_DIR, PRODUCTION_DATASET.file))));
  const versions = { [WELLS_DATASET.key]: wells.version, [ABSTRACTS_DATASET.key]: abstracts.version, [PRODUCTION_DATASET.key]: production.version };
  note(`changed: ${changed.join(", ")}; versions ${JSON.stringify(versions)}`);

  // 4. Compare with the live database (read-only) and gate.
  const counties = REFRESH_COUNTIES.map((c) => c.name);
  const conn = await db();
  const gateFailures: string[] = [];
  let statusChanged = 0;
  const transitions: Record<string, number> = {};
  const live: Record<string, number> = {};
  try {
    const rows = await conn.query<{ fid: number; county: string; status: string }>(`SELECT fid, county, status FROM rrc.wells WHERE county = ANY($1::text[])`, [counties]);
    const cur = new Map(rows.map((r) => [r.fid, r]));
    const liveByCounty: Record<string, number> = {};
    for (const r of rows) liveByCounty[r.county] = (liveByCounty[r.county] ?? 0) + 1;
    Object.assign(live, liveByCounty);
    const newByCounty: Record<string, number> = {};
    for (const w of wells.wells) {
      newByCounty[w.county] = (newByCounty[w.county] ?? 0) + 1;
      const c = cur.get(w.fid);
      if (c && c.status !== w.status) { statusChanged++; const k = `${c.status} → ${w.status}`; transitions[k] = (transitions[k] ?? 0) + 1; }
    }
    const newFids = new Set(wells.wells.map((w) => w.fid));
    const retired = rows.filter((r) => !newFids.has(r.fid)).length;
    for (const [county, n] of Object.entries(liveByCounty)) {
      const ratio = (newByCounty[county] ?? 0) / n;
      if (ratio < GATES.minWellsRatio) gateFailures.push(`${county}: ${newByCounty[county] ?? 0} wells in the new bundle vs ${n} live (${(ratio * 100).toFixed(0)} %)`);
    }
    if (rows.length && retired / rows.length > GATES.maxRetiredRatio) gateFailures.push(`${retired} live wells (${((retired / rows.length) * 100).toFixed(1)} %) are absent from RRC's layer`);
    if (rows.length && statusChanged / rows.length > GATES.maxStatusChangeRatio) gateFailures.push(`${statusChanged} status changes (${((statusChanged / rows.length) * 100).toFixed(1)} %) exceed the gate`);
    note(`live comparison: ${rows.length} live wells, ${statusChanged} status changes, ${retired} retired; new counts ${JSON.stringify(newByCounty)}`);
  } finally { /* keep the connection for the deploy wait */ }

  // Tests.
  const tests = spawnSync("npx", ["vitest", "run", "src/ingest/refresh", "src/routes/gis.refresh.test.ts"], { cwd: SERVER, encoding: "utf8", maxBuffer: 1 << 26 });
  if (tests.status !== 0) gateFailures.push(`refresh tests failed:\n${(tests.stdout ?? "").slice(-1500)}`);
  note(tests.status === 0 ? "refresh tests passed" : "refresh tests FAILED");

  // 5. Commit, push, PR.
  const branch = `rrc-refresh/${date}`;
  fs.writeFileSync(MAP_LAYERS, fs.readFileSync(MAP_LAYERS, "utf8").replace(/export const TILE_DATA_VERSION = "[^"]+";/, `export const TILE_DATA_VERSION = "${date}";`));
  const report = `docs/reports/rrc-refresh-${date}`;
  git("checkout", "-q", "-B", branch);
  git("add", "--", "server/data/rrc", report, "client/public/data", "client/src/lib/mapLayers.ts");
  const byCounty = Object.entries(wells.wells.reduce<Record<string, number>>((m, w) => { m[w.county] = (m[w.county] ?? 0) + 1; return m; }, {})).map(([c, n]) => `${c} ${n}`).join(", ");
  const transLines = Object.entries(transitions).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `- ${k}: ${v}`);
  const sources = wells.sources.map((s) => `- ${s.name}: ${s.file} (${s.asOf})`);
  const msg = [
    `RRC refresh ${date}: ${wells.wells.length} wells, ${statusChanged} status changes`,
    "",
    `Automated cycle. Bundles rebuilt from RRC's newest files; ${changed.join(", ")} changed.`,
    `Wells by county: ${byCounty}. Wellbores ${wells.bores.length}, abstracts ${abstracts.abstracts.length}, production rows ${production.rows.length}.`,
    "",
    "Sources:", ...sources,
    "",
    ...(transLines.length ? ["Status changes vs the live database:", ...transLines, ""] : []),
    `Report: ${report}/README.md`,
    "",
    "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>",
  ].join("\n");
  git("commit", "-q", "-m", msg);
  note(`committed on ${branch}`);
  sh("git", ["push", "-q", "-u", "origin", branch], { quiet: true });
  const body = [
    "## Summary", "",
    `Automated RRC refresh (${date}). ${changed.join(", ")} changed. Report: \`${report}/README.md\`.`, "",
    `| | |`, `|---|---|`, `| Wells | ${wells.wells.length} (${byCounty}) |`, `| Wellbores | ${wells.bores.length} |`, `| Abstracts | ${abstracts.abstracts.length} |`, `| Production rows | ${production.rows.length} (${production.fromYm}–${production.toYm}) |`, `| Status changes vs live | ${statusChanged} |`, "",
    "### Sources", ...sources, "",
    ...(transLines.length ? ["### Status changes (live → new)", ...transLines, ""] : []),
    ...(gateFailures.length ? ["### ⚠️ Gate failures — NOT merged automatically", ...gateFailures.map((g) => `- ${g}`), ""] : ["All safety gates passed; refresh tests passed.", ""]),
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");
  const bodyFile = path.join(HOME, "logs", `pr-${date}.md`);
  fs.writeFileSync(bodyFile, body);
  const prUrl = sh("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `RRC refresh ${date}: ${wells.wells.length} wells, ${statusChanged} status changes`, "--body-file", bodyFile], { quiet: true }).trim().split("\n").at(-1)!;
  note(`PR ${prUrl}`);

  if (gateFailures.length) {
    await conn.close();
    finish({ outcome: "needs-review", pr: prUrl, gateFailures, statusChanged, transitions, runLog });
    process.exitCode = 2;
    return;
  }
  if (!merge) { await conn.close(); finish({ outcome: "pr-open", pr: prUrl, statusChanged, transitions, runLog }); return; }

  // 6. Merge and wait for the deploy to load the bundles.
  sh("gh", ["pr", "merge", prUrl, "--merge", "--delete-branch"], { quiet: true });
  note("merged; waiting for the deploy to load the new bundle versions");
  git("checkout", "-q", "main");
  const started = Date.now();
  let loaded = false;
  while (Date.now() - started < DEPLOY_TIMEOUT_MS) {
    const markers = await conn.query<{ key: string; version: string }>(`SELECT key, version FROM gis.dataset_version WHERE key = ANY($1::text[])`, [Object.keys(versions)]);
    const have = new Map(markers.map((m) => [m.key, m.version]));
    if (Object.entries(versions).every(([k, v]) => have.get(k) === v)) { loaded = true; break; }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  if (!loaded) { await conn.close(); throw new Error(`deploy did not load the new bundles within ${DEPLOY_TIMEOUT_MS / 60000} min — raw files kept in ${dataDir}`); }
  const logRows = await conn.query<{ dataset: string; counts: unknown }>(`SELECT dataset, counts FROM rrc.refresh_log WHERE dataset_version = ANY($1::text[]) ORDER BY id`, [Object.values(versions)]);
  const liveNow = await conn.query<CountyCounts>(`SELECT county, count(*)::int AS n FROM rrc.wells WHERE county = ANY($1::text[]) GROUP BY 1 ORDER BY 1`, [counties]);
  await conn.close();
  const liveTotal = liveNow.reduce((a, r) => a + r.n, 0);
  const mismatch = Math.abs(liveTotal - wells.wells.length) > 0;
  note(`deploy loaded: ${JSON.stringify(logRows)}; live wells ${liveTotal} vs bundle ${wells.wells.length}${mismatch ? " (MISMATCH — research-linked wells kept?)" : ""}`);

  // 7. Remove the raw files.
  const removal = removeRawFiles(dataDir, date, `Refresh ${date} merged (${prUrl}) and verified loaded (versions ${JSON.stringify(versions)}).`);
  for (const d of fs.readdirSync(path.join(HOME, "data"))) {
    const p = path.join(HOME, "data", d);
    if (fs.statSync(p).isDirectory() && Date.now() - fs.statSync(p).mtimeMs > 7 * 86_400_000) { fs.rmSync(p, { recursive: true, force: true }); note(`removed stale raw data ${p}`); }
  }
  finish({ outcome: "deployed", pr: prUrl, statusChanged, transitions, liveWells: liveTotal, bundleWells: wells.wells.length, refreshLog: logRows, removalLog: removal, runLog, live });
}

// ---------------------------------------------------------------------------

try {
  if (cmd === "plan") plan();
  else if (cmd === "check") process.exitCode = check(path.resolve(arg("data-dir") ?? "")) ? 0 : 1;
  else if (cmd === "run") await run();
  else { console.error("usage: rrcRefreshCycle.ts plan|check|run [--data-dir <dir>] [--date YYYY-MM-DD] [--merge]"); process.exitCode = 1; }
} catch (e) {
  console.error(`CYCLE_ERROR ${(e as Error).message}`);
  process.exitCode = 1;
}
