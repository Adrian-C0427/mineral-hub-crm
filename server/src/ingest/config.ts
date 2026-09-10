/**
 * RRC ingestion scope + tunables. Proved end-to-end on Freestone alone; now
 * widened to the user's three target counties (2026-09-09) rather than going
 * statewide — statewide production is a storage/cost decision (100M+ rows,
 * needs a paid Neon tier) that stays deferred. RRC county codes are 3-digit
 * and are NOT FIPS (Freestone = 161, Leon = 289, Cherokee = 073); codes and
 * B1-B4 coverage confirmed against importRrcRegulatory.ts's county table.
 */
export interface CountyScope {
  name: string;    // display + rrc.production.county key (matches existing loader)
  rrcCode: string; // 3-digit RRC county code (API prefix)
  district: string; // RRC district the county reports under (display only —
                     // production filtering keys on rrcCode; each row's own
                     // district comes from the PDQ data, not this field)
}

export const COUNTIES: CountyScope[] = [
  { name: "Freestone", rrcCode: "161", district: "05" },
  { name: "Leon", rrcCode: "289", district: "05" },
  { name: "Cherokee", rrcCode: "073", district: "06" },
];

/**
 * Production history retention (2026-09-10): rrc.production holds the PAST 5
 * YEARS per county (cycle_ym >= 202106 at trim time), fitting the Neon free
 * tier's 512MB project cap — full 1993+ history for even these three counties
 * exceeded it. Monthly runs keep this shape on their own (the watermark +
 * restate window only appends new/restated recent months; trimmed history is
 * never re-sent). Only a from-scratch reload of an EMPTIED table would
 * resurrect full history — if that's ever needed, pre-filter the extracted
 * county TSVs to the retention window first (awk on cycle_ym, column 4).
 */

export const ingestConfig = {
  counties: COUNTIES,
  countyNames: COUNTIES.map((c) => c.name),
  countyCodes: COUNTIES.map((c) => c.rrcCode),

  /** Where raw downloads are staged. Must be a real disk/volume — RRC files are
   *  large (the full wellbore master is multi-GB), so /tmp on a tiny container
   *  will not hold them. Point RRC_WORK_DIR at a mounted volume in production. */
  workDir: process.env.RRC_WORK_DIR ?? "/tmp/rrc-ingest",

  /** Optional pre-downloaded data dir (skips the download step when the raw RRC
   *  files are already on the host — e.g. ~/rrc-data during local testing). */
  rrcDataDir: process.env.RRC_DATA_DIR ?? "",

  /** Failure/attention notifications. Email is used when INGEST_ALERT_EMAIL is
   *  set and SMTP is configured; otherwise the alert falls back to Sentry. */
  alertEmail: process.env.INGEST_ALERT_EMAIL ?? "",

  /** Download resilience. */
  maxRetries: Number(process.env.RRC_MAX_RETRIES ?? 4),
  retryBaseMs: Number(process.env.RRC_RETRY_BASE_MS ?? 2000),
  /** A download smaller than this is treated as a failed/partial fetch. */
  minBytes: Number(process.env.RRC_MIN_BYTES ?? 1024),

  /** The RRC data-sets catalog page; the download layer scrapes it to resolve a
   *  dataset's current permanent-link URL by matching its exact link text. */
  catalogUrl:
    process.env.RRC_CATALOG_URL ??
    "https://www.rrc.texas.gov/resource-center/research/data-sets-available-for-download/",
} as const;
