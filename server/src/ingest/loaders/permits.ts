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
 *   type "02" (510c): same key 2:14; api8 = the line's LAST 8 characters;
 *                    surface acres 325:333 (DA-SURFACE-ACRES, 9(6)V9(2) —
 *                    the W-1's lease/pooled-unit acreage, two implied
 *                    decimals; verified against real Freestone units, e.g.
 *                    "00064000" = the section-sized 640.00-acre gas unit);
 *                    surface location per DA-LOCATION-FORMATION-FLAG at 242:
 *                    'N' = fixed fields (survey 261:316, abstract 316:322 as
 *                    a bare number), else old free text 243:295 like
 *                    "G. LEFFEL SUR. A-498" (abstract regexed out of it)
 * A permit row is emitted when a root and its api8 trailer have both been
 * seen. Operator here is the operator AT PERMIT TIME (historic by design).
 *
 * Retention (2026-09-10, user decision): only the most recent
 * PERMIT_RETENTION_YEARS of permits are kept — older roots are skipped at
 * parse time so a full-history master file never resurrects trimmed rows.
 * The raw file (~/rrc-data/daf802-2026-09/daf802.txt.gz) keeps the full
 * 1976+ history if it's ever wanted back.
 */
const PERMIT_RETENTION_YEARS = Number(process.env.RRC_PERMIT_RETENTION_YEARS ?? 6);
/** Oldest permit date to keep (rolling window from today). */
export function permitRetentionCutoff(now = new Date()): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - PERMIT_RETENTION_YEARS);
  return d.toISOString().slice(0, 10);
}
import fs from "node:fs";
import readline from "node:readline";
import type { MergeSpec } from "../merge.js";
import { mergeRows, ensureRegulatoryTables, yyyymmddToIso } from "./util.js";

export const PERMITS_SPEC: MergeSpec = {
  schema: "rrc",
  table: "permits",
  columns: ["status_no", "api8", "county", "district", "lease_name", "operator", "operator_no", "permit_date", "acres", "survey", "abstract"],
  conflict: ["status_no", "api8"],
  update: ["county", "district", "lease_name", "operator", "operator_no", "permit_date", "acres", "survey", "abstract"],
  casts: { permit_date: "date", acres: "numeric" },
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

export interface PermitTrailer {
  key: string; api8: string; acres: number | null;
  survey: string | null; abstract: string | null;
}

export function parsePermitApi(line: string): PermitTrailer | null {
  if (!line.startsWith("02") || line.length < 22) return null;
  const key = line.slice(2, 14);
  const api8 = line.slice(line.length - 8).trim();
  if (!/^\d{8}$/.test(api8)) return null;
  // DA-SURFACE-ACRES: 8 zoned digits, two implied decimals; zero = unreported.
  const rawAcres = line.slice(325, 333);
  const acres = /^\d{8}$/.test(rawAcres) && Number(rawAcres) > 0 ? Number(rawAcres) / 100 : null;
  // Surface location. New format ('N') has fixed survey/abstract fields; the
  // old format is one free-text line where the abstract rides along as
  // "A-498" / "A 498" — regex it out and store both normalized as "A-<n>".
  let survey: string | null = null;
  let abstract: string | null = null;
  if (line.length >= 322) {
    if (line[242] === "N") {
      survey = line.slice(261, 316).trim() || null;
      const num = line.slice(316, 322).trim().replace(/^A-?/i, "");
      abstract = /^\d+$/.test(num) ? `A-${Number(num)}` : null;
    } else {
      const loc = line.slice(243, 295).trim();
      const m = loc.match(/\bA[- ]?(\d+)\b/i);
      abstract = m ? `A-${Number(m[1])}` : null;
      // Survey = the location text minus the abstract token and "SUR(VEY)."
      // suffix noise; empty when nothing meaningful remains.
      survey = loc.replace(/\bA[- ]?\d+\b/i, "").replace(/\b(SURVEY|SUR)\.?\s*,?/gi, "").replace(/[,\s]+$/g, "").trim() || null;
    }
  }
  return { key, api8, acres, survey, abstract };
}

export interface PermitLoadStats { rootsSeen: number; merged: number; filteredOut: number }

/** County name lookup comes from the configured scope (RRC code → name). */
export async function loadPermits(
  filePath: string,
  countyByCode: ReadonlyMap<string, string>,
): Promise<PermitLoadStats> {
  await ensureRegulatoryTables();

  const cutoff = permitRetentionCutoff();
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
      if (countyByCode.has(root.countyCode) && root.permitDate != null && root.permitDate >= cutoff) roots.set(root.key, root);
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
      trailer.acres, trailer.survey, trailer.abstract,
    ]);
    if (rows.length >= 1000) await flush();
  }
  await flush();
  return stats;
}
