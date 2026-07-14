/**
 * RRC monthly ingestion orchestrator — the scheduled entrypoint.
 *
 *   npx tsx src/ingest/run.ts [--trigger schedule|manual] [--only <datasetId>]
 *
 * Flow per dataset: resolve source (staged file under RRC_DATA_DIR, else
 * download via the catalog/permanent link) → checksum → skip if unchanged →
 * parse → incrementally merge → record results. Every step logs to
 * rrc.ingest_run / rrc.source_file; failures notify via email (or Sentry).
 * Merges key on natural keys, so any re-run is a no-op, never a duplicate.
 *
 * Increment 2 wires the remaining Phase-1 loaders onto the increment-1 core:
 * PDQ download + county extraction (no more manual DSV prep), drilling
 * permits, P5 operators, field names, G-10 gas status (EBCDIC), Full Wellbore
 * enrichment (EBCDIC), and completions (python packet parser). Still pending:
 * the standalone Oil W-10 file (layout undocumented — the oil current
 * operator already arrives via Full Wellbore type-23 records) and the county
 * shapefile geometry refresh (tools/rrc/build_wells.py remains the manual
 * path until the pyshp step is containerized).
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";
import { ingestConfig, type CountyScope } from "./config.js";
import { datasetById, requiredDatasets, type DatasetSpec } from "./manifest.js";
import { startRun, finishRun, recordFile, queryLastChecksum, type DatasetResult } from "./runLog.js";
import { sha256File, isDatasetChanged } from "./checksum.js";
import { loadProduction } from "./loadProduction.js";
import { resolveUrl, downloadWithRetry } from "./download.js";
import { extractProductionTsvs, extractedTsvPath, stagedPdqSource } from "./pdqExtract.js";
import { loadPermits } from "./loaders/permits.js";
import { loadOperators, loadFields } from "./loaders/refData.js";
import { loadGasWellStatus } from "./loaders/gasWellStatus.js";
import { loadWellboreEnrichment } from "./loaders/wellbore.js";
import { loadCompletions } from "./loaders/completions.js";
import { sendIngestAlert, renderRunSummary } from "./notify.js";

const args = process.argv.slice(2);
const argVal = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : undefined;
};
const trigger: "schedule" | "manual" = argVal("--trigger") === "manual" ? "manual" : "schedule";
const only = argVal("--only");

const countyByCode: ReadonlyMap<string, string> = new Map(ingestConfig.counties.map((c) => [c.rrcCode, c.name]));
const countyCodes: ReadonlySet<string> = new Set(ingestConfig.countyCodes);
const districts: ReadonlySet<string> = new Set(ingestConfig.counties.map((c) => c.district));

/** Known staged filenames per dataset when RRC_DATA_DIR points at a local drop. */
const STAGED_NAMES: Record<string, string[]> = {
  drilling_permits: ["daf802.txt", "daf802", "documents_20260701-7/daf802.txt"],
  p5_organizations: ["orf850.txt", "documents_20260703-4/orf850.txt"],
  field_names: ["fldtpe-2.txt", "fldtpe.txt"],
  gas_well_status: ["gse10.ebc"],
  full_wellbore: ["dbf900.ebc"],
};

/** Resolve a dataset's input file: staged copy first, else download. */
async function resolveSource(spec: DatasetSpec): Promise<{ file: string; downloaded: boolean; url?: string }> {
  const dir = ingestConfig.rrcDataDir;
  if (dir) {
    for (const name of STAGED_NAMES[spec.id] ?? []) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return { file: p, downloaded: false };
    }
  }
  const url = await resolveUrl(spec);
  const dest = path.join(ingestConfig.workDir, `${spec.id}${path.extname(new URL(url).pathname) || ".dat"}`);
  const dl = await downloadWithRetry(url, dest);
  return { file: dl.path, downloaded: true, url };
}

type LoaderFn = (file: string) => Promise<{ summary: string; inserted: number; skipped?: number }>;

