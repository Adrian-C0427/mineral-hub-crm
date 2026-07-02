/**
 * CLI: load a SYNTHETIC research dataset so the Research & Market Intelligence
 * module can be explored before real county/permit data is imported.
 *
 * All rows are tagged source="sample" — remove them any time from the app
 * (Research → Data & Imports → Remove Data, source "sample") or by re-running
 * with --clear.
 *
 * Usage:
 *   RESEARCH_ORG_EMAIL="owner@co.com" npm run research:sample --workspace=server
 *   RESEARCH_ORG_EMAIL="owner@co.com" npm run research:sample --workspace=server -- --clear
 *
 * The dataset covers ~18 months across 12 Texas counties with engineered
 * storylines (so opportunity detection has something to find):
 *   - Freestone: leasing surge in the last 60 days
 *   - Robertson: mineral-transaction surge + abstract concentration
 *   - Leon: new operator entering with horizontal permits
 *   - Reeves/Loving: steady high baseline (Permian control group)
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { classifyDocType, normalizeEntity } from "../domain/research.js";

const SOURCE = "sample";
const DAY = 86400000;

const COUNTIES = [
  "Leon", "Freestone", "Robertson", "Anderson", "Houston", "Limestone",
  "Madison", "Navarro", "Reeves", "Loving", "Midland", "Martin",
];

const BUYERS = [
  "Blackrock Minerals LLC", "Apex Royalty Partners LP", "Lone Star Mineral Holdings LLC",
  "Brazos Basin Minerals Inc", "Cedar Creek Royalty Co", "Permian Legacy Minerals LLC",
  "Heritage Mineral Group LP", "Trinity River Minerals LLC", "Sabine Royalty Ventures",
  "Wildcat Mineral Acquisitions LLC",
];
const SELLERS = [
  "Smith, John et ux", "Jones Family Trust", "Garcia, Maria", "Williams Estate",
  "Thompson, Robert et al", "Miller Ranch Partnership", "Davis, Linda", "Wilson Heirs",
  "Anderson Family LP", "Taylor, James et ux", "Moore Living Trust", "Jackson, Patricia",
];
const OPERATORS = [
  "Comanche Exploration Co", "Big Thicket Energy LLC", "Palo Duro Operating Inc",
  "Guadalupe Resources LP", "Caprock Drilling Partners", "Frontier E&P Services",
];
const NEW_OPERATOR = "Meridian Shale Partners LLC"; // enters Leon in the last 45 days

const DOC_TYPES = [
  "Mineral Deed", "Royalty Deed", "Mineral Conveyance", "Oil and Gas Conveyance",
  "Quitclaim Mineral Deed", "Warranty Deed (Mineral Rights)", "Assignment of Mineral Interest",
  "Oil & Gas Lease", "Memorandum of Oil and Gas Lease", "Assignment of Oil and Gas Lease",
  "Release of Oil and Gas Lease", "Ratification of Oil and Gas Lease",
];
const SURVEYS = ["J HALLMARK", "T RAGSDALE", "M CANALES", "J DUNN", "WM PENN", "S GRIFFIN", "H&TC RR CO", "I&GN RR CO"];

// Deterministic PRNG so re-runs produce comparable datasets.
let seed = 42;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const chance = (p: number): boolean => rnd() < p;

/** Per-county daily intensity multipliers implementing the storylines. */
function intensity(county: string, daysAgo: number, kind: "doc" | "lease" | "permit"): number {
  let base = 0.5;
  if (county === "Reeves" || county === "Loving" || county === "Midland") base = 1.4; // busy Permian baseline
  if (county === "Madison" || county === "Navarro") base = 0.25;
  if (county === "Freestone" && kind === "lease" && daysAgo < 60) return base + 3.0;   // leasing surge
  if (county === "Robertson" && kind === "doc" && daysAgo < 75) return base + 2.4;     // transaction surge
  if (county === "Leon" && kind === "permit" && daysAgo < 45) return base + 1.6;       // permitting pickup
  return base;
}

