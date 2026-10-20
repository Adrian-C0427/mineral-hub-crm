# Pooled units from operators' RRC permit plats: Comstock + Mitsui (2026-10-20)

Mineral Hub's map gains a **Pooled units** layer that can be switched on and off.

- **What it shows:** each pooled unit's outline as the operator's surveyor drew it on the plat filed with the RRC drilling permit (W-1 attachment).
- **This release:** **74 units** (72 Comstock, 2 Mitsui).
- **Coverage:** 36 of the 89 Comstock/Mitsui wells in Leon and Freestone have at least one of their units shown.

Built offline by the pipeline in `tools/rrc/units/` from the 269 plat files, and shipped as `server/data/rrc/tx-pooled-units.json.gz`.

## How a unit gets on the map

Nothing is drawn by hand or estimated.

- **Outline.** The outline is traced from the plat itself:
  - JDS plats: the colored hatched boundary;
  - Bowman/Mitsui plats: the heavy black dashed boundary.

  The traced line is moved inward to the line's centerline.
- **Placement.** Each placement is fitted from the three surveyed points printed on the well-location plat: surface location, first take point and bottom hole, in NAD27 State Plane.
- **Conversion to the map.** Coordinates go to NAD83 with RRC's own NAD27→NAD83 conversion (fitted from 8,000+ wells, 0.07 ft median).

A placement is accepted only if all of these hold:

1. **Three markers.** All three points sit on actual drawn markers, and the worst point is within 25 ft.
2. **Drawn path.** The well path is drawn between them.
3. **Survey lines.** RRC's survey/abstract lines, projected through the placement, land on the plat's own drawn survey lines, and do so decisively:
   - ≥ 50% within 30 ft, at least 1.4× better than the same placement nudged 300 ft or turned 2°;
   - or ≥ 35% at 1.5×.

   A sub-foot fit alone is not trusted. On most Comstock wells the three points sit nearly on one line, so a wrong match can fit just as well. This check is what catches those.

A unit plat, which carries no coordinates, is lined up against the same unit on its well's placed well-location plat. It is accepted only if:

- **Shape match:** its outline matches the well plat's drawing, with ≥ 60% of the edge within ~10 ft, or a sharp partial fit (≥ 20% within ~10 ft and ≥ 1.6× better than nudged or turned);
- **Area:** both the traced and the mapped area are within 2.5% of the acres the plat calls.

Independent checks on the result:

- **Surface locations.** The plats' surveyed surface locations match RRC's own surface locations for the same wells to a median of 0.2 ft, across all 39 placed plats.
- **Well paths.** 80 of 84 unit–well pairs have the well's RRC lateral crossing or touching the unit. The other 4 are neighbouring units the plat also shows, which is why the map panel says "Shown on the permit plat for…".
- **Visual review.** Every published outline was drawn back onto its plat and reviewed by eye (`work/qa/` in the pipeline folder).

Where the same unit appears on several wells' plats, it is published once. Outlines that overlap ≥ 80% with called acres within 2% are treated as the same unit, and all their wells are listed.

## Units on the map

