/**
 * CLI: create — or wipe and recreate — the demo / showcase workspace
 * ("Brazos Ridge Minerals"). See services/demoSeed.ts for the safety model.
 *
 * Usage:
 *   DEMO_USER_PASSWORD='…' npm run seed:demo -- --reference-org "<org id or exact org name>"            # dry run
 *   DEMO_USER_PASSWORD='…' npm run seed:demo -- --reference-org "<org id or exact org name>" --confirm  # apply
 *
 * Env:
 *   DEMO_USER_EMAIL     login user (default demo@brazosridge.demo; must end with @brazosridge.demo)
 *   DEMO_USER_PASSWORD  required, at least 12 characters
 *
 * Without --confirm nothing is written: the plan is printed (database host
 * only — never the URL or credentials) and the script exits 0.
 */
import { prisma, runtimeDatabaseUrl } from "../db.js";
import { s3Configured } from "../services/s3.js";
import {
  DEMO_EMAIL_DOMAIN, DEMO_ORG_NAME, MIN_DEMO_PASSWORD_LENGTH,
  assertDemoEmail, countDemoRows, findDemoOrg, resolveReferenceOrg, seedDemoOrg,
} from "../services/demoSeed.js";

function parseArgs(argv: string[]): { referenceOrg: string | null; confirm: boolean; help: boolean } {
  let referenceOrg: string | null = null;
  let confirm = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm") confirm = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--reference-org") referenceOrg = argv[++i] ?? null;
    else if (a.startsWith("--reference-org=")) referenceOrg = a.slice("--reference-org=".length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { referenceOrg, confirm, help };
}

function dbHost(): string {
  try {
    const u = new URL(runtimeDatabaseUrl(process.env.DATABASE_URL) ?? "");
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function printCounts(counts: Record<string, number>, onlyNonZero: boolean): void {
  const rows = Object.entries(counts).filter(([, n]) => !onlyNonZero || n > 0);
  if (!rows.length) { console.log("    (nothing)"); return; }
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, n] of rows) console.log(`    ${k.padEnd(w)}  ${String(n).padStart(6)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run seed:demo -- --reference-org "<org id or exact org name>" [--confirm]');
    return;
  }
  if (!args.referenceOrg) throw new Error('--reference-org "<org id or exact org name>" is required');
  const email = (process.env.DEMO_USER_EMAIL ?? `demo@${DEMO_EMAIL_DOMAIN}`).trim().toLowerCase();
  const password = process.env.DEMO_USER_PASSWORD ?? "";
  assertDemoEmail(email);
  if (password.length < MIN_DEMO_PASSWORD_LENGTH) throw new Error(`DEMO_USER_PASSWORD is required and must be at least ${MIN_DEMO_PASSWORD_LENGTH} characters`);

  // Resolution refuses ambiguous names and demo orgs.
  const reference = await resolveReferenceOrg(prisma, args.referenceOrg);
  const demo = await findDemoOrg(prisma);
  if (demo && demo.id === reference.id) throw new Error("The reference organization cannot be the demo organization");

  console.log(`Database host:   ${dbHost()}`);
  console.log(`Demo org:        ${demo ? `found (${demo.id}) — will be WIPED and reseeded` : `not found — "${DEMO_ORG_NAME}" will be created (isDemo = true)`}`);
  console.log(`Reference org:   "${reference.name}" (${reference.id}) — read-only; its id is stored on the demo org`);
  console.log(`Login user:      ${email}`);
  console.log(`Documents:       ${s3Configured() ? "S3 configured — generated PDFs will be uploaded" : "S3 not configured — documents skipped"}`);

  if (!args.confirm) {
    console.log("\nDRY RUN — nothing was written.");
    if (demo) {
      console.log("Rows that would be wiped (demo org only):");
      printCounts(await countDemoRows(prisma, demo.id), true);
    }
    console.log("\nRe-run with --confirm to apply.");
    return;
  }

  const started = Date.now();
  const result = await seedDemoOrg(prisma, {
    referenceOrgId: reference.id,
    demoUserEmail: email,
    demoUserPassword: password,
    log: (m) => console.log(`  · ${m}`),
  });
  console.log(`\nSeeded demo org ${result.organizationId} in ${((Date.now() - started) / 1000).toFixed(1)}s. Rows per model:`);
  printCounts(result.counts, false);
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (err) => {
    console.error(`seed:demo failed: ${err instanceof Error ? err.message : String(err)}`);
    await prisma.$disconnect();
    process.exit(1);
  });
