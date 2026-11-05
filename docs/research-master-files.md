# Research transactions — county master files

The county "Full Transactions List" files (GRANTOR, GRANTEE, DOC TYPE, RECORDED
DATE, INSTRUMENT NUMBER, VOLUME, PAGE, ABSTRACT, COUNTY, STATE, PERCENT SOLD,
SURVEY NAME) are the reviewed source of truth for a county's mineral
transactions. This page records how the app reads them. Rules live in
`server/src/domain/researchFields.ts`; the importer is
`server/src/domain/researchIngest.ts`.

## Owner decisions (2026-11-04)

| Question | Rule |
|---|---|
| What PERCENT SOLD means | The share of the **grantor's own interest** the instrument conveys, 0–100. Stored as `percentSold`; the cell verbatim in `percentSoldRaw`. A cell with several values ("66.67%; 33.33%") keeps the number empty — never guessed. |
| Grantee "(30%)" shares | Kept apart from PERCENT SOLD (`partyInterests`, summed in `interestPct`, shown as "Party shares"). `shareBasis` per row: **absolute** (shares add up to PERCENT SOLD), **of-conveyed** (shares add up to 100 while PERCENT SOLD is lower — each buyer's split of what was sold), **unknown** otherwise. `[66% TOTAL]` is kept as `granteeStatedTotalPct`. |
| Rows the app has that the master file leaves out | Kept, tagged **Outside the master list**, and no longer counted as acquisitions. Never deleted. |
| Abstract disagreements | The master file wins; the previous values stay in the archive. |
| Corrections, certified copies, amendments, gift deeds, stipulations | Kept and shown with a flag; **not** counted as a buyer's acquisition (profiles, rankings, matching, Relationships). |
| Estate / trust sellers | Grantor text kept as recorded; flagged **Estate or trust seller** (informational). |
| Same-day instruments, same parties and abstracts | Separate records sharing `txGroupKey`; counted **once** in buyer activity and matching. |
| Survey named, no abstract | The abstract is looked up in the county survey layer **only** when every survey has exactly one abstract; `abstractSource = "survey-lookup"`. |
| Buyer score vs share bought | Unchanged: a 2% purchase and a 100% purchase weigh the same. |
| Volume / Page | Optional Records columns; always in the record detail. |

## Columns added to `ResearchDocument`

`percentSold`, `percentSoldRaw`, `shareBasis`, `granteeStatedTotalPct`, `surveys[]`
(standardized, one per entry), `surveyAsRecorded`, `tracts` (abstract ↔ survey
pairs, positional, only when both lists have the same length), `abstractSource`,
`docFlags[]`, `countsAsAcquisition`, `txGroupKey`, `sourceRow` (every column of
the source row, verbatim, including unmapped ones), `derivedVersion`,
`updatedAt`, `updatedByRunId`. Migration `20261105120000_research_master_fields`
(additive). Existing rows get the derived fields from the boot backfill
`services/researchDerivedBackfill.ts` (versioned, once per row).

## Updating existing records from a master file

Import → Deeds → tick **"This file is the county's master list — update existing
records"** (CLI: `--replace`; master files also need **reviewed** / `--reviewed`
because they include general deed types):

1. A row whose **county + instrument number** match exactly one existing record
   updates it **in place**: same id, same buyer links, the creating import is
   kept. Before any write the whole previous row is copied to
   `archive.research_document_history` (reason "master-file update").
2. A row with no match is imported as new (normal duplicate rules apply).
3. An instrument appearing twice in the file, or matching several existing
   records, is rejected for a person to resolve.
4. Existing transactions of the file's counties **and recording-date span** that
   the file leaves out are archived, then tagged `outside-master-list`
   (`countsAsAcquisition = false`). Nothing is deleted.

Always dry-run first (the preview shows will update / will import / not in file).
To restore one record: `SELECT row FROM archive.research_document_history WHERE
document_id = '…' ORDER BY archived_at DESC LIMIT 1`.
