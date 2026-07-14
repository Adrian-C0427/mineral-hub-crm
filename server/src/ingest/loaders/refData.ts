/**
 * Reference-data loaders: P5 organizations (orf850) → rrc.operators and the
 * Oil & Gas Field Name & Numbers file (fldtpe) → rrc.fields. Same fixed-width
 * offsets the proven importRrcRef script used, re-expressed as incremental
 * natural-key upserts so a monthly run only touches changed names.
 */
import fs from "node:fs";
import readline from "node:readline";
import type { MergeSpec } from "../merge.js";
import { mergeRows, ensureRefTables } from "./util.js";

export const OPERATORS_SPEC: MergeSpec = {
  schema: "rrc",
  table: "operators",
  columns: ["op_no", "name"],
  conflict: ["op_no"],
  update: ["name"],
};

export const FIELDS_SPEC: MergeSpec = {
  schema: "rrc",
  table: "fields",
  columns: ["district", "field_no", "suffix", "type", "name"],
  conflict: ["district", "field_no", "suffix"],
  update: ["type", "name"],
};

/** "A " organization-master line → [op_no, name], else null. */
export function parseOperatorLine(line: string): [string, string] | null {
  if (!line.startsWith("A ")) return null;
  const opNo = line.slice(2, 8).trim();
  const name = line.slice(8, 40).trim();
  return /^\d{6}$/.test(opNo) && name ? [opNo, name] : null;
}

/** fldtpe line → [district, field_no, suffix, type, name], else null. */
export function parseFieldLine(line: string): [string, string, string, string, string] | null {
  if (line.length < 30) return null;
  const district = line.slice(0, 3).trim();
  const fieldNo = line.slice(3, 11).trim();
  const suffix = line.slice(11, 14).trim();
  const type = line.slice(15, 20).trim();
  const name = line.slice(20, 52).trim();
  return district && fieldNo && name ? [district, fieldNo, suffix, type, name] : null;
}

export async function loadOperators(filePath: string): Promise<number> {
  await ensureRefTables();
  const byNo = new Map<string, string>(); // last occurrence wins (file is chronological)
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    const row = parseOperatorLine(line);
    if (row) byNo.set(row[0], row[1]);
  }
  return mergeRows(OPERATORS_SPEC, [...byNo.entries()].map(([a, b]) => [a, b]));
}

export async function loadFields(filePath: string): Promise<number> {
  await ensureRefTables();
  const seen = new Set<string>();
  const rows: (string | null)[][] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    const row = parseFieldLine(line);
    if (!row) continue;
    const key = `${row[0]}|${row[1]}|${row[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([row[0], row[1], row[2], row[3] || null, row[4]]);
  }
  return mergeRows(FIELDS_SPEC, rows);
}
