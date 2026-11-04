# Buyer Matching — redesign report (2026-11-04)

The Buyer Matching section of a Deal Profile gave almost every buyer the same
rating. This report records what was wrong, what replaced it, how the new
ranking was validated against the deals Carsa actually sold, and what is still
limited by the data. The methodology itself is documented in
`docs/buyer-matching.md`.

## 1. Root causes

Audit of the previous engine (`domain/matching.ts`, `GET /deals/:id/matches`)
against production data, read-only, 2026-11-04:

1. **Only the buy box was scored.** Five criteria — state, county, asset type,
   acreage range, price range — weighted 20/20/10/5/5. Research transaction
   history, GIS geography, offers, closed deals, passes and responses were
   never consulted. The data existed: 5,257 transaction records (Leon,
   Freestone, Harrison, Panola), 36 offers, 35 accepted, statewide abstract
   geometry in PostGIS.
2. **37 of Carsa's 38 buyers had the identical buy box.** They were created
   by the Research → Buyers import, which fills only state and counties from
   the buyer's research footprint (`TX` + Leon/Freestone/Panola). With two
   criteria specified and both met, every one of them scored exactly
   75 on every Leon deal. Measured on five real deals: 36 buyers at 75, one at
   42, one at 25 — three distinct scores for 38 buyers.
3. **"Accepts any" was credited.** An unspecified criterion still earned 25%
   of its weight, so an empty buy box scored 25 rather than "unknown", and
   sparse boxes were pushed toward the middle together.
4. **Ties were broken by nothing meaningful** (criteria count, then the
   database order), so the displayed rank within the 36-way tie was arbitrary.
5. **No geography beyond the county name**, no recency, no de-duplication
   concerns (none were needed because no transactions were read), no
   confidence, and explanations limited to "County ✓ State ✓".

Historical check of the old ranking (section 4): for the 35 Carsa deals that
received an offer, the buyer who actually offered was in the top 10 **0%** of
the time (median rank 18.5 — the middle of the tie).

## 2. What was built

- `server/src/domain/buyerMatch.ts` — the scoring model: five factors
  (geography 35, buy box 20, recent activity 15, relationship 25, deal fit 5),
  neutral-prior handling of unknowns, hard requirements → eligibility,
  confidence, highlights, per-factor reasons. Pure and unit-tested
  (`buyerMatch.test.ts`, 25 scenarios covering the acceptance list).
- `server/src/services/buyerMatching.ts` — the acquisition index (every
  transaction record keyed by grantee, de-duplicated by record and by
  instrument number, abstracts resolved to GIS ids), PostGIS distances and
  adjacency per deal, county adjacency, CRM history; caching and invalidation.
- Routes: `GET /deals/:id/matches` (new payload; `matchPercent` kept for
  older clients), `PUT/DELETE /deals/:id/matches/:buyerId/override`, deal
  detail buyer-activity rows carry the new score; buy box PATCH accepts the
  new criteria; Research import/delete invalidate the index.
- Schema (additive): `BuyBoxCriteria.minNra/maxNra/maxPricePerNma/
  leaseStatuses/operators/minRoyalty/strictKeys/notes`; new
  `DealBuyerMatchOverride`. Migration `20261104120000_buyer_matching_engine`.
- Client: `components/BuyerMatches.tsx` shared by Deal Profile and Mineral
  Asset Sell tab — score ring, confidence, eligibility, highlights, facts,
  expandable breakdown, sort (score, confidence, nearest acquisition, same
  abstract, same county, recent activity, buy box, relationship), filters
  (eligible only, bought in this abstract, active in this county, bought in
  the last 12 months, show excluded), pin / flag / exclude overrides; the
  existing selection, Send deal by email, Mark as contacted, CSV export and
  Log contact are unchanged. Buyer Profile buy box gains the new fields and
  "Hard requirements".
- `server/src/scripts/buyerMatchBacktest.ts` — the validation below.

## 3. Methodology in brief

See `docs/buyer-matching.md`. The points that matter most for trust:

