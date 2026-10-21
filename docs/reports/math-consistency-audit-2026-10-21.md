# Math & formula consistency audit — 2026-10-21

**Trigger.** Three deals on the Deals list looked identical (NMA "8.752", $7,000.00/NMA) yet showed
different NRA (14.003 vs 14.004), Our cost ($61,264 vs $61,266), $/NRA ($4,375.00 vs $4,374.99) and
profit. Every figure was arithmetically "correct" for its inputs — the display hid the input that
differed (NMA 8.752 vs 8.7523) and the $/NRA was derived through a rounded intermediate.

Three audit passes covered every formula in `server/src` and `client/src` (domain libs, serializer,
routes, shared components, every page). This file records the policy, what was wrong, what changed,
and what was deliberately left alone.

## Precision policy (now enforced)

| Quantity | Stored | Computed | Displayed |
|---|---|---|---|
| Acreage (NMA, NRA) | **4 dp**, rounded at the API boundary (`normalizeNumbers`, routes/deals.ts) | 4 dp (`roundTo(n, 4)` — the string-shift rounder in `domain/money.ts` / `lib/money.ts`, no `Math.round(n*1e4)/1e4`) | **4 dp** via `acres()` everywhere (was 3 dp via `num()` on the Deals list, deal page package totals, Pipeline cards, Assets footer, Map, Portal admin, Opportunity board, buy box, Research) |
| Money (totals, prices, offers, revenue, expenses) | cents, rounded at the boundary | cents via `roundMoney`; sums via `sumMoney` (integer cents) — never a plain `reduce(+)` | whole dollars on big-figure surfaces, cents wherever a figure is used to reconcile a per-acre rate |
| Per-acre rates | cents | **one formula**, `perAcreRates()` (client `lib/perAcre.ts`, mirrored in `server/domain/perAcre.ts`, parity-tested) | cents |
| Royalty | 8 dp decimal | `royaltyValue` (same parser both sides) | fraction · % (6 dp) |
| Ratios (margin, close rate, win rate, ROI) | — | unrounded fraction; ROI % to 2 dp | `pct()` = 1 dp (was 0 dp on the deal page's implied margin) |
| Day counts | — | **calendar days (UTC)**, one rule (`daysUntil` / `daysBetween`) | — |

### The per-acre rule
`per NMA = total ÷ NMA`. When NRA is the NMA converted at the deal's royalty (the normal case),
`per NRA = per NMA ÷ (royalty × 8)` — computed *through the royalty*, never through the 4-decimal NRA.
So $7,000/NMA at 1/5 is exactly $4,375/NRA on every deal, whatever its acreage. When NRA was entered
on its own, `per NRA = total ÷ NRA`. The Deals list, deal page strip, the editors (New deal, Deal
characteristics, New asset), the asset list and asset page all call this one function.

## What was wrong → what changed

| # | Finding | Fix |
|---|---|---|
| 1 | Deals list (and 9 other places) showed acreage at 3 dp while the math carries 4 — the reported bug | `acres()` everywhere |
| 2 | $/NRA derived from the rounded NRA (`total ÷ 14.0037` → $4,374.99) | `perAcreRates`: through the royalty |
| 3 | Server stored acreage/money at whatever precision was sent (an NMA of 8.75234 displayed as 8.7523 but priced as 8.75234) | `normalizeNumbers` on create/update: acreage 4 dp, money cents; offer / revenue / expense amounts to the cent |
| 4 | Server per-acre rounder was `Math.round(n*100)/100` (misses half cents) while the client used `roundMoney`; `round4` used the same pattern both sides | both use `lib/money` rounders; parity test |
| 5 | Six different per-acre computations (stored rate vs total÷acres vs purchasePrice÷acres) across Deals list, deal page, asset list, asset page, editors | one `perAcreRates` |
| 6 | Editing a calculated total in a whole-dollar field truncated its cents and silently rewrote the per-acre rates | price totals accept cents |
| 7 | "Is this price rate-driven?" used an absolute 1¢ tolerance (misclassified for small/large acreage) | tolerance scales with acreage |
| 8 | Deals totals row summed money with a float `reduce` rounded to 4 dp; Expenses page and asset revenue used plain float sums; dashboard cumulative mode too | `sumMoney` (integer cents) |
| 9 | Expense dashboard totals accumulated floats; outstanding could differ from total − reimbursed by a cent | integer-cent accumulators |
| 10 | Three "profit at asking" rules: server (ask − cost − closing), Marketing funnel (3 % closing guess, cost ?? 0), asset page (3 % guess, purchasePrice only) | all = ask − (Our Cost ?? purchase price) − entered closing costs |
| 11 | Map (and AI context) loaded offers without id/status, so they used the *best* offer where every other screen uses the *accepted* one | select id/status |
| 12 | Responses to edits (PATCH, stage move, accept offer, …) were serialized without offers/child assets → Profit est. / buyer price / package roll-ups came back null | `dealInclude` carries them |
| 13 | Reports analytics lacked `purchasePrice`, so its cost-basis fallback differed from the dashboard and buyer history | included |
| 14 | Dashboard "Under contract" used Our Price only; Deals header included owned assets; Pipeline excluded them | all: seller deals only, `ourPrice ?? purchasePrice` |
| 15 | Converting a deal to an asset left purchase price empty (ROI / gain / $ per acre had nothing to work from) | Our Cost ↔ purchase price carried across the conversion when the other side is empty |
| 16 | Deal page implied margin at 0 dp vs Reports at 1 dp; ROI % unrounded; days-in-stage used raw milliseconds (floor) while overdue used calendar days; deal-page alert used local-time `ceil` | one precision / one day rule |
| 17 | Mineral Assets KPI strip summed *all* assets while the table and totals row showed the filtered set | KPIs follow the rows in view |
| 18 | CSV exports: Deals exported own acreage while the table showed package roll-ups; Buyers exported close rate as 0.333; Assets exported ROI pre-rounded | exports match the table |
| 19 | Asset page: avg/mo double-rounded, scenario $/NRA whole dollars beside cents | fixed |

## Left as is (reviewed, not a consistency defect)
- `money()` shows whole dollars on list/KPI surfaces and cents in editors, per-acre figures and reconciliations — a display convention, not a different number.
- Valuation engine outputs (NPV/IRR) are formatted but not rounded in storage; they are model outputs, not booked figures.
- Dashboard "Profit at ask" KPI counts only deals *without* offers (by design — it is the complement of projected profit).
- "Accepted offer" on the dashboard/reports/buyers = the deal's selected offer; the serializer additionally honours an offer whose status is ACCEPTED without a selection. Both routes set both fields in the app, so they agree in practice.

## Verification
- `client/src/lib/perAcre.test.ts`, `client/src/lib/blendedCost.test.ts`, `server/src/domain/perAcre.precision.test.ts` (server ↔ client parity, the reported deals, boundary rounding).
- Full server suite (1,125) and client suite pass; production build passes.
- Reproduced the reported deals locally (NMA 8.752, 8.752, 8.7523 at $7,000/NMA, 1/5): the list now shows 8.752 / 8.752 / 8.7523, NRA 14.0032 / 14.0032 / 14.0037, $7,000.00 and **$4,375.00 on all three**; an NMA sent as 8.75234 is stored as 8.7523 and priced as such.
