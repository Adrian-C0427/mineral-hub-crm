import { describe, it, expect } from "vitest";
import {
  DELIVERED_STATUSES, FAILED_STATUSES, PENDING_STATUSES,
  isDeliveredStatus, isFailedStatus, isPendingStatus, isSentStatus, summarizeContact,
} from "./smsMetrics.js";
import {
  BEST_TIME_MIN_SAMPLE, DELTA_KIND, DRILL_SETS, MAX_FILTER_VALUES, NO_SENDER, NO_TAG, UNASSIGNED_LABEL, UNKNOWN_USER_LABEL,
  allRange, bestTimeGrid, bucketKeys, bucketStart, computeKpis, cohortCounts, costSummary, dayRange, drillRow, effectiveScope,
  fillTrend, funnelSummary, furthestStep, healthDays, healthOf, isValidTimeZone, isoDay, lineCounts, listParam, mergeBreakdown,
  mergeQuality, parseIsoDay, parseReportScope, phoneTagSets, pointChange, rangeJson, readHlConfig, relativeChange,
  requestedPeriod, senderName, smsDeltas, speedSummary, trendBucket, waitingSince, type FunnelCounts,
} from "./smsReport.js";

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const NOW = new Date("2026-10-12T18:30:00Z");

describe("status lists for SQL", () => {
  // Every status HighLevel documents, plus blanks and odd spellings: the SQL
  // classification (list membership after lower/trim) must match the helpers.
  const statuses = ["pending", "scheduled", "queued", "sent", "delivered", "read", "undelivered", "failed", "opened",
    "clicked", "opt_out", "connected", "", null, " Delivered ", "FAILED", "unknown_new_status"];
  const sqlNorm = (s: string | null) => (s ?? "").trim().toLowerCase();
  it.each(statuses)("classifies %j the same way", (s) => {
    expect(PENDING_STATUSES.includes(sqlNorm(s))).toBe(isPendingStatus(s));
    expect(!PENDING_STATUSES.includes(sqlNorm(s))).toBe(isSentStatus(s));
    expect(DELIVERED_STATUSES.includes(sqlNorm(s))).toBe(isDeliveredStatus(s));
    expect(FAILED_STATUSES.includes(sqlNorm(s))).toBe(isFailedStatus(s));
  });
});

