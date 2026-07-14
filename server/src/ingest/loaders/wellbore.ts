/**
 * Full Wellbore enrichment loader (dbf900, EBCDIC cp037, fixed 247-byte
 * records, no newlines, sorted by API). rrc.wells rows are ANCHORED by the
 * county shapefiles (geometry + fid), so this loader never inserts — it
 * UPDATEs existing wells by api8 with the master-file facts:
 * formations, plug date, lease name, survey, and (via the type-23 oil W-10)
 * the latest oil operator number into rrc.well_status.
 *
 * Record dispatch (offsets from the validated tools/rrc extraction):
 *   type 01 root      : api8 2:10 (county 3 + unique 5) — starts a well group
 *   type 09 formation : name 5:37 (repeats; one formation per record)
 *   type 12 lease     : lease name 2:34, survey 34:82
 *   type 14 plugging  : plug date 2:10 (yyyymmdd)
 *   type 23 oil W-10  : operator no 11:17, year 17:21 — keep max year
 */
import { prisma } from "../../db.js";
import { decodeCp037, fixedRecords } from "../ebcdic.js";
import { mergeRows, ensureWellStatusTable, yyyymmddToIso } from "./util.js";
import { WELL_STATUS_SPEC } from "./gasWellStatus.js";

export const DBF900_RECORD_SIZE = 247;

export interface WellboreFacts {
  api8: string;
  formations: string[];
  leaseName: string | null;
  survey: string | null;
  plugDate: string | null;
  oilOperatorNo: string | null;
  oilStatusYear: number | null;
  oilDistrict: string | null;
  oilLeaseNo: string | null;
}

const newFacts = (api8: string): WellboreFacts => ({
  api8, formations: [], leaseName: null, survey: null, plugDate: null,
  oilOperatorNo: null, oilStatusYear: null, oilDistrict: null, oilLeaseNo: null,
});

/** Fold one 247-byte record into the running per-well facts. Exported for tests. */
export function foldRecord(rec: Buffer, current: WellboreFacts | null): { facts: WellboreFacts | null; isRoot: boolean } {
  const type = decodeCp037(rec, 0, 2);
  if (type === "01") {
    const api8 = decodeCp037(rec, 2, 10).trim();
    return { facts: /^\d{8}$/.test(api8) ? newFacts(api8) : null, isRoot: true };
  }
  if (!current) return { facts: null, isRoot: false };
  if (type === "09") {
    const name = decodeCp037(rec, 5, 37).trim();
    if (name && !current.formations.includes(name)) current.formations.push(name);
  } else if (type === "12") {
    current.leaseName = decodeCp037(rec, 2, 34).trim() || current.leaseName;
    current.survey = decodeCp037(rec, 34, 82).trim() || current.survey;
  } else if (type === "14") {
    current.plugDate = yyyymmddToIso(decodeCp037(rec, 2, 10)) ?? current.plugDate;
  } else if (type === "23") {
    const year = Number(decodeCp037(rec, 17, 21));
    if (Number.isFinite(year) && year > (current.oilStatusYear ?? 0)) {
      current.oilStatusYear = year;
      current.oilOperatorNo = decodeCp037(rec, 11, 17).trim() || null;
      current.oilDistrict = decodeCp037(rec, 23, 25).trim() || null;
      current.oilLeaseNo = decodeCp037(rec, 25, 33).trim() || null;
    }
  }
  return { facts: current, isRoot: false };
}

export interface WellboreStats { wellsSeen: number; inScope: number; updated: number; statusMerged: number; wellsTableMissing?: boolean }

export async function loadWellboreEnrichment(
  filePath: string,
  countyCodes: ReadonlySet<string>,
): Promise<WellboreStats> {
  await ensureWellStatusTable();
  // rrc.wells is created by the shapefile import (PostGIS geometry). On a
  // database that hasn't run it yet, still harvest the oil W-10 status rows
  // and just skip the per-well UPDATEs instead of failing the dataset.
  const [{ present }] = await prisma.$queryRawUnsafe<{ present: string | null }[]>(
    `SELECT to_regclass('rrc.wells')::text AS present`,
  );
  const wellsTablePresent = present != null;
  const stats: WellboreStats = { wellsSeen: 0, inScope: 0, updated: 0, statusMerged: 0, wellsTableMissing: !wellsTablePresent };
  let current: WellboreFacts | null = null;
  const pending: WellboreFacts[] = [];
  const statusRows: (string | null)[][] = [];

  const flushFacts = async () => {
    if (!wellsTablePresent) { pending.length = 0; return; }
    if (!pending.length) return;
    for (const f of pending) {
      const res = await prisma.$executeRawUnsafe(
        `UPDATE rrc.wells SET
           formations = CASE WHEN cardinality($2::text[]) > 0 THEN $2::text[] ELSE formations END,
           lease_name = COALESCE(lease_name, $3),
           survey     = COALESCE(survey, $4),
           plug_date  = COALESCE($5::date, plug_date)
         WHERE api8 = $1`,
        f.api8, f.formations, f.leaseName, f.survey, f.plugDate,
      );
      stats.updated += Number(res);
    }
    pending.length = 0;
  };

  const finishWell = (f: WellboreFacts | null) => {
    if (!f) return;
    stats.wellsSeen++;
    if (!countyCodes.has(f.api8.slice(0, 3))) return;
    stats.inScope++;
    pending.push(f);
    if (f.oilOperatorNo && f.oilDistrict && f.oilLeaseNo) {
      statusRows.push(["O", f.oilDistrict, f.oilLeaseNo, f.oilOperatorNo]);
    }
  };

  for await (const rec of fixedRecords(filePath, DBF900_RECORD_SIZE)) {
    const { facts, isRoot } = foldRecord(rec, current);
    if (isRoot) {
      finishWell(current);
      if (pending.length >= 500) await flushFacts();
      current = facts;
    } else {
      current = facts ?? current;
    }
  }
  finishWell(current);
  await flushFacts();

  // Oil current-operator (latest W-10 year) into well_status; dedupe on key.
  const latest = new Map<string, (string | null)[]>();
  for (const r of statusRows) latest.set(`${r[1]}|${r[2]}`, r);
  stats.statusMerged = await mergeRows(WELL_STATUS_SPEC, [...latest.values()]);
  return stats;
}
