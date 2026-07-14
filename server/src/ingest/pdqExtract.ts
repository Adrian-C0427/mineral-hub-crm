/**
 * PDQ download → per-county production TSVs, removing the manual DSV prep the
 * production path needed in increment 1.
 *
 * The RRC "Production Data Query Dump" is a zip whose members are '}'-delimited
 * DSV tables. Production lives in OG_COUNTY_LEASE_CYCLE_DATA_TABLE.dsv (33 GB
 * uncompressed statewide), so we never inflate it to disk: the member is
 * streamed through `unzip -p` (or read directly when RRC_DATA_DIR already has
 * the extracted .dsv) and filtered line-by-line to the configured counties,
 * emitting the exact 12-column TSV `loadProduction` consumes.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { ingestConfig, type CountyScope } from "./config.js";

export const PDQ_PRODUCTION_MEMBER = "OG_COUNTY_LEASE_CYCLE_DATA_TABLE.dsv";

/**
 * Map one '}'-delimited OG_COUNTY_LEASE_CYCLE line to the loadProduction TSV
 * row, or null when the line is a header / other county / malformed.
 * DSV columns: 0 OG, 1 district, 2 lease, 3 year, 4 month, 5 COUNTY_NO,
 * 6 operator, 7 field, 8 CYCLE_YEAR_MONTH, 10 gas well no, 12 oil, 15 gas,
 * 18 cond, 21 csgd. TSV column order matches normalizeProductionLine().
 */
export function pdqLineToTsv(line: string, countyCodes: ReadonlySet<string>): { countyCode: string; tsv: string } | null {
  if (!line || line.startsWith("OIL_GAS_CODE")) return null;
  const c = line.split("}");
  if (c.length < 22) return null;
  const og = c[0];
  if (og !== "O" && og !== "G") return null;
  const countyCode = c[5];
  if (!countyCodes.has(countyCode)) return null;
  const tsv = [
    og, c[1], c[2], c[8], countyCode, c[6], c[7], (c[10] ?? "").trim(),
    c[12] || "0", c[15] || "0", c[18] || "0", c[21] || "0",
  ].join("\t");
  return { countyCode, tsv };
}

/** Line source: the extracted .dsv when present, else `unzip -p` on the dump. */
function openLines(source: string): { rl: readline.Interface; done: Promise<void> } {
  if (source.endsWith(".zip")) {
    const child = spawn("unzip", ["-p", source, PDQ_PRODUCTION_MEMBER], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    const done = new Promise<void>((resolve, reject) => {
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}: ${stderr.slice(0, 300)}`))));
      child.on("error", reject);
    });
    return { rl: readline.createInterface({ input: child.stdout, crlfDelay: Infinity }), done };
  }
  return {
    rl: readline.createInterface({ input: fs.createReadStream(source), crlfDelay: Infinity }),
    done: Promise.resolve(),
  };
}

export interface ExtractStats { linesSeen: number; matched: number; outputs: Record<string, string> }

/**
 * Stream `source` (dump .zip or extracted .dsv) and write
 * `production-<code>.tsv` per configured county into `outDir`.
 */
export async function extractProductionTsvs(
  source: string,
  counties: readonly CountyScope[] = ingestConfig.counties,
  outDir: string = ingestConfig.workDir,
): Promise<ExtractStats> {
  fs.mkdirSync(outDir, { recursive: true });
  const codes = new Set(counties.map((c) => c.rrcCode));
  const writers = new Map<string, fs.WriteStream>();
  const outputs: Record<string, string> = {};
  for (const c of counties) {
    const p = path.join(outDir, `production-${c.rrcCode}.tsv`);
    outputs[c.rrcCode] = p;
    writers.set(c.rrcCode, fs.createWriteStream(p));
  }

  const { rl, done } = openLines(source);
  const stats: ExtractStats = { linesSeen: 0, matched: 0, outputs };
  for await (const line of rl) {
    stats.linesSeen++;
    const row = pdqLineToTsv(line, codes);
    if (!row) continue;
    stats.matched++;
    writers.get(row.countyCode)!.write(row.tsv + "\n");
  }
  await done;
  await Promise.all([...writers.values()].map((w) => new Promise((res) => w.end(res))));
  return stats;
}

/** Where the production TSV for a county lands after extraction. */
export function extractedTsvPath(county: CountyScope, outDir: string = ingestConfig.workDir): string {
  return path.join(outDir, `production-${county.rrcCode}.tsv`);
}

/**
 * Locate a staged PDQ source when RRC_DATA_DIR is set: the extracted member
 * .dsv (preferred) or a dump .zip beside it. Returns null when neither exists
 * (the caller then downloads the dump).
 */
export function stagedPdqSource(): string | null {
  const dir = ingestConfig.rrcDataDir;
  if (!dir) return null;
  const dsv = path.join(dir, PDQ_PRODUCTION_MEMBER);
  if (fs.existsSync(dsv)) return dsv;
  const pdqDsv = path.join(dir, "PDQ_DSV", PDQ_PRODUCTION_MEMBER);
  if (fs.existsSync(pdqDsv)) return pdqDsv;
  const zips = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /pdq.*\.zip$/i.test(f) || /production.*dump.*\.zip$/i.test(f))
    : [];
  return zips.length ? path.join(dir, zips.sort().at(-1)!) : null;
}
