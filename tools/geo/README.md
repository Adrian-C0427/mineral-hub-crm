# Basins, plays and formations — bundle builders

The server ships two reference bundles in `server/data/gis/` that drive the
Basin / Formation suggestions, the map's basin and play overlays and the
basin/formation filters (`server/src/domain/geoRegions.ts`,
`server/src/services/geoRegions.ts`, `GET /api/geo/*`). The scripts here rebuild
them from the public source files; nothing in the app build runs them.

## `tx-geo-regions.json.gz` — `build_geo_regions.py`

```
python3 -I tools/geo/build_geo_regions.py <downloads> client/public/data/tx-counties.geojson server/data/gis/tx-geo-regions.json.gz
```

Needs `pyshp` and `shapely` (a venv is fine). `<downloads>` holds, each in its own folder:

| folder | file(s) | source |
| --- | --- | --- |
| `epa-basins/` | `Basins_GHGRP.shp` (+ dbf/prj) | EPA Greenhouse Gas Reporting Program basin boundaries = AAPG CSD geologic provinces. A tessellation: every point of Texas lies in exactly one basin. **Primary basin layer.** |
| `eia-basins/basins.geojson` | layer 109 of EIA's U.S. energy atlas feature service, exported within the Texas envelope | EIA Sedimentary Basins (2024). Used as the independent **reference** layer for confidence, plus the Marfa Basin outline. |
| `eia-permian/` | `Permian_SubBasins_201712.shp` | EIA Permian Basin sub-basins (Delaware, Midland, Central Basin Platform, Ozona Arch, Val Verde). |
| `eia-plays/` | `ShalePlays_US_EIA_Dec2021.shp` | EIA shale play outlines (Barnett, Haynesville-Bossier, Eagle Ford, Bend, Abo-Yeso, Glorieta-Yeso, Bone Spring, Delaware, Wolfcamp, Wolfcamp-Midland, Spraberry, Tuscaloosa). |
| `usgs-delaware/`, `usgs-midland/`, `usgs-eagleford/`, `usgs-austinchalk/` | `*.geojson` assessment units | USGS NOGA assessment-unit polygons (2016–2018); dissolved per formation into the play outlines. |

Basin names are mapped to the app's vocabulary in `EPA_NAMES` / `EIA_NAMES`;
plays are dissolved per formation (`EIA_PLAYS` + the `usgs(...)` rules). The
script also computes each Texas county's area share inside every region
(`countyRegions`) so county-only records get an answer without PostGIS, and
embeds the county FIPS list. Basins with no free public polygon are listed
under `uncovered` and stay available as manual picks.

## `tx-formations.json.gz` — `build_formation_dictionary.py`

```
python3 -I tools/geo/build_formation_dictionary.py <fldtpe.txt> <work-dir> server/data/gis/tx-formations.json.gz
```

Input: RRC's "Oil & Gas Field Names & Numbers" fixed-width file (`fldtpe.txt`,
MFT bulk download; OGA040 layout — district 1-3, field number 4-11, county
code 12-14, class 16-20, name 21-52). The reservoir token is the field name's
last parenthetical; `normalize()` strips depth and bench suffixes, rock-type
words and the abbreviations in `ABBR`, so "WILCOX 9200", "WILCOX, A-1" and
"WILCOX SAND" all map to Wilcox. Tokens that are a depth or a rock type alone
("5500", "CONGL.") are deliberately left unmapped — they name no formation.

Outputs in `<work-dir>`: `formation-dictionary.json` (full mapping + the generic
groups), `formation-dictionary-review.csv` (every formation with fewer than 5
field-reservoirs — the long tail worth a human look) and
`county-formations.json`. The gz bundle carries the token map, the formation
list with record counts and the per-county counts (county code = 3-digit FIPS).

After rebuilding either bundle, boot reloads what changed: the regions table is
versioned by content hash and the abstract shares are recomputed per county
(`services/geoRegions.ts`).
