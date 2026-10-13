import { describe, it, expect } from "vitest";
import {
  toMessageRow, messageChanged, importStartDate, advanceCheckpoint, formatStartDate, startDateIgnored,
  toContactFields, smsOptedOut, toUserRefs, isDue, isPaused, phaseAfterRun, readSyncState, responseWindowOf,
  parseLocationId, storageEstimateMb, connectErrorMessage, OVERLAP_MS,
} from "./mapping.js";
import { HighLevelError } from "./client.js";

const dto = (over: Record<string, unknown> = {}) => ({
  id: "m1", contactId: "c1", conversationId: "cv1", dateAdded: "2026-10-01T15:00:00.000Z", direction: "outbound",
  status: "Delivered", messageType: "TYPE_SMS", source: "workflow", userId: "u1", body: "Hi Ray, any interest in an offer?",
  ...over,
});

describe("toMessageRow", () => {
  it("keeps what the metrics need and drops the wording", () => {
    const row = toMessageRow(dto());
    expect(row).toEqual({
      hlId: "m1", hlContactId: "c1", conversationId: "cv1", direction: "outbound", messageType: "TYPE_SMS",
      status: "delivered", source: "workflow", hlUserId: "u1", optOut: false, sentAt: new Date("2026-10-01T15:00:00.000Z"),
    });
    expect(JSON.stringify(row)).not.toContain("offer");
  });

  it("flags inbound opt-out replies only", () => {
    expect(toMessageRow(dto({ direction: "inbound", body: "STOP", userId: undefined, source: undefined }))).toMatchObject({ optOut: true, hlUserId: null, source: null });
    expect(toMessageRow(dto({ direction: "inbound", body: "Not interested" }))!.optOut).toBe(false);
    expect(toMessageRow(dto({ direction: "outbound", body: "Reply STOP to opt out" }))!.optOut).toBe(false);
  });

  it("skips rows without an id, contact, valid date or direction", () => {
    expect(toMessageRow(dto({ id: "" }))).toBeNull();
    expect(toMessageRow(dto({ contactId: null }))).toBeNull();
    expect(toMessageRow(dto({ dateAdded: "not a date" }))).toBeNull();
    expect(toMessageRow(dto({ direction: "sideways" }))).toBeNull();
  });
});

describe("messageChanged", () => {
  const base = toMessageRow(dto())!;
  it("is false for an identical re-read (overlap pages write nothing)", () => {
    expect(messageChanged({ ...base }, toMessageRow(dto())!)).toBe(false);
  });
  it("detects status, sender, source and time changes", () => {
    expect(messageChanged(base, toMessageRow(dto({ status: "failed" }))!)).toBe(true);
    expect(messageChanged(base, toMessageRow(dto({ userId: "u2" }))!)).toBe(true);
    expect(messageChanged(base, toMessageRow(dto({ source: "app" }))!)).toBe(true);
    expect(messageChanged(base, toMessageRow(dto({ dateAdded: "2026-10-01T15:00:01.000Z" }))!)).toBe(true);
  });
});

describe("checkpoint math", () => {
  it("starts a fresh query 2 minutes before the checkpoint", () => {
    expect(importStartDate(undefined)).toBeNull();
    expect(importStartDate("2026-10-01T15:00:00.000Z")!.getTime()).toBe(Date.parse("2026-10-01T15:00:00.000Z") - OVERLAP_MS);
  });
  it("advances to the latest createdAt and never moves backwards", () => {
    const rows = [{ sentAt: new Date("2026-10-01T10:00:00Z") }, { sentAt: new Date("2026-10-01T12:00:00Z") }];
    expect(advanceCheckpoint(undefined, rows)).toBe("2026-10-01T12:00:00.000Z");
    expect(advanceCheckpoint("2026-10-02T00:00:00.000Z", rows)).toBe("2026-10-02T00:00:00.000Z");
    expect(advanceCheckpoint(undefined, [])).toBeUndefined();
    expect(advanceCheckpoint("2026-10-02T00:00:00.000Z", [])).toBe("2026-10-02T00:00:00.000Z");
  });
  it("formats startDate as ISO or epoch ms, and notices an ignored filter", () => {
    const d = new Date("2026-10-01T15:00:00.000Z");
    expect(formatStartDate(d, "iso")).toBe("2026-10-01T15:00:00.000Z");
    expect(formatStartDate(d, "ms")).toBe(String(d.getTime()));
    expect(startDateIgnored(d, [{ sentAt: new Date("2025-01-01T00:00:00Z") }])).toBe(true);
    expect(startDateIgnored(d, [{ sentAt: new Date("2026-10-01T15:00:30Z") }])).toBe(false);
    expect(startDateIgnored(d, [])).toBe(false);
  });
});

