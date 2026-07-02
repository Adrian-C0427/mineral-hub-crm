# Leon County, TX — importing recorded documents

Leon County records are hosted on **GovOS Public Search**
(`https://leon.tx.publicsearch.us`). The platform has **no public API** and its
search runs over an authenticated WebSocket that rejects automated clients, so
the supported path is the site's own **export**, imported through
**Research → Data & Imports** with the *"Leon County, TX — publicsearch.us
export"* source. Rows are auto-classified, entity names normalized, and
duplicates skipped on import.

## Step-by-step

1. Go to https://leon.tx.publicsearch.us and open **Advanced Search** in the
   **Real Property** department.
2. Set a **Recorded Date** range (e.g. the last 90 days for a trends refresh,
   or a full year for a backfill).
3. Under **Document Types**, select the mineral & leasing instruments you care
   about (the full list Leon uses is in the appendix below — the essentials are
   *Mineral Deed, Royalty Deed, Mineral Conveyance, Oil and Gas Lease,
   Memorandum of Oil and Gas Lease, Assignment of Lease, Release of Lease,
   Ratification of Lease*).
4. Run the search and use **Export Results** to download the CSV.
5. In Mineral Hub: **Research → Data & Imports** → data kind **County recordings**,
   source **Leon County, TX — publicsearch.us export**, State **TX**, County
   **Leon** → upload the CSV. The column mapping is auto-detected (Grantor,
   Grantee, Doc Type, Recorded Date, Doc Number, Book/Volume/Page, Legal
   Description); adjust if needed, then **Import**.

The importer skips anything that isn't a mineral/leasing instrument (liens,
deeds of trust, easements) and reports per-reason skip counts. Re-importing an
overlapping date range is safe — documents are de-duplicated by county +
instrument number.

## Appendix — Leon County mineral & leasing document types

These are the Real Property instrument descriptions the importer recognizes as
mineral- or leasing-related, grouped by the normalized type they map to. Select
the relevant ones on the site before exporting. (Extracted from the county's own
document-type configuration.)

**Mineral Deeds** (11 types) — normalized to `MINERAL_DEED`
- AMD MINERAL DEED
- C C COR MINERAL DEED
- C C MINERAL DEED
- CC MINERAL DEED
- COR MINERAL DEED
- CORR MINERAL DEED
- GIFT MINERAL DEED
- MIN DEED CONTRACT
- MINERAL DEED & P/A
- Mineral Deed
- OIL & MIN DEED

**Royalty Deeds & Conveyances** (34 types) — normalized to `ROYALTY_DEED`
- AMD ASG ORR ROY INTR
- AMD ROYALTY CONVEYNC
- AMD ROYALTY DEED
- ASG ORR ROY INTR
- ASG ROYALTY CONT
- ASG ROYALTY INTR
- C C ASG ORR ROY INTR
- C C ASG ROYALTY INTR
- C C COR ROYALTY DEED
- C C ROYALTY CONVEYNC
- C C ROYALTY DEED
- CC ASG ORR ROY INTR
- CONFIRM ROYALTY CON
- COR ASG ORR ROY INTR
- COR ASG ROYALTY INTR
- COR ROYALTY CONTRACT
- COR ROYALTY CONVEYNC
- COR ROYALTY DEED
- CORR ASG ORR ROY INT
- CORR ASG ROYALTY INT
- MEM ASG ORR ROY INTR
- MIN & ROY ASSIGNMENT
- MIN & ROYALTY DEED
- MIN DEED & ROY TRAN
- MINERAL/ROYALTY DEED
- ORR ASGN
- P/ASGMT ORR ROY
- REL ROYALTY CONT
- ROYALTY CONTRACT
- ROYALTY CONVEYNC
- ROYALTY DEED
- ROYALTY DIV ORDR
- ROYALTY OPTION
- Royalty Deed & Asgmt

**Mineral Conveyances & Grants** (9 types) — normalized to `MINERAL_CONVEYANCE`
- AMD MINERAL CONVEYNC
- C C MINERAL CONVEYNC
- CC MINERAL CONVEYNC
- COR MINERAL CONVEYNC
- CORR MINERAL CONVEYN
- MINERAL CONVEYNC
- MINERAL GRANT
- POWER ATTY & MIN CONVEY
- RATIFY MIN CONVEYANCE

**Oil & Gas Conveyances** (1 types) — normalized to `OG_CONVEYANCE`
- OIL & GAS GRANT