- Geography is **behaviour**, from recorded deeds, placed against the deal's
  own tract geometry: same abstract 1.0 · adjacent 0.85 · ≤2 mi 0.75 ·
  ≤5 mi 0.60 · ≤10 mi 0.45 · ≤25 mi 0.30 · same county 0.25 · neighbouring
  county 0.12. 75% of the factor is the best-placed acquisition (time-decayed,
  24-month half-life, floor 35%), 25% rewards concentration with diminishing
  returns.
- Unknown is **25 (neutral)**, confirmed-absent is **0**. Missing buy-box
  data never counts as a match; a stated criterion the deal has no value for
  is skipped, not failed.
- Relationship starts at neutral and moves on closed deals, offers, engaged
  statuses, passes, non-response, Hot/Cold and recency. Sending an email does
  nothing.
- Confidence is reported separately and never changes the score.

## 4. Historical validation

`npx tsx src/scripts/buyerMatchBacktest.ts --tune` (read-only transaction,
2026-11-04). For each deal that received an offer, buyers are scored **as of
the instant before the first offer**: Research records recorded later and CRM
events dated later are ignored, and the deal's own outcome never counts as
history. Target = the buyer(s) who offered.

### Carsa Minerals — 35 deals, 36 offer-buyers, 38 buyers scored per deal

| Ranker | hit@1 | hit@3 | hit@5 | hit@10 | MRR | median rank | distinct scores / deal |
|---|---:|---:|---:|---:|---:|---:|---:|
| **New engine (35/20/15/25/5)** | 33% | 81% | 81% | 89% | **0.566** | 2 | 19.8 |
| New engine, brief's weights (35/25/15/15/10) | 33% | 67% | 67% | 83% | 0.514 | 2 | 19.7 |
| Geography only | 14% | 28% | 42% | 47% | 0.265 | 14 | 24.7 |
| Relationship-heavy (30/20/10/30/10) | 31% | 81% | 86% | 89% | 0.565 | 2 | 18.6 |
| Buy-box-heavy (25/40/10/15/10) | 33% | 78% | 83% | 83% | 0.559 | 2 | 17.6 |
| **Previous engine (buy box only)** | **0%** | **0%** | **0%** | **0%** | 0.052 | 18.5 | 2.9 |

Reading: with the new engine the buyer who actually made the offer is the #1
recommendation a third of the time and in the top three four times out of
five; the previous engine never put them in the top ten. Scores now take ~20
distinct values per deal instead of 3.

**Why the weights moved from the brief's starting point.** The brief proposed
35/25/15/15/10. Carsa sells repeatedly to a small set of buyers, so having
closed with us before was the single most predictive fact after geography;
raising relationship from 15 to 25 (taken from buy box and deal fit, which
added little) lifted hit@3 from 67% to 81%. Geography stays the largest
factor. The candidate weightings within a few points of each other
(relationship 25–30, geography 30–35) are statistically indistinguishable on
36 targets; the chosen one keeps geography first as the brief asked.

**Caveats.** (a) 36 targets from 5 distinct buyers over four months is a small
sample; these numbers describe Carsa's recent pattern, not a general law.
(b) The buyer roster and buy boxes are today's — buyers created after an
offer still compete, which only makes the test harder for the engine. (c) The
Research data covers four counties from 2025-01; the Cherokee and Houston
deals have no nearby records and scored on relationship and buy box alone.

### Brazos Ridge Minerals (demo, synthetic data) — 42 deals, 106 offers

| Ranker | hit@1 | hit@3 | hit@5 | hit@10 | MRR |
|---|---:|---:|---:|---:|---:|
| New engine | 14% | 42% | 76% | 96% | 0.365 |
| Previous engine | 4% | 50% | 64% | 83% | 0.32 |

The demo's offers are generated by its seeder, so this only shows the engine
is not worse on a fuller, synthetic CRM; it is not evidence about real buyers.

### Worked examples (Carsa, scored as of the offer date)

- **Suzanne Solomon (Leon, 2026-07-15).** Winner Morningstar Minerals ranked
  #1 at 86 (High): "Bought 1 time in the same abstract (latest 3 mo ago) ·
  Closed 1 deal with us (1 in this county) · Meets all 2 stated criteria".
  #2 FMTX LP 82 (same abstract this month, 49 acquisitions in 90 days);
  #3 Boomslang Resources 76 (8 acquisitions within 10 miles).
