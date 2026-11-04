# Buyer matching

How the CRM ranks buyers for a deal (`GET /deals/:id/matches`, the "Buyer
matches" section of a Deal Profile and the Sell tab of a Mineral Asset).

Code: `server/src/domain/buyerMatch.ts` (the scoring model, pure and
unit-tested), `server/src/services/buyerMatching.ts` (loads and caches the
data), `client/src/components/BuyerMatches.tsx` (the list). Validation:
`server/src/scripts/buyerMatchBacktest.ts`; findings in
`docs/reports/buyer-matching-redesign-2026-11-04.md`.

## What a score means

Each buyer gets a **match score, 0–100**, plus a separate **confidence**
(how complete the evidence is), an **eligible / ineligible** flag, and the
facts the score rests on. The score answers "how likely is this buyer to want
*this* deal", using five factors:

| Factor | Weight | What it measures | Source |
|---|---:|---|---|
| Geography | 35 | Where the buyer has actually bought minerals, relative to the deal: same abstract → adjacent abstract → within 2 / 5 / 10 / 25 miles → same county → neighbouring county → elsewhere. Several nearby purchases beat one; recent ones count more (24-month half-life, floor 35% so an old same-abstract deed still counts). | Research TRANSACTION records where the buyer or a confirmed alias is a grantee; PostGIS distances on `gis.abstracts`; county adjacency from `gis.counties` |
| Buy box | 20 | The criteria the buyer stated on their profile: state, county, asset type, NMA range, NRA range, deal size, max $/NMA, lease status, operators, minimum royalty. Each stated criterion is met (1), a near miss within 25% (½) or failed (0). Meeting two criteria is weaker evidence than meeting five (coverage factor 0.7–1.0). | `BuyBoxCriteria` |
| Recent activity | 15 | Is the buyer buying *now*? Time-decayed count of recorded acquisitions anywhere (12-month half-life), capped at 35 when nothing was recorded in the last year, ±8 for an accelerating or slowing pace. A live conversation with us (reply, call, meeting, negotiation, offer in the last 3 / 12 months) floors it at 40 / 30. | Research records; CRM timeline |
| Relationship | 25 | Our own history: deals closed with us (+20 for the first, +12 for the next two), offers made, engaged statuses, passes (−8 each, −6 more per pass in this county), no reply to 3+ deals sent (−12), Hot / Cold (±8), recency of the last meaningful contact (+8 / +4). Outbound emails alone count for nothing. | Deals, offers, buyer activity, timeline |
| Deal fit | 5 | Demonstrated patterns: share of the buyer's recorded deeds that are the deal's interest type (mineral vs royalty), and whether the deal's size sits inside the range of deals they have offered on / closed (or the acreage their deeds convey). | Research records; CRM |

**Score = Σ weight × factor score ÷ Σ weights**, rounded.

### Missing data is not a match

A factor with **no evidence either way is "unknown"**: it scores the neutral
prior **25**, never a positive, and lowers the confidence instead. A factor
with evidence *against* (bought only far away, passed on our deals, fails the
stated criteria) scores low. The two are kept apart on purpose:

- "No recorded acquisitions in Research" → geography unknown (25).
- "No recorded acquisitions in or around Leon County (15 recorded elsewhere)" → geography **0**.
- A deal in a county Research does not cover yet → geography unknown, with that said in the reasons.
- An empty buy box → unknown. A stated criterion the deal has no value for (no NMA entered) is not checked and never counts as a miss.
- No relationship history → unknown. Three deals sent and never answered → below neutral.

A buyer with nothing known in any factor shows **Insufficient data** instead
of a number.

### Hard requirements vs preferences

Any stated criterion can be marked a **hard requirement** on the buyer profile
("Hard requirements" in the buy box). A deal that fails one makes the buyer
**ineligible**: the card says which requirement, the buyer sorts below every
eligible buyer, and the "Eligible only" filter hides them. The weighted score
is still computed and shown, but nothing is folded into it. Every other
criterion is a preference that only moves the score.

### Confidence

Confidence is data completeness, reported beside the score and never mixed
into it:

- geography known: +0.35 when the deal's abstracts are in the GIS layer (real
  tract distances), +0.20 when only county-level geography was possible;
