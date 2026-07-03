# ADR 0003 — GIS Architecture for Statewide → Nationwide Scale

**Status:** Proposed (review before further county expansion)
**Date:** 2026-07-03
**Scope:** Map data storage, delivery, rendering, search, and synchronization for all Texas counties and, eventually, nationwide coverage.

---

## 1. Current state (measured)

| Component | Today | Mechanism |
|---|---|---|
| Cadastral (abstracts) | 7 counties, 6,016 polygons, ~4.2 MB | Static GeoJSON in `client/public/data`, committed to git, fetched per county with the viewport lazy-loader |
| County boundaries | Statewide (254), 106 KB | `tx-counties.geojson`, eager |
| Wells + wellbores | 2 counties, 8,025 wells / 1,148 laterals, ~4.9 MB | Static GeoJSON, eager |
| Production | 2 counties, ~3.8 MB | Static JSON, fetched by a page effect |
| Search / filters | Client-side scans of in-memory FeatureCollections | React `useMemo` |
| Rendering | MapLibre GL, GeoJSON sources, feature-state via `promoteId` | Client |
| Database | Neon Postgres (no PostGIS), Prisma | CRM data only — GIS data never touches the DB |
| Hosting | Railway (API + static client), GitHub | Data ships inside the client build |
| Updates | Manual: run `tools/otls/fetch_abstracts.py`, commit, deploy | None automated |

This was the right architecture for 2–10 counties: zero infrastructure, trivially cacheable, no server dependency. It is **not** the right architecture for 254 counties, and it is actively wrong for nationwide.

## 2. Where the current approach breaks

Extrapolating from measured data (≈860 abstracts/county, ≈4,000 wells/county in active areas):

| Concern | Texas statewide | Nationwide | Breaking point |
|---|---|---|---|
| Abstract GeoJSON | ~220k polygons, 110–130 MB | PLSS/parcels: several GB | Git repo & Railway image bloat is **permanent** (git history never shrinks). Already 13 MB of data in the repo. |
| Wells | ~1.1M wells (RRC) | ~4M+ wells | A single MapLibre GeoJSON source re-tiles **all** loaded features on every `setData` — O(total), noticeably slow past ~50–100k features; browser memory grows unbounded as users pan. |
| Production history | 60–120M monthly rows | 300M+ rows | Cannot ship as JSON files at all. Needs a real database. |
| Search | in-memory scan | — | Requires downloading data before it's searchable; already why the county filter had to be special-cased to the registry. |
| Updates | manual script + git commit + deploy | — | No validation history, no incremental updates, no recovery. RRC publishes updates weekly/daily. |

The just-built viewport lazy-loader mitigates initial load but not the fundamentals: data still lives in git, still accumulates in browser memory, and still can't be searched/filtered until downloaded. It was the correct incremental step for static files; the architecture below supersedes it.

## 3. Recommended target architecture

Four layers. Every piece runs on the existing stack (GitHub, Railway, Neon) plus **one new service: S3-compatible object storage** (Cloudflare R2 recommended).

```
┌────────────────────────────────────────────────────────────────┐
│ 1. SOURCE OF TRUTH — Neon Postgres + PostGIS                   │
│    All spatial + attribute data. GIST indexes. Partitioned     │
│    production. Staging schema for imports.                     │
└──────────────┬─────────────────────────────┬───────────────────┘
               │ nightly/weekly ETL          │ live queries
┌──────────────▼──────────────┐  ┌───────────▼───────────────────┐
│ 2. TILE PIPELINE (worker)   │  │ 3. API (existing Express)     │
│    PostGIS → GeoJSON export │  │    /gis/search  (FTS/trigram) │
│    → tippecanoe → .pmtiles  │  │    /wells/:api  (detail)      │
│    → upload to R2           │  │    /gis/within  (spatial)     │
└──────────────┬──────────────┘  └───────────┬───────────────────┘
               │ static byte-range reads     │ JSON
┌──────────────▼─────────────────────────────▼───────────────────┐
│ 4. CLIENT — MapLibre GL + pmtiles protocol                     │
│    Vector-tile sources (constant per-viewport cost at ANY      │
│    dataset size). feature-state selection via promoteId        │
│    unchanged. Click → API detail fetch.                        │
└────────────────────────────────────────────────────────────────┘
```

### 3.1 Database: PostGIS on Neon

Neon supports the PostGIS extension natively (`CREATE EXTENSION postgis`). No new database service needed.

**Schema sketch** (separate `gis` schema; Prisma models the attribute side, geometry columns as `Unsupported("geometry")` with raw SQL for spatial ops):

