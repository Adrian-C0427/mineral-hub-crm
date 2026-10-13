/**
 * Reports → SMS performance display helpers (client/src/lib/smsReport.ts) and
 * the shared KPI comparison pill math (client/src/lib/reportDelta.ts). The
 * counting rules are tested on the server (domain/smsMetrics, smsReport).
 *
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import {
  EMPTY_SMS_FILTERS, dayLabel, fmtCost, fmtDuration, fmtPer, furthestStepLabel, heatLevel, hourLabel, hourShort, lineLabel, outcomeLabel,
  sentByLabel, slotHours, slotLabel, smsQuery, touchLabel, trendLabel, trendTitle, withRow, wrongNumberLabel,
} from "../src/lib/smsReport";
import { deltaView } from "../src/lib/reportDelta";

describe("smsQuery", () => {
  const range = { from: "2026-09-01", to: "2026-09-30" };
  it("sends the period, the comparison and one param per filter value", () => {
    const q = new URLSearchParams(smsQuery({
      allTime: false, range, cmp: { from: "2026-08-01", to: "2026-08-31" },
      filters: { senders: ["u1", "none"], tags: ["Reeves, Oct 2026"], sources: [] },
    }));
    expect(q.get("from")).toBe("2026-09-01");
    expect(q.get("to")).toBe("2026-09-30");
    expect(q.get("compareFrom")).toBe("2026-08-01");
    expect(q.getAll("senders")).toEqual(["u1", "none"]);
    expect(q.getAll("tags")).toEqual(["Reeves, Oct 2026"]); // a comma inside a tag survives
    expect(q.has("sources")).toBe(false);
  });

  it("sends ?period=ALL with no dates and never a comparison for All", () => {
    const q = new URLSearchParams(smsQuery({ allTime: true, range: { from: "", to: "" }, cmp: { from: "2025-01-01", to: "2025-12-31" }, filters: EMPTY_SMS_FILTERS }));
    expect(q.get("period")).toBe("ALL");
    expect(q.has("from") || q.has("compareFrom")).toBe(false);
  });

  it("sends the scope (minerals unless asked for all texting)", () => {
    expect(new URLSearchParams(smsQuery({ allTime: false, range, cmp: null, filters: EMPTY_SMS_FILTERS })).get("scope")).toBe("minerals");
    expect(new URLSearchParams(smsQuery({ allTime: false, range, cmp: null, filters: EMPTY_SMS_FILTERS, scope: "all" })).get("scope")).toBe("all");
  });

  it("narrows a drill to one table row on top of the filters (they still apply)", () => {
    const base = smsQuery({ allTime: false, range, cmp: null, filters: { senders: [], tags: ["A", "B"], sources: [] } });
    const q = new URLSearchParams(withRow(base, { dim: "listTag", key: "(no tag)" }));
    expect(q.getAll("tags")).toEqual(["A", "B"]);
    expect([q.get("rowDim"), q.get("rowKey")]).toEqual(["listTag", "(no tag)"]);
  });
});

describe("fmtDuration", () => {
  it("reads naturally from seconds to days", () => {
    expect(fmtDuration(null)).toBe("N/A");
    expect(fmtDuration(42)).toBe("under a minute");
    expect(fmtDuration(12 * 60)).toBe("12 min");
    expect(fmtDuration(3600)).toBe("1 hr");
    expect(fmtDuration(5.5 * 3600)).toBe("5.5 hrs");
    expect(fmtDuration(47 * 3600)).toBe("47 hrs");
    expect(fmtDuration(2.34 * 86400)).toBe("2.3 days");
  });
});

describe("trend labels", () => {
  it("labels days and weeks by their first day and months by month", () => {
    expect(trendLabel("2026-10-05", "day")).toBe("Oct 5");
    expect(trendTitle("2026-10-05", "week")).toBe("Week of Oct 5, 2026");
    expect(trendTitle("2026-10-05", "day")).toBe("Oct 5, 2026");
    expect(trendLabel("2026-10", "month")).toBe("Oct ’26");
  });
});

describe("plain-language labels", () => {
  it("names the text-number buckets", () => {
    expect(touchLabel({ touch: 2, orLater: false })).toBe("Text 2");
    expect(touchLabel({ touch: 6, orLater: true })).toBe("6th or later");
    expect(touchLabel({ touch: 6, orLater: true }, true)).toBe("6th+");
  });

  it("describes outcomes in plain words", () => {
    expect(outcomeLabel("RESPONDED")).toBe("Replied");
    expect(outcomeLabel("OPTED_OUT")).toBe("Asked to stop");
    expect(outcomeLabel("INBOUND_FIRST")).toBe("Texted us first");
    expect(outcomeLabel("WRONG_NUMBER")).toBe("Wrong number");
    expect(outcomeLabel(null)).toBe("—");
  });

  it("says who sent a text: the contact, a person, or an automation", () => {
    expect(sentByLabel({ direction: "inbound", sender: null, source: null })).toEqual({ label: "The contact", automated: false });
    expect(sentByLabel({ direction: "outbound", sender: "Maria", source: "app" })).toEqual({ label: "Maria", automated: false });
    expect(sentByLabel({ direction: "outbound", sender: "Maria", source: "bulk_actions" })).toEqual({ label: "Maria (bulk send)", automated: false });
    expect(sentByLabel({ direction: "outbound", sender: null, source: "workflow" })).toEqual({ label: "Automation (workflow)", automated: true });
    expect(sentByLabel({ direction: "outbound", sender: null, source: null })).toEqual({ label: "Automation", automated: true });
  });
});

describe("deltaView (Reports comparison pill)", () => {
  it("shows counts as a relative change and rates as points", () => {
    expect(deltaView(0.125)).toEqual({ text: "+12.5%", tone: "good" });
    expect(deltaView(-0.4)).toEqual({ text: "−40%", tone: "bad" });
    expect(deltaView(0.053, { kind: "points" })).toEqual({ text: "+5.3 pts", tone: "good" });
    expect(deltaView(-0.01, { kind: "points" })).toEqual({ text: "−1 pt", tone: "bad" });
  });

  it("flips the tone where up is bad, and shows a sub-0.05 move as flat", () => {
    expect(deltaView(0.02, { kind: "points", invert: true }).tone).toBe("bad");
    expect(deltaView(-0.3, { invert: true }).tone).toBe("good");
    expect(deltaView(0.0004)).toEqual({ text: "0%", tone: "flat" });
  });
});

describe("KPI section helpers", () => {
  it("formats costs to the cent, tiny ones as under 1¢, missing ones as N/A", () => {
    expect(fmtCost(52.0884)).toBe("$52.09");
    expect(fmtCost(0.18)).toBe("$0.18");
    expect(fmtCost(0.004)).toBe("under 1¢");
    expect(fmtCost(0)).toBe("$0.00");
    expect(fmtCost(null)).toBe("N/A");
    expect(fmtPer(135.727)).toBe("135.7");
    expect(fmtPer(1234)).toBe("1,234");
    expect(fmtPer(null)).toBe("N/A");
  });

  it("names business lines, funnel steps and why someone is a wrong number", () => {
    expect([lineLabel("minerals"), lineLabel("real_estate"), lineLabel(null), lineLabel("odd")]).toEqual(["Minerals", "Real estate", "Not classified", "Not classified"]);
    expect(furthestStepLabel("accepted", false)).toBe("Offer accepted");
    expect(furthestStepLabel("offer", true)).toBe("Offer made · now dead");
    expect(furthestStepLabel(null, null)).toBe("—");
    expect(wrongNumberLabel({ wrongNumberAt: "2026-09-03T15:00:00Z", wrongNumberTouch: 2 })).toBe("Replied so after text 2");
    expect(wrongNumberLabel({ wrongNumberAt: null, wrongNumberTouch: null })).toBe("XLeads wrong-number tag");
  });

  it("labels best-time slots and picks the hours to show", () => {
    expect([hourLabel(0), hourLabel(9), hourLabel(12), hourLabel(17)]).toEqual(["12 AM", "9 AM", "12 PM", "5 PM"]);
    expect([hourShort(0), hourShort(9), hourShort(12), hourShort(23)]).toEqual(["12a", "9a", "12p", "11p"]);
    expect(slotLabel({ dow: 3, hour: 11 })).toBe("Wed 11 AM");
    expect(slotHours([{ hour: 14 }, { hour: 9 }])).toEqual([9, 10, 11, 12, 13, 14]);
    expect(slotHours([])).toHaveLength(11);
  });

  it("shades a cell against the best rate with enough people (small samples never set the scale)", () => {
    const cells = [{ rate: 0.2, small: false }, { rate: 0.1, small: false }, { rate: 0.9, small: true }];
    expect(heatLevel(0.2, cells)).toBe(1);
    expect(heatLevel(0.1, cells)).toBe(0.5);
    expect(heatLevel(0.9, cells)).toBe(1); // capped
    expect(heatLevel(null, cells)).toBe(0);
    expect(heatLevel(0.1, [{ rate: 0, small: false }])).toBe(0);
  });

  it("labels a carrier-health day", () => {
    expect(dayLabel("2026-09-30")).toBe("Sep 30");
  });
});