async function main() {
  const email = (process.env.RESEARCH_ORG_EMAIL ?? "").trim().toLowerCase();
  if (!email) {
    console.error("Set RESEARCH_ORG_EMAIL to the email of a user in the target organization.");
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.organizationId) {
    console.error(`No user (or no organization) found for ${email}.`);
    process.exit(1);
  }
  const org = user.organizationId;

  const clear = process.argv.includes("--clear");
  const removedDocs = await prisma.researchDocument.deleteMany({ where: { organizationId: org, source: SOURCE } });
  const removedPermits = await prisma.researchPermit.deleteMany({ where: { organizationId: org, source: SOURCE } });
  if (removedDocs.count || removedPermits.count) {
    console.log(`Cleared previous sample data (${removedDocs.count} documents, ${removedPermits.count} permits).`);
  }
  if (clear) {
    await prisma.$disconnect();
    return;
  }

  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const DAYS = 550; // ~18 months
  const docs: Prisma.ResearchDocumentCreateManyInput[] = [];
  const permits: Prisma.ResearchPermitCreateManyInput[] = [];
  let instr = 100000;

  for (let daysAgo = DAYS; daysAgo >= 0; daysAgo--) {
    const date = new Date(today.getTime() - daysAgo * DAY);
    for (const county of COUNTIES) {
      // Recorded documents (transactions + leases)
      const docCount = Math.floor(intensity(county, daysAgo, "doc") * rnd() * 2.2);
      const leaseCount = Math.floor(intensity(county, daysAgo, "lease") * rnd() * 2.0);
      for (let i = 0; i < docCount + leaseCount; i++) {
        const isLease = i >= docCount;
        const docTypeRaw = isLease ? DOC_TYPES[7 + Math.floor(rnd() * 5)] : DOC_TYPES[Math.floor(rnd() * 7)];
        const cls = classifyDocType(docTypeRaw);
        if (!cls) continue;
        const grantee = pick(BUYERS);
        const grantor = pick(SELLERS);
        // Robertson storyline: concentrate recent buys into two abstracts.
        const abstractId = county === "Robertson" && daysAgo < 75 && chance(0.5)
          ? pick(["A-112", "A-287"])
          : chance(0.6) ? `A-${100 + Math.floor(rnd() * 400)}` : null;
        docs.push({
          organizationId: org, state: "TX", county,
          docTypeRaw, docType: cls.docType, docClass: cls.docClass,
          instrumentNumber: `${date.getUTCFullYear()}-${instr++}`,
          recordingDate: date,
          grantor, grantee,
          grantorNorm: normalizeEntity(grantor), granteeNorm: normalizeEntity(grantee),
          abstractId, survey: chance(0.7) ? pick(SURVEYS) : null,
          acreage: chance(0.7) ? Math.round(rnd() * 320 + 10) : null,
          consideration: chance(0.3) ? Math.round((rnd() * 900 + 100)) * 1000 : null,
          source: SOURCE,
        });
      }

      // Drilling permits
      const permitCount = chance(intensity(county, daysAgo, "permit") * 0.16) ? 1 : 0;
      for (let i = 0; i < permitCount; i++) {
        const isNewOp = county === "Leon" && daysAgo < 45 && chance(0.5);
        const operator = isNewOp ? NEW_OPERATOR : pick(OPERATORS);
        const horizontal = chance(isNewOp ? 0.9 : 0.55);
        const approved = chance(0.7);
        permits.push({
          organizationId: org, state: "TX", county,
          apiNumber: `42-${100 + Math.floor(rnd() * 400)}-${30000 + Math.floor(rnd() * 60000)}`,
          permitNumber: String(800000 + Math.floor(rnd() * 99999)),
          operator, operatorNorm: normalizeEntity(operator) ?? operator.toUpperCase(),
          leaseName: `${pick(SELLERS).split(",")[0].split(" ")[0].toUpperCase()} UNIT`,
          wellName: `${1 + Math.floor(rnd() * 9)}${horizontal ? "H" : ""}`,
          status: approved ? "APPROVED" : "SUBMITTED",
          trajectory: horizontal ? "HORIZONTAL" : chance(0.3) ? "DIRECTIONAL" : "VERTICAL",
          activityDate: date,
          filedDate: date,
          approvedDate: approved ? new Date(date.getTime() + Math.floor(rnd() * 20) * DAY) : null,
          formation: chance(0.6) ? pick(["Eagle Ford", "Austin Chalk", "Buda", "Woodbine", "Wolfcamp", "Bone Spring"]) : null,
          totalDepth: Math.round(6000 + rnd() * 8000),
          abstractId: chance(0.5) ? `A-${100 + Math.floor(rnd() * 400)}` : null,
          survey: chance(0.5) ? pick(SURVEYS) : null,
          source: SOURCE,
        });
      }
    }
  }

  const CHUNK = 1000;
  for (let i = 0; i < docs.length; i += CHUNK) await prisma.researchDocument.createMany({ data: docs.slice(i, i + CHUNK) });
  for (let i = 0; i < permits.length; i += CHUNK) await prisma.researchPermit.createMany({ data: permits.slice(i, i + CHUNK) });

  await prisma.researchIngestRun.create({
    data: {
      organizationId: org, kind: "DOCUMENTS", source: SOURCE, state: "TX",
      filename: "synthetic-sample", rowsTotal: docs.length + permits.length,
      rowsImported: docs.length + permits.length, status: "COMPLETED", createdByUserId: user.id,
    },
  });

  console.log(`\n✅ Sample research data loaded for org ${org}:`);
  console.log(`   ${docs.length.toLocaleString()} recorded documents, ${permits.length.toLocaleString()} permits`);
  console.log(`   Counties: ${COUNTIES.join(", ")}`);
  console.log(`   ALL rows have source="sample" — remove via Research → Data & Imports, or --clear.\n`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Sample load failed:", err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
