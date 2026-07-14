/**
 * G-10 gas-well-status loader (gse10, EBCDIC cp037, fixed 130-byte records
 * starting "GT"). Validated 100% against current PDQ operators — this file is
 * the CURRENT-operator source of truth for gas leases, so it upserts
 * rrc.well_status keyed (og_code='G', district, rrc_id).
 *
 * Offsets: district 2:4, gas RRC id 4:10, operator no 104:110.
 */
import type { MergeSpec } from "../merge.js";
import { decodeCp037, fixedRecords } from "../ebcdic.js";
import { mergeRows, ensureWellStatusTable } from "./util.js";

export const GSE10_RECORD_SIZE = 130;

export const WELL_STATUS_SPEC: MergeSpec = {
  schema: "rrc",
  table: "well_status",
  columns: ["og_code", "district", "rrc_id", "operator_no"],
  conflict: ["og_code", "district", "rrc_id"],
  update: ["operator_no"],
};

export interface GasStatusRow { district: string; rrcId: string; operatorNo: string }

/** Decode one 130-byte record; null when it isn't a GT test record. */
export function parseGse10Record(rec: Buffer): GasStatusRow | null {
  if (rec.length !== GSE10_RECORD_SIZE) return null;
  const head = decodeCp037(rec, 0, 2);
  if (head !== "GT") return null;
  const district = decodeCp037(rec, 2, 4).trim();
  const rrcId = decodeCp037(rec, 4, 10).trim();
  const operatorNo = decodeCp037(rec, 104, 110).trim();
  if (!district || !rrcId || !/^\d+$/.test(rrcId)) return null;
  return { district, rrcId, operatorNo };
}

export interface GasStatusStats { records: number; merged: number }

export async function loadGasWellStatus(filePath: string, districts?: ReadonlySet<string>): Promise<GasStatusStats> {
  await ensureWellStatusTable();
  // Last record per key wins (the file carries 26 months; later = newer).
  const latest = new Map<string, GasStatusRow>();
  const stats: GasStatusStats = { records: 0, merged: 0 };
  for await (const rec of fixedRecords(filePath, GSE10_RECORD_SIZE)) {
    const row = parseGse10Record(rec);
    if (!row) continue;
    stats.records++;
    if (districts && !districts.has(row.district)) continue;
    latest.set(`${row.district}|${row.rrcId}`, row);
  }
  stats.merged = await mergeRows(
    WELL_STATUS_SPEC,
    [...latest.values()].map((r) => ["G", r.district, r.rrcId, r.operatorNo || null]),
  );
  return stats;
}
