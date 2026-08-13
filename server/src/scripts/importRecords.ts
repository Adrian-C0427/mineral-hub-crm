/**
 * Headless county-records CSV importer.
 *
 * Ingests recorded deed/lease records (or drilling permits) into the database
 * WITHOUT the UI, so a scheduled automation can keep a county's Research dataset
 * current. It runs the EXACT same ingest core as the web importer
 * (POST /api/research/ingest/commit) — see domain/researchIngest.ts — so
 * dedup, doc-type classification, geography normalization, party splitting and
 * the per-import audit trail (ResearchIngestRun + ResearchIngestRow) are
 * identical between the two paths. Nothing is reimplemented here.
 *
 * Idempotency: a documents row is a duplicate when its full recording signature
 * (state + county + instrument# + recording date + doc type + normalized
 * grantor/grantee + volume/page/abstract) matches an existing record — never the
 * instrument number alone, which county exports repeat across each grantor/
 * grantee and legal tract. Re-running the same CSV therefore inserts 0 rows.
 * (For deeds there is no in-place "update": a changed field is a new distinct
 * record. In-place updates apply to the permits category only.)
 *
 * Input CSV columns (recorded documents; header names are auto-mapped via the
 * app's alias table, so casing/spacing variants are fine):
 *   GRANTOR, GRANTEE, DOC TYPE, RECORDED DATE, INSTRUMENT NUMBER,
 *   VOLUME, PAGE, ABSTRACT, COUNTY, STATE
 * ABSTRACT may hold multiple comma-separated values inside a quoted field
 * (e.g. "22, 1045"); the CSV parser keeps it as one value, as the app stores it.
 *
 * Usage:
 *   npm run records:import -- <path-to-csv> --org <id|name> [options]
 *   npx tsx src/scripts/importRecords.ts <path-to-csv> --org <id|name> [options]
 *
 * Options:
 *   --org <id|name>        REQUIRED. Organization id or (unique) name to import into.
 *   --category <c>         deeds | leases | permits   (default: deeds)
 *   --state <XX>           File-level State fallback for rows lacking a State column.
 *   --county <name>        File-level County fallback for rows lacking a County column.
 *   --dry-run              Parse + validate + dedup, print the outcome, write nothing.
 *   -h, --help             Show this help.
 *
 * Exit codes: 0 = success; 1 = one or more rows were rejected (malformed / not
 * mineral-related / missing required fields), so a caller can detect problems;
 * 2 = the import could not run at all (bad args, file/org not found, DB error).
 *
 * Database connection: taken from the app's existing config (DATABASE_URL via
 * server/.env / the process environment). No credentials live in this script.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";
import { ingestResearchCsv, parseCsv, resolveCategory, type ImportCategory } from "../domain/researchIngest.js";
import { guessMapping, sourceFor } from "../domain/researchSources.js";

interface Args {
  csvPath: string;
  org: string;
  category: ImportCategory;
  state: string | null;
  county: string | null;
  dryRun: boolean;
}

const HELP = `Import county deed records (CSV) into the Research module.

Usage:
  npm run records:import -- <path-to-csv> --org <id|name> [options]
  npx tsx src/scripts/importRecords.ts <path-to-csv> --org <id|name> [options]

Options:
  --org <id|name>     REQUIRED. Organization id or unique name.
  --category <c>      deeds | leases | permits          (default: deeds)
  --state <XX>        File-level State fallback (rows without a State column).
  --county <name>     File-level County fallback (rows without a County column).
  --dry-run           Validate + dedup only; write nothing.
  -h, --help          Show this help.

Exit codes: 0 ok · 1 some rows rejected · 2 could not run.`;

/** Minimal flag parser — one positional (csv path) plus --flags. */
function parseArgs(argv: string[]): Args | { help: true } {
  if (argv.includes("-h") || argv.includes("--help")) return { help: true };
  let csvPath = "";
  let org = "";
  let category: ImportCategory = "deeds";
  let state: string | null = null;
  let county: string | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`Missing value for ${a}`);
      i++;
      return v;
    };
    switch (a) {
      case "--org": org = next(); break;
      case "--category": {
        const v = next().toLowerCase();
        if (v !== "deeds" && v !== "leases" && v !== "permits") throw new UsageError(`--category must be deeds, leases, or permits (got "${v}")`);
        category = v;
        break;
      }
      case "--state": state = next(); break;
      case "--county": county = next(); break;
      case "--dry-run": dryRun = true; break;
      default:
        if (a.startsWith("-")) throw new UsageError(`Unknown option: ${a}`);
        if (csvPath) throw new UsageError(`Unexpected extra argument: ${a}`);
        csvPath = a;
    }
  }

  if (!csvPath) throw new UsageError("A path to the CSV file is required.");
  if (!org) throw new UsageError("--org <id|name> is required.");
  return { csvPath, org, category, state, county, dryRun };
}

