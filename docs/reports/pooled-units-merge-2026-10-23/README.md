# Leon pooled units — merge of the QGIS package (2026-10-23)

**What changed.** The map's pooled-unit bundle grew from 102 to 139 units, and two overlays were added.

| | Before | After |
|---|---|---|
| Pooled units | 102 (86 Leon + 16 Freestone) | **139** (123 Leon + 16 Freestone) |
| W-1 laterals (plat coordinates) | — | 46 Leon wells: surface, penetration / first take, bottom hole, lateral lines |
| Lease tracts crossed but not pooled | — | 9 |

**Source.** `~/Desktop/Leon-Units-Map` (a QGIS package: 119 Leon units traced from the operators' unit plats and tied to the georeferenced well plats, ±25–30 ft; W-1 laterals from the permits' printed coordinates; lease tracts from the well plats). Built by the same method as ours and, for the 82 units both had, placed within 50 ft of ours for 65 and within 200 ft for the rest.

**Decisions (every one backed by `verification.md`):**
- Kept every unit the app already had, including the 16 Freestone units and Navasot that the package lacks.
- Added the 37 Leon units only the package had, all verified for position against RRC laterals, survey polygons and (for the two that resisted) road, railroad and river geometry.
- **Dubayah**: replaced by the package's amended 9/02/2026 outline (704 ac; ours was the original 305.3 ac).
- **Neyland Gas**: kept ours (619.588 ac, the plats on the May and August 2026 permits); the package's 502.5-ac outline is an older subset.
- **Rockin BL Holdings** and **Hodges**: the package's 628.74-ac (2024) Rockin BL and its Hodges A (2025) are different units from ours, each crossed by its own well's lateral — both kept, Rockin BL labelled by plat year.
- Acreage notes stay on List, Morgan, Noey, Hallowed Ground, Williams Heirs and JBC Ranch (the plats draw a little more or less than they call); the map follows the drawing and says so on the panel.
- **Whitaker 1H (Mitsui)**: position confirmed (the well's lateral lies entirely inside; the W-1 and the plat's tract table both say 463.80 ac) but the package outline measures about 11% more — shipped with that note on the panel; the outline still needs re-tracing from its plat (which carries exact NAD27 coordinates).
- Zero-area slivers were dropped from 28 multipart polygons; every unit was recoloured so touching units never share a palette colour.

**Build.** `~/rrc-data/unit-plats/tools/merge_qgis_package.py <repo> <package data dir>` writes `server/data/rrc/tx-pooled-units.json.gz`, `tx-w1-laterals.json.gz` and `tx-lease-tracts.json.gz`. The verification scripts (`verify2.py`–`verify4.py`) live beside it.

**Still open** (from `~/rrc-data/unit-plats/OPEN-UNITS.md`): Carr-Navasot, Gresham Trust Unit A, Pickens "B", and the 2006–2012 units (Little 4 Ranch, A.D. Carr "A", Chaney J., McMurrey-State) — no placeable plat yet.
