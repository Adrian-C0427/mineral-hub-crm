# Pooled-unit outlines from RRC permit plats

Offline builder for `server/data/rrc/tx-pooled-units.json.gz`, which the map serves at `GET /api/gis/units` as the toggleable **Pooled units** layer. Method, checks and the latest results: `docs/reports/pooled-units-2026-10-20/`.

**Input.** The plat files (PDF/TIF attachments of RRC drilling permits) go in `~/rrc-data/unit-plats/plats/`. They are named `<county>-<seq>_<LEASE>_<well>_permit<no>_<rrcId>_<original name>`. Work files go in `~/rrc-data/unit-plats/work/`. Keep bulk data out of Desktop/Documents (iCloud eviction).

**Setup.** macOS only: text reading uses the built-in Vision framework.
```
python3 -m venv ~/rrc-data/unit-plats/.venv
~/rrc-data/unit-plats/.venv/bin/pip install -r requirements.txt
swiftc -O -o ~/rrc-data/unit-plats/tools/ocr ocr.swift
cp server/data/rrc/tx-rrc-abstracts.json.gz ~/rrc-data/unit-plats/work/   # survey lines for the placement check
```

NAD27→NAD83 (`datum.py`) is fitted once from RRC's Freestone/Leon well layers (`~/rrc-data/2026-10/well161.zip`, `well289.zip`) and saved to `work/datum_shift.json`; later runs only need that file.

**Run.** From this folder, with the venv's python and `-I`:

| Step | Does |
|---|---|
| `stage1_ocr.py` | Render every plat (300 dpi) and read its text |
| `stage2_scan.py` | Read SHL/PP/BHL coordinates, scale and unit labels; place each well-location plat (`georef.py` + `survey_check.py`) |
| `old_plats.py <wells bundle>` | Older scanned plats (2006-2012, one printed point): place from the printed surface location by matching RRC's survey lines (`survey_register.py` helpers) → `work/old_place.json` |
| `stage3_units.py <wells bundle>` | Trace each unit plat (`outline3.py`), line it up on its well's placed plat (`register.py`) and check it against the unit plat's own survey lines and survey names (`abstract_check.py`); outlines drawn on placed older plats |
| `stage3b_vector.py <wells bundle>` | Mitsui/Bowman vector plats: place from the drawn red path (`vector_place.py`), trace the heavy dashed outline |
| `stage4_bundle.py <wells bundle> <out.json.gz>` | Checks (`fit_sharpness.py`), de-duplicate, NAD83 (`datum.py`), write the bundle |
| `stage5_overlays.py` | Draw every published outline back onto its plat for review (`work/qa/sheet_*.jpg`) |
| `stage6_report.py <wells bundle>` | Print the report tables (published units, what could not be placed, what failed and why) |

Review every overlay sheet before shipping a new bundle. For the older plats also draw RRC's survey lines through each accepted placement and check they follow the plat's drawn survey lines (a placement can lock onto the sheet border; `old_plats.frame_free` removes it).
