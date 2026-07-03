# ADR 0004 — RRC Dataset Roadmap (Phase B Data Sources)

**Status:** Accepted
**Date:** 2026-07-03
**Source:** [RRC Data Sets Available for Download](https://www.rrc.texas.gov/resource-center/research/data-sets-available-for-download/)
**Context:** Complete inventory of Texas Railroad Commission public datasets to import for statewide well, production, permit, and regulatory coverage, feeding the PostGIS/vector-tile architecture from [ADR 0003](0003-gis-scale-architecture.md). Dataset names below are verbatim from the RRC download page. Record layouts for three of the fixed-width files (`dbf900` = Full Wellbore, `daf802` = Drilling Permit Master and Trailer, `gse10` = Statewide API Data) are already documented in the repo root.

---

## First production release — the 8 Critical datasets

| # | Exact RRC Dataset Name | File Format | Update Frequency | Role |
|---|---|---|---|---|
| 1 | **Full Wellbore** | ASCII | Weekly (by following Monday) | Master well record: API #, lease #/name, well #, operator, field, county, abstract & survey, spud/completion/plug dates, depth, status, oil/gas code. The backbone every other dataset keys onto (`dbf900` layout). |
| 2 | **Production Data Query Dump** | CSV | Last Saturday each month | Lease-level monthly oil / casinghead gas / gas-well gas / condensate, Jan 1993–present, with operator and field cross-references. Already powers Leon/Freestone production. |
| 3 | **Completion Information in Data Format** | ASCII | Nightly | Structured W-2/G-1 completion filings: completion date, formation/reservoir, perforations, casing. Source of formation attribution and completion history. |
| 4 | **Drilling Permit Master and Trailer - Daily File (Includes Latitudes and Longitudes)** | ASCII | Nightly | Permit history with coordinates — leading indicator for acquisition targeting (`daf802` layout). Superset of the other permit-file variants. |
| 5 | **Well Layers by County** | ArcView Shape File | Twice a week | Surface well points **and wellbore/lateral arcs** — the only bulk source of horizontal wellbore geometry (directional surveys are PDF-only). |
| 6 | **Statewide API Data** | ASCII (dBase also offered) | Twice a week | Attribute table keyed to the map well points (API #, symbol/status, operator); joins shapefiles to well records (`gse10` layout). |
| 7 | **P5 Organization** | ASCII (EBCDIC also offered) | Monthly (by 25th) | Operator master: P-5 number, name, address, status. Normalizes every operator reference. |
| 8 | **Oil & Gas Field Name & Numbers** | ASCII | Monthly (by 4th working day) | Field number → name lookup; fields are RRC's reservoir proxy and appear in every well/production record. |

Together these cover: API number, RRC lease number, well/lease names, operator, county, abstract, survey, field, formation (via completions), surface locations, horizontal wellbore geometry, permit history, completion history, well status, spud/completion/plug dates, and full 1993+ oil & gas production history.

## Phase 2 — Recommended

| Exact RRC Dataset Name | Format | Frequency | Why |
|---|---|---|---|
| **UIC Database** | ASCII (EBCDIC also offered) | Monthly (by 3rd workday) | Injection & disposal well permits |
| **Oil Well Status (26 Month W-10)** | EBCDIC | Monthly (by 27th) | Latest well tests: producing status + oil/gas/**water** test volumes |
| **Gas Well Status (26 Month G-10)** | EBCDIC | Monthly (by 27th) | Same for gas wells (deliverability, condensate, water) |
| **Certificate of Authorization P-4 Database Oil and Gas** | EBCDIC | Monthly (by 27th) | Lease→operator transfer history (operator-change alerts) |
| **Horizontal Drilling Permits** | ASCII | Monthly (3rd Monday) | Flags horizontal/lateral permits |
| **PR(P1/P2) Gas Disposition** | ASCII | Monthly (by 27th) | Gas disposition (sold/flared/vented/lease use) |
| **Oil & Gas Field Rules** | ASCII | Monthly (by 27th) | Spacing/density/allocation rules per field |
| **Historical Ledger – Statewide Oil** | EBCDIC | Monthly (by 27th) | The only source of pre-1993 oil production |
| **Historical Ledger – Statewide Gas** | EBCDIC | Monthly (by 27th) | Pre-1993 gas production |
| **Survey Layers by County** | ArcView Shape File | Twice a week | RRC's abstract/survey polygons (reconciliation vs. our OTLS data) |

## Phase 3 — Optional / on-demand

| Exact RRC Dataset Name | Format | Frequency | Note |
|---|---|---|---|
| **Drilling Permit (W1) Imaged Files** | PDF | Nightly | Deep-link from permit records, don't bulk-import |
| **Imaged Completion Files** | PDF | Nightly | Deep-link from well detail |
| **Directional Survey Applications** | PDF | Nightly | PDFs only — geometry comes from Well Layers instead |
| **Pipeline Layers by County** | ArcView Shape File | Twice a week | Midstream/takeaway context |
| **Base Layers by County** | ArcView Shape File | Twice a week | Redundant with our basemap + tx-counties |
| **All Layers by County** | ArcView Shape File | Twice a week | Bundle — use instead of individual layers if taking 3+ |
| **Production Report for Pending Leases** | CSV | Monthly (by 21st) | Newest-well production before lease assignment |
| **Oil and Gas Docket** | ASCII | Monthly (by 27th) | Hearings/enforcement |
| **P-18 Skim Oil/Condensate Report** | JSON | Monthly | Niche |
| **High Cost Gas** / **High Cost Gas (Tight Sands Only)** / **Natural Gas Policy Act** / **ST-1 Application Report** | ASCII / CSV | Monthly (by 27th) | Severance-tax incentive flags |
| **RRC Oil / ICE data** | TXT | Weekly (Mondays) | Posted oil price for the Valuation module |
| **Oil Annual Report Field Table** / **Gas Annual Report Field Table** | ASCII | Monthly (by 27th) | Annual field rollups |
| **R3 Gas Processing Plants** | JSON | Monthly | Midstream reference |
| **Boundary Ventures Site Data** | PDF | Once | Skip |

## Overlaps — do not double-import

- **Production Data Query Dump** ⊇ **Oil/Gas Ledger Dist files** ⊇ **Statewide Production Data Oil/Gas**: same production three ways. Take PDQ (CSV). District ledgers only if mid-month freshness ever matters; the EBCDIC statewide files never.
- **Full Wellbore** ⊇ **Wellbore Query Data** ⊇ **Statewide Oil/Gas Well Database** / **Oil Detail Well**: take Full Wellbore only.
- **Drilling Permit Master** has four variants — take only the **Daily File (Includes Latitudes and Longitudes)**.
- **Statewide Field Data** (EBCDIC) duplicates the ASCII field tables.

## Parsing/transformation notes

- **Fixed-width ASCII** (Full Wellbore, permits, completions, API data): positional multi-record-type layouts — parser pattern already proven in repo (`dbf900`/`daf802`/`gse10` layout docs).
- **EBCDIC** (Historical Ledgers, W-10/G-10, P-4): mainframe encoding + packed-decimal (COMP-3) — needs a decode step. Prefer ASCII/CSV/JSON variants wherever offered; only these three force EBCDIC.
- **Shapefiles** → ogr2ogr/parser → PostGIS.
- **PDQ CSV** → COPY into partitioned production tables (ADR 0003 schema).

## Not available from RRC (external sources required)

| Gap | Why | Source |
|---|---|---|
| Basin attribution | Not an RRC concept | EIA/USGS basin & play shapefiles (free) — spatial join |
| Well logs | Not published by RRC | TX BEG / University Lands (limited free); TGS, S&P/Enverus (commercial) |
| Digital directional surveys | PDF images only | Digitize, or commercial; Well Layers arcs are the free approximation |
| Well-level oil production | Texas reports oil at lease level | Allocation algorithms (we already prorate lease→well for the heat map) |
| Monthly produced-water volumes | Only test-day rates (W-10/G-10) | B3/Sourcenergy (commercial), or accept test-based |
| Formation tops / geology | Not collected | BEG, USGS, commercial |
| Mineral ownership / title | Not RRC jurisdiction | County clerk / appraisal district records, title plants |
| Pricing beyond posted WTI | Only the ICE file | EIA (free), OPIS/Platts (commercial) |
