/**
 * Buyer-matching backtest — READ ONLY.
 *
 * For every deal that received an offer, score the org's buyers as of the
 * moment just before the first offer arrived (Research records and CRM events
 * dated later are ignored; the deal's own outcome never counts), then ask:
 * where did the buyer(s) who actually offered / bought land in the ranking?
 *
 * Compares three rankers on the same deals:
 *   new      domain/buyerMatch.ts with the configured weights
 *   current  the buy-box-only engine this replaces (domain/matching.ts); its
 *            ties are scored at their average rank, as a user scrolling a
 *            tied list would experience them
 *   geo      the new engine with geography alone
 *
 * Usage (from server/):
 *   npx tsx src/scripts/buyerMatchBacktest.ts                 # every org with offers
 *   npx tsx src/scripts/buyerMatchBacktest.ts --org "Carsa Minerals"
 *   npx tsx src/scripts/buyerMatchBacktest.ts --tune          # also try alternative weightings
 *   npx tsx src/scripts/buyerMatchBacktest.ts --json out.json # machine-readable results
 *
 * Caveats it prints with the numbers: the buyer roster is today's (buyers
 * created later than the offer still compete, which only makes the test
 * harder for the new engine); buy boxes are today's.
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { computeMatch } from "../domain/matching.js";
import { DEFAULT_MATCH_WEIGHTS, compareMatches, type MatchWeights } from "../domain/buyerMatch.js";
import { matchBuyersForDeal, type MatchBuyerRow } from "../services/buyerMatching.js";

const prisma = new PrismaClient();

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const onlyOrg = arg("--org");
const tune = process.argv.includes("--tune");
const jsonOut = arg("--json");

interface DealCase { dealId: string; name: string; asOf: Date; targets: Set<string>; buyers: number }
interface RankerResult { name: string; hit1: number; hit3: number; hit5: number; hit10: number; mrr: number; medianRank: number; distinctScoresAvg: number; n: number }

/** Rank (1-based) of each target under a scored list; ties take the average rank of the tied block. */
function ranksOf(scored: { id: string; key: number }[], targets: Set<string>): number[] {
  const sorted = [...scored].sort((a, b) => b.key - a.key);
  const ranks: number[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].key === sorted[i].key) j++;
    const avg = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) if (targets.has(sorted[k].id)) ranks.push(avg);
    i = j + 1;
  }
  return ranks;
}

function summarize(name: string, perDeal: { ranks: number[]; distinct: number }[]): RankerResult {
  const all = perDeal.flatMap((d) => d.ranks);
  const hit = (k: number) => Math.round((100 * all.filter((r) => r <= k).length) / Math.max(1, all.length));
  const sorted = [...all].sort((a, b) => a - b);
  return {
    name, n: all.length, hit1: hit(1), hit3: hit(3), hit5: hit(5), hit10: hit(10),
    mrr: Math.round((1000 * all.reduce((s, r) => s + 1 / r, 0)) / Math.max(1, all.length)) / 1000,
    medianRank: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    distinctScoresAvg: Math.round((10 * perDeal.reduce((s, d) => s + d.distinct, 0)) / Math.max(1, perDeal.length)) / 10,
  };
}

type Db = Parameters<Parameters<PrismaClient["$transaction"]>[0] extends (tx: infer T) => unknown ? (tx: T) => unknown : never>[0];

async function main() {
  // Everything runs inside one READ ONLY transaction: the database refuses any write.
  await prisma.$transaction(async (db) => {
    await db.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await backtest(db);
  }, { timeout: 10 * 60_000, maxWait: 30_000 });
}

