# Spot check: 25 random wells vs RRC's GIS map and records (2026-10-19)

Random sample drawn within each status so every status is covered: 7 producing, 4 shut-in, 6 plugged, 2 other/unknown, 1 permitted, 1 drilling, 1 disposal, 1 injection, and 2 extra horizontal/directional wells. By county: 12 Freestone, 11 Leon, 2 Cherokee.

Compared against what RRC's public GIS Viewer shows for each well (gis.rrc.texas.gov):
- **Map points:** the Well Locations and Horiz/Dir Surface Locations layers.
- **Wellbore paths:** the Horizontal/Directional Lines layer.
- **Well popup:** its Wellbore and Completion services.
- **Linked Drilling Permit query:** used for unit size.
- **Linked Production Data Query:** used for production.

Our side is the bundled refresh, which the deploy loads. Locations were also read from the live app's public map tiles.

## Result

| Check | Result |
|---|---|
| Surface location vs RRC map point | 25 / 25 within 0.2 ft |
| Live map tiles vs loaded data | 25 / 25 within 0.9 ft (tile rounding) |
| Bottom hole vs RRC map point (8 deviated wells) | 8 / 8 within 0.2 ft |
| Wellbore path ends vs RRC's drawn line | within 10.6 ft (RRC's line layer sits ~9 ft off RRC's own points) |
| Status vs RRC records | 25 / 25 consistent (see notes) |
| Plug date | 6 / 6 match |
| Permit number + approval date | 23 / 23 match (2 wells have no permit on file at RRC) |
| Unit size vs the W-1 permit on RRC's Drilling Permit query | 23 / 23 exact; the other 2 have no permit at RRC |
| Lease name, well number | 25 / 25 match |
| Lease number, field | 18 / 18 match (7 have no completion at RRC) |
| Abstract | 20 / 20 match (5 have none at RRC) |
| Operator | 23 / 25 match (see notes) |

## Wells

| API | County | Status (ours) | RRC map symbol / wellbore status / completion type | Unit size (ours) | RRC permit acres |
|---|---|---|---|---|---|
| 161-33673 | Freestone | Producing | Gas Well / OPEN / PRODUCING | 570.68 | 570.68 |
| 161-32417 | Freestone | Producing | Gas Well / OPEN / HISTORY, PRODUCING, HISTORY | 690 | 690.0 |
| 161-34271 | Freestone | Producing | Gas Well / OPEN / PRODUCING | 328.98 | 328.98 |
| 161-31667 | Freestone | Producing | Gas Well / OPEN / PRODUCING | 703.43 | 703.43 |
| 161-31837 | Freestone | Producing | Gas Well / OPEN / PRODUCING | 704 | 704.0 |
| 161-33127 | Freestone | Producing — Schedule: PRODUCING, SWR-10-WELL | Gas Well / OPEN / PRODUCING, None | 679.65 | 679.65 |
| 289-31534 | Leon | Producing | Gas Well / OPEN / PRODUCING | 700 | 700.0 |
| 161-31442 | Freestone | Shut-In — Inactive since 2026-07 | Gas Well / OPEN / PRODUCING | 312.68 | 312.68 |
| 161-30978 | Freestone | Shut-In — Shut in since 2024-02 · 14(b)(2) extension | Oil Well / OPEN / SHUT IN | 468 | 468.0 |
| 289-30764 | Leon | Shut-In — Shut in since 1998-01 · 14(b)(2) extension | Oil Well / OPEN / HISTORY, SHUT IN | 160 | 160.0 |
| 161-32213 | Freestone | Shut-In — Temporarily abandoned since 2017-01 · 14(b)(2) extension | Gas Well / OPEN / TEMP ABANDONED | 40 | 40.0 |
| 161-30865 | Freestone | Plugged | Plugged Gas Well / PLUG / HISTORY | 320 | 320.0 |
| 073-30919 | Cherokee | Plugged — Dry hole | Dry Hole / DRY / — | 135.5 | 135.5 |
| 289-31925 | Leon | Plugged | Plugged Oil Well / PLUG / HISTORY | 760.87 | 760.87 |
| 289-30047 | Leon | Plugged | Plugged Gas Well / PLUG / HISTORY | — | no permit at RRC |
| 161-31652 | Freestone | Plugged — Dry hole | Dry Hole / DRY / — | 40 | 40.0 |
| 289-31180 | Leon | Plugged — Dry hole | Dry Hole / DRY / — | 665.6 | 665.6 |
| 289-31781 | Leon | Other/Unknown — Permit expired 2010-10-04 · not drilled | Permitted Location / LOCATION / — | 3466 | 3466.0 |
| 161-33118 | Freestone | Other/Unknown — Permit expired 2006-12-10 · not drilled | Permitted Location / LOCATION / — | 704 | 704.0 |
| 289-32216 | Leon | Permitted — Permit 0910187 approved 2025-09-04 | Permitted Location / LOCATION / — | 1144 | 1144.0 |
| 289-32222 | Leon | Drilling — Spudded 2026-01-22 · completion not yet filed | Permitted Location / LOCATION / — | 2168.11 | 2168.11 |
| 073-00350 | Cherokee | Disposal — Disposal into a productive zone (H-1) | Injection / Disposal from Gas / OPEN / HISTORY, HISTORY, INJECTION | — | no permit at RRC |
| 289-31684 | Leon | Injection — Secondary/tertiary recovery | Injection / Disposal from Oil / OPEN / HISTORY, INJECTION | 479.8 | 479.8 |
| 289-31440 | Leon | Producing | Gas Well / OPEN / PRODUCING | 226.41 | 226.41 |
| 289-31418 | Leon | Producing | Gas Well / OPEN / PRODUCING | 2560.3 | 2560.3 |

## Notes

- **Map symbol lag.** RRC's map symbol is set at completion and isn't updated after. Two wells still show as "Permitted Location" although their permits expired in 2006 and 2010 without drilling, per RRC's Drilling Permit query. One well shows the same symbol although it was spudded 2026-01-22. Shut-in wells keep their oil/gas symbol. Our status follows RRC's Wellbore Query and permit records.
- **On-schedule flag.** RRC's popup Completion service reports On Schedule = N for every producing completion and Y for history rows. RRC's Wellbore Query file lists the same completions as on schedule (Y). We use the Wellbore Query.
- **Operator.**
  - 161-30978: RRC's 2026-10-02 Wellbore Query lists JAY MANAGEMENT COMPANY LLC; RRC's live popup now lists FLAMINGO OIL & GAS LLC. This is a transfer after our snapshot, and the next refresh picks it up.
  - 161-33118: the 2004 permit spells the operator ANADARKO PETROLEUM CORP., and RRC's popup spells it ANADARKO PETROLEUM CORPORATION. Same company.

## Fixed after this check

- **Operator and lease for permit-stage wells.** Before the fix, wells with no completion on the Wellbore Query (permitted, drilling, expired permit) showed no operator or lease. They now take both from their newest permit, as RRC's popup does. That covers 775 wells, which now all have both.
- **Shut-in note.** The note said a shut-in wellbore had "no production for 12+ months". In fact RRC's wellbore shut-in date is the month production stopped. For example, 161-31442 produced through 2026-06 and was shut in 2026-07. The note now gives the shut-in month and the last reported production.
- **Conflicting shut-in records flagged.** 83 gas wells are still tracked inactive by RRC yet reported production in the last 12 months, after their shut-in date. One example is LOVERING E.H. #1, inactive since 2020-03 with production through 2026-07. That production was confirmed on RRC's Production Data Query. These wells stay Shut-In, because production never sets a status. They are flagged "Needs investigation" with the dates.