```sql
gis.states     (fips PK, name, geom MultiPolygon)
gis.counties   (fips PK, state_fips, name, geom, bbox)
gis.abstracts  (id PK "TX-289001", county_fips, abstract_no, survey,
                block, area_m2, geom, valid_from, valid_to)
gis.surveys    (id, name, state, geom)          -- future named-survey layer
wells          (api14 PK, rrc_id, name, operator_id, lease_id,
                status, type, spud/completion dates,
                surface_geom Point, bh_geom Point, county_fips, state)
wellbores      (id, api14 FK, geom LineString, lateral_len)
operators      (id PK, rrc_number, name, address, ...)
leases         (id PK, rrc_lease_no, name, district, county_fips, ...)
production     (lease_id/api14, month, oil_bbl, gas_mcf, ...)
               PARTITION BY LIST(state), then RANGE(year)
permits        (permit_no, api14, status, filed_date, ..., geom Point)
ownership / public_records: attribute tables keyed to abstracts/wells
```

**Indexing strategy:**
- `GIST(geom)` on every geometry column — this is the spatial index; bbox/intersection queries are O(log n) regardless of table size.
- B-tree on natural keys (`api14`, `county_fips`, `operator_id`, `(lease_id, month)`).
- `pg_trgm` GIN indexes on `wells.name`, `operators.name`, `abstracts.survey` → fast fuzzy search API replaces client-side scanning.
- Production partitioned by state, then year: queries touch only relevant partitions; old partitions can later be archived to Parquet on R2 if storage cost warrants.

**Nationwide readiness:** every table keys on `state` + county FIPS from day one. Texas abstracts and (say) New Mexico PLSS sections are both rows in a cadastral table with a `layer_type`. Adding a state = writing an importer, not a schema change.

### 3.2 Rendering: vector tiles (PMTiles), not GeoJSON

| | GeoJSON sources (today) | Vector tiles (recommended) |
|---|---|---|
| Client cost | O(total features loaded) — re-tiled in browser | O(visible tiles) — constant regardless of dataset size |
| 254-county abstracts | ~120 MB transferred over a session | ~50–300 KB per viewport |
| 1M wells | Not feasible | Routine (tippecanoe density-drops at low zooms) |
| Feature interaction | `feature-state` via `promoteId` | Identical — `promoteId` works on vector sources |
| Server needed | No | **No** (PMTiles = single static file, HTTP range requests) |
| Freshness | Deploy | Re-upload one file (nightly job) |

**PMTiles specifically** (vs a running tile server like martin/pg_tileserv): our data changes at most daily (RRC publishes on schedules), never in real time. Prebuilt static tiles are strictly better here: zero servers to run, CDN/browser cacheable, ~free to host. A live `ST_AsMVT` tile server only earns its keep for real-time data; if that need ever appears, martin can be added as a Railway service without changing the client (both speak the same MVT protocol).

**Tile layout:**
- `cadastral-v{N}.pmtiles` — layers: states (z0+), counties (z4+), abstracts (z8+, labels z9+), surveys (z12+). Statewide TX estimate: 40–80 MB.
- `wells-v{N}.pmtiles` — wells (z8+, clustered/density-dropped below z10), wellbores (z10+). TX estimate: 150–300 MB; nationwide ~0.5–1 GB.
- Tiles carry only render/click props (`id`, label, status, type, operator name). Everything else — production charts, completion data, ownership — is fetched from the API on click, exactly like the deal-panel flow today.
- Version suffix in the filename = atomic cache-busting: build new file, upload, flip one config value, old tiles keep serving until the flip.

**Client changes are contained:** swap `addSource("abstracts", {type:"geojson"...})` for `{type:"vector", url:"pmtiles://..."}` (+ the ~2 KB `pmtiles` npm package to register the protocol), point existing layers at `source-layer`, keep all paint/filter/feature-state logic. Delete the per-county fetch/merge/lazy-load machinery — tiles make viewport loading automatic and correct at every scale. Filters and search move to the `/gis/search` API.

### 3.3 Data synchronization (worker + cron)

A small **Railway worker service** (or Railway cron jobs) running Node importers, one per source. The RRC bulk-file layouts (dbf900, daf802, gse10) already documented in the repo are exactly what these importers parse.

Standard pipeline per source:

```
download → parse → load into staging schema
  → validate      (row counts vs. manifest, ST_IsValid on geometry,
                   FK checks, % -change sanity thresholds)
  → diff & upsert (by natural key: api14, abstract id, lease+month)
      · incremental by default — only changed rows touch live tables
      · full refresh = rebuild staging, then swap (zero downtime)
  → log to sync_runs (source, started/finished, inserted/updated/
      rejected counts, error detail, triggering the alerting we
      already have via Sentry)
  → if a tiled layer changed: enqueue tile rebuild → tippecanoe →
      upload cadastral-v{N+1}.pmtiles → flip version
```