describe("contacts", () => {
  it("maps details, normalizes the phone and dedupes tags", () => {
    expect(toContactFields({
      id: "c1", firstName: "Ray", lastName: "Garcia", phone: "+1 (432) 555-0101", email: "Ray@Example.com",
      source: "XLeads Skip Trace", tags: ["Reeves Oct 2026", "Reeves Oct 2026", " "], assignedTo: "u1",
      dateAdded: "2026-07-01T00:00:00.000Z", dateUpdated: "bad",
    })).toEqual({
      name: "Ray Garcia", phone: "+1 (432) 555-0101", phoneDigits: "4325550101", email: "ray@example.com",
      source: "XLeads Skip Trace", tags: ["Reeves Oct 2026"], assignedToHlUserId: "u1", smsOptedOut: false,
      hlDateAdded: new Date("2026-07-01T00:00:00.000Z"), hlDateUpdated: null,
    });
    expect(toContactFields({ id: "c2" })).toMatchObject({ name: null, phone: null, phoneDigits: null, tags: [], assignedToHlUserId: null });
  });
  it("reads SMS DND from dnd or dndSettings.SMS", () => {
    expect(smsOptedOut({ dnd: true })).toBe(true);
    expect(smsOptedOut({ dndSettings: { SMS: { status: "active" } } })).toBe(true);
    expect(smsOptedOut({ dndSettings: { SMS: { status: "permanent" } } })).toBe(true);
    expect(smsOptedOut({ dnd: false, dndSettings: { SMS: { status: "inactive" } } })).toBe(false);
    expect(smsOptedOut({})).toBe(false);
  });
  it("names users, skipping deleted ones", () => {
    expect(toUserRefs([
      { id: "u1", name: "Dana Whitfield", email: "Dana@X.test" },
      { id: "u2", firstName: "Owen", lastName: "Pruitt" },
      { id: "u3", email: "k@x.test" },
      { id: "u4" },
      { id: "u5", name: "Gone", deleted: true },
    ])).toEqual([
      { id: "u1", name: "Dana Whitfield", email: "dana@x.test" },
      { id: "u2", name: "Owen Pruitt", email: null },
      { id: "u3", name: "k@x.test", email: "k@x.test" },
      { id: "u4", name: "HighLevel user", email: null },
    ]);
  });
});

describe("scheduling and phase", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  it("isDue / isPaused", () => {
    expect(isDue(undefined, 1000, now)).toBe(true);
    expect(isDue("garbage", 1000, now)).toBe(true);
    expect(isDue(new Date(now - 6 * 3_600_000).toISOString(), 6 * 3_600_000, now)).toBe(true);
    expect(isDue(new Date(now - 3_600_000).toISOString(), 6 * 3_600_000, now)).toBe(false);
    expect(isPaused({ phase: "live", pausedUntil: new Date(now + 1000).toISOString() }, now)).toBe(true);
    expect(isPaused({ phase: "live", pausedUntil: new Date(now - 1000).toISOString() }, now)).toBe(false);
    expect(isPaused({ phase: "live" }, now)).toBe(false);
  });
  it("goes live only when messages, contacts and summaries are all complete", () => {
    const done = { messagesCaughtUp: true, pendingContacts: 0, dirtySummaries: 0 };
    expect(phaseAfterRun("importing", done)).toBe("live");
    expect(phaseAfterRun("importing", { ...done, messagesCaughtUp: false })).toBe("importing");
    expect(phaseAfterRun("importing", { ...done, pendingContacts: 12 })).toBe("importing");
    expect(phaseAfterRun("importing", { ...done, dirtySummaries: 1 })).toBe("importing");
    expect(phaseAfterRun("preview", done)).toBe("preview");
    expect(phaseAfterRun("live", { ...done, messagesCaughtUp: false })).toBe("live");
  });
  it("reads stored state and the response window defensively", () => {
    expect(readSyncState(null)).toEqual({ phase: "preview" });
    expect(readSyncState({ hlSync: { phase: "bogus", checkpoint: "x" } })).toEqual({ phase: "preview", checkpoint: "x" });
    expect(readSyncState({ hlSync: { phase: "live" } }).phase).toBe("live");
    expect(responseWindowOf({ responseWindowDays: 60 })).toBe(60);
    expect(responseWindowOf({ responseWindowDays: 45 })).toBe(30);
    expect(responseWindowOf(undefined)).toBe(30);
  });
});

describe("connect helpers", () => {
  it("accepts a bare Location ID or a HighLevel address containing one", () => {
    expect(parseLocationId("ve9EPM428h8vShlRW1KT")).toBe("ve9EPM428h8vShlRW1KT");
    expect(parseLocationId("  ve9EPM428h8vShlRW1KT ")).toBe("ve9EPM428h8vShlRW1KT");
    expect(parseLocationId("https://app.xleads.com/v2/location/ve9EPM428h8vShlRW1KT/dashboard")).toBe("ve9EPM428h8vShlRW1KT");
    expect(parseLocationId("abc")).toBeNull();
    expect(parseLocationId("not an id!")).toBeNull();
    expect(parseLocationId("")).toBeNull();
  });
  it("estimates storage in tenths of a MB", () => {
    expect(storageEstimateMb(0)).toBe(0);
    expect(storageEstimateMb(10)).toBe(0.1);
    expect(storageEstimateMb(6000)).toBe(3.9);
    expect(storageEstimateMb(100_000)).toBe(65);
  });
  it("explains connect failures in plain words", () => {
    const auth = (status: number, detail: string) => new HighLevelError("auth", { status, detail });
    expect(connectErrorMessage("location", auth(401, "Invalid JWT"), "L1")).toMatch(/rejected this key/);
    expect(connectErrorMessage("location", auth(403, "The token does not have access to this location."), "L1")).toMatch(/can't open location L1/);
    expect(connectErrorMessage("location", auth(401, "The token is not authorized for this scope."), "L1")).toMatch(/locations\.readonly/);
    expect(connectErrorMessage("users", auth(401, "Invalid JWT"), "L1")).toMatch(/users\.readonly/);
    expect(connectErrorMessage("messages", auth(403, ""), "L1")).toMatch(/conversations\/message\.readonly/);
    expect(connectErrorMessage("location", new HighLevelError("notFound", { status: 404 }), "L1")).toMatch(/couldn't find a location with ID L1/);
    expect(connectErrorMessage("location", new HighLevelError("network"), "L1")).toMatch(/Couldn't reach HighLevel/);
  });
});
