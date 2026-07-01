# ADR 0001 — Interactive Texas abstract map for active deals

- Status: Proposed (design only — not yet built)
- Date: 2026-06-30
- Owner: Adrian
- Related: `Deal` model, Pipeline/Deals pages

## Context

We want an interactive map that shows all **active deals** across Texas on top of
the **actual survey/abstract boundaries** (not points, not county outlines). Users
must see which specific abstracts contain activity, zoom/pan smoothly with the
boundaries always visible, click a highlighted abstract to see deal details, and
filter by county/basin/formation/asset type/status.

Texas is the hard case: it never adopted the federal PLSS (township/range/section).
It uses **abstracts/surveys** from Spanish, Mexican, and Republic-era land grants —
~200k+ irregular polygons statewide. The design must also extend to all 50 states
later, where survey systems differ (PLSS in most of the West/Midwest, metes-and-bounds
parcels in the original colonies).

## Decision

Adopt a **static-geometry / dynamic-state split**:

1. **Rendering:** MapLibre GL JS (WebGL vector rendering) in React.
2. **Boundaries:** pre-baked **Mapbox Vector Tiles** produced with `tippecanoe`,
   packaged as **PMTiles**, served from **S3 / Cloudflare R2 behind a CDN** (no tile
   server to run). Immutable, cache-forever.
3. **Highlighting:** MapLibre `feature-state` keyed on a stable `abstract_id`
   (`promoteId`). A thin API endpoint returns only the active `abstract_id`s +
   deal summaries; the client recolors those features. We never re-render 200k
   polygons to light up a few dozen active abstracts.
4. **Data model:** a normalized `survey_unit` table with a `survey_system`
   discriminator so a TX abstract, a PLSS section, and an East-Coast parcel are all
   just "a polygon with a stable id and a label."

## Answers to the key questions

### Texas abstract boundary data source
- Free/authoritative: **Railroad Commission of Texas (RRC)** survey/abstract layer
  (aligned with O&G work), **Texas GLO** land-grant abstracts, **TxGIO/TNRIS**
  clearinghouse. Visualization-grade, not survey-grade.
- Commercial upgrade (clean geometry + operator/well data, redistribution-restricted):
  Enverus/DrillingInfo, TGS, P2, S&P Global.
- Plan: prototype on RRC/GLO; treat commercial as a drop-in schema-compatible upgrade.

### Mapping framework — MapLibre GL JS
- WebGL GPU rendering scales to large vector-tile datasets; `feature-state` is
  purpose-built for real-time highlighting; BSD-licensed and self-hostable.
- Rejected: Leaflet (DOM/SVG, dies past ~100k polygons), Google Maps (Data layer
  can't handle the volume, metered), Esri ArcGIS JS (excellent but heavier/pricier/
  lock-in). Optional `deck.gl` overlay for nationwide (tens of millions of polygons).

### Rendering hundreds of thousands of polygons
- Vector tiles via `tippecanoe` (simplify/drop at low zoom, full detail high zoom) →
  PMTiles on CDN. Browser only handles the current viewport at the current zoom.
- Base abstract layer = thin lines / low-opacity fill, immutable tiles.
- Highlight via `feature-state`, decoupled from the heavy base geometry.

### Storage & indexing for real-time linkage
- Geometry lives in the tileset (not necessarily the app DB). Each polygon carries a
  globally-unique `abstract_id` (build as `TX-<countyFIPS>-<abstractNo>` now).
- `Deal` gains `abstractId` (FK → `survey_unit`). Linking is either an **attribute
  join** (county + abstract number → id; no PostGIS needed in the app DB) or a
  **spatial point-in-polygon** (needs PostGIS: GIST index on
  `geometry(MultiPolygon,4326)`).
- Highlight endpoint: `GET /api/map/active-abstracts?<filters>` → small list of active
  ids + deal summary. Filters are plain SQL `WHERE` on deals — we filter deals, not
  repaint geometry.
- Infra note: Railway's default Postgres has no PostGIS. Spatial auto-linking needs a
  `postgis/postgis` image or managed provider; attribute-join avoids PostGIS in the
  app DB entirely (PostGIS still used offline in the tile pipeline).

### Nationwide architecture
```
survey_unit(
  id            text PK,          -- e.g. TX-201-A1234 or PLSS-…
  state         char(2),
  survey_system enum('TX_ABSTRACT','PLSS','METES_BOUNDS','PARCEL'),
  display_label text,
  external_ids  jsonb,           -- TX:{abstract_no,survey_name}; PLSS:{pm,twp,rng,sec}
  geometry / centroid            -- in the pipeline / PostGIS
)
```
Deals reference `survey_unit_id` and are system-agnostic. Adding a state = a new ETL
adapter that normalizes that source into this schema and appends to the tileset.
Framework, DB, and rendering are unchanged. PLSS comes free from **BLM CadNSDI**.

### Licensing / availability / cost
- TX RRC/GLO/TxGIO: public, free, redistributable (approximate quality).
- County Appraisal District parcels: 254 authorities, inconsistent license/format.
- BLM PLSS (nationwide): free, public domain.
- Nationwide parcels: no free authoritative source — Regrid (Loveland), ReportAll,
  CoreLogic, Enverus; expensive and typically **prohibit redistribution / public
  derived tiles** — verify terms before baking into a public tile layer.
- Basemap: MapLibre is free but needs a basemap; cheapest is **Protomaps basemap as
  PMTiles on our own R2/S3**; alternatives MapTiler/Stadia/Mapbox (metered).
- Commercial minerals data (Enverus/TGS): per-seat, no redistribution.

## How it lands in this app
- Offline pipeline: source → PostGIS (normalize to `survey_unit`) → tippecanoe →
  PMTiles → S3/R2 + CDN.
- API (Express): `GET /api/map/active-abstracts` (+ existing filter params); `Deal`
  gains `abstractId`.
- Frontend (React): MapLibre map component; base abstract layer from PMTiles;
  `feature-state` highlight from the API; popup reuses the deal DTO; filter controls
  reuse existing filter UI.

## Phase-1 spike (Texas-only, free RRC data) — tickets

1. **Data acquisition spike** — download RRC (and/or GLO) statewide abstract layer;
   inspect attributes; confirm a county + abstract-number key exists; note geometry
   quality. Output: raw dataset + a short data dictionary.
2. **Tile pipeline PoC** — load into PostGIS, assign `abstract_id`
   (`TX-<countyFIPS>-<abstractNo>`), run `tippecanoe` → PMTiles; publish to R2/S3;
   verify range-request serving.
3. **Map component** — React + MapLibre; Protomaps basemap; render the abstract
   PMTiles layer over Texas; confirm smooth zoom/pan at statewide extent.
4. **Deal → abstract linkage** — add `Deal.abstractId`; attribute-join resolver
   (county + abstract number); backfill/UI to set it on a deal.
5. **Active-deal highlight** — `GET /api/map/active-abstracts` returns active ids +
   summary; client applies `feature-state`; click → popup with name/status/county/
   operator/asset type/NMA/NRA.
6. **Filters** — county/basin/formation/asset type/stage drive the highlight query.
7. **Generalization checkpoint** — introduce `survey_unit`; ingest one PLSS state from
   BLM CadNSDI to prove the abstraction before committing to nationwide.

## Risks / open questions
- Free TX boundary quality may be too coarse for some abstracts → commercial data.
- PostGIS on Railway (image swap vs. managed) — decide when spatial linking is needed.
- Parcel licensing will constrain any future public nationwide parcel tiles.
- Deal-to-abstract linkage UX: manual selection vs. captured lat/lng point-in-polygon.
