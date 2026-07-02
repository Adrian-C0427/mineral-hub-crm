/**
 * CLI: load SYNTHETIC wells + monthly production so the Well Analysis &
 * Valuation tool can be explored before real production data is imported.
 *
 * All rows are tagged source="sample"; re-run with --clear to remove them.
 *
 * Usage:
 *   RESEARCH_ORG_EMAIL="owner@co.com" npm run wells:sample --workspace=server
 *   RESEARCH_ORG_EMAIL="owner@co.com" npm run wells:sample --workspace=server -- --clear
 *
 * The set includes distinct engineering storylines so decline fits, anomaly
 * detection and the economics all have something to chew on:
 *   - a young horizontal Permian oil well (steep hyperbolic decline)
 *   - mature vertical oil wells (shallow exponential decline, long tails)
 *   - a gas well with liquids yield
 *   - a well with a workover bump and downtime months
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

const SOURCE = "sample";

// Deterministic PRNG so re-runs produce comparable datasets.
let seed = 1337;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const noise = (pct: number) => 1 + (rnd() * 2 - 1) * pct;

interface WellSpec {
  name: string;
  apiNumber: string;
  operator: string;
  leaseName: string;
  county: string;
  status: "PRODUCING" | "SHUT_IN" | "PLUGGED" | "INACTIVE" | "UNKNOWN";
  trajectory: "VERTICAL" | "HORIZONTAL" | "DIRECTIONAL" | "UNKNOWN";
  wellType: string;
  formation: string;
  months: number; // history length
  qiOil: number; // bbl/month at peak
  qiGasPerOil: number; // mcf per bbl (GOR proxy); for gas wells use qiGas directly
  qiGas?: number;
  b: number;
  diAnnual: number; // nominal
  nglYield: number; // bbl NGL per bbl oil (or per 10 mcf for gas wells)
  waterCut: number; // bbl water per bbl oil
  downtimeMonths?: number[]; // indexes (from start) with zero production
  workoverAt?: number; // index where rates jump back up ~60%
}

const WELLS: WellSpec[] = [
  {
    name: "MUSTANG DRAW UNIT 1H", apiNumber: "42-329-41876", operator: "Permian Legacy Operating LLC",
    leaseName: "MUSTANG DRAW UNIT", county: "Midland", status: "PRODUCING", trajectory: "HORIZONTAL",
    wellType: "OIL", formation: "Wolfcamp B", months: 30, qiOil: 18500, qiGasPerOil: 2.4, b: 1.1,
    diAnnual: 2.6, nglYield: 0.09, waterCut: 2.8,
  },
  {
    name: "SPRABERRY TREND 22-3", apiNumber: "42-329-38455", operator: "Caprock Drilling Partners",
    leaseName: "SPRABERRY TREND", county: "Midland", status: "PRODUCING", trajectory: "VERTICAL",
    wellType: "OIL", formation: "Spraberry", months: 96, qiOil: 2600, qiGasPerOil: 1.8, b: 0.4,
    diAnnual: 0.28, nglYield: 0.06, waterCut: 1.9,
  },
  {
    name: "HALLMARK A-3", apiNumber: "42-161-33210", operator: "Big Thicket Energy LLC",
    leaseName: "HALLMARK", county: "Freestone", status: "PRODUCING", trajectory: "VERTICAL",
    wellType: "GAS", formation: "Bossier", months: 84, qiOil: 40, qiGasPerOil: 0, qiGas: 42000,
    b: 0.6, diAnnual: 0.42, nglYield: 0.012, waterCut: 0.4,
  },
  {
    name: "RAGSDALE B-7", apiNumber: "42-161-31099", operator: "Big Thicket Energy LLC",
    leaseName: "RAGSDALE", county: "Freestone", status: "PRODUCING", trajectory: "VERTICAL",
    wellType: "OIL", formation: "Woodbine", months: 120, qiOil: 1450, qiGasPerOil: 1.2, b: 0.2,
    diAnnual: 0.19, nglYield: 0.04, waterCut: 3.4,
    downtimeMonths: [55, 56, 88], workoverAt: 57,
  },
  {
    name: "COMANCHE RIDGE 4", apiNumber: "42-289-30772", operator: "Comanche Exploration Co",
    leaseName: "COMANCHE RIDGE", county: "Leon", status: "PRODUCING", trajectory: "DIRECTIONAL",
    wellType: "OIL", formation: "Buda", months: 60, qiOil: 3900, qiGasPerOil: 2.1, b: 0.7,
    diAnnual: 0.55, nglYield: 0.07, waterCut: 2.2,
  },
  {
    name: "TRINITY SANDS 9", apiNumber: "42-289-29841", operator: "Guadalupe Resources LP",
    leaseName: "TRINITY SANDS", county: "Leon", status: "SHUT_IN", trajectory: "VERTICAL",
    wellType: "OIL", formation: "Georgetown", months: 72, qiOil: 900, qiGasPerOil: 0.9, b: 0.3,
    diAnnual: 0.24, nglYield: 0.03, waterCut: 4.1,
    downtimeMonths: [66, 67, 68, 69, 70, 71], // shut in for the last 6 months
  },
];

function arps(qi: number, diAnnual: number, b: number, t: number): number {
  const diM = diAnnual / 12;
  if (b < 1e-6) return qi * Math.exp(-diM * t);
  return qi / Math.pow(1 + b * diM * t, 1 / b);
}

const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

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
  const removed = await prisma.researchWell.deleteMany({ where: { organizationId: org, source: SOURCE } });
  if (removed.count) console.log(`Cleared ${removed.count} previous sample wells (production cascades).`);
  if (clear) {
    await prisma.$disconnect();
    return;
  }

  const now = new Date();
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let wells = 0, months = 0;

  for (const spec of WELLS) {
    const firstProd = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - spec.months, 1));
    const well = await prisma.researchWell.create({
      data: {
        organizationId: org,
        apiNumber: spec.apiNumber,
        name: spec.name,
        operator: spec.operator,
        leaseName: spec.leaseName,
        fieldName: null,
        formation: spec.formation,
        state: "TX",
        county: spec.county,
        status: spec.status,
        trajectory: spec.trajectory,
        wellType: spec.wellType,
        firstProdDate: firstProd,
        source: SOURCE,
      },
    });
    wells++;

    const rows: Prisma.WellProductionMonthCreateManyInput[] = [];
    for (let t = 0; t < spec.months; t++) {
      const month = new Date(Date.UTC(firstProd.getUTCFullYear(), firstProd.getUTCMonth() + t, 1));
      if (spec.downtimeMonths?.includes(t)) {
        rows.push({ wellId: well.id, month, oilBbl: 0, gasMcf: 0, nglBbl: 0, waterBbl: 0, daysOn: 0, source: SOURCE });
        months++;
        continue;
      }
      // Workover resets the effective decline clock partway back.
      const tEff = spec.workoverAt != null && t >= spec.workoverAt ? Math.max(0, t - Math.floor(spec.workoverAt * 0.55)) : t;
      const oil = spec.wellType === "GAS"
        ? arps(spec.qiOil, spec.diAnnual, spec.b, tEff) * noise(0.15)
        : arps(spec.qiOil, spec.diAnnual, spec.b, tEff) * noise(0.08);
      const gas = spec.wellType === "GAS"
        ? arps(spec.qiGas!, spec.diAnnual, spec.b, tEff) * noise(0.07)
        : oil * spec.qiGasPerOil * noise(0.12);
      const ngl = spec.wellType === "GAS" ? (gas / 10) * spec.nglYield * noise(0.15) : oil * spec.nglYield * noise(0.15);
      const water = oil * spec.waterCut * noise(0.2);
      rows.push({
        wellId: well.id,
        month,
        oilBbl: Math.round(oil),
        gasMcf: Math.round(gas),
        nglBbl: Math.round(ngl),
        waterBbl: Math.round(water),
        daysOn: 28 + Math.floor(rnd() * 3),
        source: SOURCE,
      });
      months++;
    }
    await prisma.wellProductionMonth.createMany({ data: rows });
    console.log(`  ${spec.name} (${spec.county}) — ${spec.months} months, first prod ${ym(firstProd)}`);
  }

  console.log(`\nSeeded ${wells} wells with ${months} production months for org ${org}.`);
  console.log(`Open Well Analysis in the app, select wells and run a valuation.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