| Unit | Operator | County | Called acres | Mapped | How placed | Shown on the plat for |
|---|---|---|---|---|---|---|
| Adams Unit | Comstock | Leon | 546.76 | +0.03% | unit plat lined up on the well plat | SEABERG OTA 1H |
| Alford Unit | Comstock | Leon | 669.07 | -0.03% | unit plat lined up on the well plat | JENNINGS FSRA 1H |
| Armstrong Unit | Comstock | Leon | 703.25 | -1.64% | unit plat lined up on the well plat | JONES LA 1H |
| Beddingfield Unit | Comstock | Leon | 517.975 | -1.98% | unit plat lined up on the well plat | MILES BM 1H |
| Bell Unit | Comstock | Leon | 618.274 | +1.32% | unit plat lined up on the well plat | BELL MEYER 1H |
| Blackburn Unit | Comstock | Leon | 700.0 | -1.16% | unit plat lined up on the well plat | BROWN TRUEHEART W 1H |
| Blackmar Gas Unit | Comstock | Leon | 636.3727 | -1.38% | unit plat lined up on the well plat | NEYLAND BG 1H |
| Brown Trueheart A Unit | Comstock | Leon | 640.0 | +2.46% | unit plat lined up on the well plat | BROWN TRUEHEART W 1H, LOTSPEICH BJ 1H |
| Buckview Unit | Comstock | Leon | 701.989 | -0.52% | unit plat lined up on the well plat | KIKER BK 1H |
| Burroughs Unit | Comstock | Leon | 521.6 | +2.10% | unit plat lined up on the well plat | POLLARD MBK 1H |
| Carper Gas Unit | Comstock | Leon | 700.089 | -0.22% | unit plat lined up on the well plat | LANIER CW 1H |
| Choctaw Unit | Comstock | Leon | 704.0 | +0.75% | drawn on the well plat | DANFORD CS 1H |
| Cravey Unit | Comstock | Leon | 697.451 | +1.23% | unit plat lined up on the well plat | HUGHES SC 1H |
| D.B. Grayson Deep Unit | Comstock | Leon | 664.45 | -1.72% | unit plat lined up on the well plat | POLLARD TFG 1H |
| Danford Unit | Comstock | Leon | 507.16 | -0.55% | unit plat lined up on the well plat | DANFORD CS 1H |
| Deornellas Unit | Comstock | Leon | 700.467 | -0.85% | unit plat lined up on the well plat | DEORNELLAS PB A 1H, DEORNELLAS PB B 2H |
| Dollie Jones Gas Unit | Comstock | Freestone | 542.48 | +0.37% | unit plat lined up on the well plat | DOLLIE JONES RP 1H |
| Dynegy "C" Gas Unit | Comstock | Freestone | 643.766 | -0.89% | unit plat lined up on the well plat | WEAVER DK 1H |
| Eva Lanier Gas Unit | Comstock | Leon | 701.4459 | -0.29% | unit plat lined up on the well plat | LANIER CW 1H |
| Evans Unit | Comstock | Leon | 492.96 | +0.91% | unit plat lined up on the well plat | SEABERG ES 1H |
| Farley Unit | Comstock | Leon | 403.367 | -1.40% | drawn on the well plat | FARLEY GD 1H, HAYNIE FD 1H |
| Fender Unit | Comstock | Leon | 553.976 | -1.98% | unit plat lined up on the well plat | POLLARD TFG 1H |
| Ferguson Unit | Comstock | Leon | 618.209 | -0.92% | unit plat lined up on the well plat | JENNINGS FSRA 1H |
| Glass Unit | Comstock | Leon | 560.0 | +1.47% | unit plat lined up on the well plat | GLASS KG 1H |
| Grace Gas Unit | Comstock | Leon | 667.768 | +2.00% | unit plat lined up on the well plat | NEYLAND BG 1H |
| Hill Unit | Comstock | Leon | 648.489 | -1.82% | unit plat lined up on the well plat | HOLT MHP 1H |
| Hodges Unit | Comstock | Leon | 583.878 | -0.98% | unit plat lined up on the well plat | HODGES RLT 1H |
| Holloway A Unit | Comstock | Freestone | 699.74 | -1.49% | unit plat lined up on the well plat | KRETZSCHMAR PBH 1H |
| Hughes Unit | Comstock | Leon | 663.563 | -2.43% | unit plat lined up on the well plat | HUGHES SC 1H |
| Jensen Deep Gas Unit | Comstock | Leon | 370.029 | -0.48% | unit plat lined up on the well plat | JENSEN WW 1H |
| Jones Unit | Comstock | Leon | 701.101 | -0.17% | unit plat lined up on the well plat | JONES LA 1H, LOTSPEICH BJ 1H |
| Judice Unit | Comstock | Leon | 589.586 | +1.52% | unit plat lined up on the well plat | LOTSPEICH BJ 1H |
| Kern Gas Unit | Comstock | Leon | 619.038 | -1.38% | unit plat lined up on the well plat | KERN NWS 1H, KERN PP 1H |
| Ketchey Unit | Comstock | Leon | 679.2585 | +0.33% | unit plat lined up on the well plat | KIKER BK 1H |
| Kiker Unit | Comstock | Leon | 635.009 | -1.33% | unit plat lined up on the well plat | KIKER BK 1H |
| Killough Unit | Comstock | Leon | 672.821 | -0.55% | unit plat lined up on the well plat | POLLARD MBK 1H |
| Knowles "A" Gas Unit | Comstock | Freestone | 700.0 | -0.79% | unit plat lined up on the well plat | WEAVER DK 1H |
| Lipsey 1H Unit | Mitsui | Freestone | 774.2 | +0.35% | drawn on the well plat | LIPSEY 1H |
| Lipsey A 2H Unit | Mitsui | Freestone | 679.0 | +0.06% | drawn on the well plat | LIPSEY A 2H |
| Lotspeich Unit | Comstock | Leon | 703.728 | -1.05% | unit plat lined up on the well plat | JONES LA 1H, LOTSPEICH BJ 1H |
| Machine Unit | Comstock | Leon | 648.16 | -1.03% | unit plat lined up on the well plat | HOGUE MMP 1H |
| Meyer Unit | Comstock | Leon | 567.802 | -1.90% | unit plat lined up on the well plat | BELL MEYER 1H |
| Milstead Unit | Comstock | Leon | 697.462 | +0.84% | unit plat lined up on the well plat | WILLIAMS RM 1H |
| Milton Golie Deep Unit | Comstock | Leon | 689.25 | -0.98% | unit plat lined up on the well plat | LEON CO ALLOC 38H, MILES BM 1H |
| Mojo Unit | Comstock | Leon | 472.441 | -2.30% | unit plat lined up on the well plat | HUTTO TMM 1H |
| Moon Unit | Comstock | Leon | 629.46 | -0.53% | unit plat lined up on the well plat | HOGUE MMP 1H |
| Morris Lazy K Ranch Unit | Comstock | Leon | 699.92 | -0.88% | unit plat lined up on the well plat | POLLARD MBK 1H |
| Murff Unit | Comstock | Leon | 519.3003 | -1.35% | unit plat lined up on the well plat | HOLT MH C 3H, HOLT MHP 1H |
| Newsom Gas Unit | Comstock | Leon | 324.03 | -1.44% | unit plat lined up on the well plat | KERN NWS 1H |
| Neyland Gas Unit | Comstock | Leon | 619.588 | -0.20% | unit plat lined up on the well plat | NEYLAND BG 1H |
| Oehler Unit | Comstock | Leon | 603.26 | -0.46% | unit plat lined up on the well plat | SEABERG OTA 1H |
| Perrenot "A" Unit | Comstock | Freestone | 700.0 | -1.65% | unit plat lined up on the well plat | DOLLIE JONES RP 1H |
| Pickens "A" Unit | Comstock | Freestone | 700.0 | -1.00% | unit plat lined up on the well plat | KRETZSCHMAR PBH 1H |
| Pilkenton Unit | Comstock | Leon | 696.399 | -0.53% | unit plat lined up on the well plat | HOGUE MMP 1H |
| Pinto Gas Unit | Comstock | Leon | 526.7532 | +1.72% | unit plat lined up on the well plat | KERN PP 1H |
| Pipes Unit | Comstock | Leon | 699.602 | -0.66% | unit plat lined up on the well plat | HOLT MHP 1H |
| Powell Unit | Comstock | Leon | 665.903 | -1.47% | unit plat lined up on the well plat | POWELL BD 1H |
| Powers Unit | Comstock | Leon | 699.463 | -0.44% | unit plat lined up on the well plat | DEORNELLAS PB A 1H, DEORNELLAS PB B 2H |
| Reed "C" Unit | Comstock | Freestone | 663.89 | -0.99% | unit plat lined up on the well plat | DOLLIE JONES RP 1H |
| Robinson Unit | Comstock | Leon | 693.28 | +0.61% | unit plat lined up on the well plat | WILLIAMS RM 1H |
| Salty Rock Unit | Comstock | Leon | 577.59 | -0.05% | unit plat lined up on the well plat | JENNINGS FSRA 1H |
| Seaberg Unit | Comstock | Leon | 696.82 | -0.42% | unit plat lined up on the well plat | SEABERG ES 1H, SEABERG OTA 1H |
| Severs Gas Unit | Comstock | Leon | 655.076 | -2.06% | unit plat lined up on the well plat | KERN NWS 1H |
| Tange Unit | Comstock | Leon | 573.731 | +0.23% | unit plat lined up on the well plat | POLLARD TFG 1H |
| Thompson Unit | Comstock | Leon | 321.27 | -1.03% | unit plat lined up on the well plat | SEABERG OTA 1H |
| Trammell Gas Unit | Comstock | Leon | 704.0 | +0.21% | unit plat lined up on the well plat | HAYNIE FD 1H |
| Trefry Unit | Comstock | Leon | 572.345 | -0.60% | unit plat lined up on the well plat | HODGES RLT 1H |
| Walker Deep Unit | Comstock | Leon | 771.275 | -2.20% | unit plat lined up on the well plat | JENSEN WW 1H |
| Wandell Gas Unit | Comstock | Leon | 561.84485 | -0.60% | unit plat lined up on the well plat | KERN NWS 1H |
| Weaver Gas Unit | Comstock | Freestone | 492.15 | -1.97% | drawn on the well plat | WEAVER DK 1H |
| Whitaker Unit | Comstock | Leon | 607.849 | -1.91% | unit plat lined up on the well plat | BROWN TRUEHEART W 1H |
| Williams Unit | Comstock | Leon | 694.2134 | +0.12% | unit plat lined up on the well plat | WILLIAMS RM 1H |
| Willingham Deep Unit | Comstock | Leon | 225.708 | +0.02% | unit plat lined up on the well plat | JENSEN WW 1H |
| Winn Gas Unit | Comstock | Leon | 704.0 | -0.12% | unit plat lined up on the well plat | LANIER CW 1H |

