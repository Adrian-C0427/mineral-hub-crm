/**
 * RRC ingestion scope + tunables. Start scoped to a single county to prove the
 * pipeline end-to-end, then widen COUNTIES (or later add a STATEWIDE flag) once
 * verified. RRC county codes are 3-digit and are NOT FIPS (Freestone = 161).
 */
export interface CountyScope {
  name: string;    // display + rrc.production.county key (matches existing loader)
  rrcCode: string; // 3-digit RRC county code (API prefix)
  district: string; // RRC district the county reports under
}

export const COUNTIES: CountyScope[] = [
  { name: "Freestone", rrcCode: "161", district: "05" },
];

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
