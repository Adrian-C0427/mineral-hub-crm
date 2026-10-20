# Pooled units from operators' RRC permit plats: Comstock + Mitsui (2026-10-20, second pass)

Mineral Hub's map has a **Pooled units** layer that can be switched on and off.

- **What it shows:** each pooled unit's outline as the operator's surveyor drew it on the plat filed with the RRC drilling permit (W-1 attachment).
- **This release:** **102 units** (98 Comstock, 4 Mitsui). The first release (PR #293) had 74.
- **Coverage:** 53 of the 89 Comstock/Mitsui wells in Leon and Freestone have at least one of their units shown (was 36).

Built offline by the pipeline in `tools/rrc/units/` from the 269 plat files, and shipped as `server/data/rrc/tx-pooled-units.json.gz`. No database changes.

## What changed since the first release

**Corrections to units that were already on the map.** A new check, the survey names (below), and a closer look at the unit plats' orientation found four units in the first release that were placed wrong. A near-symmetric outline can fit its well plat just as well turned 90-180 degrees or shifted onto a neighbour:

| Unit | In the first release | Now |
|---|---|---|
| Hughes Unit | lined up upside down, ~3,700 ft from where the plat draws it | moved: now sits on the plat's own Hughes Unit boundary |
| Killough Unit | did not follow any boundary the well plat draws | removed |
| Morris Lazy K Ranch Unit | turned 91 degrees; followed nothing on the plat | removed |
| Willingham Deep Unit | lined up upside down (a rectangle, so it covered the same ground) | re-placed the right way up; footprint unchanged |

The first release's Hill Unit (648.489 ac) is now listed as Hill Unit 657.953 ac (the newer plat's call for the same outline, 97% overlap) with all three Holt wells.

**New units.** 31 more units, from four fixes:

- **Well plats that couldn't be placed before.** The first release listed 20 well-location plats it couldn't place; 11 remain. The fixes:
  - plats that print the surface location twice (X/Y and latitude/longitude) are tried both ways;
  - plats whose text runs sideways are read upright;
  - control points the plat prints without a label are recovered.

  Every one still has to pass the survey-line check.
