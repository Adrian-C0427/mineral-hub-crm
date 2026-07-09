/**
 * RRC monthly ingestion orchestrator — the scheduled entrypoint.
 *
 *   npx tsx src/ingest/run.ts [--trigger schedule|manual] [--only <datasetId>]
 *
 * Flow per dataset: resolve link → download (retry+verify) → checksum → skip if
 * unchanged → parse → incrementally merge → record results. Every step is
 * logged to rrc.ingest_run / rrc.source_file; a failure notifies via email
 * (or Sentry). Because merges are keyed on natural keys, a re-run is a no-op.
 *
 * Increment 1 wires the incremental PRODUCTION path end-to-end (it consumes the
 * county-filtered PDQ DSV — the same input B5 used — and appends only the new /
 * restated months). The remaining required datasets are logged as `pending`;
 * their parsers already exist under tools/rrc and get wired in the next
 * increment. Nothing here rewrites existing history.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";
import { ingestConfig, type CountyScope } from "./config.js";
import { datasetById, requiredDatasets } from "./manifest.js";
import { startRun, finishRun, recordFile, queryLastChecksum, type DatasetResult } from "./runLog.js";
import { sha256File, isDatasetChanged } from "./checksum.js";
import { loadProduction } from "./loadProduction.js";
import { sendIngestAlert, renderRunSummary } from "./notify.js";

const args = process.argv.slice(2);
const argVal = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : undefined;
};
const trigger: "schedule" | "manual" = argVal("--trigger") === "manual" ? "manual" : "schedule";
const only = argVal("--only");

/** Prepared county-filtered PDQ DSV for a county (see importRrcProduction.ts). */
function productionTsvPath(county: CountyScope): string {
  if (ingestConfig.counties.length === 1 && process.env.RRC_PRODUCTION_TSV) {
    return process.env.RRC_PRODUCTION_TSV;
  }
  const dataDir = ingestConfig.rrcDataDir || ingestConfig.workDir;
  return path.join(dataDir, `production-${county.rrcCode}.tsv`);
}

async function runProduction(runId: string): Promise<DatasetResult> {
  const spec = datasetById("production_pdq")!;
  let inserted = 0, skipped = 0, imported = false, unchanged = false, pending = false;
  const errors: string[] = [];

  for (const county of ingestConfig.counties) {
    const tsv = productionTsvPath(county);
    if (!fs.existsSync(tsv)) {
      pending = true;
      await recordFile(runId, { dataset: spec.id, filename: tsv, status: "pending",
        error: `Prepared DSV not found; set RRC_PRODUCTION_TSV or stage ${path.basename(tsv)} (extraction step lands in increment 2).` });
      continue;
    }
    try {
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
    } catch (e) {
      errors.push(`${county.name}: ${String(e)}`);
      await recordFile(runId, { dataset: spec.id, filename: tsv, status: "failed", error: String(e) });
    }
  }

  const status: DatasetResult["status"] =
    errors.length ? "failed" : imported ? "imported" : pending ? "pending" : unchanged ? "unchanged" : "pending";
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
      if (spec.id === "production_pdq") {
        results.push(await runProduction(runId));
      } else {
        // Parser exists under tools/rrc; loader wiring is the next increment.
        await recordFile(runId, { dataset: spec.id, status: "pending", error: `Loader pending (${spec.parser})` });
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
