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

## Not yet used

`wlf607.ebc` (well filing ledger) and the daily W-2/G-1 completion-packet
zips (`documents_*/{district}/trackingNo_*/packetData_*.dat`, `{`-delimited)
were part of the same RRC drop but aren't consumed by this pipeline yet. The
completion packets contain casing/perforation/formation detail per filing if
deeper well data is ever needed.