- **Size checks.** A unit whose drawing measures 2.5-15% away from its called acres is published when the trace is shown to cover the whole drawn boundary (at least 95% of the unit's own marking). The map then follows the drawing and the unit panel says so. 18 units carry this note, including BAKER 101H (+7.2%, Mitsui). A scale sweep confirmed the size: for 14 of the 18 noted unit plats checked, the outline fits its well plat best at exactly the printed scale, so the difference is in the drawing, not in our scaling.
- **Mitsui vector plats.** O. HENSON 1H is now placed and traced.
- **Older scanned plats (2006-2012).** These print only one surveyed point, the surface location.
  - **Method.** The plat is anchored on that printed point (or RRC's, when the text doesn't scan) at its stated scale. It is then turned until RRC's survey lines fall on the plat's drawn survey lines.
  - **Acceptance:** at least 50% of RRC's lines within 30 ft, and 1.6x better than any nudged or turned placement. Where the plat prints a proposed bottom hole, it must land on a drawn marker within 30 ft.
  - **Results:** 10 of 31 placed. Navasot 2's printed bottom hole lands 22 ft from its marker, an independent confirmation. Navasot Unit (983 ac) is published: two separate Navasot plats both measure it within 1.6% of RRC's W-1 acres.

**New checks** on every lined-up unit plat. The unit plat itself is now georeferenced through its placement, so it can be checked directly:

1. **Survey lines on the unit plat.** RRC's survey lines must fall on the unit plat's own drawn survey lines: sharpness at least 1.15, or 1.10 with a 60% fit at an expected orientation, unless the outline sits on the well plat's drawing almost everywhere (at least 75% within ~10 ft).
2. **Survey names.** The labels the unit plat prints ("D. Frisman Survey, A-267") must land inside RRC's polygon for that abstract number, for at least half of the labels that can be checked. Labels more than 25,000 ft from their abstract are another county's survey or a misread, and are not counted.
3. **Orientation.** Unit plats are drawn grid-north-up or in their well plat's frame. A fit far from both is re-tried at both, and whichever passes the checks above is used.

A unit name printed in a callout outside the unit (Hughes) no longer counts against a placement that these checks confirm.

## How a unit gets on the map

Nothing is drawn by hand or estimated.

- **Outline.** Traced from the plat itself: the colored hatched boundary (JDS plats), the heavy black dashed boundary (Bowman/Mitsui), or the red dashed boundary (older Stanger plats). It is then moved inward to the line's centerline.
- **Placement.**
  - Well-location plats: fitted from the three surveyed points printed on them (surface location, first take point, bottom hole), in NAD27 State Plane.
  - Older scanned plats: from the printed surface location plus RRC's survey lines.
  - Unit plats, which carry no coordinates: lined up on their well's placed plat.
- **Conversion to the map.** NAD27 to NAD83 uses RRC's own conversion, fitted from 8,000+ wells (0.07 ft median).

**Placement checks.**

1. All three points sit on drawn markers, within 25 ft, with the well path drawn between them.
2. RRC's survey/abstract lines, projected through the placement, land on the plat's own drawn survey lines decisively: at least 50% within 30 ft and 1.4x better than nudged 300 ft or turned 2 degrees (or 35% at 1.5x).
3. A sub-foot fit alone is never trusted; on most Comstock wells the three points sit nearly on one line.

**Unit plat checks.**

1. **Shape:** the outline matches the well plat's drawing, with at least 60% of the edge within ~10 ft, or a sharp partial fit.
2. **Unit plat's own survey lines and names:** both checks above.
3. **Size:** within 2.5% of the called acres, or within 15% with a complete trace (published with a note).

**Older-plat units.**

- within 2.5% of RRC's W-1 unit acres, with no allowance;
- the well's drawn surface location inside the outline;
- the plat's survey names consistent.

**Independent checks on the result.**

- **Surface locations.** The 48 coordinate-placed plats' printed surface locations match RRC's own to a median of 0.2 ft (90th percentile 0.5 ft).
- **Well paths.** 119 of 130 unit-well pairs have the well's RRC path crossing or touching the unit. The other 11 are neighbouring units the plat also shows (100-700 ft away), which is why the map panel says "Shown on the permit plat for...".
- **Visual review.** Every published outline was drawn back onto its plat and reviewed by eye (`work/qa/` in the pipeline folder). For the older plats, RRC's survey lines were also drawn through every accepted placement. That review caught a placement that had locked onto the sheet border (Gresham Trust #3); the border is now removed before matching.

**On the map**, each unit is drawn in its own color (outline, light fill and label), picked from an 8-color palette so that no two touching or overlapping units share one. The unit's panel shows the same color.

Where the same unit appears on several wells' plats, it is published once: outlines overlapping at least 80%, with called acres within 2%, are one unit, and all their wells are listed.

## Units on the map

| Unit | Operator | County | Called acres | Mapped | How placed | Shown on the plat for |
|---|---|---|---|---|---|---|
| Abe Jones "A" Unit | Comstock | Freestone | 694.0 | -1.05% | unit plat lined up on the well plat | DOLLIE JONES RP 1H |
| Adams Unit | Comstock | Leon | 546.76 | +0.03% | unit plat lined up on the well plat | SEABERG OTA 1H |
| Alford Unit | Comstock | Leon | 669.07 | -0.03% | unit plat lined up on the well plat | JENNINGS FSRA 1H |
| Armstrong Unit | Comstock | Leon | 703.25 | -1.64% | unit plat lined up on the well plat | JONES LA 1H |
| Baker 101h Unit | Mitsui | Freestone | 742.65 | +7.23% (drawing differs from called acres) | drawn on the well plat | BAKER 101H |
| Beddingfield Unit | Comstock | Leon | 517.975 | -1.98% | unit plat lined up on the well plat | MILES BM 1H |
| Bell Unit | Comstock | Leon | 618.274 | +1.32% | unit plat lined up on the well plat | BELL MEYER 1H |
| Blackburn Unit | Comstock | Leon | 700.0 | -1.16% | unit plat lined up on the well plat | BROWN TRUEHEART BB 1H, BROWN TRUEHEART W 1H |
| Blackmar Gas Unit | Comstock | Leon | 636.3727 | -1.38% | unit plat lined up on the well plat | NEYLAND BG 1H |
| Brown Trueheart A Unit | Comstock | Leon | 640.0 | +2.46% | unit plat lined up on the well plat | BROWN TRUEHEART W 1H, LOTSPEICH BJ 1H |
| Buckingham Unit | Comstock | Freestone | 470.793 | -6.03% (drawing differs from called acres) | unit plat lined up on the well plat | KRETZSCHMAR PBH 1H |
| Buckview Unit | Comstock | Leon | 701.989 | -0.52% | unit plat lined up on the well plat | KIKER BK 1H |
| Burroughs Unit | Comstock | Leon | 521.6 | +2.10% | unit plat lined up on the well plat | POLLARD MBK 1H |
| Carper Gas Unit | Comstock | Leon | 700.089 | -0.22% | unit plat lined up on the well plat | LANIER CW 1H |
| Carrington Unit | Comstock | Leon | 672.76 | +0.15% | unit plat lined up on the well plat | WINN CR 1H |
| Choctaw Unit | Comstock | Leon | 704.0 | +0.75% | drawn on the well plat | DANFORD CS 1H |
| Cravey Unit | Comstock | Leon | 697.451 | +1.23% | unit plat lined up on the well plat | HUGHES SC 1H |
| D.B. Grayson Deep Unit | Comstock | Leon | 664.45 | -1.72% | unit plat lined up on the well plat | POLLARD TFG 1H |
| Danford Unit | Comstock | Leon | 507.16 | -0.55% | unit plat lined up on the well plat | DANFORD CS 1H |
| Deornellas Unit | Comstock | Leon | 700.467 | -0.85% | unit plat lined up on the well plat | DEORNELLAS PB A 1H, DEORNELLAS PB B 2H |
| Dollie Jones Gas Unit | Comstock | Freestone | 542.48 | +0.37% | unit plat lined up on the well plat | DOLLIE JONES RP 1H |
| Dubayah Unit | Comstock | Leon | 305.3 | +4.21% (drawing differs from called acres) | unit plat lined up on the well plat | FARLEY GD 1H |
| Dynegy "C" Gas Unit | Comstock | Freestone | 643.766 | -0.89% | unit plat lined up on the well plat | WEAVER DK 1H |
| Eva Lanier Gas Unit | Comstock | Leon | 701.4459 | -0.29% | unit plat lined up on the well plat | LANIER CW 1H |
| Evans Unit | Comstock | Leon | 492.96 | +0.91% | unit plat lined up on the well plat | SEABERG ES 1H |
| Farley Unit | Comstock | Leon | 403.367 | -1.40% | drawn on the well plat | FARLEY GD 1H, HAYNIE FD 1H |
| Fender Unit | Comstock | Leon | 553.976 | -1.98% | unit plat lined up on the well plat | POLLARD TFG 1H |
| Ferguson Unit | Comstock | Leon | 618.209 | -0.92% | unit plat lined up on the well plat | JENNINGS FSRA 1H |
| Glass Unit | Comstock | Leon | 560.0 | +1.47% | unit plat lined up on the well plat | GLASS KG 1H, GLASS RT 1H |
| Grace Gas Unit | Comstock | Leon | 667.768 | +2.00% | unit plat lined up on the well plat | NEYLAND BG 1H |
| Gragg Unit | Comstock | Leon | 435.121 | -1.28% | unit plat lined up on the well plat | STROUD GV 1H |
| Grimes Unit | Comstock | Leon | 111.7775 | +3.86% (drawing differs from called acres) | unit plat lined up on the well plat | KIKER BK 1H |
| Haynie Gas Unit | Comstock | Leon | 570.4778 | +5.23% (drawing differs from called acres) | unit plat lined up on the well plat | FARLEY HG 1H |
| Hegward "A" Deep Unit | Comstock | Freestone | 694.0 | -1.13% | unit plat lined up on the well plat | HEGWARD STEBBINS 1H |
| Hill Unit | Comstock | Leon | 657.953 | -3.36% (drawing differs from called acres) | unit plat lined up on the well plat | HOLT MH C 3H, HOLT MHP 1H, HOLT MHP B 2H |
| Hodges Gas Unit | Comstock | Leon | 702.495 | -2.82% (drawing differs from called acres) | unit plat lined up on the well plat | NEYLAND MMM 1H |
| Hodges Unit | Comstock | Leon | 583.878 | -0.98% | unit plat lined up on the well plat | HODGES RLT 1H |
| Hogue Unit | Comstock | Leon | 691.654 | -2.62% (drawing differs from called acres) | unit plat lined up on the well plat | HOGUE MMP 1H |
| Holloway A Unit | Comstock | Freestone | 699.74 | -1.49% | unit plat lined up on the well plat | KRETZSCHMAR PBH 1H |
| Holt Unit | Comstock | Leon | 652.925 | +3.59% (drawing differs from called acres) | unit plat lined up on the well plat | HOLT MH C 3H, HOLT MHP 1H, HOLT MHP B 2H |
| Hughes Unit | Comstock | Leon | 663.563 | -2.42% | unit plat lined up on the well plat | HUGHES SC 1H |
| Hutto Unit | Comstock | Leon | 690.242 | -2.59% (drawing differs from called acres) | unit plat lined up on the well plat | HUTTO RODELL 1H, HUTTO TMM 1H |
| Jensen Deep Gas Unit | Comstock | Leon | 370.029 | -0.48% | unit plat lined up on the well plat | JENSEN WW 1H |
| Jones Unit | Comstock | Leon | 701.101 | -0.17% | unit plat lined up on the well plat | JONES LA 1H, LOTSPEICH BJ 1H |
| Judice Unit | Comstock | Leon | 589.586 | +1.52% | unit plat lined up on the well plat | LOTSPEICH BJ 1H |
| Kern Gas Unit | Comstock | Leon | 619.038 | -1.38% | unit plat lined up on the well plat | KERN NWS 1H, KERN PP 1H |
| Ketchey Unit | Comstock | Leon | 679.2585 | +0.33% | unit plat lined up on the well plat | KIKER BK 1H |
| Kiker Unit | Comstock | Leon | 635.009 | -1.33% | unit plat lined up on the well plat | KIKER BK 1H, KIKER BK B 2H |
| King Cobra Unit | Comstock | Leon | 501.95 | -1.98% | unit plat lined up on the well plat | GLASS KG 1H |
| Knowles "A" Gas Unit | Comstock | Freestone | 700.0 | -0.79% | unit plat lined up on the well plat | WEAVER DK 1H |
| Kretzschmar Unit | Comstock | Freestone | 356.756 | +0.81% | unit plat lined up on the well plat | KRETZSCHMAR PBH 1H, KRETZSCHMAR PP 1H |
| Lipsey 1H Unit | Mitsui | Freestone | 774.2 | +0.35% | drawn on the well plat | LIPSEY 1H |
| Lipsey A 2H Unit | Mitsui | Freestone | 679.0 | +0.06% | drawn on the well plat | LIPSEY A 2H |
| Lotspeich Unit | Comstock | Leon | 703.728 | -1.05% | unit plat lined up on the well plat | JONES LA 1H, LOTSPEICH BJ 1H |
| Louetta Parker A Unit | Comstock | Freestone | 702.0 | -1.81% | unit plat lined up on the well plat | KRETZSCHMAR PP 1H |
| Machine Unit | Comstock | Leon | 648.16 | -1.03% | unit plat lined up on the well plat | HOGUE MMP 1H |
| Mcspadden Unit | Comstock | Leon | 617.17 | +5.62% (drawing differs from called acres) | unit plat lined up on the well plat | HUTTO TMM 1H |
| Meyer Unit | Comstock | Leon | 567.802 | -1.90% | unit plat lined up on the well plat | BELL MEYER 1H |
| Milstead Unit | Comstock | Leon | 697.462 | +0.84% | unit plat lined up on the well plat | WILLIAMS RM 1H |
| Milton Golie Deep Unit | Comstock | Leon | 689.25 | -0.98% | unit plat lined up on the well plat | LEON CO ALLOC 38H, MILES BM 1H |
| Mojo Unit | Comstock | Leon | 472.441 | -2.30% | unit plat lined up on the well plat | HUTTO TMM 1H |
| Moon Unit | Comstock | Leon | 629.46 | -0.53% | unit plat lined up on the well plat | HOGUE MMP 1H |
| Murff Unit | Comstock | Leon | 519.3003 | -1.35% | unit plat lined up on the well plat | HOLT MH C 3H, HOLT MHP 1H, HOLT MHP B 2H |
| Navasot Unit | Comstock | Leon | 983.0 | -0.58% | drawn on an older scanned plat (survey-line placement) | NAVASOT 1, NAVASOT 2 |
| Newsom Gas Unit | Comstock | Leon | 324.03 | -1.44% | unit plat lined up on the well plat | KERN NWS 1H |
| Neyland Gas Unit | Comstock | Leon | 597.579 | +0.38% | unit plat lined up on the well plat | NEYLAND MMM 1H |
| Neyland Gas Unit | Comstock | Leon | 619.588 | -0.20% | unit plat lined up on the well plat | NEYLAND BG 1H, NEYLAND ML 1H |
| O. Henson 1H Unit | Mitsui | Leon | 406.55 | -0.56% | drawn on the well plat | O. HENSON 1H |
| Oehler Unit | Comstock | Leon | 603.26 | -0.46% | unit plat lined up on the well plat | SEABERG OTA 1H |
| Perrenot "A" Unit | Comstock | Freestone | 700.0 | -1.65% | unit plat lined up on the well plat | DOLLIE JONES RP 1H, KRETZSCHMAR PP 1H |
| Pickens "A" Unit | Comstock | Freestone | 700.0 | -0.94% | unit plat lined up on the well plat | KRETZSCHMAR PBH 1H, OLAJUWON PICKENS 1H |
| Pilkenton Unit | Comstock | Leon | 696.399 | -0.53% | unit plat lined up on the well plat | HOGUE MMP 1H |
| Pinto Gas Unit | Comstock | Leon | 526.7532 | +1.72% | unit plat lined up on the well plat | KERN PP 1H |
| Pipes Unit | Comstock | Leon | 699.602 | -0.66% | unit plat lined up on the well plat | HOLT MHP 1H, HOLT MHP B 2H |
| Pollard Unit | Comstock | Leon | 629.06 | -6.40% (drawing differs from called acres) | unit plat lined up on the well plat | POLLARD MBK 1H, POLLARD TFG 1H |
| Powell Unit | Comstock | Leon | 665.903 | -1.47% | unit plat lined up on the well plat | POWELL BD 1H |
| Powers Unit | Comstock | Leon | 699.463 | -0.44% | unit plat lined up on the well plat | DEORNELLAS PB A 1H, DEORNELLAS PB B 2H |
| Ramsey Unit | Comstock | Leon | 626.77 | -3.52% (drawing differs from called acres) | unit plat lined up on the well plat | FARLEY HG 1H |
| Reed "C" Unit | Comstock | Freestone | 663.89 | -0.99% | unit plat lined up on the well plat | DOLLIE JONES RP 1H |
| Robinson Unit | Comstock | Leon | 693.28 | +0.61% | unit plat lined up on the well plat | WILLIAMS RM 1H |
| Rockin BL Holdings Unit | Comstock | Leon | 575.7 | -2.71% (drawing differs from called acres) | unit plat lined up on the well plat | NEYLAND MMM 1H |
| Rodell Unit | Comstock | Leon | 703.07 | -3.22% (drawing differs from called acres) | unit plat lined up on the well plat | HUTTO RODELL 1H |
| Salty Rock Unit | Comstock | Leon | 577.59 | -0.05% | unit plat lined up on the well plat | JENNINGS FSRA 1H, WINN CR 1H |
| Seaberg Unit | Comstock | Leon | 696.82 | -0.42% | unit plat lined up on the well plat | SEABERG ES 1H, SEABERG OTA 1H |
| Severs Gas Unit | Comstock | Leon | 655.076 | -2.06% | unit plat lined up on the well plat | KERN NWS 1H |
| Smith Unit | Comstock | Leon | 472.288 | -2.30% | unit plat lined up on the well plat | WINN CR 1H |
| Stone Unit | Comstock | Leon | 472.818 | -3.08% (drawing differs from called acres) | unit plat lined up on the well plat | SEABERG ES 1H |
| Stroud Unit | Comstock | Leon | 656.16 | -0.20% | unit plat lined up on the well plat | STROUD GV 1H |
| Tange Unit | Comstock | Leon | 573.731 | +0.23% | unit plat lined up on the well plat | POLLARD TFG 1H |
| Thompson Unit | Comstock | Leon | 321.27 | -1.03% | unit plat lined up on the well plat | SEABERG OTA 1H |
| Tipps Unit | Comstock | Leon | 276.7 | -14.53% (drawing differs from called acres) | unit plat lined up on the well plat | HUTTO TMM 1H |
| Trammell Gas Unit | Comstock | Leon | 704.0 | +0.21% | unit plat lined up on the well plat | GLASS RT 1H, HAYNIE FD 1H |
| Trefry Unit | Comstock | Leon | 572.345 | -0.60% | unit plat lined up on the well plat | HODGES RLT 1H |
| Vannatta Unit | Comstock | Leon | 399.25 | -0.08% | unit plat lined up on the well plat | STROUD GV 1H |
| Walker Deep Unit | Comstock | Leon | 771.275 | -2.20% | unit plat lined up on the well plat | JENSEN WW 1H |
| Wandell Gas Unit | Comstock | Leon | 561.84485 | -0.60% | unit plat lined up on the well plat | KERN NWS 1H |
| Weaver Gas Unit | Comstock | Freestone | 492.15 | -4.31% (drawing differs from called acres) | unit plat lined up on the well plat | WEAVER DK 1H |
| Whitaker Unit | Comstock | Leon | 607.849 | -1.91% | unit plat lined up on the well plat | BROWN TRUEHEART W 1H |
| Williams Unit | Comstock | Leon | 694.2134 | +0.12% | unit plat lined up on the well plat | WILLIAMS RM 1H |
| Willingham Deep Unit | Comstock | Leon | 225.708 | +0.02% | unit plat lined up on the well plat | JENSEN WW 1H |
| Winn Gas Unit | Comstock | Leon | 704.0 | -0.12% | unit plat lined up on the well plat | LANIER CW 1H |
| Winn Unit | Comstock | Leon | 343.439 | -1.29% | unit plat lined up on the well plat | WINN CR 1H |

Mapped area vs called acres: median 1.16%; 84 of 102 within 2.5%; the other 18 carry a drawn-vs-called note (worst 14.5%).

## Not on the map (and why)

### Well-location plats that could not be placed

Their unit plats have nothing to be lined up against. Some of their units still appear through a neighbouring well's plat. Also:

- NEYLAND ML 1H: no coordinates could be read.
- JBC RANCH 1H (Mitsui): placed, but its heavy dashed outline doesn't close near the first take point, so no outline is published rather than guessing the gap.

| Well | Plat | Why |
|---|---|---|
| DINKINS JG 1H (42-289-32180) | Dinkins JG #1H well loc plat.pdf | a control point isn't on a detected marker and the survey lines don't confirm it strongly |
| HARRISON WA 1H (42-289-32185) | Harrison WA 1H well loc plat.pdf | RRC survey lines don't line up with the plat's (best 36%, sharpness 1.38) |
| MENN PB 21H (42-289-32196) | 901796_Plat_Revised.pdf | RRC survey lines don't line up with the plat's (best 30%, sharpness 1.05) |
| BROWN TRUEHEART W 1H (42-289-32202) | 905823 Brown Trueheart W #1H as drld plat.pdf | RRC survey lines don't line up with the plat's (best 31%, sharpness 0.97) |
| BROWN TRUEHEART BB 1H (42-289-32203) | Brown Trueheart BB 1H well loc plat.pdf | only two control points printed (no independent check) |
| BUMPURS NMH 1H (42-289-32205) | 906897 Bumpurs NMH 1H rev well loc plat.pdf | RRC survey lines don't line up with the plat's (best 42%, sharpness 1.21) |
| BUMPURS NMH 1H (42-289-32205) | Bumpurs NMH #1H as drld plat.pdf | RRC survey lines don't line up with the plat's (best 45%, sharpness 0.96) |
| BUMPURS BHGJ 1H (42-289-32206) | Bumpurs BHGJ #1H as drld plat.pdf | RRC survey lines don't line up with the plat's (best 41%, sharpness 1.17) |
| WHITAKER 1H (42-289-32207) | Whitaker final plat.pdf | RRC survey lines don't line up with the plat's (best 34%, sharpness 1.14) |
| ERICSON KN 1H (42-289-32210) | 908119 Ericson KN #1H as drld plat.pdf | RRC survey lines don't line up with the plat's (best 40%, sharpness 1.19) |
| KIKER BK B 2H (42-289-32218) | Kiker BK B 2H well loc plat.pdf | RRC survey lines don't line up with the plat's (best 42%, sharpness 1.17) |

### Older scanned plats (2006-2012) that could not be placed

The bar for these is stricter than for coordinate plats: one printed point is a weaker anchor. Three more were placed but print no colored unit outline (Amanda Rose Unit 1, Little 4 Ranch 1 and 3, all black-and-white). Little 4 Ranch 5 misses the survey bar by a hair (49.7%).

| Well | Plat | Why |
|---|---|---|
| CHANEY J. UNIT 1 (42-289-31726) | plat chaney, j unit #1.tif | survey lines 21%, sharpness 1.25 |
| CARR A. D. A 1 (42-289-31727) | carr 1 revised plat.tif | survey lines 34%, sharpness 1.50; printed bottom hole lands 214 ft from the nearest drawn marker |
| CARR A. D. A 2 (42-289-31779) | A.D. CARR A #2 PLAT.TIF | survey lines 21%, sharpness 1.39 |
| A. D. CARR A 6 (42-289-31793) | A. D. Carr A #6.tif | survey lines 19%, sharpness 1.18 |
| LITTLE 4 RANCH 2 (42-289-31807) | LITTLE 4 RANCH 2 PLAT.TIF | survey lines 33%, sharpness 1.65 |
| LITTLE 4 RANCH 5 (42-289-31808) | LITTLE 4 RANCH 5 PLAT.TIF | survey lines 50%, sharpness 3.13 |
| A. D. CARR A 5 (42-289-31836) | A. D. CARR A 5 PERMIT PLAT.TIF | survey lines 19%, sharpness 1.30 |
| LITTLE 4 RANCH-STATE UNIT 1 (42-289-31845) | A.D.CARR A 7 PERMIT PLAT.TIF | survey lines 20%, sharpness 1.52 |
| CARR-NAVASOT UNIT 2 (42-289-31858) | 691764 plat(rev).tif | survey lines 39%, sharpness 1.64; printed bottom hole lands 46 ft from the nearest drawn marker |
| CARR-NAVASOT UNIT 2 (42-289-31858) | 691764 plat2(rev).tif | survey lines 34%, sharpness 1.26 |
| CARR-NAVASOT UNIT 2 (42-289-31858) | rev691764plat.tif | survey lines 47%, sharpness 1.95 |
| NCC UNIT 1 (42-289-31869) | NCC Unit #1.tif | survey lines 34%, sharpness 1.60 |
| MCMURREY-STATE UNIT 2 (42-289-31874) | 251691_McMurrey-StateUnit_2_Plat.tif | survey lines 46%, sharpness 1.61 |
| MCMURREY-STATE UNIT 3 (42-289-31877) | McMurrey-State Unit Well #3.tif | survey lines 37%, sharpness 1.43 |
| SENATOR RANCH A UNIT 1 (42-289-31887) | 251691_289_SENATORRANCHAUNIT_1_PLAT.tif | survey lines 43%, sharpness 1.71 |
| CARR-LITTLE 4 RANCH UNIT 1 (42-289-31889) | 251691_289_ADCARRA_9_PLAT.tif | survey lines 18%, sharpness 1.40 |
| GRESHAM TRUST UNIT A 1 (42-289-31917) | Gresham Trust Unit A #1 Plat.tif | survey lines 48%, sharpness 2.04 |
| SENATOR RANCH B UNIT 4 (42-289-31926) | 708703 plat(rev).tif | printed bottom hole lands 124 ft from the nearest drawn marker |
| GRESHAM TRUST 1H (42-289-31944) | Gresham Trust #1H Plat.tif | survey lines 48%, sharpness 2.07 |
| JOHN GRESHAM UNIT 1H (42-289-31986) | John Gresham Unit #1H Plat.tif | survey lines 45%, sharpness 1.57 |
| JOHN GRESHAM UNIT 2H (42-289-31987) | John Gresham Unit 2H Plat.tif | survey lines 46%, sharpness 1.72 |

### Units whose outline failed a check

| Unit | Called acres | Why |
|---|---|---|
| Brown Trueheart B Unit | 635.5 | at this placement RRC's survey lines miss the unit plat's own (21%, sharpness 1.06); at this placement the unit plat's survey names land in other surveys (1 of 3 in their own) |
| Carr-navasot Unit | 320 | mapped area -5.1% from the W-1 unit acres |
| Dubayah Unit | 704.0 | mapped area +3.0% from called acres (trace accounts for 68% of the unit's marking) |
| Gresham Trust Unit | 576.8 | mapped area -57.0% from the W-1 unit acres |
| Gresham Unit | 404.156 | mapped area +2.5% from called acres (trace accounts for 52% of the unit's marking) |
| Hodges "A" Unit | 700.0 | at this placement RRC's survey lines miss the unit plat's own (34%, sharpness 1.00); at this placement the unit plat's survey names land in other surveys (0 of 1 in their own) |
| Jennings Unit | 682.003 | at this placement RRC's survey lines miss the unit plat's own (32%, sharpness 1.10); at this placement the unit plat's survey names land in other surveys (0 of 1 in their own); outline doesn't line up decisively with the well plat (fit 31%, sharpness 1.14); unit's name label falls outside the lined-up outline |
| Killough Unit | 672.821 | at this placement RRC's survey lines miss the unit plat's own (24%, sharpness 0.96) |
| List Unit | 587.05 | outline doesn't line up decisively with the well plat (fit 48%, sharpness 1.50) |
| Morgan Gas Unit | 606.729 | at this placement RRC's survey lines miss the unit plat's own (37%, sharpness 1.08); at this placement RRC's survey lines miss the unit plat's own (38%, sharpness 1.06); at this placement the unit plat's survey names land in other surveys (1 of 5 in their own); unit's name label falls outside the lined-up outline |
| Morgan Gas Unit | 619.588 | at this placement RRC's survey lines miss the unit plat's own (35%, sharpness 0.97); at this placement the unit plat's survey names land in other surveys (0 of 9 in their own); mapped area -7.6% from called acres (trace accounts for 84% of the unit's marking); outline doesn't line up decisively with the well plat (fit 19%, sharpness 1.39); traced area -7.6% from called acres; unit's name label falls outside the lined-up outline |
| Morris Lazey K Ranch Unit | 642.514 | outline doesn't line up decisively with the well plat (fit 19%, sharpness 1.07) |
| Morris Lazy K Ranch Unit | 699.92 | at this placement RRC's survey lines miss the unit plat's own (20%, sharpness 1.13); at this placement the unit plat's survey names land in other surveys (1 of 6 in their own) |
| Olene Reagan Gas Unit NO. 1 | 704.0 | at this placement RRC's survey lines miss the unit plat's own (13%, sharpness 0.88) |
| Pickens "B Unit | 704.0 | at this placement RRC's survey lines miss the unit plat's own (25%, sharpness 0.89); at this placement the unit plat's survey names land in other surveys (1 of 7 in their own); outline doesn't line up decisively with the well plat (fit 21%, sharpness 1.59) |
| Pope Gas Unit | 624.63 | at this placement the unit plat's survey names land in other surveys (0 of 6 in their own); mapped area -97.1% from called acres; traced area -97.1% from called acres; unit's name label falls outside the lined-up outline |
| Reynolds Unit | 634.152 | mapped area -3.7% from called acres (trace accounts for 93% of the unit's marking); traced area -3.7% from called acres |
| Rockin B L Holdings Unit | 628.74 | outline doesn't line up decisively with the well plat (fit 53%, sharpness 1.54) |
| Senator Ranch A Unit | 447.99 | mapped area -97.5% from the W-1 unit acres; the well's drawn surface location is outside this outline |
| Senator Ranch B Unit | 548.7 | mapped area +11.7% from the W-1 unit acres; mapped area +12.1% from the W-1 unit acres |
| Unit Fract S | 492.96 | mapped area +3.0% from called acres (trace accounts for 80% of the unit's marking) |
| Williams Heirs Deep Gas Unit | 86.303 | at this placement RRC's survey lines miss the unit plat's own (39%, sharpness 1.04); at this placement the unit plat's survey names land in other surveys (0 of 2 in their own) |
