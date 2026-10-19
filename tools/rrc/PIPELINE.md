# RRC automated ingestion pipeline

A hands-off, monthly pipeline that downloads the Texas Railroad Commission
datasets behind the Well-Analysis feature, validates them, merges them
**incrementally** into the `rrc` schema on Neon, and lets every dependent
feature (Map, Well Analysis, Research, Permits, Production, Operators, Buyer
Matching, Heat Maps) serve the fresh data with no further action — the app
already reads the `rrc` schema live, so the database is the single source of
truth.

> **Approach:** deterministic code on a **cron schedule**, not an LLM agent and
> not browser automation. The RRC files are direct HTTP downloads, so `fetch`
> beats driving a browser; monthly ETL of gigabyte files must be idempotent and
> boring. An optional agent belongs only on top, as a failure watchdog (the
> same pattern as the existing Sentry monitor).

## Current scope

Configured in `server/src/ingest/config.ts`. **Freestone County (RRC 161)** only
for now — prove it end-to-end, then widen `COUNTIES` (or add a statewide flag).
Freestone already carries B1–B5 data, so "merge with existing" is exercised on
day one.

## Design

```
run.ts (monthly cron)
  └─ startRun()                          → rrc.ingest_run row
     for each required dataset:
        resolveUrl → download (retry+verify) → sha256
        unchanged since last import?  → skip (rrc.source_file 'unchanged')
        else parse (inline / tools/rrc) → incremental merge → record counts
     finishRun() + notify on failure
```

| Module | Responsibility |
|---|---|
| `config.ts` | scope (counties), work dir, retries, alert email |
| `manifest.ts` | the Phase-1/2 RRC datasets: exact name, format, URL resolution, target table, Well-Analysis section |
| `download.ts` | resolve current RRC link from the catalog, fetch with retry/backoff, size-verify |
| `checksum.ts` | SHA-256 + change detection vs the last imported file |
| `merge.ts` | generic idempotent `INSERT … ON CONFLICT` (UPSERT dimensions / append production) + watermark |
| `loadProduction.ts` | incremental, append-only production load (the storage-critical path) |
| `runLog.ts` | `rrc.ingest_run` + `rrc.source_file` logging |
| `notify.ts` | email (SMTP) → Sentry → stderr fallback |
| `run.ts` | orchestrator / entrypoint (`npm run ingest:rrc`) |

## Incremental & storage-efficient

- **Production is append-only.** A unique natural key
  `(og_code, district, lease_no, gas_well_no, cycle_ym)` (migration
  `20260709090000_rrc_ingest_pipeline`) makes re-imports UPSERT. Given the stored
  watermark (newest month per county), only rows at/after
  `watermark − RRC_RESTATE_WINDOW` (default 6 months) are sent to the DB: new
  months INSERT, RRC's late restatements UPDATE volumes, older history is never
  rewritten. The table grows by the new data, not by a full monthly copy.
- **Dimensions UPSERT** on their PKs (operators `op_no`, fields
  `district+field_no+suffix`, etc.) so unchanged rows cost nothing.
- **Unchanged files skip entirely** via checksum comparison.
- Relationships are preserved by stable keys: **API-14** ↔ production ↔ permits
  ↔ `operator_no` ↔ `field_no`.

## Reliability

- **Download verification** — HTTP status + minimum-size check; a truncated
  fetch is treated as failure.
- **Retry** — exponential backoff (`RRC_MAX_RETRIES`, `RRC_RETRY_BASE_MS`).
- **Validation before merge** — per-line normalization drops malformed / non-O&G
  / all-zero rows.
- **Logging** — every download/import/skip/error in `rrc.source_file`; one
  summary row per run in `rrc.ingest_run` (status, per-dataset counts, error).
- **Notifications** — failures email `INGEST_ALERT_EMAIL` (falls back to Sentry).

## Running it

```sh
cd server
# One county already prepared as a DSV (same awk extraction B5 used):
RRC_PRODUCTION_TSV=/path/to/freestone-production.tsv npm run ingest:rrc -- --trigger manual
# Re-run: unchanged checksum ⇒ skipped; changed ⇒ only new/restated months merged.
```

Environment variables: `RRC_WORK_DIR`, `RRC_DATA_DIR`, `RRC_PRODUCTION_TSV`,
`INGEST_ALERT_EMAIL`, `RRC_RESTATE_WINDOW`, `RRC_MAX_RETRIES`,
`RRC_RETRY_BASE_MS`, `RRC_MIN_BYTES`, `RRC_CATALOG_URL`.