Mapped area vs called acres: median 0.98%, worst 2.46%.

## Not on the map (and why)

### Wells whose well-location plat could not be placed with confidence

Their unit plats have nothing to be lined up against. Some of their units still appear through a neighbouring well's plat.

| Well | Plat | Why |
|---|---|---|
| OLAJUWON PICKENS 1H (42-161-34868) | Olajuwon_PP_1H_well_loc_plat.pdf | a control point isn't on a detected marker (no independent check) |
| KRETZSCHMAR PP 1H (42-161-34873) | Kretzschmar_PP_1H_well_loc_plat_revised_final.pdf | a control point isn't on a detected marker (no independent check) |
| GRESHAM TRUST 1H (42-289-31944) | Gresham_Trust_1H_Plat.tif | no bottom-hole coordinates read |
| DINKINS JG 1H (42-289-32180) | Dinkins_JG_1H_well_loc_plat.pdf | a control point isn't on a detected marker (no independent check) |
| NEYLAND MMM 1H (42-289-32182) | Neyland_HRM_1H_cert_well_loc_plat_revised.pdf | a control point isn't on a detected marker (no independent check) |
| HARRISON WA 1H (42-289-32185) | Harrison_WA_1H_well_loc_plat.pdf | RRC survey lines don't line up with the plat's (best 36%, sharpness 1.38) |
| MENN PB 21H (42-289-32196) | 901796_Plat_Revised.pdf | no bottom-hole coordinates read |
| HUTTO RODELL 1H (42-289-32198) | Hutto_Rodell_1H_well_loc_plat.pdf | a control point isn't on a detected marker (no independent check) |
| BROWN TRUEHEART W 1H (42-289-32202) | 905823_Brown_Trueheart_W_1H_as_drld_plat.pdf | RRC survey lines don't line up with the plat's (best 31%, sharpness 0.97) |
| BROWN TRUEHEART BB 1H (42-289-32203) | Brown_Trueheart_BB_1H_well_loc_plat.pdf | only two control points printed (no independent check) |
| O. HENSON 1H (42-289-32204) | rev906039plat.pdf | only two control points printed (no independent check) |
| BUMPURS NMH 1H (42-289-32205) | 906897_Bumpurs_NMH_1H_rev_well_loc_plat.pdf | RRC survey lines don't line up with the plat's (best 42%, sharpness 1.21) |
| BUMPURS NMH 1H (42-289-32205) | Bumpurs_NMH_1H_as_drld_plat.pdf | RRC survey lines don't line up with the plat's (best 54%, sharpness 1.10) |
| BUMPURS BHGJ 1H (42-289-32206) | Bumpurs_BHGJ_1H_as_drld_plat.pdf | RRC survey lines don't line up with the plat's (best 41%, sharpness 1.17) |
| WHITAKER 1H (42-289-32207) | Whitaker_final_plat.pdf | RRC survey lines don't line up with the plat's (best 32%, sharpness 1.17) |
| ERICSON KN 1H (42-289-32210) | 908119_Ericson_KN_1H_as_drld_plat.pdf | RRC survey lines don't line up with the plat's (best 40%, sharpness 1.19) |
| KIKER BK B 2H (42-289-32218) | Kiker_BK_B_2H_well_loc_plat.pdf | RRC survey lines don't line up with the plat's (best 42%, sharpness 1.17) |
| JBC RANCH 1H (42-289-32220) | JBC_Ranch_1H_-_no_NPZ_final.pdf | only two control points printed (no independent check) |
| WINN CR 1H (42-289-32224) | Winn_CR_1H_well_loc_plat_rev_SL.pdf | a control point isn't on a detected marker (no independent check) |
| HOLT MHP B 2H (42-289-32233) | Holt_MHP_B_2H_well_loc_plat.pdf | RRC survey lines don't line up with the plat's (best 35%, sharpness 1.07) |