- **Versioning:** production is append-only (natural history). Wells get `status` change history via a small audit table; abstracts get `valid_from/valid_to` (they change ~never).
- **Recovery:** staging-then-swap means a failed import never corrupts live data; re-run is idempotent.
- **Cadence:** production monthly (matches PDQ), well/permit status weekly, cadastral on demand.

### 3.4 Performance characteristics at scale

- **Map load:** style + 6–12 tile fetches (~50–400 KB) regardless of whether we cover 2 counties or 50 states.
- **Pan/zoom:** browser-cached tiles; MapLibre renders MVT natively on the GPU.
- **Search:** trigram-indexed Postgres query, ~ms at millions of rows; results are `id + centroid`, client flies to them (works for data not yet rendered).
- **Filtering:** layer filter expressions on tile attributes (instant, client-side) for status/type/operator; API-driven for anything not in tiles.
- **Concurrency:** static tiles from R2 scale infinitely; API load is unchanged from today.
- **Memory:** MapLibre evicts off-screen tiles — browser memory stays flat during long sessions (the unbounded-growth problem disappears).

## 4. Storage & cost estimates

| Stage | Postgres (Neon) | Object storage (R2) | Est. monthly infra |
|---|---|---|---|
| Today | <1 GB | — | ~$25–40 (current Railway + Neon) |
| TX cadastral + wells | ~5–10 GB | ~0.5 GB tiles + raw archives | +$1–20 → **~$40–70** |
| TX + full production history | 25–60 GB (partitioned) | ~2 GB | Neon scale tier → **~$100–175** |
| Nationwide (wells, production, cadastral) | 150–300 GB | 5–15 GB | **~$250–500** |

Notes: R2 storage is ~$0.015/GB-mo with **zero egress fees** (egress is the trap with S3/tile hosting — tiles are the highest-traffic asset). Neon costs are dominated by storage past ~50 GB; the Parquet-archive escape hatch for cold production partitions caps this. Numbers are order-of-magnitude planning figures, not quotes.

**Rejected costlier alternatives:** Mapbox-hosted tiles (per-request pricing at our traffic grows unboundedly), ArcGIS Online (per-credit pricing, vendor lock-in), self-hosted PostGIS on Railway (Neon already does this job with better ops), running tile server (unneeded for daily-refresh data).

## 5. What changes now vs. later

### Phase A — do now, before any more counties (the actual "review outcome")
1. **Stop committing GeoJSON to git.** This is the one decision that gets more expensive every week (git history is permanent). `client/public/data` gets frozen and then removed once tiles ship.
2. `CREATE EXTENSION postgis` on Neon; create `gis` schema; import `tx-counties` + the 7 counties' abstracts as the seed.
3. **Import all 254 counties' abstracts straight into PostGIS** via the existing OTLS fetcher pointed at the DB instead of files. With tiles, the batch-of-5 process is obsolete — statewide cadastral becomes one pipeline run, because data volume no longer touches the app bundle or the browser.
4. Build the tile pipeline (script: PostGIS export → tippecanoe → PMTiles → R2) and switch MapView's `counties`/`abstracts` sources to vector tiles. Selection/highlight/deals logic carries over via `promoteId`.
5. Add `/api/gis/search` (trigram) and move county/survey/abstract search + filter option lists to it.

*Effort: the MapView surgery is contained (source/layer defs + search wiring); the pipeline is a few hundred lines. This replaces, rather than extends, the lazy-loading code just added.*

### Phase B — Texas depth
6. Wells/wellbores statewide from RRC bulk files (layouts already documented in-repo) → PostGIS → `wells.pmtiles`.
7. Production history into partitioned tables; well detail panel reads the API (drop per-county production JSON).
8. Sync worker + cron cadences + `sync_runs` logging/alerting.

### Phase C — nationwide
9. Per-state importer adapters (each state agency publishes differently; the pipeline, schema, tiles, and client don't change).
10. Cadastral layer types beyond TX abstracts (PLSS sections, parcels) as additional rows/layers in the same system.

## 6. Decision summary

| Question | Recommendation |
|---|---|
| Spatial database | **PostGIS on existing Neon** (extension, not new service) |
| Spatial indexing | GIST on geometry, trigram on names, list+range partitioning on production |
| Vector tiles vs GeoJSON | **Vector tiles** — GeoJSON does not survive statewide |
| Tile generation | **Prebuilt PMTiles via tippecanoe** (nightly worker), not a live tile server |
| Tile delivery | **Cloudflare R2** (new service; zero egress), pmtiles protocol, no server |
| Attribute/production storage | Postgres, partitioned; tiles carry render-props only |
| Search | Server-side (Postgres FTS/trigram) via API |
| Sync | Railway worker: staging → validate → diff-upsert → tile rebuild → version flip |
| Biggest change to make *now* | Stop shipping GIS data in git/the client bundle |
| TX→nationwide migration cost under this design | Importers only — no schema, pipeline, or client changes |
