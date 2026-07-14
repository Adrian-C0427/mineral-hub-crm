import { describe, it, expect } from "vitest";
import { planDeadlineEvents } from "./outlookCalendarSync.js";

const deal = (over: Partial<Parameters<typeof planDeadlineEvents>[0][number]> = {}) => ({
  id: "deal1", name: "Smith Ranch",
  dateUnderContract: null, originalClosingDate: null,
  findBuyerByDateOverride: null, finalClosingDateOverride: null,
  ...over,
});

describe("planDeadlineEvents", () => {
  it("derives find-buyer-by (+15d) and closing events from anchor dates", () => {
    const events = planDeadlineEvents([deal({
      dateUnderContract: new Date("2026-08-01T00:00:00Z"),
      originalClosingDate: new Date("2026-09-01T00:00:00Z"),
    })]);
    const byKey = new Map(events.map((e) => [e.key, e]));
    expect(byKey.get("deal1:findBuyerBy")?.date).toBe("2026-08-16"); // +15 calendar days
    expect(byKey.get("deal1:originalClosing")?.date).toBe("2026-09-01");
    expect(byKey.get("deal1:finalClosing")?.date).toBe("2026-09-16"); // +15 calendar days
    expect(byKey.get("deal1:findBuyerBy")?.subject).toBe("Smith Ranch — Find buyer by (Mineral Hub)");
    expect(byKey.get("deal1:findBuyerBy")?.link).toBe("/deals/deal1");
  });

  it("respects overrides over the auto-derived dates", () => {
    const events = planDeadlineEvents([deal({
      dateUnderContract: new Date("2026-08-01T00:00:00Z"),
      findBuyerByDateOverride: new Date("2026-08-10T00:00:00Z"),
    })]);
    expect(events.find((e) => e.key === "deal1:findBuyerBy")?.date).toBe("2026-08-10");
  });

  it("emits nothing for deals without dates", () => {
    expect(planDeadlineEvents([deal()])).toEqual([]);
  });

  it("caps the total number of events", () => {
    const many = Array.from({ length: 200 }, (_, i) => deal({
      id: `d${i}`, dateUnderContract: new Date("2026-08-01T00:00:00Z"),
      originalClosingDate: new Date("2026-09-01T00:00:00Z"),
    }));
    expect(planDeadlineEvents(many).length).toBeLessThanOrEqual(300);
  });
});