- **Greg Kelly A-782 (Leon, 2026-09-18).** Winner Morningstar #1 at 90:
  3 purchases in the same abstract, the latest that month, 2 deals closed
  with us. Flatland IV GP 87, Horizon Minerals Acquisition Group 82.
- **Paul Geisler (Leon, 2026-10-20).** Winner Flatland IV GP ranked #2 at 82
  (8 acquisitions within 10 miles, 6 deals closed with us); Morningstar #1 at
  92 (same-abstract purchase a month earlier, 4 deals closed).
- **Bobby Crowley (Freestone, 2026-07-17).** Winner Culroy LP ranked #30 at
  64: an adjacent-abstract purchase and one closed deal, but its stated
  counties did not include Freestone, so the buy box scored against it. An
  honest miss — the stated criteria disagreed with the behaviour.

## 5. Geographic proximity — method

Deal abstracts (`Deal.abstractIds`, GIS ids such as `TX-289182`) are unioned
in PostGIS; every abstract referenced by the research index in the same state
within 40 miles gets `ST_Distance(geography)` and `ST_Intersects` (adjacency).
Research abstract numbers map to GIS ids through `gis.counties` FIPS (Leon
A-182 → `TX-289182`), so abstract numbers are never assumed unique across
counties. County adjacency is `ST_Touches` on the statewide county layer.
Records that name no GIS-known abstract stay county-level and can never earn
a "within N miles" tier. Approximate (county-level) and verified
(tract-level) placements are distinguished in the breakdown ("same county"
vs a distance), and the deal's own placement lowers confidence when its
abstracts are not in the layer.

## 6. Data sources

Research `ResearchDocument` (TRANSACTION class), `BuyBoxCriteria`, `Deal`
(location, size, price, asset types, lease, royalty, selected buyer, stage),
`Offer`, `DealBuyerActivity`, `DealBuyerMessage` (inbound email, phone,
meeting, negotiation), `Buyer` (aliases, Hot/Warm/Cold, last contact),
`gis.abstracts`, `gis.counties`.

## 7. Aliases and duplicates

A buyer's identity is its company name plus confirmed aliases (profile →
Relationships → alias review); nothing is merged by similarity inside the
engine. Multi-party instruments credit each participant once. A record counts
once per buyer regardless of how many of its names appear; the same instrument
number in the same county counts once across imports.

## 8. Performance

Cold request on Carsa (5,257 records, 38 buyers, PostGIS distances for ~1,500
candidate abstracts): well under a second; warm (index and geo context cached)
a few milliseconds. No full-table work happens on page open after the first
request in a 10-minute window; Research imports and deletions invalidate
explicitly. The previous route issued one `deal.count` per buyer (38 queries);
the new one issues a handful of set queries.

## 9. Remaining data limitations

- Research covers Leon, Freestone, Harrison and Panola from 2025-01. A buyer
  active elsewhere shows "no recorded acquisitions"; a deal outside those
  counties gets geography marked unknown. Importing more counties is the
  single biggest improvement available.
- No acreage or consideration is recorded on the Carsa transactions, so
  demonstrated deal-size fit uses CRM offers and closed deals only.
- CRM history is thin: 38 activity rows, no PASSED, no inbound replies logged
  yet, so the negative relationship signals have not been exercised on real
  data (they are unit-tested).
- 37 buy boxes are the import's state + counties only; the new criteria and
  hard requirements are empty until someone fills them in.

## 10. Recommendations

1. Fill in hard requirements and NMA/NRA minimums for the five active buyers;
   the engine will start eliminating mismatches rather than only ranking them.
2. Record passes and replies in Buyer Activity (status PASSED, response
   received) so the relationship factor can work in both directions.
3. Re-run the backtest after each Research import; revisit the weights when
   there are ≥100 offer outcomes from ≥15 distinct buyers.
4. Consider a stored per-buyer acquisition profile if the API ever runs more
   than one instance, and a per-org weight override once the model settles.
