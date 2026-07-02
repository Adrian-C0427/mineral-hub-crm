# ADR 0002 — Research & Market Intelligence platform

**Status:** Accepted · **Date:** 2026-07-01

## Context

We want to spot emerging mineral-acquisition opportunities before they are
widely recognized, by watching three public-record activity streams:

1. **Mineral transactions** — recorded instruments transferring mineral/royalty
   ownership (mineral deeds, royalty conveyances, quitclaim/warranty mineral
   deeds, assignments, reservations…).
2. **Leasing activity** — O&G leases, lease memos, assignments, releases,
   amendments, extensions, ratifications.
3. **Drilling activity** — permit filings/approvals, spuds, completions,
   horizontal vs directional, and new operators entering an area.

Initial focus is Texas; the architecture must scale to all 50 states without a
redesign, despite wildly different recording systems and cadastral schemes.

## Decision

### Data model (3 tables, org-scoped)

- `ResearchDocument` — one recorded instrument. Raw instrument type is kept
  (`docTypeRaw`) alongside a normalized `docType` (16-value enum) and a coarse
  `docClass` (`TRANSACTION` | `LEASE`) that all trend math keys off.
- `ResearchPermit` — one permit/well lifecycle record with a canonical
  `activityDate` (earliest known lifecycle date) for bucketing.
- `ResearchIngestRun` — provenance for every import.

**Geography is deliberately generic:** `state` + `county` everywhere, plus
optional `abstractId`/`survey` (Texas) and `trs` (section-township-range for
PLSS states). A new state needs zero schema change — its cadastral unit goes
in `trs` (or stays county-level). Data is org-scoped like every other record
in the CRM (each org imports/owns its research data; a future shared/global
dataset can be layered on with a nullable org id).

**Entity resolution v1:** `grantorNorm`/`granteeNorm`/`operatorNorm` store an
uppercased, punctuation- and legal-suffix-stripped grouping key computed at
ingest ("Blackrock Minerals, L.L.C." ≡ "BLACKROCK MINERALS LLC"). Rankings and
filters group on these keys. A proper entity table (aliases, hierarchies) can
replace the keys later without breaking the API.

### Ingestion: source-adapter registry

`domain/researchSources.ts` defines canonical field sets (documents/permits)
and a registry of **sources** — each is just a header-alias map plus metadata
(`generic-documents`, `tx-county-clerk`, `generic-permits`, `tx-rrc-w1`).
CSV import flow: analyze (guess mapping) → user adjusts mapping → commit
(classify, normalize, dedupe by instrument#/API#, chunked `createMany`,
`ResearchIngestRun` written). **Adding a state/provider = one registry entry.**
Automated connectors (RRC daily W-1 pulls, county-clerk scrapers, commercial
feeds) will reuse exactly this pipeline server-side.

Rows whose instrument type is not mineral-related are skipped at ingest with
per-reason counts (critically: "Deed of Trust" ≠ deed — liens, mortgages,
easements, plats are excluded in `classifyDocType`).

### Analytics

All formulas live in pure, unit-tested `domain/research.ts`:

- **Trends** — any period vs any comparison period (default: same-length prior
  period; UI also offers prior-year and custom). Absolute + % change +
  direction per KPI; gap-free time series (auto day/week/month granularity)
  with rolling averages.
- **Hotspots** — current window vs 6 equal-length history windows; flagged when
  volume ≥ 5, z-score ≥ 2 *and* ≥ 50% above historical mean (the extra lift
  guard prevents over-flagging low-variance baselines).
- **Opportunity signals** (`/research/opportunities`): county-level surges per
  stream, abstract-level transaction concentration (≥ 3 in window), new
  operators (permits now, none in prior 12 months), and **confluence** —
  multiple streams surging in the same county, boosted severity. Severity
  (0–100) blends growth, volume and z-score so a +120% jump on 60 records
  outranks +300% on 4.

Routes load lightweight row projections and aggregate in-process. At CSV-import
scale this is milliseconds and keeps logic testable; when statewide automated
feeds land, swap the loaders for SQL rollups/materialized views behind the same
response contracts.

### UI

`/research` (lazy, permission `viewResearch`; imports gated by
`manageResearchData`): Overview (trend KPIs, stacked activity chart, instrument
breakdown) · Geography (county/abstract/survey tables + **SVG Texas choropleth**
from `public/data/tx-counties.geojson`, ~100KB, no MapLibre needed at state
scale) · Rankings (buyers/sellers/operators, new-entrant badges) ·
Opportunities (severity-ranked signal cards → drill to records) · Records
(paginated drill-in + CSV export) · Data & Imports (mapping wizard, history,
bulk delete). PDF export reuses `lib/pdf.ts`.

### Sample data

`npm run research:sample` (server, `RESEARCH_ORG_EMAIL=...`) loads a clearly
synthetic 18-month dataset (source `"sample"`, engineered surge storylines) so
the module is explorable before real data arrives; `--clear` removes it. This
respects the "no seed data" rule — it is opt-in and tagged for deletion.

## Leon County, TX — first live source (2026-07)

Reconnaissance of `leon.tx.publicsearch.us` (GovOS Public Search) established
there is **no public/documented API**: the SSR page renders `numRecords: 0` and
results load post-hydration over an **authenticated WebSocket** (`wss://…/ws`,
messages `{type, payload, correlationId, authToken, sync}`) that closes the
connection for any client not presenting the site's signed session cookies. This
is a commercial platform whose ToS disallows automated access, so we chose the
**manual export → import** path over scraping.

Two things were salvaged from the site's JS bundle + embedded config and baked
in permanently:

- The **Real Property export column layout** (Grantor, Grantee, Doc Type,
  Recorded Date, Doc Number, Book/Volume/Page, Legal Description) → the
  `tx-leon-publicsearch` source adapter maps these directly.
- Leon's **complete instrument-type vocabulary** (1,738 RP types). The
  mineral/leasing subset drove hardening of `classifyDocType` to handle the terse
  abbreviations Texas county-clerk systems emit (`O&GL`, `ASGMT OF LEASE`,
  `REL OIL&GAS LS`, `Q/C MINERAL DEED`, `ASG ORR ROY INTR`, `MIN & ROYALTY
  DEED`) — word-bounded so `MIN`/`ORR`/`ROY` don't match inside
  `ADMIN`/`CORR`/etc. Coverage on genuine O&G/mineral descriptions is ~99% with
  no non-mineral leaks (liens, easements, deeds of trust still reject). The
  operator workflow + the recognized type list live in
  `docs/leon-county-import.md`.

This validates the source-adapter design: onboarding Leon was a registry entry +
classifier hardening, no schema or route changes.

## Nationwide expansion path

1. New state = registry entry (+ optional per-state boundary GeoJSON for the
   choropleth, keyed by the same `{fips,name}` props).
2. Automated connectors post into the same ingest pipeline (Integration rows
   already model per-org connection state).
3. Scale-up: move aggregation to SQL rollups; vector tiles for sub-county
   geometry; shared cross-org public dataset with nullable org scoping.
4. Entity resolution service replacing normalized-string grouping.

## Consequences

- Schema is fully additive (deploy-safe with `prisma db push`).
- In-process aggregation caps out around a few hundred thousand rows per org
  per query window — acceptable for v1, with a defined escape hatch.
- Instrument classification is keyword-based; unclassifiable rows are skipped
  (reported per-reason at import) rather than polluting trends.