**Quitclaim Mineral Deeds** (2 types) — normalized to `QUITCLAIM_MINERAL_DEED`
- Q/C MINERAL DEED
- QUITCLAIM MIN DEED

**Mineral Assignments** (5 types) — normalized to `ASSIGNMENT`
- AMD ASG MINERAL INTR
- ASG MINERAL
- ASG MINERAL INTR
- C C ASG MINERAL INTR
- COR ASG MINERAL INTR

**Oil & Gas Leases** (25 types) — normalized to `OG_LEASE`
- AMD MINERAL LEASE
- AMD NOTICE O&G LEASE
- AMD OIL & GAS LEASE
- C C COR OIL & GAS LS
- C C OIL & GAS LEASE
- CC OIL & GAS LEASE
- COR AMD OIL & GAS LS
- COR NOTICE O&G LEASE
- COR OIL & GAS LEASE
- CORR OIL & GAS LEASE
- FORFEIT O&G LEASE
- MEM NOTICE O&G LEASE
- MEM OIL & GAS LEASE
- MIN LEASE & DEED
- MIN LEASE & EXT
- MINERAL LEASE
- NOTICE O&G LEASE
- OIL & GAS LEASE
- OIL GAS MINERAL LEASE
- OIL LEASE CONTRACT
- OIL-GAS LSE
- Oil and Gas Lease
- PARTN MIN LEASE
- PETROLEUM LEASE
- RENEW O&G LEASE

**Lease Memoranda** (1 types) — normalized to `LEASE_MEMO`
- MEMO LEASE

**Lease Assignments** (17 types) — normalized to `LEASE_ASSIGNMENT`
- AMD ASGMT OF LEASE
- AMD P/ASGMT OF LEASE
- ASG LEASE CONTRACT
- ASG LSE INT
- ASG OF LSE
- ASGMT OF LEASE
- C C ASGMT OF LEASE
- C C P/ASGMT OF LEASE
- CC ASGMT OF LEASE
- CONV & ASGMT OF LS
- COR ASGMT OF LEASE
- COR P/ASGMT OF LEASE
- CORR ASGMT OF LEASE
- LEASE & ASSIGNMENT
- MEM ASGMT OF LEASE
- MIN LEASE & ASSIGN
- P/ASGMT OF LEASE

**Lease Releases** (23 types) — normalized to `LEASE_RELEASE`
- AFF TERMINATE LEASE
- C C P/REL OIL&GAS LS
- C C REL OF LEASE
- C C REL OIL&GAS LS
- CANCEL LEASE
- COR P/REL COAL LEASE
- COR P/REL LEASE
- COR P/REL OIL&GAS LS
- COR REL OIL&GAS LS
- MEM REL OIL&GAS LS
- MEM TERMINATN LEASE
- P/REL COAL LEASE
- P/REL LEASE
- P/REL OIL&GAS LS
- PARTIAL RELEASE OF LEASE
- PTL REL MIN LSE
- REL COAL LEASE
- REL OF LEASE
- REL OGM LSE
- REL OIL&GAS LS
- RELEASE FARM LEASE
- TERMINATN LEASE
- TERMINATN O&G LS

**Lease Amendments** (1 types) — normalized to `LEASE_AMENDMENT`
- AMEND LSE

**Lease Extensions** (9 types) — normalized to `LEASE_EXTENSION`
- AMD EXTENSN OF LEASE
- AMD LEASE EXTENSION
- C C EXTENSN OF LEASE
- COR EXTENSN OF LEASE
- CORR LEASE EXTENSION
- EXTENSN OF LEASE
- LEASE EXTENSION
- MEM EXTENSN OF LEASE
- MEM LEASE EXTENSION

**Lease Ratifications** (14 types) — normalized to `LEASE_RATIFICATION`
- AMD RATIF OF LEASE
- C C RATIF OF LEASE
- C C RATIFY & AMD LS
- CC RATIF OF LEASE
- COR & RATIF LEASE
- COR RATIF OF LEASE
- COR RATIFY & AMD LS
- CORR RATIF OF LEASE
- MEM RATIFY & AMD LS
- O&GL & RATIFICATION
- RATIF LEASE
- RATIF OF LEASE
- RATIFY & AMD LS
- RATIFY LS & STIP INT

**Other mineral-related** (7 types) — normalized to `OTHER`
- GAS PURCHASE CONTRACT
- MEM MINERAL CONTRACT
- MINERAL AFF
- MINERAL INTEREST
- MINERAL SALE AGRMT
- P/REL MINERALS
- TRANSFER OIL PAYMENT