- buy box: +0.25 × (checked criteria ÷ 5);
- activity known: +0.15 × min(1, acquisitions ÷ 3);
- relationship known: +0.15; deal fit known: +0.10.

≥ 0.70 **High**, ≥ 0.45 **Medium**, otherwise **Low**. A buyer can score high
with low confidence (one same-abstract deed and nothing else known).

### Explanations

Every card shows up to three **highlights** (hard conflicts first, then the
strongest geography, relationship, buy-box and activity facts) and, on demand,
the **breakdown**: each factor's score, weight and reasons, the buy box
criterion by criterion, the closest recorded acquisitions, and the counts
behind them. Every line is derived from a record — nothing is phrased unless
the data supports it.

## Buyer identity and de-duplication

A buyer's acquisitions are the Research TRANSACTION records whose grantee side
contains the buyer's **company name or any confirmed alias**, normalized the
way grantees are at import (`normalizeEntity`). Multi-party instruments are
expanded to participants (`sideParties`), so a buyer that is one of three
grantees is credited once. Each record counts **once per buyer** however many
of the buyer's names appear on it, and the same instrument imported twice
(`state|county|instrument number`) counts once. Aliases are only those the
user confirmed on the profile — nothing is merged by name similarity here.

## Geography details

- Research abstract numbers are resolved to GIS ids as `TX-<county fips><abstract no>`
  (e.g. Leon A-182 → `TX-289182`) using `gis.counties`; records with no
  abstract the layer knows stay **county-level** (they can still be "same
  county", never "within 5 miles").
- Distances are PostGIS `ST_Distance(geography)` from the **union of the
  deal's tracts** to each candidate abstract within 40 miles;
  `ST_Intersects` marks adjacency. County adjacency is `ST_Touches` on
  `gis.counties` (all 254 Texas counties and the Louisiana parishes loaded).
- A deal with no abstract on file, or no PostGIS (a fresh local database),
  degrades to county tiers; the reasons say so and confidence is lower.
- Nothing is placed by county centroid, and no coordinates are invented for a
  record without location data.

## Manual overrides

`PUT /deals/:id/matches/:buyerId/override` with `kind` = `PRIORITIZE` (pin to
the top), `EXCLUDE` (sort last, hidden by default) or `FLAG`, optional `note`;
`DELETE` clears it. One override per buyer per deal, stored in
`DealBuyerMatchOverride` with who set it, shown as a badge beside the score
and logged to the activity log. Needs `editDeals`. The score is never edited.

## Performance and freshness

- The **acquisition index** (every transaction record keyed by grantee, with
  resolved GIS ids) is built once per research scope and cached 10 minutes;
  Research imports and deletions drop it at once (`invalidateBuyerMatchCaches`).
- A deal's **geo context** (distances, adjacency) is cached 10 minutes, keyed
  by the deal's state, counties and abstract set — editing the deal's location
  misses the cache naturally.
- County adjacency and the county→FIPS map are cached for an hour.
- CRM history (deals, offers, activity, timeline) is read fresh on every
  request, so an offer, status or buy-box change shows at once.

At today's scale (5k records, 38 buyers) a cold request takes well under a
second and a warm one a few milliseconds. The index is in-process memory; if a
second API instance is ever added, a shared cache or a stored
`BuyerAcquisitionProfile` table is the next step.

## Configuration

`BUYER_MATCH_WEIGHTS='{"geography":35,"buyBox":20,"activity":15,"relationship":25,"fit":5}'`
overrides the weights per deploy (`server/src/config.ts`). Tier values,
half-lives and thresholds live in `MATCH_CONFIG`.

## Validating changes

```bash
cd server
npx tsx src/scripts/buyerMatchBacktest.ts --org "Carsa Minerals" --tune
```

runs inside a READ ONLY transaction and reports, for every deal that received
an offer, where the buyers who offered ranked when scored with only the
information available before that offer — for the new engine, alternative
weightings, geography alone and the previous buy-box-only engine.
