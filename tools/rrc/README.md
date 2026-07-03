# RRC statewide bulk-data pipeline

Fills operator / lease / production-join / formation gaps in the county well
layers (`client/public/data/{county}-wells.geojson`) from the Texas Railroad
Commission's statewide bulk datasets. This is how the 2026-07 enrichment of
Leon + Freestone was produced; adding a county or refreshing from newer RRC
drops is a re-run with different arguments.

Python 3.9+, stdlib only.

## Input files (multi-GB, gitignored — keep them out of the repo)

| File | RRC dataset | Format |
|---|---|---|
| `dbf900.ebc` | Wellbore Master (every API statewide) | EBCDIC cp037, fixed 247-byte records |
| `daf802.txt` | Drilling Permit (DA) Master | ASCII lines |
| `gse10.ebc` | G-10 gas-well test file | EBCDIC cp037, fixed 130-byte records |

All three are downloadable from the RRC's "Digital Map Data / Bulk Data"
distribution. Record layouts (empirically verified against PDQ-enriched
wells) are documented in each script's docstring.

## Pipeline

```sh
cd tools/rrc && mkdir -p work

# 1. cut the two counties out of the 6.5 GB wellbore master (~20 s)
python3 extract_dbf900.py /path/to/dbf900.ebc work/dbf900_extract.txt --counties 161 289

# 2. parse to per-API enrichment; --validate checks the field offsets
#    against wells that already have PDQ data (expect oilGas ~99%,
#    lease ~75% — the misses are recompletions where dbf900 is NEWER)
python3 parse_dbf900.py work/dbf900_extract.txt work/dbf900_parsed.json \
    --validate ../../client/public/data/freestone-wells.geojson

# 3. permits (operator at permit time + statewide operatorNo->name dict)
python3 parse_daf802.py /path/to/daf802.txt work/daf802 --counties 161 289

# 4. current gas-lease operators
python3 parse_gse10.py /path/to/gse10.ebc work/gse10_ops.json

# 5. fill the gaps (loops to a fixed point; idempotent on re-runs;
#    prints per-county before/after coverage)
python3 enrich_wells.py --data-dir ../../client/public/data --work-dir work \
    --counties leon freestone
```

County codes: RRC 3-digit API county codes (Freestone 161, Leon 289 — note
these are RRC codes, not FIPS).

## Source-trust notes

- **gse10 operators are current** — validated 100% (888/888) against PDQ
  operators on the initial import. Best statewide answer for a gas well.
- **daf802 permit operators are historic** (operator at permit time). That is
  the *correct* thing to display for permitted locations and old dry holes,
  but never overrides a current source — the enrichment waterfall in
  `enrich_wells.py` encodes the precedence.
- **dbf900 completion records (type 02) list every recompletion**; the last
  one is the current lease. `enrich_wells.py` uses this for the
  "lease-currency fix": if dbf900's lease has strictly newer production than
  the joined one, the well is re-pointed and its stale lease-level cums are
  cleared.
- Wells with no API number at all (blank `api8`, ~875 in Freestone / ~440 in
  Leon, mostly pre-1960s dry holes) cannot be joined to anything.

## Phase B (2026-07): PostGIS is now the destination

Raw RRC files live in `~/rrc-data` (NEVER inside the repo — see the
gitignore). The full 12-county pipeline (outputs land in `work12/`,
gitignored):

```sh
cd tools/rrc && mkdir -p work12/data
C="001 005 073 161 225 289 293 313 365 395 405 419"   # RRC county codes

python3 extract_dbf900.py ~/rrc-data/dbf900.ebc work12/dbf900_extract.txt --counties $C
python3 parse_dbf900.py work12/dbf900_extract.txt work12/dbf900_parsed.json
python3 parse_daf802.py ~/rrc-data/documents_20260702-4/daf802.txt work12/daf802 --counties $C
python3 parse_daf802_full.py ~/rrc-data/documents_20260702-4/daf802.txt work12/daf802_full.json --counties $C
python3 parse_gse10.py ~/rrc-data/documents_20260702-2/gse10.ebc work12/gse10_ops.json
# per county: shapefile bundle -> raw wells/wellbores geojson (NAD83)
python3 build_wells.py ~/rrc-data/documents_20260703/Shp365.zip 365 "Panola" work12/data   # … x12
python3 enrich_wells.py --data-dir work12/data --work-dir work12 --counties leon freestone … shelby
python3 parse_completions.py work12/completions.json --counties $C \
    --zip-dirs ~/rrc-data/documents_20260702-3 ~/rrc-data/documents_20260703-3

cd ../../server   # then load Neon/PostGIS:
npx tsx src/scripts/importRrcRef.ts         # B1 rrc.fields + rrc.operators (statewide)
npx tsx src/scripts/importRrcWells.ts       # B2 rrc.wells + rrc.wellbores (+ abstract spatial join)
npx tsx src/scripts/importRrcRegulatory.ts  # B3/B4 rrc.permits + rrc.completions
```

The map serves wells/wellbores as extra layers in the cadastral vector tiles
(`/api/gis/tiles`), gated to z≥9/z≥10; detail/search/filters come from
`/api/gis/wells/*` and `/api/gis/options`.

`build_wells.py` notes: surface points use the dbf NAD83 attrs (shp geometry
is NAD27); laterals are shp polylines shifted per line by the surface well's
NAD83−NAD27 delta; BOTTOM_ID keys laterals (multi-lateral surfaces exist);
the SYMNUM→symbol/type/status map was recovered empirically from the enriched
Leon/Freestone data.

## Not yet used

`wlf100.ebc`/`wlf607.ebc` (well status test files) aren't consumed yet; the
completion packets also carry casing/perforation detail beyond what
parse_completions.py extracts.
