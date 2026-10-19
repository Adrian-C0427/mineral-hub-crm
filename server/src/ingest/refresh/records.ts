/**
 * Record parsers for the RRC files the status refresh reads, each validated
 * against the RRC manual and real 2026-10 files:
 *
 *  - Wellbore Query Data (OG_WELLBORE_EWA_Report_YYYY-MM-DD.csv): quoted CSV,
 *    latin-1, NO header row. The first 43 fields follow the EWA definition
 *    manual (og_wellbore_ewadefinitionmanual) exactly, through
 *    WL_14B2_EXT_STATUS; the 2026 files carry 59 fields — the tail is more
 *    single-letter 14(b)(2) flags than the 2013 manual lists, none of which
 *    the status rules read, so they are accepted and ignored. One row per
 *    lease/completion on a wellbore; ON_SCHEDULE = 'Y' rows are RRC's current
 *    proration schedule.
 *  - Drilling Permit Master and Trailer (daf802, manual OGA049): fixed-width
 *    ASCII. The 02 segment's printed positions double-count the 2-byte
 *    record id, so every 02 offset is (manual position − 3), 0-based —
 *    confirmed against the existing parser's validated surface-acres field.
 *  - UIC Database (uif700a, manual UIA010): 622-byte ASCII records; root
 *    segment "01" carries the API number and the injection type.
 */
import { type PermitFacts, type WellboreQueryRow } from "../../domain/wellStatus.js";

export const EWA_FIELDS = [
  "DISTRICT", "COUNTY_CODE", "API_NO", "COUNTY_NAME", "OIL_GAS_CODE", "LEASE_NAME", "FIELD_NUMBER", "FIELD_NAME",
  "LEASE_NUMBER", "WELL_NO_DISPLAY", "OIL_UNIT_NUMBER", "OPERATOR_NAME", "OPERATOR_NUMBER", "WB_WATER_LAND_CODE",
  "MULTI_COMP_FLAG", "API_DEPTH", "WB_SHUT_IN_DATE", "WB_14B2_FLAG", "WELL_TYPE_NAME", "WL_SHUT_IN_DATE", "PLUG_DATE",
  "PLUG_LEASE_NAME", "PLUG_OPERATOR_NAME", "RECENT_PERMIT", "RECENT_PERMIT_LEASE_NAME", "RECENT_PERMIT_OPERATOR_NO",
  "ON_SCHEDULE", "OG_WELLBORE_EWA_ID", "W2_G1_FILED_DATE", "W2_G1_DATE", "COMPLETION_DATE", "W3_FILE_DATE",
  "CREATED_BY", "CREATED_DT", "MODIFIED_BY", "MODIFIED_DT", "WELL_NO", "P5_RENEWAL_MONTH", "P5_RENEWAL_YEAR",
  "P5_ORG_STATUS", "CURR_INACT_YRS", "CURR_INACT_MOS", "WL_14B2_EXT_STATUS",
] as const;
export type EwaField = (typeof EWA_FIELDS)[number];
const EWA_INDEX = Object.fromEntries(EWA_FIELDS.map((f, i) => [f, i])) as Record<EwaField, number>;

/**
 * Incremental CSV tokenizer: feed it chunks, it emits complete records.
 * Handles quoted fields with embedded commas, quotes ("") and newlines.
 */
export class CsvSplitter {
  private field = "";
  private record: string[] = [];
  private quoted = false;
  private afterQuote = false;

  push(chunk: string, emit: (rec: string[]) => void): void {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (this.quoted) {
        if (c === '"') {
          if (chunk[i + 1] === '"') { this.field += '"'; i++; } else { this.quoted = false; this.afterQuote = true; }
        } else this.field += c;
        continue;
      }
      if (c === '"' && this.field === "" && !this.afterQuote) { this.quoted = true; continue; }
      if (c === ",") { this.record.push(this.field); this.field = ""; this.afterQuote = false; continue; }
      if (c === "\n" || c === "\r") {
        if (c === "\r" && chunk[i + 1] === "\n") i++;
        this.record.push(this.field);
        if (!(this.record.length === 1 && this.record[0] === "")) emit(this.record);
        this.record = []; this.field = ""; this.afterQuote = false;
        continue;
      }
      this.field += c;
    }
  }

  end(emit: (rec: string[]) => void): void {
    if (this.field !== "" || this.record.length) { this.record.push(this.field); emit(this.record); }
    this.record = []; this.field = "";
  }
}

/** One Wellbore Query record (the named fields, trimmed) or null when malformed. */
export function ewaRecord(fields: readonly string[]): Record<EwaField, string> | null {
  if (fields.length < EWA_FIELDS.length) return null;
  const rec = {} as Record<EwaField, string>;
  for (const f of EWA_FIELDS) rec[f] = (fields[EWA_INDEX[f]] ?? "").replace(/\s+/g, " ").trim();
  if (!/^\d{8}$/.test(rec.API_NO)) return null;
  return rec;
}

