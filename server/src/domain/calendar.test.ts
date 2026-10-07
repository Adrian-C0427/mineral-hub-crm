import { describe, it, expect } from "vitest";
import {
  CALENDAR_MAX_RANGE_DAYS, STARTER_TYPES, TYPE_PALETTE, closingEntries, dayKey, dayKeyInRange, eventEntry, eventTimeError,
  followUpEntry, nextTypeColor, parseCalendarRange, parseDayKey, sortEntries, taskEntry, TIME_RE,
} from "./calendar.js";

const day = (k: string) => new Date(`${k}T00:00:00Z`);

describe("day keys", () => {
  it("parses a day at UTC midnight and formats it back", () => {
    const d = parseDayKey("2026-10-14")!;
    expect(d.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(dayKey(d)).toBe("2026-10-14");
  });

  it("rejects malformed, impossible and absurd dates", () => {
    for (const bad of ["", "2026-1-5", "2026-02-31", "2026-13-01", "0202-07-09", "2026-10-14T00:00:00Z", null, undefined, 20261014]) {
      expect(parseDayKey(bad)).toBeNull();
    }
  });

  it("keeps a late-evening UTC timestamp on its own UTC day", () => {
    expect(dayKey(new Date("2026-10-14T23:59:59Z"))).toBe("2026-10-14");
  });
});

describe("parseCalendarRange", () => {
  it("accepts an inclusive range and exposes an exclusive end", () => {
    const r = parseCalendarRange("2026-10-01", "2026-10-31");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(r.endExclusive.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect([r.fromKey, r.toKey]).toEqual(["2026-10-01", "2026-10-31"]);
  });

  it("accepts a single day", () => {
    expect(parseCalendarRange("2026-10-01", "2026-10-01").ok).toBe(true);
  });

  it("rejects missing, malformed and inverted ranges", () => {
    expect(parseCalendarRange(undefined, "2026-10-31").ok).toBe(false);
    expect(parseCalendarRange("garbage", "2026-10-31").ok).toBe(false);
    expect(parseCalendarRange("2026-10-31", "2026-10-01").ok).toBe(false);
  });

  it("caps the span at 400 days, both ends counted", () => {
    expect(CALENDAR_MAX_RANGE_DAYS).toBe(400);
    expect(parseCalendarRange("2026-01-01", "2027-02-04").ok).toBe(true); // exactly 400 days
    expect(parseCalendarRange("2026-01-01", "2027-02-05").ok).toBe(false); // 401
  });
});

describe("starter types and colours", () => {
  it("lists the five starter types in order with their system keys", () => {
    expect(STARTER_TYPES.map((t) => [t.name, t.color, t.systemKey])).toEqual([
      ["Closing", "#22C55E", "closing"],
      ["Contract deadline", "#EF4444", null],
      ["Follow-up", "#3B82F6", "follow"],
      ["Title & diligence", "#A855F7", null],
      ["Option expiry", "#F97316", null],
    ]);
  });

  it("picks the first palette colour not in use (case-insensitive)", () => {
    expect(nextTypeColor([])).toBe("#22C55E");
    expect(nextTypeColor(STARTER_TYPES.map((t) => t.color))).toBe("#F59E0B");
    expect(nextTypeColor(["#22c55e", "#ef4444"])).toBe("#3B82F6");
    expect(TYPE_PALETTE).toContain(nextTypeColor([...TYPE_PALETTE]));
  });
});

describe("event times", () => {
  it("validates HH:MM", () => {
    expect(TIME_RE.test("09:30")).toBe(true);
    expect(TIME_RE.test("23:59")).toBe(true);
    expect(TIME_RE.test("24:00")).toBe(false);
    expect(TIME_RE.test("9:30")).toBe(false);
  });

  it("requires a start unless all day, and an end after the start", () => {
    expect(eventTimeError({ allDay: true, start: null, end: null })).toBeNull();
    expect(eventTimeError({ allDay: false, start: null, end: null })).toMatch(/start time/);
    expect(eventTimeError({ allDay: false, start: "09:00", end: null })).toBeNull();
    expect(eventTimeError({ allDay: false, start: "09:00", end: "09:00" })).toMatch(/after/);
    expect(eventTimeError({ allDay: false, start: "09:00", end: "08:30" })).toMatch(/after/);
    expect(eventTimeError({ allDay: false, start: "09:00", end: "10:15" })).toBeNull();
  });
});

describe("eventEntry", () => {
  const row = {
    id: "ev1", title: "Sign PSA", typeId: "t1", date: day("2026-10-14"), allDay: false, startTime: "15:00", endTime: "15:45",
    notes: "bring docs", completedAt: null, deal: null, buyer: null, assignedTo: { id: "u1", name: "Adrian" },
  };

  it("maps a hand-entered event", () => {
    expect(eventEntry(row)).toEqual({
      id: "ev1", source: "event", readOnly: false, title: "Sign PSA", typeId: "t1", date: "2026-10-14", allDay: false,
      start: "15:00", end: "15:45", link: null, assignee: { id: "u1", name: "Adrian" }, notes: "bring docs", done: false, href: null,
    });
  });

  it("links to the deal or the buyer and drops times when all day", () => {
    expect(eventEntry({ ...row, deal: { id: "d1", name: "Smith 40" } }).link).toEqual({ kind: "deal", id: "d1", label: "Smith 40" });
    expect(eventEntry({ ...row, buyer: { id: "b1", name: "Basin Peak" } }).link).toEqual({ kind: "buyer", id: "b1", label: "Basin Peak" });
    const allDay = eventEntry({ ...row, allDay: true, completedAt: new Date() });
    expect([allDay.start, allDay.end, allDay.done]).toEqual([null, null, true]);
  });
});

describe("closingEntries", () => {
  const deal = {
    id: "d1", name: "Smith 40", stage: "UNDER_CONTRACT", dateUnderContract: null, originalClosingDate: day("2026-10-01"),
    findBuyerByDateOverride: null, finalClosingDateOverride: null, daysToClose: null, buyerClosingDate: null,
  };

  it("emits only the applicable final closing (original + 15 days), never the original", () => {
    const out = closingEntries(deal, "tc");
    expect(out.map((e) => [e.id, e.title, e.date])).toEqual([
      ["closing:d1:final", "Closing — Smith 40", "2026-10-16"],
    ]);
    expect(out[0]).toMatchObject({
      source: "closing", readOnly: true, allDay: true, start: null, end: null, typeId: "tc", href: "/deals/d1",
      link: { kind: "deal", id: "d1", label: "Smith 40" }, assignee: null, done: false,
    });
  });

  it("uses the override (where extensions land) as the one closing entry", () => {
    const out = closingEntries({ ...deal, finalClosingDateOverride: day("2026-10-31") }, null);
    expect(out.map((e) => [e.id, e.date])).toEqual([["closing:d1:final", "2026-10-31"]]);
    expect(out[0].typeId).toBeNull();
  });

  it("adds a separate 'Closing with buyer' entry when the buyer closing date is set", () => {
    const out = closingEntries({ ...deal, buyerClosingDate: day("2026-10-20") }, "tc");
    expect(out.map((e) => [e.id, e.title, e.date, e.typeId, e.href])).toEqual([
      ["closing:d1:final", "Closing — Smith 40", "2026-10-16", "tc", "/deals/d1"],
      ["closing:d1:buyer", "Closing with buyer — Smith 40", "2026-10-20", "tc", "/deals/d1"],
    ]);
    // Buyer closing alone (no seller-side dates) still shows up.
    expect(closingEntries({ ...deal, originalClosingDate: null, buyerClosingDate: day("2026-10-20") }, "tc").map((e) => e.id)).toEqual(["closing:d1:buyer"]);
  });

  it("emits only the final when there is no original, and nothing for dead or undated deals", () => {
    expect(closingEntries({ ...deal, originalClosingDate: null, finalClosingDateOverride: day("2026-11-02") }, "tc").map((e) => e.date)).toEqual(["2026-11-02"]);
    expect(closingEntries({ ...deal, stage: "DEAD", buyerClosingDate: day("2026-10-20") }, "tc")).toEqual([]);
    expect(closingEntries({ ...deal, originalClosingDate: null }, "tc")).toEqual([]);
  });

  it("marks a closed deal's closing as done", () => {
    expect(closingEntries({ ...deal, stage: "CLOSED" }, "tc")[0].done).toBe(true);
  });
});