/** Dataset → loader. Each returns human-readable stats for the run log. */
const LOADERS: Record<string, LoaderFn> = {
  drilling_permits: async (file) => {
    const s = await loadPermits(file, countyByCode);
    return { summary: `roots=${s.rootsSeen} merged=${s.merged}`, inserted: s.merged, skipped: s.filteredOut };
  },
  p5_organizations: async (file) => {
    const n = await loadOperators(file);
    return { summary: `operators=${n}`, inserted: n };
  },
  field_names: async (file) => {
    const n = await loadFields(file);
    return { summary: `fields=${n}`, inserted: n };
  },
  gas_well_status: async (file) => {
    const s = await loadGasWellStatus(file, districts);
    return { summary: `records=${s.records} merged=${s.merged}`, inserted: s.merged };
  },
  full_wellbore: async (file) => {
    const s = await loadWellboreEnrichment(file, countyCodes);
    return { summary: `wells=${s.wellsSeen} inScope=${s.inScope} updated=${s.updated} oilStatus=${s.statusMerged}`, inserted: s.updated + s.statusMerged };
  },
};

/** Generic file-dataset runner: resolve → checksum-skip → load → record. */
async function runFileDataset(runId: string, spec: DatasetSpec): Promise<DatasetResult> {
  try {
    const src = await resolveSource(spec);
    const sha = await sha256File(src.file);
    const bytes = fs.statSync(src.file).size;
    if (!(await isDatasetChanged(queryLastChecksum, spec.id, sha))) {
      await recordFile(runId, { dataset: spec.id, filename: src.file, bytes, sha256: sha, status: "unchanged" });
      return { name: spec.name, status: "unchanged" };
    }
    const out = await LOADERS[spec.id](src.file);
    await recordFile(runId, { dataset: spec.id, filename: src.file, bytes, sha256: sha, status: "imported", rowsSeen: out.inserted });
    console.log(`  ${spec.id}: ${out.summary}`);
    return { name: spec.name, status: "imported", inserted: out.inserted, skipped: out.skipped ?? 0 };
  } catch (e) {
    await recordFile(runId, { dataset: spec.id, status: "failed", error: String(e) });
    return { name: spec.name, status: "failed", error: String(e) };
  }
}

/** Completions run on zip DIRECTORIES (daily packet zips), not a single file. */
async function runCompletions(runId: string, spec: DatasetSpec): Promise<DatasetResult> {
  try {
    const dir = ingestConfig.rrcDataDir;
    const zipDirs = dir && fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.startsWith("documents_")).map((f) => path.join(dir, f))
          .filter((p) => fs.statSync(p).isDirectory())
      : [];
    if (!zipDirs.length) {
      const url = await resolveUrl(spec);
      const dest = path.join(ingestConfig.workDir, "completions.zip");
      await downloadWithRetry(url, dest);
      zipDirs.push(ingestConfig.workDir);
    }
    const s = await loadCompletions(zipDirs, countyByCode);
    await recordFile(runId, { dataset: spec.id, filename: zipDirs.join(";").slice(0, 500), status: "imported", rowsSeen: s.parsed });
    console.log(`  completions: parsed=${s.parsed} merged=${s.merged}`);
    return { name: spec.name, status: "imported", inserted: s.merged };
  } catch (e) {
    await recordFile(runId, { dataset: spec.id, status: "failed", error: String(e) });
    return { name: spec.name, status: "failed", error: String(e) };
  }
}

/** County TSV path honoring the increment-1 overrides. */
function countyTsvPath(county: CountyScope): string {
  if (ingestConfig.counties.length === 1 && process.env.RRC_PRODUCTION_TSV) return process.env.RRC_PRODUCTION_TSV;
  if (ingestConfig.rrcDataDir) {
    const staged = path.join(ingestConfig.rrcDataDir, `production-${county.rrcCode}.tsv`);
    if (fs.existsSync(staged)) return staged;
  }
  return extractedTsvPath(county);
}

