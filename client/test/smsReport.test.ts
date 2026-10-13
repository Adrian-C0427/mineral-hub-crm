/**
 * Reports → SMS performance display helpers (client/src/lib/smsReport.ts) and
 * the shared KPI comparison pill math (client/src/lib/reportDelta.ts). The
 * counting rules are tested on the server (domain/smsMetrics, smsReport).
 *
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import {
  EMPTY_SMS_FILTERS, fmtDuration, outcomeLabel, sentByLabel, smsQuery, touchLabel, trendLabel, trendTitle, withFilter,
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

  it("narrows one dimension to a breakdown row, keeping the others", () => {
    expect(withFilter({ senders: ["u1"], tags: ["A", "B"], sources: ["S"] }, "tags", "(no tag)"))
      .toEqual({ senders: ["u1"], tags: ["(no tag)"], sources: ["S"] });
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
