/**
 * Completions loader ("Completion Information in Data Format" — daily zips of
 * '{'-delimited W-2/G-1 packets). The proven decoder is the python tool
 * (tools/rrc/parse_completions.py); porting its packet grammar adds risk for
 * zero gain, so this loader SHELLS OUT to it for parsing and owns the
 * incremental upsert into rrc.completions on (tracking_no, api8).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MergeSpec } from "../merge.js";
import { mergeRows, ensureRegulatoryTables } from "./util.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PARSER = path.join(REPO_ROOT, "tools/rrc/parse_completions.py");

export const COMPLETIONS_SPEC: MergeSpec = {
  schema: "rrc",
  table: "completions",
  columns: [
    "tracking_no", "api8", "filing_type", "status", "filed_date", "completion_date",
    "county", "district", "operator_no", "field_no", "field_name", "well_name", "well_no", "survey",
  ],
  conflict: ["tracking_no", "api8"],
  // Resubmissions update status/dates; identity fields refresh too.
  update: [
    "filing_type", "status", "filed_date", "completion_date", "county", "district",
    "operator_no", "field_no", "field_name", "well_name", "well_no", "survey",
  ],
  casts: { filed_date: "date", completion_date: "date" },
};

interface ParsedCompletion {
  trackingNo: string; api8: string; filingType?: string | null; status?: string | null;
  filedDate?: string | null; completionDate?: string | null; county?: string | null;
  district?: string | null; operatorNo?: string | null; fieldNo?: string | null;
  fieldName?: string | null; wellName?: string | null; wellNo?: string | null; survey?: string | null;
}

function runParser(zipDirs: string[], countyCodes: string[]): Promise<ParsedCompletion[]> {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `completions-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const args = [PARSER, out, "--counties", ...countyCodes, "--zip-dirs", ...zipDirs];
    const child = spawn("python3", args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => reject(new Error(`python3 not available for completions parsing: ${String(e)}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`parse_completions.py exited ${code}: ${stderr.slice(0, 400)}`));
      try {
        const rows = JSON.parse(fs.readFileSync(out, "utf8")) as ParsedCompletion[];
        fs.rmSync(out, { force: true });
        resolve(rows);
      } catch (e) { reject(e); }
    });
  });
}

/** Packet dates arrive as MM/DD/YYYY — normalize to ISO for the ::date cast. */
export function mdyToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/** Map parser output to the merge tuple. Exported for tests. */
export function completionRow(c: ParsedCompletion, countyByCode: ReadonlyMap<string, string>): (string | null)[] | null {
  if (!c.trackingNo || !/^\d{8}$/.test(c.api8 ?? "")) return null;
  const countyName = c.county && countyByCode.get(c.county);
  return [
    c.trackingNo, c.api8, c.filingType ?? null, c.status ?? null, mdyToIso(c.filedDate),
    mdyToIso(c.completionDate), countyName ?? c.county ?? null, c.district ?? null,
    c.operatorNo ?? null, c.fieldNo ?? null, c.fieldName ?? null, c.wellName ?? null,
    c.wellNo ?? null, c.survey ?? null,
  ];
}

export interface CompletionStats { parsed: number; merged: number }

export async function loadCompletions(
  zipDirs: string[],
  countyByCode: ReadonlyMap<string, string>,
): Promise<CompletionStats> {
  await ensureRegulatoryTables();
  const parsed = await runParser(zipDirs, [...countyByCode.keys()]);
  const rows = parsed
    .map((c) => completionRow(c, countyByCode))
    .filter((r): r is (string | null)[] => r !== null);
  const merged = await mergeRows(COMPLETIONS_SPEC, rows);
  return { parsed: parsed.length, merged };
}