## Scheduling (monthly)

RRC refreshes most sets late in the month, so run early the following month.

**Railway cron service** (recommended — same infra as the app):

```
# railway.json / service settings
start:  npm run ingest:rrc -- --trigger schedule
cron:   0 6 3 * *      # 06:00 on the 3rd of each month
```

Point the service at a volume for `RRC_WORK_DIR` (the raw files are large) and
give it the same `DATABASE_URL` as the API.

**GitHub Actions alternative:**

```yaml
on:
  schedule: [{ cron: "0 6 3 * *" }]
jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cd server && npm ci && npm run ingest:rrc -- --trigger schedule
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          INGEST_ALERT_EMAIL: ${{ secrets.INGEST_ALERT_EMAIL }}
```

> Runner disk (~14 GB) cannot hold the full extracted PDQ; for statewide/full
> history use a Railway worker with a mounted volume, or keep production scoped.

## Status

**Increment 1 (this commit).** Framework + incremental **production** path
end-to-end (download/checksum/skip/merge/log/notify), migration, and unit tests.
The other required datasets are logged as `pending`.

**Increment 2 (next).** Wire the remaining loaders (Full Wellbore, permits,
operators, fields, well status, completions, shapefiles) — the `tools/rrc`
parsers already decode these; this connects them to the same merge core — and
add the PDQ download+extract so no manual DSV prep is needed.

**Increment 3.** Provision the cron service on the chosen host + the failure
watchdog agent.

## App integration (already true)

The Map serves wells/wellbores via `ST_AsMVT` tiles; Research and Well Analysis
query the `rrc` schema live. Once a run commits, those features reflect the new
data automatically — no re-import, no user action. Add cache-busting only if a
specific layer caches.


## Increment 2 (shipped)

All remaining Phase-1 loaders now run through the incremental merge core —
no manual prep left for a scheduled run:

| Dataset | Source | Loader | Merge key |
| --- | --- | --- | --- |
| Production (PDQ) | dump zip → `unzip -p` stream, county-filtered | `pdqExtract.ts` → `loadProduction` | og, district, lease, gas well, month |
| Drilling permits | daf802 ASCII (01 roots + 02 API trailers) | `loaders/permits.ts` (pure TS) | status_no, api8 |
| P5 organizations | orf850 "A " records | `loaders/refData.ts` | op_no |
| Field names | fldtpe fixed-width | `loaders/refData.ts` | district, field_no, suffix |
| Gas well status (G-10) | gse10 EBCDIC cp037, 130-byte records | `loaders/gasWellStatus.ts` | og, district, rrc_id |
| Full Wellbore | dbf900 EBCDIC cp037, 247-byte records | `loaders/wellbore.ts` | UPDATE rrc.wells by api8 + oil W-10 → well_status |
| Completions | daily packet zips via `tools/rrc/parse_completions.py` | `loaders/completions.ts` | tracking_no, api8 |

Notes:
- `RRC_DATA_DIR` short-circuits downloads when the raw files are already
  staged (local runs); production falls back to the catalog/permanent links.
- EBCDIC decoding is native TS (`ebcdic.ts`, cp037 subset) — python is only
  required for the completion packets.
- `mergeSql` gained per-column `casts` (dates) — text params into typed
  columns need explicit ::casts under prepared statements.
- The wellbore loader degrades gracefully when `rrc.wells` (PostGIS,
  shapefile-created) doesn't exist yet: oil W-10 status still merges.
- Still manual/pending: standalone Oil W-10 file (layout undocumented; oil
  operator arrives via wellbore type-23) and the county shapefile geometry
  refresh (`build_wells.py` + `importRrcWells`).
- Validated against the real statewide files (2026-07 drop): 65,826 fields,
  74,947 operators, 11,731 gas + 77 oil status rows, 7,237 Freestone/Leon
  permits, PDQ slice → 6,020 Freestone production rows.

Increment 3 = Railway cron + failure watchdog.


## 2026-10 refresh: bundled, loaded on deploy

The production database isn't reachable from the build machine, so the
Leon / Freestone / Cherokee refresh ships as **bundles in the repo**
(`server/data/rrc/*.json.gz`). The API loads them at boot through the same
versioned, advisory-locked, single-transaction loader as the Louisiana data
(`services/rrcRefresh.ts` on top of `services/gisRegions.loadVersionedDataset`).
Each bundle loads once per content version; later boots are no-ops.