class UsageError extends Error {}

/** Resolve an org by id first, then by exact name. Errors if ambiguous/missing. */
async function resolveOrg(idOrName: string): Promise<{ id: string; name: string }> {
  const byId = await prisma.organization.findUnique({ where: { id: idOrName }, select: { id: true, name: true } });
  if (byId) return byId;
  const byName = await prisma.organization.findMany({ where: { name: idOrName }, select: { id: true, name: true } });
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new UsageError(`Multiple organizations named "${idOrName}"; pass the org id instead.`);
  throw new UsageError(`No organization matches "${idOrName}" (by id or name).`);
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) { console.log(HELP); return 0; }
  const { csvPath, org: orgArg, category, state, county, dryRun } = parsed;

  const absPath = path.resolve(csvPath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    throw new UsageError(`CSV file not found: ${absPath}`);
  }
  const csv = fs.readFileSync(absPath, "utf8");

  const organization = await resolveOrg(orgArg);

  // Auto-map the file's headers with the same guesser the UI uses on /analyze.
  const { kind } = resolveCategory(category);
  const { headers } = parseCsv(csv);
  const mapping = guessMapping(sourceFor(kind), headers);

  console.error(
    `[import-records] ${dryRun ? "DRY RUN — " : ""}file=${path.basename(absPath)} ` +
    `org="${organization.name}" (${organization.id}) category=${category}`,
  );
  console.error(`[import-records] columns: ${headers.join(", ") || "(none)"}`);
  const mappedPairs = Object.entries(mapping).map(([field, header]) => `${field}<-${header}`);
  console.error(`[import-records] mapped: ${mappedPairs.join(", ") || "(nothing matched)"}`);

  const summary = await ingestResearchCsv({
    prisma,
    organizationId: organization.id,
    createdByUserId: null, // headless/automation run — no acting user
    // CLI imports are the scheduled county-scan syncs: their records blend
    // into Research, but the run is hidden from the Import history UI.
    automated: true,
    category,
    csv,
    mapping,
    filename: path.basename(absPath),
    assignedState: state,
    assignedCounty: county,
    dryRun,
  });

  // unchanged = duplicates (already present / repeated in-file, nothing written).
  const unchanged = summary.duplicates;

  // Human-readable block on stderr (keeps stdout clean for the JSON line).
  console.error("");
  console.error(`  rows read : ${fmtInt(summary.rowsTotal)}`);
  console.error(`  inserted  : ${fmtInt(summary.imported)}${dryRun ? " (would insert)" : ""}`);
  console.error(`  updated   : ${fmtInt(summary.updated)}`);
  console.error(`  unchanged : ${fmtInt(unchanged)} (duplicates)`);
  console.error(`  skipped   : ${fmtInt(summary.rejected)} (rejected)`);
  if (summary.skippedReasons.length) {
    console.error("  skipped reasons:");
    for (const { reason, count } of summary.skippedReasons) {
      console.error(`    - ${fmtInt(count)} × ${reason}`);
    }
  }
  if (summary.runId) console.error(`  import run: ${summary.runId}`);
  console.error("");

  // Machine-parseable one-liner on stdout for an automation to capture.
  const out = {
    ok: summary.rejected === 0,
    dryRun,
    org: organization.id,
    category,
    file: path.basename(absPath),
    runId: summary.runId,
    rowsRead: summary.rowsTotal,
    inserted: summary.imported,
    updated: summary.updated,
    unchanged,
    skipped: summary.rejected,
    skippedReasons: summary.skippedReasons,
  };
  console.log(JSON.stringify(out));

  // Non-zero when any row failed, so a scheduler can detect problems.
  return summary.rejected > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    await prisma.$disconnect().catch(() => {});
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n`);
      console.error(HELP);
      process.exit(2);
    }
    console.error("[import-records] failed:", err instanceof Error ? err.message : err);
    process.exit(2);
  });
