import { describe, it, expect } from "vitest";
import {
  DELIVERED_STATUSES, FAILED_STATUSES, PENDING_STATUSES,
  isDeliveredStatus, isFailedStatus, isPendingStatus, isSentStatus,
} from "./smsMetrics.js";
import {
  DELTA_KIND, MAX_FILTER_VALUES, NO_SENDER, UNASSIGNED_LABEL, UNKNOWN_USER_LABEL,
  allRange, bucketKeys, bucketStart, computeKpis, cohortCounts, dayRange, fillTrend, isoDay, listParam, mergeBreakdown,
  parseIsoDay, pointChange, rangeJson, readHlConfig, relativeChange, requestedPeriod, senderName, smsDeltas, trendBucket,
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
    ])).toEqual({ reached: 43, responded: 10, optedOut: 2, lateReplies: 1 });
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

  it("uses points for the two rates and relative change for everything else", () => {
    expect(Object.entries(DELTA_KIND).filter(([, v]) => v === "points").map(([k]) => k).sort()).toEqual(["optOutRate", "responseRate"]);
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