- **Older scanned plats:** 29 wells, 2008–2012, mostly vertical/directional wells. Their plats are scanned images that print at most a surface and bottom-hole location close together, so there is no independent check on placement. They are left out of this release.
- **BAKER 101H (Mitsui):** placed correctly (1.6 ft, survey-line check passed). Its drawn outline measures 7% more than the 742.65 acres its tract table calls, so it fails the acreage check and is not published.

### Units whose outline failed a check

| Unit | Called acres | Plat | Why |
|---|---|---|---|
| Abe Jones "A" Unit | 694.0 | 161-34875_DOLLIE_JONES_RP_1H_permit912866_9122879_Abe_Jones_A_pooled_unit_plat.pdf | unit's name label falls outside the lined-up outline |
| Baker 101h Unit | 742.65 | 161-34869_BAKER_101H_permit904999_plat.pdf | mapped area +7.0% from called acres |
| Buckingham Unit | 470.793 | 161-34874_KRETZSCHMAR_PBH_1H_permit910665_8848107_Buckingham_pooled_unit_plat.pdf | mapped area -6.0% from called acres; traced area -6.0% from called acres |
| Dubayah Unit | 305.3 | 289-32184_FARLEY_GD_1H_permit891492_7087930_Farley_GD_1H_well_loc_plat.pdf, 289-32184_FARL | mapped area +4.2% from called acres; mapped area +5.0% from called acres; traced area +3.0% from called acres |
| Dubayah Unit | 704.0 | 289-32236_HAYNIE_FD_1H_permit918464_9827548_Haynie_FD_1H_well_loc_plat.pdf | mapped area +3.0% from called acres |
| Gresham Unit | 404.156 | 289-32184_FARLEY_GD_1H_permit891492_7087930_Farley_GD_1H_well_loc_plat.pdf | mapped area +2.5% from called acres |
| Grimes Unit | 111.7775 | 289-32214_KIKER_BK_1H_permit909381_8697518_Grimes_pooled_unit_plat.pdf | mapped area +3.9% from called acres; traced area +3.9% from called acres |
| Haynie Gas Unit | 570.4778 | 289-32237_FARLEY_HG_1H_permit918465_9826074_Haynie_unit_plat.pdf | mapped area +5.2% from called acres; traced area +5.2% from called acres |
| Hill Unit | 657.953 | 289-32232_HOLT_MH_C_3H_permit917469_9655443_Hill_pooled_unit_plat.pdf | mapped area -3.4% from called acres; traced area -3.4% from called acres |
| Hogue Unit | 691.654 | 289-32191_HOGUE_MMP_1H_permit896250_7466213_Hogue_pooled_unit_plat.pdf | mapped area -2.6% from called acres; traced area -2.6% from called acres |
| Holt Unit | 652.925 | 289-32221_HOLT_MHP_1H_permit911422_8933457_Holt_pooled_unit_plat.pdf, 289-32232_HOLT_MH_C_ | mapped area +3.6% from called acres; outline doesn't line up decisively with the well plat (fit 15%, sharpness 1.20); traced area +3.6% from called acres |
| Hutto Unit | 690.242 | 289-32200_HUTTO_TMM_1H_permit904520_8192768_Hutto_pooled_unit_plat.pdf | mapped area -2.6% from called acres; traced area -2.6% from called acres |
| Jennings Unit | 682.003 | 289-32197_JENNINGS_FSRA_1H_permit902662_8026792_Jennings_pooled_unit_plat.pdf | outline doesn't line up decisively with the well plat (fit 31%, sharpness 1.14); unit's name label falls outside the lined-up outline |
| King Cobra Unit | 501.95 |  | outline collapsed when cleaned |
| Kretzschmar Unit | 356.756 | 161-34874_KRETZSCHMAR_PBH_1H_permit910665_8848103_Kretzschmar_pooled_unit_plat.pdf | outline doesn't line up decisively with the well plat (fit 23%, sharpness 1.24) |
| List Unit | 587.05 | 289-32193_HODGES_RLT_1H_permit898780_7694603_List_pooled_unit_plat.pdf | mapped area +4.4% from called acres; outline doesn't line up decisively with the well plat (fit 48%, sharpness 1.50); traced area +4.4% from called acres |
| Mcspadden Unit | 617.17 | 289-32200_HUTTO_TMM_1H_permit904520_8192772_McSpadden_pooled_unit_plat.pdf | mapped area +5.6% from called acres; traced area +5.6% from called acres |
| Morgan Gas Unit | 606.729 | 289-32211_POLLARD_MBK_1H_permit908489_8568530_Morgan_pooled_unit_plat.pdf | mapped area -6.1% from called acres; traced area -6.1% from called acres; unit's name label falls outside the lined-up outline |
| Pollard Unit | 629.06 | 289-32208_POLLARD_TFG_1H_permit907960_8541360_Pollard_pooled_unit_plat.pdf, 289-32211_POLL | mapped area -6.4% from called acres; traced area -6.4% from called acres |
| Pope Gas Unit | 624.63 | 289-32228_KERN_PP_1H_permit914493_9330848_Pope_GU_pooled_unit_plat.pdf | mapped area -97.1% from called acres; traced area -97.1% from called acres; unit's name label falls outside the lined-up outline |
| Ramsey Unit | 626.77 | 289-32237_FARLEY_HG_1H_permit918465_9826075_Ramsey_unit_plat.pdf | mapped area -3.5% from called acres; traced area -3.5% from called acres |
| Rockin B L Holdings Unit | 628.74 | 289-32193_HODGES_RLT_1H_permit898780_7694592_Rockin_BL_Holdings_pooled_unit_plat.pdf | outline doesn't line up decisively with the well plat (fit 53%, sharpness 1.54) |
| Stone Unit | 472.818 | 289-32223_SEABERG_ES_1H_permit911858_8996492_Stone_pooled_unit_plat.pdf | mapped area -3.1% from called acres; traced area -3.1% from called acres |
| Tipps Unit | 276.7 | 289-32200_HUTTO_TMM_1H_permit904520_8192760_Hutto_TMM_1H_well_loc_plat.pdf, 289-32200_HUTT | mapped area -11.3% from called acres; mapped area -14.5% from called acres; traced area -14.5% from called acres |
| Unit Fract S | 492.96 | 289-32223_SEABERG_ES_1H_permit911858_8996740_Seaberg_ES_1H_well_loc_plat.pdf | mapped area +3.0% from called acres |
| Williams Heirs Deep Gas Unit | 86.303 | 289-32209_JENSEN_WW_1H_permit908115_8555891_Williams_Heirs_Deep_Gas_Unit_pooled_unit_plat. | mapped area -3.9% from called acres; traced area -3.9% from called acres |
