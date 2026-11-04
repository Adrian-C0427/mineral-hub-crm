/**
 * Buyer matching engine — the acceptance list from the redesign brief, each as
 * a small scenario: scores separate for real reasons, geography leads, recency
 * outranks age, hard requirements disqualify, missing data never flatters.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_WEIGHTS, MATCH_CONFIG, NEUTRAL, checkBuyBox, compareMatches, decay, normalizeWeights, scoreBuyer,
  type Acquisition, type CrmHistory, type GeoContext, type MatchBuyBox, type MatchDeal,
} from "./buyerMatch.js";

const NOW = new Date("2026-11-04T12:00:00Z");
const MI = MATCH_CONFIG.mile;
const monthsAgo = (m: number) => new Date(NOW.getTime() - m * 30.4375 * 86_400_000);

const deal: MatchDeal = {
  state: "TX", counties: ["Leon"], abstractIds: ["TX-289182"], acreageNma: 5, nra: 0.625, askPrice: 25_000,
  assetTypes: ["MI"], operator: null, leaseStatuses: ["Held By Production"], royalty: 0.125,
};
const emptyBox: MatchBuyBox = {
  states: [], counties: [], assetTypes: [], minAcreage: null, maxAcreage: null, minPrice: null, maxPrice: null,
  minNra: null, maxNra: null, maxPricePerNma: null, leaseStatuses: [], operators: [], minRoyalty: null, strictKeys: [],
};
const noCrm: CrmHistory = {
  closedDeals: 0, closedSameCounty: 0, offersMade: 0, offersAccepted: 0, offersRejected: 0, passed: 0, passedSameCounty: 0,
  contacted: 0, responded: 0, engaged: 0, lastMeaningfulAt: null, relationshipStatus: "WARM", dealSizes: [],
};
const geo: GeoContext = {
  dealLocated: true,
  distanceM: new Map([["TX-289183", 0], ["TX-289200", 1.5 * MI], ["TX-289300", 7 * MI], ["TX-289400", 30 * MI], ["TX-161427", 22 * MI]]),
  adjacent: new Set(["TX-289183"]),
  neighborCounties: new Set(["TX|freestone", "TX|houston", "TX|madison", "TX|robertson", "TX|limestone", "TX|anderson"]),
  coveredCounties: new Set(["TX|leon", "TX|freestone"]),
};
let n = 0;
const acq = (p: Partial<Acquisition> & { date: Date }): Acquisition => ({
  docId: `d${++n}`, state: "TX", county: "Leon", abstractIds: [], docType: "MINERAL_DEED", interestPct: null, acreage: null, ...p,
});
const run = (acqs: Acquisition[], box: MatchBuyBox | null = emptyBox, crm: CrmHistory = noCrm, d: MatchDeal = deal, g: GeoContext = geo) =>
  scoreBuyer({ deal: d, buyer: { id: "b", buyBox: box, acquisitions: acqs, crm }, geo: g, now: NOW });
const comp = (r: ReturnType<typeof run>, key: string) => r.components.find((c) => c.key === key)!;

describe("geography leads the ranking", () => {
  it("ranks same abstract > adjacent > nearby > same county > neighbouring county > elsewhere", () => {
    const scores = [
      run([acq({ date: monthsAgo(3), abstractIds: ["TX-289182"] })]),
      run([acq({ date: monthsAgo(3), abstractIds: ["TX-289183"] })]),
      run([acq({ date: monthsAgo(3), abstractIds: ["TX-289200"] })]),
      run([acq({ date: monthsAgo(3), abstractIds: ["TX-289300"] })]),
      run([acq({ date: monthsAgo(3), county: "Freestone", abstractIds: ["TX-161427"] })]), // 22 mi, next county
      run([acq({ date: monthsAgo(3), abstractIds: ["TX-289400"] })]), // 30 mi, same county
      run([acq({ date: monthsAgo(3), county: "Houston" })]),
      run([acq({ date: monthsAgo(3), county: "Midland" })]),
    ].map((r) => comp(r, "geography").score!);
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThan(scores[i]);
    expect(scores[0]).toBeGreaterThanOrEqual(80);
    expect(scores[scores.length - 1]).toBe(0);
  });
  it("several recent purchases a few miles away beat one purchase 30 miles out", () => {
    const cluster = run([1, 2, 4, 6].map((m) => acq({ date: monthsAgo(m), abstractIds: ["TX-289200"] })));
    const far = run([acq({ date: monthsAgo(2), abstractIds: ["TX-289400"] })]);
    expect(comp(cluster, "geography").score!).toBeGreaterThan(comp(far, "geography").score! + 25);
    expect(cluster.facts.within10mi).toBe(4);
    expect(cluster.facts.nearestAcquisitionMiles).toBe(1.5);
  });
  it("a 22-mile acquisition in the next county is 'within 25 miles', not just 'neighbouring county'", () => {
    const r = run([acq({ date: monthsAgo(3), county: "Freestone", abstractIds: ["TX-161427"] })]);
    expect(r.facts.geoTier).toBe("within25mi");
    expect(comp(r, "geography").score!).toBeGreaterThan(comp(run([acq({ date: monthsAgo(3), county: "Freestone" })]), "geography").score!);
  });
  it("distinguishes no acquisitions (unknown) from acquisitions only far away (negative)", () => {
    const none = run([]);
    const far = run([acq({ date: monthsAgo(3), county: "Midland" }), acq({ date: monthsAgo(5), county: "Reeves" })]);
    expect(comp(none, "geography").score).toBeNull();
    expect(comp(far, "geography").score).toBe(0);
    expect(comp(far, "geography").reasons[0]).toMatch(/No recorded acquisitions in or around Leon County/);
    expect(none.score).toBeNull();
    expect(none.confidence).toBe("INSUFFICIENT");
  });
  it("treats a deal in a county Research does not cover as unknown, not as a confirmed miss", () => {
    const d = { ...deal, counties: ["Cherokee"], abstractIds: ["TX-073100"] };
    const r = run([acq({ date: monthsAgo(3), county: "Midland" })], emptyBox, noCrm, d, { ...geo, neighborCounties: new Set() });
    expect(comp(r, "geography").score).toBeNull();
    expect(comp(r, "geography").reasons[0]).toMatch(/no transaction records for Cherokee County/);
  });
  it("county-level records (no abstract) still count as same-county activity", () => {
    const r = run([acq({ date: monthsAgo(3) })]);
    expect(r.facts.geoTier).toBe("sameCounty");
    expect(r.facts.sameCounty).toBe(1);
    expect(r.facts.nearestAcquisitionMiles).toBeNull();
  });
});

describe("recency", () => {
  it("decays with the half-life", () => {
    expect(decay(0, 12)).toBe(1);
    expect(decay(12, 12)).toBeCloseTo(0.5);
    expect(decay(24, 12)).toBeCloseTo(0.25);
  });
  it("a same-abstract purchase last quarter outranks the same purchase four years ago, which still counts", () => {
    const recent = run([acq({ date: monthsAgo(3), abstractIds: ["TX-289182"] })]);
    const old = run([acq({ date: monthsAgo(48), abstractIds: ["TX-289182"] })]);
    expect(comp(recent, "geography").score!).toBeGreaterThan(comp(old, "geography").score!);
    expect(comp(old, "geography").score!).toBeGreaterThan(50);
    expect(comp(recent, "activity").score!).toBeGreaterThan(comp(old, "activity").score!);
    expect(comp(old, "activity").score!).toBeLessThanOrEqual(35);
    expect(comp(old, "activity").reasons[0]).toMatch(/No acquisitions recorded in the last 24 months/);
  });
  it("many acquisitions in the last 90 days read as current activity", () => {
    const r = run([1, 1.5, 2, 2.5, 3].map((m) => acq({ date: monthsAgo(m), county: "Harrison" })));
    expect(comp(r, "activity").score!).toBeGreaterThan(60);
    expect(comp(r, "activity").reasons[0]).toBe("5 acquisitions in the last 90 days");
    expect(r.facts.last90d).toBe(5);
  });
  it("a buyer with no recent deeds is not written off when the relationship is live", () => {
    const r = run([acq({ date: monthsAgo(30), abstractIds: ["TX-289182"] })], emptyBox, { ...noCrm, closedDeals: 2, lastMeaningfulAt: monthsAgo(1) });
    expect(comp(r, "relationship").score!).toBeGreaterThanOrEqual(65);
    expect(comp(r, "activity").score).toBe(40); // in conversation this quarter, despite the old deed
    expect(comp(r, "activity").reasons[0]).toBe("In contact with us 1 mo ago");
    const unknown = run([]);
    expect(r.score!).toBeGreaterThan((unknown.score ?? NEUTRAL) + 15);
  });
});

describe("buy box", () => {
  it("stated criteria move the score; an empty box is unknown, not a match", () => {
    const stated = run([], { ...emptyBox, states: ["TX"], counties: ["Leon"], assetTypes: ["MI"], minAcreage: 1, maxAcreage: 50 });
    const empty = run([], emptyBox);
    expect(comp(stated, "buyBox").score!).toBeGreaterThanOrEqual(90);
    expect(comp(empty, "buyBox").score).toBeNull();
    expect(comp(empty, "buyBox").reasons[0]).toMatch(/empty/);
  });
  it("meeting two criteria is weaker evidence than meeting five", () => {
    const two = run([], { ...emptyBox, states: ["TX"], counties: ["Leon"] });
    const five = run([], { ...emptyBox, states: ["TX"], counties: ["Leon"], assetTypes: ["MI"], minAcreage: 1, minPrice: 1000 });
    expect(comp(two, "buyBox").score!).toBeLessThan(comp(five, "buyBox").score!);
    expect(comp(five, "buyBox").score).toBe(100);
    expect(two.confidenceScore).toBeLessThan(five.confidenceScore);
  });
  it("a soft minimum the deal misses lowers the score; a near miss costs half", () => {
    const miss = run([], { ...emptyBox, counties: ["Leon"], minAcreage: 10 });
    const near = run([], { ...emptyBox, counties: ["Leon"], minAcreage: 6 });
    expect(miss.eligible).toBe(true);
    expect(comp(miss, "buyBox").score!).toBeLessThan(comp(near, "buyBox").score!);
    expect(comp(miss, "buyBox").reasons[0]).toBe("Acreage (NMA): 5 NMA outside 10 NMA–any");
    expect(comp(near, "buyBox").reasons[0]).toMatch(/just outside/);
  });
  it("a hard minimum the deal fails makes the buyer ineligible without touching the weighted score", () => {
    const r = run([acq({ date: monthsAgo(2), abstractIds: ["TX-289182"] })], { ...emptyBox, counties: ["Leon"], minAcreage: 10, strictKeys: ["acreage"] });
    expect(r.eligible).toBe(false);
    expect(r.hardConflicts).toEqual(["Acreage (NMA): 5 NMA outside 10 NMA–any (required)"]);
    expect(r.highlights[0]).toMatch(/required/);
    expect(r.score).not.toBeNull(); // still ranked within the ineligible group
  });
  it("a criterion the deal has no value for is not checked, and never counts as a miss", () => {
    const d = { ...deal, acreageNma: null, askPrice: null };
    const r = run([], { ...emptyBox, counties: ["Leon"], minAcreage: 10, strictKeys: ["acreage"] }, noCrm, d);
    expect(r.eligible).toBe(true);
    expect(comp(r, "buyBox").score).toBe(Math.round(100 * 1 * (0.7 + 0.3 * 0.2)));
    expect(comp(r, "buyBox").reasons.at(-1)).toMatch(/Acreage \(NMA\) not checked/);
  });
  it("checks every extended criterion", () => {
    const box: MatchBuyBox = { ...emptyBox, minNra: 0.5, maxPricePerNma: 3500, leaseStatuses: ["Held By Production"], operators: ["XTO"], minRoyalty: 0.15 };
    const checks = checkBuyBox(deal, box);
    const by = Object.fromEntries(checks.map((c) => [c.key, c]));
    expect(by.nra.result).toBe(1);
    expect(by.pricePerNma.result).toBe(0); // 5,000/NMA well over a 3,500 cap
    expect(checkBuyBox(deal, { ...box, maxPricePerNma: 4200 }).find((c) => c.key === "pricePerNma")!.result).toBe(0.5); // within 25%: near miss
    expect(by.leaseStatus.result).toBe(1);
    expect(by.operator.result).toBeNull(); // deal has no operator entered
    expect(by.royalty.result).toBe(0.5); // 12.5% vs a 15% floor: near miss
    expect(checkBuyBox(deal, { ...box, minRoyalty: 0.1875 }).find((c) => c.key === "royalty")!.result).toBe(0); // 12.5% vs 3/16: a miss
    expect(by.state.specified).toBe(false);
  });
});

describe("relationship", () => {
  it("no history is neutral and unknown — not a penalty, not a bonus", () => {
    const r = run([acq({ date: monthsAgo(2), abstractIds: ["TX-289182"] })]);
    expect(comp(r, "relationship").score).toBeNull();
    const w = DEFAULT_MATCH_WEIGHTS;
    expect(r.score).toBe(Math.round((w.geography * comp(r, "geography").score! + w.buyBox * NEUTRAL + w.activity * comp(r, "activity").score! + w.relationship * NEUTRAL + w.fit * NEUTRAL) / 100));
  });
  it("closing deals with us lifts the score; passing lowers it; emails alone do nothing", () => {
    const closer = run([], emptyBox, { ...noCrm, closedDeals: 3, closedSameCounty: 2, offersMade: 3, offersAccepted: 3 });
    const passer = run([], emptyBox, { ...noCrm, passed: 3, passedSameCounty: 2, contacted: 3 });
    const ghost = run([], emptyBox, { ...noCrm, contacted: 4 });
    expect(comp(closer, "relationship").score).toBe(NEUTRAL + 44);
    expect(comp(closer, "relationship").reasons[0]).toBe("Closed 3 deals with us (2 in this county)");
    expect(comp(passer, "relationship").score!).toBeLessThan(NEUTRAL);
    expect(comp(ghost, "relationship").score!).toBeLessThan(NEUTRAL);
    expect(comp(ghost, "relationship").reasons[0]).toBe("No response to 4 deals sent");
  });
  it("relationship cannot outweigh geography plus buy box", () => {
    const strongRel = run([acq({ date: monthsAgo(3), county: "Midland" })], { ...emptyBox, counties: ["Midland"], minAcreage: 20 },
      { ...noCrm, closedDeals: 3, relationshipStatus: "HOT", lastMeaningfulAt: monthsAgo(0.5) });
    const strongGeo = run([1, 3, 5].map((m) => acq({ date: monthsAgo(m), abstractIds: ["TX-289182"] })), { ...emptyBox, counties: ["Leon"], minAcreage: 1 });
    expect(strongGeo.score!).toBeGreaterThan(strongRel.score!);
  });
});

describe("deal fit", () => {
  it("compares asset type and size only when there is enough recorded data", () => {
    const royaltyBuyer = run([1, 2, 3, 4].map((m) => acq({ date: monthsAgo(m), docType: "ROYALTY_DEED" })));
    const mineralBuyer = run([1, 2, 3, 4].map((m) => acq({ date: monthsAgo(m), docType: "MINERAL_DEED" })));
    expect(comp(mineralBuyer, "fit").score).toBe(100);
    expect(comp(royaltyBuyer, "fit").score).toBe(0);
    expect(comp(run([acq({ date: monthsAgo(1) })]), "fit").score).toBeNull();
    const sized = run([], emptyBox, { ...noCrm, offersMade: 2, dealSizes: [{ nma: 4, price: 20_000 }, { nma: 12, price: 60_000 }] });
    expect(comp(sized, "fit").score).toBe(100);
    expect(comp(sized, "fit").reasons[0]).toMatch(/within their offer range of 4 NMA–12 NMA/);
  });
});

describe("combination, confidence and explanations", () => {
  it("buyers with identical sparse boxes no longer tie once their behaviour differs", () => {
    const box = { ...emptyBox, states: ["TX"], counties: ["Leon", "Freestone"] };
    const a = run([1, 2, 3].map((m) => acq({ date: monthsAgo(m), abstractIds: ["TX-289182"] })), box);
    const b = run([acq({ date: monthsAgo(8), abstractIds: ["TX-289300"] })], box);
    const c = run([acq({ date: monthsAgo(14), county: "Harrison" })], box);
    const d = run([], box);
    // nearby & recent > one modest purchase nearby > nothing known > bought only far away
    const scores = [a, b, d, c].map((r) => r.score!);
    expect(new Set(scores).size).toBe(4);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    expect(scores[1] - scores[2]).toBeGreaterThanOrEqual(4);
  });
  it("confidence tracks data completeness and is separate from the score", () => {
    const thin = run([acq({ date: monthsAgo(1), abstractIds: ["TX-289182"] })]);
    const rich = run([1, 2, 3].map((m) => acq({ date: monthsAgo(m), abstractIds: ["TX-289182"] })),
      { ...emptyBox, states: ["TX"], counties: ["Leon"], assetTypes: ["MI"], minAcreage: 1, minPrice: 1000 }, { ...noCrm, closedDeals: 1 });
    expect(thin.confidence).toBe("LOW");
    expect(rich.confidence).toBe("HIGH");
    expect(thin.score!).toBeGreaterThan(NEUTRAL + 15); // strong but thin: a real score, low confidence
    expect(comp(thin, "geography").score!).toBeGreaterThan(75);
    const countyOnly = run([acq({ date: monthsAgo(1), abstractIds: ["TX-289182"] })], emptyBox, noCrm, deal, { ...geo, dealLocated: false });
    expect(countyOnly.confidenceScore).toBeLessThan(thin.confidenceScore);
  });
  it("every explanation is backed by a fact in the inputs", () => {
    const r = run([acq({ date: monthsAgo(4), abstractIds: ["TX-289182"] }), acq({ date: monthsAgo(9), abstractIds: ["TX-289200"] })],
      { ...emptyBox, counties: ["Leon"], minAcreage: 10 }, { ...noCrm, closedDeals: 1 });
    expect(r.highlights).toEqual([
      "Bought 1 time in the same abstract (latest 4 mo ago)",
      "Closed 1 deal with us",
      "Acreage (NMA): 5 NMA outside 10 NMA–any",
    ]);
    expect(r.facts.recentNearby[0]).toMatchObject({ tier: "sameAbstract", miles: 0, county: "Leon" });
  });
  it("weights are configurable and normalised; the default total is 100", () => {
    expect(Object.values(DEFAULT_MATCH_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(normalizeWeights({ geography: 50, fit: -1 as number })).toEqual({ ...DEFAULT_MATCH_WEIGHTS, geography: 50 });
    const r = scoreBuyer({ deal, buyer: { id: "b", buyBox: emptyBox, acquisitions: [acq({ date: monthsAgo(1), abstractIds: ["TX-289182"] })], crm: noCrm }, geo, now: NOW, weights: { geography: 100, buyBox: 0, activity: 0, relationship: 0, fit: 0 } });
    expect(r.score).toBe(comp(r, "geography").score);
  });
  it("orders pinned, eligible by score, ineligible, excluded", () => {
    const rows = [
      { name: "ex", score: 90, confidenceScore: 1, eligible: true, override: "EXCLUDE" },
      { name: "inel", score: 95, confidenceScore: 1, eligible: false, override: null },
      { name: "mid", score: 60, confidenceScore: 0.5, eligible: true, override: null },
      { name: "top", score: 70, confidenceScore: 0.5, eligible: true, override: null },
      { name: "pin", score: 20, confidenceScore: 0.2, eligible: true, override: "PRIORITIZE" },
      { name: "none", score: null, confidenceScore: 0, eligible: true, override: null },
      { name: "tie", score: 60, confidenceScore: 0.9, eligible: true, override: null },
    ];
    expect(rows.sort(compareMatches).map((r) => r.name)).toEqual(["pin", "top", "tie", "mid", "none", "inel", "ex"]);
  });
});