async function backtest(db: Db) {
  const orgs = await db.organization.findMany({ where: onlyOrg ? { name: onlyOrg } : {}, select: { id: true, name: true, isDemo: true, referenceOrgId: true } });
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), weights: DEFAULT_MATCH_WEIGHTS, orgs: [] as unknown[] };
  for (const org of orgs) {
    const offers = await db.offer.findMany({ where: { deal: { organizationId: org.id } }, select: { dealId: true, buyerId: true, dateSubmitted: true, status: true } });
    if (!offers.length) continue;
    // Only the long-standing buy-box columns, so the backtest also runs against a
    // database that predates the matching-engine migration.
    const buyers = await db.buyer.findMany({
      where: { organizationId: org.id },
      include: { buyBox: { select: { states: true, counties: true, assetTypes: true, minAcreage: true, maxAcreage: true, minPrice: true, maxPrice: true } } },
    });
    const researchOrgIds = [...new Set([org.isDemo && org.referenceOrgId ? org.referenceOrgId : org.id, org.id])];
    const dealIds = [...new Set(offers.map((o) => o.dealId))];
    const deals = await db.deal.findMany({ where: { id: { in: dealIds } } });
    const cases: DealCase[] = deals.map((d) => {
      const os = offers.filter((o) => o.dealId === d.id);
      const asOf = new Date(Math.min(...os.map((o) => o.dateSubmitted.getTime())) - 1);
      return { dealId: d.id, name: d.name, asOf, targets: new Set(os.map((o) => o.buyerId)), buyers: buyers.length };
    });
    const weightSets: Record<string, MatchWeights> = { new: DEFAULT_MATCH_WEIGHTS, geo: { geography: 100, buyBox: 0, activity: 0, relationship: 0, fit: 0 } };
    if (tune) {
      Object.assign(weightSets, {
        "geo-heavy": { geography: 50, buyBox: 15, activity: 15, relationship: 15, fit: 5 },
        "box-heavy": { geography: 25, buyBox: 40, activity: 10, relationship: 15, fit: 10 },
        "activity-heavy": { geography: 30, buyBox: 20, activity: 30, relationship: 10, fit: 10 },
        "relationship-heavy": { geography: 30, buyBox: 20, activity: 10, relationship: 30, fit: 10 },
        "no-fit": { geography: 40, buyBox: 25, activity: 20, relationship: 15, fit: 0 },
        // Geography still first, relationship raised: candidates after the first Carsa run.
        "geo35-rel25-a": { geography: 35, buyBox: 20, activity: 10, relationship: 25, fit: 10 },
        "geo35-rel25-b": { geography: 35, buyBox: 20, activity: 15, relationship: 25, fit: 5 },
        "geo35-rel30": { geography: 35, buyBox: 20, activity: 10, relationship: 30, fit: 5 },
        "geo30-rel25": { geography: 30, buyBox: 25, activity: 10, relationship: 25, fit: 10 },
      });
    }
    const perRanker = new Map<string, { ranks: number[]; distinct: number }[]>();
    const examples: unknown[] = [];
    for (const c of cases) {
      const deal = deals.find((d) => d.id === c.dealId)!;
      const rows: MatchBuyerRow[] = buyers.map((b) => ({ id: b.id, companyName: b.companyName, aliases: b.aliases, relationshipStatus: b.relationshipStatus, lastContactDate: b.lastContactDate, buyBox: b.buyBox }));
      for (const [name, weights] of Object.entries(weightSets)) {
        const res = await matchBuyersForDeal({ db, orgId: org.id, researchOrgIds, deal, buyers: rows, asOf: c.asOf, now: c.asOf, weights });
        const list = buyers.map((b) => ({ id: b.id, name: b.companyName, ...res.get(b.id)!, override: null }));
        list.sort(compareMatches);
        // compareMatches order → rank; ties in score keep the engine's deterministic tiebreak.
        const ranks = list.map((r, i) => (c.targets.has(r.id) ? i + 1 : -1)).filter((r) => r > 0);
        const distinct = new Set(list.map((r) => r.score)).size;
        (perRanker.get(name) ?? perRanker.set(name, []).get(name)!).push({ ranks, distinct });
        if (name === "new" && examples.length < 6) {
          const target = list.find((r) => c.targets.has(r.id));
          examples.push({ deal: c.name, asOf: c.asOf.toISOString().slice(0, 10), buyers: list.length, winner: target?.name, winnerRank: ranks[0], winnerScore: target?.score, winnerHighlights: target?.highlights,
            top3: list.slice(0, 3).map((r) => ({ name: r.name, score: r.score, confidence: r.confidence, highlights: r.highlights })) });
        }
      }
      // The engine being replaced.
      const cur = buyers.map((b) => ({ id: b.id, key: computeMatch(deal, b.buyBox ?? { states: [], counties: [], assetTypes: [], minAcreage: null, maxAcreage: null, minPrice: null, maxPrice: null }).matchPercent }));
      (perRanker.get("current") ?? perRanker.set("current", []).get("current")!).push({ ranks: ranksOf(cur, c.targets), distinct: new Set(cur.map((x) => x.key)).size });
    }
    const results = [...perRanker.entries()].map(([name, per]) => summarize(name, per));
    console.log(`\n=== ${org.name}${org.isDemo ? " (demo — synthetic data)" : ""}: ${cases.length} deals with offers, ${buyers.length} buyers`);
    console.table(results.map((r) => ({ ranker: r.name, targets: r.n, "hit@1 %": r.hit1, "hit@3 %": r.hit3, "hit@5 %": r.hit5, "hit@10 %": r.hit10, MRR: r.mrr, "median rank": r.medianRank, "distinct scores/deal": r.distinctScoresAvg })));
    (report.orgs as unknown[]).push({ org: org.name, isDemo: org.isDemo, deals: cases.length, buyers: buyers.length, results, examples });
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