| Bundle | Contents | Loader behavior |
| --- | --- | --- |
| `tx-rrc-wells.json.gz` | surface wells with normalized status, deviated wellbores (bottom hole + approximate path), status history, recent permits, source snapshot dates | upsert; status always from the snapshot, descriptive fields only replace a stored value when the snapshot has one; wells missing from RRC's complete layer are archived to `rrc.retired_wells`, then removed, unless a `ResearchWell` links to them (kept, flagged) |
| `tx-rrc-abstracts.json.gz` | abstract/survey polygons from RRC's survey layer, NAD83 | upsert; stale ones archived to `gis.abstracts_retired`, then removed, unless a deal references them |
| `tx-rrc-production.json.gz` | newest 12 months of lease production | upsert on the natural key; never deletes |

Counts land in `rrc.refresh_log`; file names and snapshot dates in `rrc.source_snapshot`.

### Rebuilding (next month)

1. Download into `~/rrc-data/<yyyy-mm>/` (never under Desktop/Documents): `well{fips}.zip` +
   `surv{fips}.zip` per county, `OG_WELLBORE_EWA_Report_<date>.csv`, `daf802.txt.gz`
   (NOT the frozen `daf802.txt`), `dbf900.ebc.gz` (NOT the frozen `dbf900.ebc`),
   `uif700a.txt.gz`, `PDQ_DSV.zip`, and the Oil & Gas Ledgers `gsf002l.ebc.gz` (gas,
   districts 4–6) + `olf003l.ebc.gz` / `olf005l.ebc.gz` (oil, districts 3 and 5–6).
   Use the `.gz` copies: the uncompressed ones on the portal are frozen. The MFT
   portal is a browser download.
2. From `server/`:
   `npx tsx src/scripts/buildRrcRefresh.ts --data-dir ~/rrc-data/<yyyy-mm> --as-of <today> --dbf900-date <MFT date> --uic-date <MFT date> --ledger-date <MFT date>`
3. Review `docs/reports/rrc-refresh-<as-of>/` (reconciliation, corrections, needs-investigation, missing locations).
4. Bump `TILE_DATA_VERSION` (client/src/lib/mapLayers.ts), open a PR, merge, deploy.

### Status rules (domain/wellStatus.ts)

Normalized statuses: Permitted · Drilling · Producing · Shut-In · Plugged · Injection · Disposal · Other/Unknown.
RRC's own finer wording stays alongside as `status_detail` (temporarily abandoned,
14(b)(2), dry hole, expired permit…), with `status_source`, `status_as_of`, and an
uncertainty `status_flag` (needs-investigation, no-recent-production, map-only, unverified).

Source priority: the Wellbore Query's on-schedule rows (RRC's proration schedule,
including the wellbore's inactive date), then a W-3 plug date, then the drilling
permit (approval, spud, expiry, cancellation), then the UIC permit (disposal vs
injection), and the RRC map symbol only as a tie-breaker or for wells without an
API number. Production is never used to call a well Producing; it only flags a
scheduled producer with no production reported for 12+ months.

### Geometry notes

- RRC's lateral lines are straight 2-point surface → bottom-hole segments, so every
  wellbore path is labelled approximate. RRC publishes directional surveys only as
  scanned images.
- RRC's survey polygons are NAD27. They're converted with the NAD27 → NAD83 shift
  RRC itself applied to each county's wells: a quadratic surface fit, under 0.2 ft
  median residual. The previous OTLS-sourced abstracts sat about 35 ft off RRC's frame.
- UT BEG has withdrawn the OTLS abstracts layer. RRC's per-county survey layer is
  the replacement.

### Unit size

- `unit_acres` holds the W-1 lease / pooled-unit acreage from the **newest permit in RRC's full history** that reports it. It uses that permit's acres for the field the well produces from, else its lease/unit acres, else its bottom-hole lease acres.
- The retained `rrc.permits` table (6 years) is not used for this, so wells permitted before 2020 keep their unit size.
- Pre-September-1986 permits carry different application and permit numbers. A permit record is paired with the application record directly above it, not by number.
- `assigned_acres` is the acreage RRC's proration schedule currently assigns the well (Oil/Gas Ledger). It is often a share of the pooled unit, so it is shown as its own value. It stands in for unit size, labelled "assigned", only where no permit reports acreage.
- Manual position errors found and corrected:
  - daf802 `DA-FIELD-ACRES` is at 48–55, not 46.
  - Every 02-segment position is manual − 3 (0-based).