describe("periods (UTC days)", () => {
  it("parses only real calendar days", () => {
    expect(parseIsoDay("2026-02-28")?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(parseIsoDay("2026-02-30")).toBeNull();
    expect(parseIsoDay("0202-07-09")).toBeNull();
    expect(parseIsoDay("2026-1-5")).toBeNull();
    expect(parseIsoDay(["2026-01-01"])).toBeNull();
    expect(parseIsoDay(undefined)).toBeNull();
  });

  it("covers the whole last day: [from 00:00Z, to + 1 day 00:00Z)", () => {
    const r = dayRange(D("2026-09-01"), D("2026-09-30"));
    expect(r.from.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(r.toExclusive.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(rangeJson(r)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("swaps a reversed range instead of returning nothing", () => {
    expect(rangeJson(dayRange(D("2026-10-12"), D("2026-10-01")))).toEqual({ from: "2026-10-01", to: "2026-10-12" });
  });

  it("defaults to this calendar year and compares only when both compare days are valid", () => {
    const p = requestedPeriod({}, NOW);
    expect(p.all).toBe(false);
    if (p.all) return;
    expect(rangeJson(p.range)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(p.compare).toBeNull();
    const c = requestedPeriod({ from: "2026-09-01", to: "2026-09-30", compareFrom: "2026-08-01", compareTo: "2026-08-31" }, NOW);
    expect(!c.all && c.compare && rangeJson(c.compare)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    const half = requestedPeriod({ from: "2026-09-01", to: "2026-09-30", compareFrom: "2026-08-01", compareTo: "nope" }, NOW);
    expect(!half.all && half.compare).toBeNull();
  });

  it("All ignores from/to/compare and spans first..last text (today when there are none)", () => {
    expect(requestedPeriod({ period: "ALL", from: "2026-01-01", compareFrom: "2025-01-01", compareTo: "2025-12-31" }, NOW)).toEqual({ all: true });
    const r = allRange(new Date("2025-08-20T15:04:00Z"), new Date("2026-10-11T23:59:00Z"), NOW);
    expect(rangeJson(r)).toEqual({ from: "2025-08-20", to: "2026-10-11" });
    expect(rangeJson(allRange(null, null, NOW))).toEqual({ from: "2026-10-12", to: "2026-10-12" });
  });
});

describe("trend buckets", () => {
  const span = (days: number) => dayRange(D("2026-01-01"), new Date(D("2026-01-01").getTime() + (days - 1) * 86_400_000));
  it("is daily up to 62 days, weekly up to 400, monthly beyond", () => {
    expect(trendBucket(span(1))).toBe("day");
    expect(trendBucket(span(62))).toBe("day");
    expect(trendBucket(span(63))).toBe("week");
    expect(trendBucket(span(365))).toBe("week");
    expect(trendBucket(span(400))).toBe("week");
    expect(trendBucket(span(401))).toBe("month");
  });

  it("starts weeks on Monday (like Postgres date_trunc('week'))", () => {
    expect(isoDay(bucketStart(new Date("2026-01-01T12:00:00Z"), "week"))).toBe("2025-12-29"); // Thursday → Monday
    expect(isoDay(bucketStart(new Date("2026-10-12T23:00:00Z"), "week"))).toBe("2026-10-12"); // Monday stays
    expect(isoDay(bucketStart(new Date("2026-10-18T23:00:00Z"), "week"))).toBe("2026-10-12"); // Sunday → previous Monday
    expect(isoDay(bucketStart(new Date("2026-10-18T23:00:00Z"), "month"))).toBe("2026-10-01");
  });

  it("lists every bucket the range touches", () => {
    expect(bucketKeys(dayRange(D("2026-09-29"), D("2026-10-02")), "day")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(bucketKeys(dayRange(D("2025-11-15"), D("2026-02-01")), "month")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    const weeks = bucketKeys(dayRange(D("2026-01-01"), D("2026-12-31")), "week");
    expect(weeks[0]).toBe("2025-12-29");
    expect(weeks.at(-1)).toBe("2026-12-28");
    expect(weeks).toHaveLength(53);
  });

  it("fills empty buckets with zeros and keeps the counted ones", () => {
    const pts = fillTrend(dayRange(D("2026-10-01"), D("2026-10-03")), "day",
      [{ period: "2026-10-02", sent: 5, delivered: 4, failed: 1, inbound: 2 }]);
    expect(pts).toEqual([
      { period: "2026-10-01", sent: 0, delivered: 0, failed: 0, inbound: 0 },
      { period: "2026-10-02", sent: 5, delivered: 4, failed: 1, inbound: 2 },
      { period: "2026-10-03", sent: 0, delivered: 0, failed: 0, inbound: 0 },
    ]);
  });
});

describe("KPIs", () => {
  it("is N/A (null) wherever a denominator is 0", () => {
    const k = computeKpis({ sent: 0, delivered: 0, failed: 0, inbound: 3, contactsTexted: 0 },
      { reached: 0, responded: 0, optedOut: 0, avgSeconds: 120, medianSeconds: 60 });
    expect(k.responseRate).toBeNull();
    expect(k.optOutRate).toBeNull();
    expect(k.avgTextsPerContact).toBeNull();
    expect(k.avgResponseSeconds).toBeNull();
    expect(k.medianResponseSeconds).toBeNull();
    expect(k.repliesReceived).toBe(3);
  });

  it("computes the rates from the cohort and texts per contact from volume", () => {
    const k = computeKpis({ sent: 300, delivered: 270, failed: 12, inbound: 80, contactsTexted: 120 },
      { reached: 100, responded: 25, optedOut: 4, avgSeconds: 7200, medianSeconds: 1800 });
    expect(k.responseRate).toBe(0.25);
    expect(k.optOutRate).toBe(0.04);
    expect(k.avgTextsPerContact).toBe(2.5);
    expect(k.medianResponseSeconds).toBe(1800);
  });

  it("sums the cohort rows (touches < 1 never counts as reached)", () => {
    expect(cohortCounts([
      { touches: 1, outcome: "RESPONDED", count: 10 }, { touches: 2, outcome: "NO_REPLY", count: 30 },
      { touches: 1, outcome: "OPTED_OUT", count: 2 }, { touches: 3, outcome: "LATE_REPLY", count: 1 },
      { touches: 0, outcome: "INBOUND_FIRST", count: 9 },
    ])).toEqual({ reached: 43, responded: 10, optedOut: 2, lateReplies: 1, respondedTexts: 10 });
  });
});

describe("still waiting and texts before a reply", () => {
  it("averages the texts each replier got up to their reply (N/A when nobody replied)", () => {
    const c = cohortCounts([
      { touches: 1, outcome: "RESPONDED", count: 6 }, { touches: 3, outcome: "RESPONDED", count: 2 },
      { touches: 5, outcome: "NO_REPLY", count: 40 }, { touches: 2, outcome: "OPTED_OUT", count: 1 },
    ]);
    expect(c.respondedTexts).toBe(12);
    const v = { sent: 300, delivered: 280, failed: 5, inbound: 20, contactsTexted: 49 };
    const k = computeKpis(v, { reached: c.reached, responded: c.responded, optedOut: c.optedOut, avgSeconds: 60, medianSeconds: 60, respondedTexts: c.respondedTexts });
    expect(k.avgTextsBeforeReply).toBe(1.5);
    expect(computeKpis(v, { reached: 40, responded: 0, optedOut: 0, avgSeconds: null, medianSeconds: null, respondedTexts: 0 }).avgTextsBeforeReply).toBeNull();
    // A caller that doesn't count it leaves it N/A, never 0.
    expect(computeKpis(v, { reached: 40, responded: 5, optedOut: 0, avgSeconds: null, medianSeconds: null }).avgTextsBeforeReply).toBeNull();
  });

  it("lifts the still-waiting count, 0 when not counted", () => {
    const v = { sent: 0, delivered: 0, failed: 0, inbound: 0, contactsTexted: 0 };
    const c = { reached: 10, responded: 2, optedOut: 0, avgSeconds: null, medianSeconds: null };
    expect(computeKpis(v, c, { stillWaiting: 7 }).stillWaiting).toBe(7);
    expect(computeKpis(v, c).stillWaiting).toBe(0);
    // Waiting people stay in the response rate's "reached".
    expect(computeKpis(v, c, { stillWaiting: 7 }).responseRate).toBe(0.2);
  });

  it("waits the response window back from now — the same window a reply is still counted in", () => {
    expect(waitingSince(NOW, 30).toISOString()).toBe("2026-09-12T18:30:00.000Z");
    expect(waitingSince(NOW, 7).toISOString()).toBe("2026-10-05T18:30:00.000Z");
    // Someone last texted exactly at the cut-off who replies now still counts as a response.
    const last = waitingSince(NOW, 30);
    const s = summarizeContact([
      { direction: "outbound", status: "delivered", sentAt: last, hlUserId: null, optOut: false },
      { direction: "inbound", status: "delivered", sentAt: NOW, hlUserId: null, optOut: false },
    ], 30);
    expect(s.outcome).toBe("RESPONDED");
  });

  it("only a text that reached them keeps someone waiting: a failed one doesn't restart the window", () => {
    const since = waitingSince(NOW, 30);
    const day = 86_400_000;
    const msgs = [
      { direction: "outbound", status: "delivered", sentAt: new Date(since.getTime() - 10 * day), hlUserId: null, optOut: false },
      { direction: "outbound", status: "failed", sentAt: new Date(NOW.getTime() - day), hlUserId: null, optOut: false },
    ];
    expect(summarizeContact(msgs, 30).outcome).toBe("NO_REPLY");
    // Their last text is recent, but a reply now comes 40 days after the last one that reached them.
    const reply = { direction: "inbound", status: "delivered", sentAt: NOW, hlUserId: null, optOut: false };
    expect(summarizeContact([...msgs, reply], 30).outcome).toBe("LATE_REPLY");
  });

  it("compares both as a relative change", () => {
    expect(DELTA_KIND.stillWaiting).toBe("relative");
    expect(DELTA_KIND.avgTextsBeforeReply).toBe("relative");
    const v = { sent: 0, delivered: 0, failed: 0, inbound: 0, contactsTexted: 0 };
    const prev = computeKpis(v, { reached: 10, responded: 4, optedOut: 0, avgSeconds: null, medianSeconds: null, respondedTexts: 8 }, { stillWaiting: 20 });
    const cur = computeKpis(v, { reached: 10, responded: 4, optedOut: 0, avgSeconds: null, medianSeconds: null, respondedTexts: 12 }, { stillWaiting: 30 });
    const d = smsDeltas(cur, prev);
    expect(d.stillWaiting).toBe(0.5);
    expect(d.avgTextsBeforeReply).toBe(0.5);
  });
});

describe("comparisons", () => {
  it("changes counts relatively and is null without a base", () => {
    expect(relativeChange(150, 100)).toBe(0.5);
    expect(relativeChange(50, 100)).toBe(-0.5);
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(0, 0)).toBeNull();
    expect(relativeChange(null, 10)).toBeNull();
  });

  it("changes rates by points", () => {
    expect(pointChange(0.3, 0.25)).toBeCloseTo(0.05);
    expect(pointChange(null, 0.25)).toBeNull();
  });

  it("uses points for rates and relative change for everything else", () => {
    expect(Object.entries(DELTA_KIND).filter(([, v]) => v === "points").map(([k]) => k).sort()).toEqual([
      "answeredWithinHourRate", "interestedRate", "neverAnsweredRate", "offerAcceptanceRate", "optOutRate", "responseRate", "wrongNumberRate",
    ]);
    const base = computeKpis({ sent: 100, delivered: 90, failed: 5, inbound: 20, contactsTexted: 50 },
      { reached: 40, responded: 10, optedOut: 2, avgSeconds: 600, medianSeconds: 300 });
    const cur = computeKpis({ sent: 200, delivered: 180, failed: 5, inbound: 20, contactsTexted: 80 },
      { reached: 80, responded: 24, optedOut: 2, avgSeconds: 600, medianSeconds: 600 });
    const d = smsDeltas(cur, base);
    expect(d.textsSent).toBe(1);
    expect(d.responseRate).toBeCloseTo(0.3 - 0.25);
    expect(d.optOutRate).toBeCloseTo(0.025 - 0.05);
    expect(d.medianResponseSeconds).toBe(1);
    expect(d.textsFailed).toBe(0);
  });
});

describe("breakdowns", () => {
  const users = [{ id: "u1", name: "Maria", email: null }];
  it("names team members, automation and unknown ids", () => {
    expect(senderName("u1", users)).toBe("Maria");
    expect(senderName(null, users)).toBe(UNASSIGNED_LABEL);
    expect(senderName(NO_SENDER, users)).toBe(UNASSIGNED_LABEL);
    expect(senderName("u9", users)).toBe(UNKNOWN_USER_LABEL);
  });

  it("joins the response and volume sides and sorts by contacts reached", () => {
    const rows = mergeBreakdown(
      [{ key: "u1", reached: 10, responded: 4, optedOut: 1, median: 99.6 }, { key: "none", reached: 30, responded: 3, optedOut: 0, median: null }],
      [{ key: "u1", textsSent: 25 }, { key: "u2", textsSent: 7 }],
      (k) => senderName(k, users),
    );
    expect(rows.map((r) => [r.name, r.contactsReached, r.textsSent])).toEqual([
      [UNASSIGNED_LABEL, 30, 0], ["Maria", 10, 25], [UNKNOWN_USER_LABEL, 0, 7],
    ]);
    expect(rows[1]).toMatchObject({ responded: 4, responseRate: 0.4, optedOut: 1, medianResponseSeconds: 100 });
    expect(rows[2].responseRate).toBeNull(); // sent texts but nobody first reached in the period
  });
});

describe("stored config", () => {
  it("reads what the report needs and tolerates anything else", () => {
    expect(readHlConfig(null)).toEqual({
      locationName: null, responseWindowDays: 30, hlUsers: [],
      sync: { phase: null, previewTexts: null, imported: 0, lastRun: null },
      scope: null, pricePerSegment: null, locationTimezone: null, hlPipelines: [], hlTags: [],
    });
    const c = readHlConfig({
      locationName: "XLeads – Carsa", responseWindowDays: 14, _secret: "x",
      hlUsers: [{ id: "u1", name: "Maria", email: "m@x.test" }, { name: "no id" }, null],
      hlSync: { phase: "importing", imported: 1234, preview: { texts: 9000, at: "2026-10-01T00:00:00Z" }, lastRun: { ok: false, message: "rate limited" } },
    });
    expect(c).toMatchObject({ locationName: "XLeads – Carsa", responseWindowDays: 14, hlUsers: [{ id: "u1", name: "Maria", email: "m@x.test" }] });
    expect(c.sync).toEqual({ phase: "importing", previewTexts: 9000, imported: 1234, lastRun: { at: null, ok: false, message: "rate limited" } });
    expect(readHlConfig({ responseWindowDays: 45 }).responseWindowDays).toBe(30); // not an allowed window
  });
});

describe("listParam", () => {
  it("takes one value per repetition, never comma-splits, trims, de-duplicates and caps", () => {
    expect(listParam("Reeves, Oct 2026")).toEqual(["Reeves, Oct 2026"]);
    expect(listParam(["a", " a ", "b", ""])).toEqual(["a", "b"]);
    expect(listParam(undefined)).toEqual([]);
    expect(listParam([{ x: 1 }, "ok"])).toEqual(["ok"]);
    expect(listParam(Array.from({ length: MAX_FILTER_VALUES + 50 }, (_, i) => `t${i}`))).toHaveLength(MAX_FILTER_VALUES);
  });
});

describe("KPI settings in the stored config", () => {
  it("reads the saved minerals filter, price and time zone, rejecting bad values", () => {
    const c = readHlConfig({
      scope: { mineralTags: ["reeves county"], realEstateTags: [], mineralPipelineIds: ["p1"] },
      pricePerSegment: 0.0091, locationTimezone: "America/Chicago",
      hlPipelines: [{ id: "p1", name: "Minerals", stages: [] }, { name: "no id" }], hlTags: ["reeves county", 7, ""],
    });
    expect(c.scope).toEqual({ mineralTags: ["reeves county"], realEstateTags: [], mineralPipelineIds: ["p1"] });
    expect(c.pricePerSegment).toBe(0.0091);
    expect(c.locationTimezone).toBe("America/Chicago");
    expect(c.hlPipelines).toEqual([{ id: "p1", name: "Minerals" }]);
    expect(c.hlTags).toEqual(["reeves county"]);
    const bad = readHlConfig({ scope: { mineralTags: "reeves" }, pricePerSegment: -1, locationTimezone: "Mars/Olympus" });
    expect([bad.scope, bad.pricePerSegment, bad.locationTimezone]).toEqual([null, null, null]);
    expect(readHlConfig({ pricePerSegment: "0.01" }).pricePerSegment).toBeNull();
    expect(readHlConfig({ pricePerSegment: 0 }).pricePerSegment).toBe(0); // free texting is a price
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("uses the saved filter, else the same suggestion the sync classifies with", () => {
    const saved = readHlConfig({ scope: { mineralTags: [], realEstateTags: ["sub2"], mineralPipelineIds: [] }, hlPipelines: [{ id: "p1", name: "Minerals" }] });
    expect(effectiveScope(saved).mineralPipelineIds).toEqual([]);
    const suggested = readHlConfig({ hlPipelines: [{ id: "p1", name: "Minerals v2" }, { id: "p2", name: "JV's" }], hlTags: ["leon county", "sub2"] });
    expect(effectiveScope(suggested)).toEqual({ mineralTags: ["leon county"], realEstateTags: [], mineralPipelineIds: ["p1"] });
  });

  it("defaults the report to minerals only", () => {
    expect(parseReportScope(undefined)).toBe("minerals");
    expect(parseReportScope("all")).toBe("all");
    expect(parseReportScope(["all"])).toBe("minerals");
  });

  it("counts anything not minerals or real estate (incl. not classified yet) as unclassified", () => {
    expect(lineCounts([{ line: "minerals", n: 5 }, { line: "real_estate", n: 2 }, { line: null, n: 3 }, { line: "unclassified", n: 1 }, { line: "odd", n: 1 }]))
      .toEqual({ minerals: 5, realEstate: 2, unclassified: 5 });
  });
});

const FUNNEL: FunnelCounts = {
  reached: 1000, responded: 100, opportunity: 40, offer: 20, accepted: 8, contract: 6, closed: 4, dead: 7, preExisting: 3,
  cohortTexts: 2600, toOpportunity: { avg: 90000.4, median: 86400.6 }, toClose: { avg: 3e6, median: 2.5e6, known: 3 },
};

describe("funnelSummary", () => {
  it("gives step-to-step and overall conversion and the per-deal figures", () => {
    const f = funnelSummary(FUNNEL);
    expect(f.steps.map((s) => [s.key, s.count, s.fromPrevious, s.fromReached])).toEqual([
      ["reached", 1000, null, 1], ["responded", 100, 0.1, 0.1], ["opportunity", 40, 0.4, 0.04], ["offer", 20, 0.5, 0.02],
      ["accepted", 8, 0.4, 0.008], ["contract", 6, 0.75, 0.006], ["closed", 4, 4 / 6, 0.004],
    ]);
    expect(f).toMatchObject({
      dead: 7, preExisting: 3, interestedRate: 0.04, offerAcceptanceRate: 0.4, contactsPerOffer: 50, contactsPerClosedDeal: 250,
      textsPerClosedDeal: 650, toOpportunity: { avgSeconds: 90000, medianSeconds: 86401 },
      toClose: { avgSeconds: 3e6, medianSeconds: 2.5e6, known: 3, unknown: 1 },
    });
  });

  it("is N/A on every zero denominator, never 0 or Infinity", () => {
    const f = funnelSummary({ ...FUNNEL, reached: 0, responded: 0, opportunity: 0, offer: 0, accepted: 0, contract: 0, closed: 0, dead: 0,
      toOpportunity: { avg: null, median: null }, toClose: { avg: null, median: null, known: 0 } });
    expect(f.steps.every((s) => s.fromReached === null)).toBe(true);
    expect(f.steps.slice(1).every((s) => s.fromPrevious === null)).toBe(true);
    expect([f.interestedRate, f.offerAcceptanceRate, f.contactsPerOffer, f.contactsPerClosedDeal, f.textsPerClosedDeal]).toEqual([null, null, null, null, null]);
    expect(f.toOpportunity).toEqual({ avgSeconds: null, medianSeconds: null });
    expect(f.toClose).toEqual({ avgSeconds: null, medianSeconds: null, known: 0, unknown: 0 });
  });

  it("names a person's furthest step and whether every opportunity is dead now", () => {
    const x = { n: 2, offer: true, accepted: false, contract: false, closed: false, alive: 0 };
    expect(furthestStep(x)).toEqual({ step: "offer", dead: true });
    expect(furthestStep({ ...x, accepted: true, contract: true, closed: true, alive: 1 })).toEqual({ step: "closed", dead: false });
    expect(furthestStep({ ...x, offer: false, alive: 2 })).toEqual({ step: "opportunity", dead: false });
    expect(furthestStep({ ...x, n: 0 })).toBeNull();
  });
});

describe("costSummary", () => {
  const results = { responded: 50, opportunities: 10, offers: 4, closed: 0 };
  it("prices the segments and divides by each result, N/A where there is none", () => {
    const c = costSummary(10_000, 12, 0.0091, results);
    expect(c).toMatchObject({ pricePerSegment: 0.0091, segments: 10_000, unknownSegments: 12, total: 91 });
    expect(c.perReply).toBeCloseTo(1.82);
    expect(c.perOpportunity).toBeCloseTo(9.1);
    expect(c.perOffer).toBeCloseTo(22.75);
    expect(c.perClosedDeal).toBeNull();
  });

  it("is N/A everywhere without a price", () => {
    expect(costSummary(10_000, 0, null, results)).toMatchObject({ total: null, perReply: null, perOpportunity: null, perOffer: null, perClosedDeal: null });
  });
});

describe("speedSummary", () => {
  it("shares are of everyone who replied, so never-answered completes the picture", () => {
    const s = speedSummary({ responded: 40, answered: 30, within5m: 8, within1h: 20, within24h: 28, avg: 5000.2, median: 1800.4 });
    expect(s).toEqual({
      responded: 40, answered: 30, never: 10, avgSeconds: 5000, medianSeconds: 1800,
      within5mRate: 0.2, within1hRate: 0.5, within24hRate: 0.7, neverRate: 0.25,
    });
    expect(speedSummary({ responded: 0, answered: 0, within5m: 0, within1h: 0, within24h: 0, avg: null, median: null }))
      .toMatchObject({ medianSeconds: null, within1hRate: null, neverRate: null });
  });
});

describe("computeKpis with the newer sections", () => {
  it("lifts the headline funnel, cost, speed and wrong-number figures", () => {
    const funnel = funnelSummary(FUNNEL);
    const k = computeKpis({ sent: 2000, delivered: 1800, failed: 50, inbound: 300, contactsTexted: 900 },
      { reached: 1000, responded: 100, optedOut: 20, avgSeconds: 10, medianSeconds: 5 },
      { wrongNumbers: 80, funnel, cost: costSummary(2400, 0, 0.01, { responded: 100, opportunities: 40, offers: 20, closed: 4 }),
        speed: speedSummary({ responded: 100, answered: 80, within5m: 10, within1h: 50, within24h: 75, avg: 900, median: 600 }) });
    expect(k).toMatchObject({
      wrongNumbers: 80, wrongNumberRate: 0.08, opportunities: 40, interestedRate: 0.04, offers: 20, offerAcceptanceRate: 0.4, closedDeals: 4,
      textingCost: 24, costPerReply: 0.24, costPerOpportunity: 0.6, costPerOffer: 1.2, costPerClosedDeal: 6,
      medianAnswerSeconds: 600, answeredWithinHourRate: 0.5, neverAnsweredRate: 0.2,
    });
  });

  it("leaves a missing section as zeros and N/A", () => {
    const k = computeKpis({ sent: 0, delivered: 0, failed: 0, inbound: 0, contactsTexted: 0 }, { reached: 0, responded: 0, optedOut: 0, avgSeconds: null, medianSeconds: null });
    expect(k).toMatchObject({ wrongNumbers: 0, wrongNumberRate: null, opportunities: 0, interestedRate: null, textingCost: null, medianAnswerSeconds: null });
  });
});

describe("bestTimeGrid", () => {
  it("mutes small samples and picks the best three slots with enough data", () => {
    const n = BEST_TIME_MIN_SAMPLE;
    const g = bestTimeGrid([
      { dow: 2, hour: 10, reached: n, responded: 4 }, // 20%
      { dow: 3, hour: 11, reached: 50, responded: 10 }, // 20%, more data → ranks first
      { dow: 1, hour: 9, reached: n - 1, responded: 9 }, // 47% but too few people
      { dow: 4, hour: 18, reached: 40, responded: 6 }, // 15%
      { dow: 5, hour: 12, reached: 40, responded: 2 }, // 5%
      { dow: 6, hour: 8, reached: 40, responded: 0 }, // never "best"
      { dow: 9, hour: 8, reached: 40, responded: 9 }, // not a weekday
      { dow: 1, hour: 3, reached: 0, responded: 0 },
    ]);
    expect(g.cells).toHaveLength(6);
    expect(g.cells[0]).toMatchObject({ dow: 1, hour: 9, small: true });
    expect(g.best.map((c) => [c.dow, c.hour])).toEqual([[3, 11], [2, 10], [4, 18]]);
  });
});

describe("phone-list quality", () => {
  it("classifies the org's tags once with the phone-tag rules (landline includes sms incapable)", () => {
    expect(phoneTagSets(["Wrong Number-2", "wrong number-1", "disconnected number-1", "landline", "SMS incapable", "switch phone (2)",
      "switch phone (1)", "all numbers exhausted", "leon county", "wrong numbers list"])).toEqual({
      wrongNumber: ["Wrong Number-2", "wrong number-1"], disconnected: ["disconnected number-1"], landline: ["landline", "SMS incapable"],
      rotated: ["switch phone (2)"], exhausted: ["all numbers exhausted"],
      any: ["Wrong Number-2", "wrong number-1", "disconnected number-1", "landline", "SMS incapable", "switch phone (2)", "all numbers exhausted"],
    });
  });

  it("joins people-based shares with delivery from the texts, N/A on empty sides", () => {
    const rows = mergeQuality(
      [{ key: "leon county", reached: 200, responded: 20, wrongNumber: 30, disconnected: 10, landline: 4, rotated: 50, exhausted: 6 }],
      [{ key: "leon county", sent: 500, delivered: 450 }, { key: NO_TAG, sent: 10, delivered: 9 }],
      (k) => k,
    );
    expect(rows[0]).toMatchObject({
      key: "leon county", deliveryRate: 0.9, responseRate: 0.1, wrongNumberRate: 0.15, disconnectedRate: 0.05, landlineRate: 0.02,
      rotatedRate: 0.25, exhaustedRate: 0.03,
    });
    expect(rows[1]).toMatchObject({ key: NO_TAG, reached: 0, responseRate: null, wrongNumberRate: null, deliveryRate: 0.9 });
  });
});

describe("carrier health", () => {
  it("fills every day of the period and lists the days that breached a threshold", () => {
    const r = dayRange(D("2026-09-29"), D("2026-10-01"));
    const h = healthDays(r, [
      { day: "2026-09-30", sent: 400, failed: 80, reached: 300, optOuts: 3 }, // 20% failed
      { day: "2026-10-01", sent: 50, failed: 20, reached: 30, optOuts: 5 }, // too few texts to judge
    ]);
    expect(h.days.map((d) => [d.day, d.sent, d.small, d.warnings])).toEqual([
      ["2026-09-29", 0, true, []], ["2026-09-30", 400, false, ["failure"]], ["2026-10-01", 50, true, []],
    ]);
    expect(h.days[0].failureRate).toBeNull();
    expect(h.breachDays).toEqual(["2026-09-30"]);
    expect(healthOf({ sent: 700, failed: 10, reached: 500, optOuts: 30 })).toMatchObject({ optOutRate: 0.06, warnings: ["optOut"] });
  });
});

describe("drill sets", () => {
  it("lists the new sets and reads a table row to narrow to", () => {
    for (const s of ["stillWaiting", "wrongNumber", "unclassified", "realEstate", "opportunity", "offer", "accepted", "closed", "dead", "unanswered",
      "disconnected", "landline", "rotated", "exhausted"]) expect(DRILL_SETS).toContain(s);
    expect(drillRow({ rowDim: "listTag", rowKey: " Leon County " })).toEqual({ dim: "listTag", key: " Leon County " });
    expect(drillRow({ rowDim: "county", rowKey: "x" })).toBeNull();
    expect(drillRow({ rowDim: "tag" })).toBeNull();
    expect(drillRow({ rowDim: "tag", rowKey: ["a", "b"] })).toBeNull();
  });
});