const d8 = (s: string | undefined): string | null => {
  const t = (s ?? "").trim();
  return /^\d{8}$/.test(t) && !/^0+$/.test(t) ? t : null;
};
const ym6 = (s: string | undefined): string | null => {
  const t = (s ?? "").trim();
  return /^\d{6}$/.test(t) && !/^0+$/.test(t) ? t : null;
};

/** The status-relevant view of a Wellbore Query record (domain/wellStatus input). */
export function toWellboreQueryRow(r: Record<EwaField, string>): WellboreQueryRow {
  const og = r.OIL_GAS_CODE;
  return {
    onSchedule: r.ON_SCHEDULE === "Y",
    wellType: r.WELL_TYPE_NAME,
    oilGas: og === "O" || og === "G" ? og : "",
    district: r.DISTRICT,
    leaseNo: r.LEASE_NUMBER,
    wbShutIn: ym6(r.WB_SHUT_IN_DATE),
    b14b2: r.WB_14B2_FLAG === "Y",
    plugDate: d8(r.PLUG_DATE),
    completionDate: d8(r.COMPLETION_DATE),
    w2g1Date: d8(r.W2_G1_DATE),
  };
}

// ---------------------------------------------------------------------------
// Drilling permits (daf802)
// ---------------------------------------------------------------------------

export interface PermitRootFacts { key: string; countyCode: string; appFlag: string; operatorNo: string; operatorName: string; leaseName: string; district: string }

/** DAROOT (01): the application's key, county and approval status (DA-STATUS-OF-APP-FLAG, pos 101). */
export function parsePermitRootFacts(line: string): PermitRootFacts | null {
  if (!line.startsWith("01") || line.length < 101) return null;
  const key = line.slice(2, 14);
  if (!/^\d{12}$/.test(key)) return null;
  return {
    key, countyCode: line.slice(11, 14), appFlag: line.slice(100, 101),
    leaseName: line.slice(14, 46).trim(), district: line.slice(46, 48).trim(),
    operatorNo: line.slice(48, 54).trim(), operatorName: line.slice(66, 98).trim(),
  };
}

export interface PermitDetail extends PermitFacts {
  key: string;
  api8: string;
  wellNo: string;
  typeApplication: string;
  totalDepth: number | null;
  wellStatusCode: string;
  directional: boolean;
  sidetrack: boolean;
}

/** DAPERMIT (02): permit dates, spud, expiry, cancellation and wellbore-profile flags. */
export function parsePermitDetail(line: string): PermitDetail | null {
  if (!line.startsWith("02") || line.length < 494) return null;
  const key = line.slice(2, 14);
  const api8 = line.slice(line.length - 8).trim();
  if (!/^\d{12}$/.test(key) || !/^\d{8}$/.test(api8)) return null;
  const depth = Number(line.slice(54, 59));
  return {
    key, api8,
    permitNo: line.slice(2, 9),
    wellNo: line.slice(48, 54).trim(),
    totalDepth: Number.isFinite(depth) && depth > 0 ? depth : null,
    typeApplication: line.slice(65, 67),
    issued: d8(line.slice(129, 137)),
    spud: d8(line.slice(153, 161)),
    wellStatusCode: line.slice(169, 170).trim(),
    expires: d8(line.slice(178, 186)),
    cancelled: d8(line.slice(186, 194)),
    cancelledFlag: line.slice(479, 480).trim(),
    directional: line[481] === "Y",
    sidetrack: line[482] === "Y",
    horizontal: line[493] === "Y",
  };
}

// ---------------------------------------------------------------------------
// UIC permits (uif700a)
// ---------------------------------------------------------------------------

export interface UicRoot { controlNo: string; api8: string; injectionType: string; activated: boolean; cancelled: string | null; approved: string | null; w3: string | null }

/** UIC root segment (01): UIC-API-NUMBER pos 33–40, UIC-TYPE-INJ pos 115 (1-based). */
export function parseUicRoot(line: string): UicRoot | null {
  if (!line.startsWith("01") || line.length < 175) return null;
  const api8 = line.slice(32, 40);
  if (!/^\d{8}$/.test(api8) || /^0+$/.test(api8)) return null;
  return {
    controlNo: line.slice(2, 11), api8,
    approved: d8(line.slice(49, 57)),
    activated: line[89] === "Y",
    cancelled: d8(line.slice(90, 98)),
    w3: d8(line.slice(106, 114)),
    injectionType: line.slice(114, 115),
  };
}