/** Production: PDQ source (staged/downloaded) → per-county TSVs → incremental merge. */
async function runProduction(runId: string): Promise<DatasetResult> {
  const spec = datasetById("production_pdq")!;
  let inserted = 0, skipped = 0, imported = false, unchanged = false;
  const errors: string[] = [];

  try {
    // Prefer already-staged per-county TSVs (increment-1 compatible); extract
    // the missing ones from the PDQ dsv/zip (staged or freshly downloaded).
    const missing = ingestConfig.counties.filter((c) => !fs.existsSync(countyTsvPath(c)));
    if (missing.length) {
      let source = stagedPdqSource();
      if (!source) {
        const url = await resolveUrl(spec);
        const dl = await downloadWithRetry(url, path.join(ingestConfig.workDir, "pdq-dump.zip"));
        source = dl.path;
      }
      const ex = await extractProductionTsvs(source, ingestConfig.counties, ingestConfig.workDir);
      console.log(`  pdq extract: lines=${ex.linesSeen} matched=${ex.matched}`);
    }

    for (const county of ingestConfig.counties) {
      const tsv = countyTsvPath(county);
      if (!fs.existsSync(tsv)) {
        errors.push(`${county.name}: production TSV missing after extraction`);
        continue;
      }
      const sha = await sha256File(tsv);
      const bytes = fs.statSync(tsv).size;
      if (!(await isDatasetChanged(queryLastChecksum, spec.id, sha))) {
        unchanged = true;
        await recordFile(runId, { dataset: spec.id, filename: tsv, bytes, sha256: sha, status: "unchanged" });
        continue;
      }
      const s = await loadProduction(tsv, county.name);
      imported = true;
      inserted += s.merged;
      skipped += s.dropped + s.belowWindow;
      await recordFile(runId, { dataset: spec.id, filename: tsv, bytes, sha256: sha, status: "imported", rowsSeen: s.seen });
      console.log(`  ${county.name}: merged=${s.merged} dropped=${s.dropped} belowWindow=${s.belowWindow} (watermark ${s.watermark})`);
    }
  } catch (e) {
    errors.push(String(e));
    await recordFile(runId, { dataset: spec.id, status: "failed", error: String(e) });
  }

  const status: DatasetResult["status"] =
    errors.length ? "failed" : imported ? "imported" : unchanged ? "unchanged" : "pending";
  return { name: spec.name, status, inserted, skipped, error: errors.join("; ") || undefined };
}

async function main(): Promise<void> {
  const scope = ingestConfig.countyNames.join(", ");
  const runId = await startRun(trigger, scope);
  console.log(`RRC ingest run ${runId} (${trigger}) — scope: ${scope}`);
  const results: DatasetResult[] = [];

  try {
    for (const spec of requiredDatasets()) {
      if (only && spec.id !== only) continue;
      if (spec.id === "production_pdq") results.push(await runProduction(runId));
      else if (spec.id === "completions") results.push(await runCompletions(runId, spec));
      else if (LOADERS[spec.id]) results.push(await runFileDataset(runId, spec));
      else {
        const note = spec.id === "oil_well_status"
          ? "Standalone W-10 layout undocumented; oil current-operator arrives via Full Wellbore type-23."
          : "Geometry refresh stays manual (tools/rrc/build_wells.py + importRrcWells) until the pyshp step is containerized.";
        await recordFile(runId, { dataset: spec.id, status: "pending", error: note });
        results.push({ name: spec.name, status: "pending" });
      }
    }

    const failed = results.some((r) => r.status === "failed");
    const anyPending = results.some((r) => r.status === "pending");
    const status = failed ? "failed" : anyPending ? "partial" : "ok";
    await finishRun(runId, status, results);

    console.log(`Run ${runId} → ${status}`);
    for (const r of results) console.log(`  ${r.status.padEnd(9)} ${r.name}`);

    if (failed) {
      await sendIngestAlert(`run ${status} — needs attention`, renderRunSummary(runId, status, results));
    }
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  } catch (e) {
    await finishRun(runId, "failed", results, String(e));
    await sendIngestAlert("run crashed", `<p>Run <code>${runId}</code> crashed:</p><pre>${String(e)}</pre>`);
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
