/**
 * Drilling-permit loader (daf802 "Drilling Permit Master and Trailer", ASCII
 * fixed-width). Replaces the full-replace importRrcRegulatory path with an
 * incremental natural-key upsert on (status_no, api8) — daily/monthly files
 * merge into history instead of rewriting it.
 *
 * Layout (validated against the statewide file and the PDQ-enriched wells):
 *   type "01" root : permit key 2:14 (API county code at 11:14), lease name
 *                    14:46, district 46:48, operator no 48:54, permit date
 *                    58:66 (yyyymmdd), operator name 66:98
 *   type "02"      : same key 2:14; api8 = the line's LAST 8 characters
 * A permit row is emitted when a root and its api8 trailer have both been
 * seen. Operator here is the operator AT PERMIT TIME (historic by design).
 */
import fs from "node:fs";
import readline from "node:readline";
import type { MergeSpec } from "../merge.js";
import { mergeRows, ensureRegulatoryTables, yyyymmddToIso } from "./util.js";

export const PERMITS_SPEC: MergeSpec = {
  schema: "rrc",
  table: "permits",
  columns: ["status_no", "api8", "county", "district", "lease_name", "operator", "operator_no", "permit_date"],
  conflict: ["status_no", "api8"],
  update: ["county", "district", "lease_name", "operator", "operator_no", "permit_date"],
  casts: { permit_date: "date" },
};

export interface PermitRoot {
  key: string; countyCode: string; leaseName: string; district: string;
  operatorNo: string; permitDate: string | null; operatorName: string;
}

export function parsePermitRoot(line: string): PermitRoot | null {
  if (!line.startsWith("01") || line.length < 98) return null;
  const key = line.slice(2, 14);
  if (!/^\d{12}$/.test(key.replace(/ /g, "0"))) return null;
  return {
    key,
    countyCode: line.slice(11, 14),
    leaseName: line.slice(14, 46).trim(),
    district: line.slice(46, 48).trim(),
    operatorNo: line.slice(48, 54).trim(),
    permitDate: yyyymmddToIso(line.slice(58, 66)),
    operatorName: line.slice(66, 98).trim(),
  };
}

export function parsePermitApi(line: string): { key: string; api8: string } | null {
  if (!line.startsWith("02") || line.length < 22) return null;
  const key = line.slice(2, 14);
  const api8 = line.slice(line.length - 8).trim();
  if (!/^\d{8}$/.test(api8)) return null;
  return { key, api8 };
}

export interface PermitLoadStats { rootsSeen: number; merged: number; filteredOut: number }

/** County name lookup comes from the configured scope (RRC code → name). */
export async function loadPermits(
  filePath: string,
  countyByCode: ReadonlyMap<string, string>,
): Promise<PermitLoadStats> {
  await ensureRegulatoryTables();

  const roots = new Map<string, PermitRoot>();
  const rows: (string | number | null)[][] = [];
  const stats: PermitLoadStats = { rootsSeen: 0, merged: 0, filteredOut: 0 };

  const flush = async () => {
    if (!rows.length) return;
    stats.merged += await mergeRows(PERMITS_SPEC, rows);
    rows.length = 0;
  };

  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    const root = parsePermitRoot(line);
    if (root) {
      stats.rootsSeen++;
      if (countyByCode.has(root.countyCode)) roots.set(root.key, root);
      else stats.filteredOut++;
      continue;
    }
    const trailer = parsePermitApi(line);
    if (!trailer) continue;
    const r = roots.get(trailer.key);
    if (!r) continue; // out-of-scope county or trailer without a root
    rows.push([
      r.key, trailer.api8, countyByCode.get(r.countyCode)!, r.district || null,
      r.leaseName || null, r.operatorName || null, r.operatorNo || null, r.permitDate,
    ]);
    if (rows.length >= 1000) await flush();
  }
  await flush();
  return stats;
}
