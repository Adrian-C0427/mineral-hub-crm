import { describe, it, expect } from "vitest";
import {
  toMessageRow, messageChanged, importStartDate, advanceCheckpoint, formatStartDate, startDateIgnored,
  toContactFields, smsOptedOut, toUserRefs, isDue, isPaused, phaseAfterRun, readSyncState, responseWindowOf,
  parseLocationId, storageEstimateMb, connectErrorMessage, OVERLAP_MS, rescanPatch, tagsChanged, weeklyRefreshLimit,
  toPipelineRefs, toTagNames, validTimezone, savedScopeOf, effectiveScope, sameScope, cleanScope, pricePerSegmentOf,
  toOpportunityFields, planOpportunity, unknownStage, healthAlert, healthKeys, healthNotice,
  type HlPipelineRef, type StoredOpp, type OppFields,
} from "./mapping.js";
import { carrierHealth } from "../../domain/smsMetrics.js";
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
      status: "delivered", source: "workflow", hlUserId: "u1", optOut: false, wrongNumber: false, segments: 1,
      sentAt: new Date("2026-10-01T15:00:00.000Z"),
    });
    expect(JSON.stringify(row)).not.toContain("offer");
  });

  it("flags wrong-number replies (inbound only, never also an opt-out) and counts segments", () => {
    expect(toMessageRow(dto({ direction: "inbound", body: "Sorry, wrong number" }))).toMatchObject({ wrongNumber: true, optOut: false });
    expect(toMessageRow(dto({ direction: "inbound", body: "Who is this?" }))!.wrongNumber).toBe(false);
    expect(toMessageRow(dto({ direction: "outbound", body: "If this is the wrong number, sorry!" }))!.wrongNumber).toBe(false);
    expect(toMessageRow(dto({ direction: "inbound", body: "Wrong number, stop texting me" }))).toMatchObject({ optOut: true, wrongNumber: false });
    expect(toMessageRow(dto({ body: "x".repeat(161) }))!.segments).toBe(2);
    expect(toMessageRow(dto({ body: "Thanks 👍" }))!.segments).toBe(1);
    expect(toMessageRow(dto({ body: `${"a".repeat(70)}👍` }))!.segments).toBe(2); // emoji → Unicode, 70 per segment
    expect(toMessageRow(dto({ body: undefined }))!.segments).toBe(1);
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
  it("rewrites rows imported before segments existed, and wrong-number changes", () => {
    expect(messageChanged({ ...base, segments: null }, base)).toBe(true);
    expect(messageChanged(base, { ...base, wrongNumber: true })).toBe(true);
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

describe("one-time rescan", () => {
  it("writes only segments and the wrong-number flag, and only when they differ", () => {
    expect(rescanPatch({ segments: null, wrongNumber: false }, { segments: 1, wrongNumber: false })).toEqual({ segments: 1, wrongNumber: false });
    expect(rescanPatch({ segments: 1, wrongNumber: false }, { segments: 1, wrongNumber: true })).toEqual({ segments: 1, wrongNumber: true });
    expect(rescanPatch({ segments: 2, wrongNumber: true }, { segments: 2, wrongNumber: true })).toBeNull();
  });
});

describe("contact refresh", () => {
  it("notices tag changes, ignoring case, spacing and order", () => {
    expect(tagsChanged(["Leon County", "new lease"], ["new lease", "leon  county"])).toBe(false);
    expect(tagsChanged(["leon county"], ["leon county", "wrong number-1"])).toBe(true);
    expect(tagsChanged([], [])).toBe(false);
  });
  it("spreads the weekly refresh so everyone comes round within a week of 15-minute runs", () => {
    expect(weeklyRefreshLimit(0)).toBe(10);
    expect(weeklyRefreshLimit(400)).toBe(10);
    expect(weeklyRefreshLimit(30_000)).toBe(50);
    expect(weeklyRefreshLimit(1_000_000)).toBe(200);
    // 600 runs (≈ 6.25 days) × the limit covers everyone.
    for (const n of [1, 599, 6_000, 59_999, 120_000]) expect(weeklyRefreshLimit(n) * 600).toBeGreaterThanOrEqual(n);
  });
});

const PIPES: HlPipelineRef[] = toPipelineRefs([
  { id: "pMin", name: "Minerals", stages: [
    { id: "s2", name: "Offer Made", position: 2 }, { id: "s1", name: "Needs Offer", position: 1 },
    { id: "s3", name: "Under Contract", position: 3 }, { id: "s4", name: "Dead", position: 4 },
  ] },
  { id: "pNA", name: "Offer Not Accepted", stages: [{ id: "n1", name: "Follow Up 30 Days", position: 0 }] },
  { id: "pRE", name: "On-Market", stages: [{ id: "r1", name: "Listed", position: 0 }] },
  { id: "", name: "broken" },
]);
const PIPE_MAP = new Map(PIPES.map((p) => [p.id, p]));

describe("pipelines, tags, time zone", () => {
  it("keeps pipelines with ids, stages in position order", () => {
    expect(PIPES.map((p) => p.id)).toEqual(["pMin", "pNA", "pRE"]);
    expect(PIPES[0].stages.map((st) => st.name)).toEqual(["Needs Offer", "Offer Made", "Under Contract", "Dead"]);
  });
  it("lists tag names once each (first spelling wins), A→Z", () => {
    expect(toTagNames([{ name: "leon county" }, { name: "Leon County" }, { name: "  " }, {}, { name: "dispo" }])).toEqual(["dispo", "leon county"]);
  });
  it("accepts IANA zones and HighLevel's aliases only", () => {
    expect(validTimezone("America/Chicago")).toBe("America/Chicago");
    expect(validTimezone("US/Central")).toBe("US/Central");
    expect(validTimezone("Mars/Olympus")).toBeNull();
    expect(validTimezone(null)).toBeNull();
  });
});

describe("Minerals filter settings", () => {
  const scope = { mineralTags: ["Leon County"], realEstateTags: ["dispo"], mineralPipelineIds: ["pMin"] };
  it("reads a saved filter, else suggests one from the account's tags and pipelines", () => {
    expect(savedScopeOf({ scope })).toEqual(scope);
    expect(savedScopeOf({ scope: { mineralTags: "x" } })).toBeNull();
    expect(effectiveScope({ scope })).toEqual({ scope, saved: true });
    expect(effectiveScope({ hlTags: ["Leon County", "dispo", "mineral sms blast"], hlPipelines: PIPES })).toEqual({
      saved: false, scope: { mineralTags: ["Leon County", "mineral sms blast"], realEstateTags: [], mineralPipelineIds: ["pMin"] },
    });
    expect(sameScope(scope, { mineralTags: ["leon county "], realEstateTags: ["DISPO"], mineralPipelineIds: ["pMin"] })).toBe(true);
    expect(sameScope(scope, { ...scope, mineralPipelineIds: [] })).toBe(false);
  });
  it("cleans a draft and refuses a tag on both lists or a pipeline that isn't the account's", () => {
    expect(cleanScope({ mineralTags: [" Leon  County", "leon county", ""], realEstateTags: ["Dispo"], mineralPipelineIds: ["pMin", "pMin"] }, PIPES))
      .toEqual({ ok: true, scope: { mineralTags: ["leon county"], realEstateTags: ["dispo"], mineralPipelineIds: ["pMin"] } });
    const both = cleanScope({ mineralTags: ["Tiny"], realEstateTags: ["tiny "], mineralPipelineIds: [] }, PIPES);
    expect(both).toEqual({ ok: false, message: expect.stringMatching(/“tiny” can't be both/) });
    expect(cleanScope({ mineralTags: [], realEstateTags: [], mineralPipelineIds: ["pGone"] }, PIPES).ok).toBe(false);
    expect(cleanScope({ mineralTags: [], realEstateTags: [], mineralPipelineIds: ["pGone"] }, []).ok).toBe(true); // pipelines not loaded yet
  });
  it("reads the price per segment", () => {
    expect(pricePerSegmentOf({ pricePerSegment: 0.0091 })).toBe(0.0091);
    expect(pricePerSegmentOf({ pricePerSegment: -1 })).toBeNull();
    expect(pricePerSegmentOf({})).toBeNull();
  });
});

describe("opportunities", () => {
  const T = (iso: string) => new Date(iso);
  const opp = (over: Record<string, unknown> = {}) => ({
    id: "o1", name: "Ray Garcia", monetaryValue: 12000, pipelineId: "pMin", pipelineStageId: "s1", assignedTo: "u1",
    status: "open", source: "XLeads", contactId: "c1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z",
    lastStageChangeAt: "2026-09-05T00:00:00.000Z", lastStatusChangeAt: "2026-09-01T00:00:00.000Z", ...over,
  });
  const fields = (over: Record<string, unknown> = {}) => toOpportunityFields(opp(over), PIPE_MAP)!;
  /** What the sync would have stored after planning `f` on first sight. */
  const stored = (f: OppFields, extra: Partial<StoredOpp> = {}): StoredOpp => {
    const { data } = planOpportunity(null, f, T("2026-10-12T00:00:00Z"));
    return { offerAt: null, acceptedAt: null, contractAt: null, closedAt: null, deadAt: null, deletedInHl: false, ...(data as object), ...extra } as StoredOpp;
  };
  const NOW = T("2026-10-12T12:00:00Z");

  it("maps the step from stage and pipeline names; status wins", () => {
    expect(fields().step).toBe("opportunity");
    expect(fields({ pipelineStageId: "s2" }).step).toBe("offer");
    expect(fields({ pipelineId: "pNA", pipelineStageId: "n1" }).step).toBe("not_accepted");
    expect(fields({ status: "won" }).step).toBe("closed");
    expect(fields({ status: "abandoned", pipelineStageId: "s2" }).step).toBe("dead");
    expect(fields({ contactId: null, contact: { id: "c9" } }).hlContactId).toBe("c9");
    expect(toOpportunityFields(opp({ pipelineId: "" }), PIPE_MAP)).toBeNull();
    expect(unknownStage(opp({ pipelineStageId: "sNew" }), PIPE_MAP)).toBe(true);
    expect(unknownStage(opp({ pipelineId: "pNew" }), PIPE_MAP)).toBe(true);
    expect(unknownStage(opp(), PIPE_MAP)).toBe(false);
  });

  it("first sight: stores it with no stage event; the current step is dated by HighLevel", () => {
    const offer = planOpportunity(null, fields({ pipelineStageId: "s2" }), NOW);
    expect(offer).toMatchObject({ create: true, event: null, dirtyContacts: ["c1"] });
    expect(offer.data).toMatchObject({ hlId: "o1", step: "offer", maxRank: 2, offerAt: T("2026-09-05T00:00:00.000Z"), pipelineId: "pMin", stageId: "s2" });
    expect(offer.data).not.toHaveProperty("lastStatusChangeAt");
    // Won / lost are dated by the status change.
    expect(planOpportunity(null, fields({ status: "won" }), NOW).data).toMatchObject({ step: "closed", maxRank: 6, closedAt: T("2026-09-01T00:00:00.000Z") });
    // A dead opportunity still got as far as "opportunity".
    expect(planOpportunity(null, fields({ pipelineStageId: "s4" }), NOW).data).toMatchObject({ step: "dead", maxRank: 1, deadAt: T("2026-09-05T00:00:00.000Z") });
    // Lost while at "Offer Made": dead, but an offer was made.
    expect(planOpportunity(null, fields({ pipelineStageId: "s2", status: "lost" }), NOW).data).toMatchObject({ step: "dead", maxRank: 2, deadAt: T("2026-09-01T00:00:00.000Z") });
    // Abandoned at "Under Contract": counts up to contract, never as closed.
    expect(planOpportunity(null, fields({ pipelineStageId: "s3", status: "abandoned" }), NOW).data).toMatchObject({ step: "dead", maxRank: 5 });
    // No timestamp column for plain opportunities; none invented when HighLevel gives no date.
    expect(planOpportunity(null, fields(), NOW).data).not.toHaveProperty("offerAt");
    expect(planOpportunity(null, fields({ pipelineStageId: "s2", lastStageChangeAt: null }), NOW).data).toMatchObject({ offerAt: null });
  });

  it("re-reading an unchanged opportunity writes nothing", () => {
    const f = fields({ pipelineStageId: "s2" });
    expect(planOpportunity(stored(f), f, NOW)).toEqual({ create: false, data: null, event: null, dirtyContacts: [] });
  });

  it("an observed stage move records one event, dated by HighLevel when it moved forward, and dates the new step if empty", () => {
    const before = stored(fields());
    const moved = planOpportunity(before, fields({ pipelineStageId: "s2", lastStageChangeAt: "2026-10-12T11:00:00.000Z" }), NOW);
    expect(moved.event).toEqual({
      opportunityHlId: "o1", pipelineId: "pMin", fromStageId: "s1", toStageId: "s2", fromStep: "opportunity", toStep: "offer",
      at: T("2026-10-12T11:00:00.000Z"),
    });
    expect(moved.data).toMatchObject({ stageId: "s2", step: "offer", maxRank: 2, offerAt: T("2026-10-12T11:00:00.000Z") });
    expect(moved.dirtyContacts).toEqual([]); // same pipeline: the line can't change
    // HighLevel's change time didn't move: the event is dated when we saw it.
    const stale = planOpportunity(before, fields({ pipelineStageId: "s2", lastStageChangeAt: "2026-09-05T00:00:00.000Z" }), NOW);
    expect(stale.event!.at).toEqual(NOW);
    // Skipping ahead to contract leaves the offer date empty (no history before we watched).
    const jump = planOpportunity(before, fields({ pipelineStageId: "s3", lastStageChangeAt: "2026-10-12T11:00:00.000Z" }), NOW);
    expect(jump.data).toMatchObject({ step: "contract", maxRank: 5, contractAt: T("2026-10-12T11:00:00.000Z") });
    expect(jump.data).not.toHaveProperty("offerAt");
  });

  it("maxRank never goes down, and a step's first date is kept", () => {
    const atOffer = stored(fields({ pipelineStageId: "s2" }));
    const died = planOpportunity(atOffer, fields({ pipelineStageId: "s4", lastStageChangeAt: "2026-10-10T00:00:00.000Z" }), NOW);
    expect(died.data).toMatchObject({ step: "dead", deadAt: T("2026-10-10T00:00:00.000Z") });
    expect(died.data).not.toHaveProperty("maxRank"); // stays 2: it was an offer
    const back = planOpportunity({ ...atOffer, stageId: "s4", step: "dead", deadAt: T("2026-10-10T00:00:00.000Z") },
      fields({ pipelineStageId: "s2", lastStageChangeAt: "2026-10-11T00:00:00.000Z" }), NOW);
    expect(back.event).toMatchObject({ fromStep: "dead", toStep: "offer" });
    expect(back.data).not.toHaveProperty("offerAt"); // already dated
  });

  it("a won / lost status is a move; a renamed stage is not; a new pipeline re-classifies the contact", () => {
    const open = stored(fields({ pipelineStageId: "s2" }));
    const won = planOpportunity(open, fields({ pipelineStageId: "s2", status: "won", lastStatusChangeAt: "2026-10-12T10:00:00.000Z" }), NOW);
    expect(won.event).toMatchObject({ fromStep: "offer", toStep: "closed", at: T("2026-10-12T10:00:00.000Z") });
    expect(won.data).toMatchObject({ status: "won", step: "closed", maxRank: 6, closedAt: T("2026-10-12T10:00:00.000Z") });
    const renamed = planOpportunity({ ...open, step: "opportunity", maxRank: 1 }, fields({ pipelineStageId: "s2" }), NOW);
    expect(renamed.event).toBeNull();
    expect(renamed.data).toEqual({ step: "offer", maxRank: 2 });
    const toNA = planOpportunity(open, fields({ pipelineId: "pNA", pipelineStageId: "n1", lastStageChangeAt: "2026-10-12T09:00:00.000Z" }), NOW);
    expect(toNA.event).toMatchObject({ pipelineId: "pNA", toStep: "not_accepted" });
    expect(toNA.dirtyContacts).toEqual(["c1"]);
    const relinked = planOpportunity(open, fields({ pipelineStageId: "s2", contactId: "c2" }), NOW);
    expect(relinked.dirtyContacts).toEqual(["c1", "c2"]);
  });

  it("an opportunity seen again after being flagged deleted comes back", () => {
    const f = fields();
    expect(planOpportunity(stored(f, { deletedInHl: true }), f, NOW)).toMatchObject({ data: { deletedInHl: false }, dirtyContacts: ["c1"], event: null });
  });
});

describe("carrier health notifications", () => {
  it("announces a new warning once, at most once a day, and forgets warnings that cleared", () => {
    expect(healthAlert([], [], false)).toEqual({ notify: null, remember: [] });
    expect(healthAlert([], ["week:failure"], false)).toEqual({ notify: ["week:failure"], remember: ["week:failure"] });
    // Still there next run: nothing new.
    expect(healthAlert(["week:failure"], ["week:failure"], false)).toEqual({ notify: null, remember: ["week:failure"] });
    // A second warning inside the same day waits (not remembered, so it's announced tomorrow if it lasts).
    expect(healthAlert(["week:failure"], ["week:failure", "day:optOut"], true)).toEqual({ notify: null, remember: ["week:failure"] });
    expect(healthAlert(["week:failure"], ["week:failure", "day:optOut"], false)).toEqual({ notify: ["week:failure", "day:optOut"], remember: ["week:failure", "day:optOut"] });
    // Cleared, then back: announced again (if a day has passed).
    expect(healthAlert(["week:failure"], [], false)).toEqual({ notify: null, remember: [] });
  });
  it("words the warning for the owner", () => {
    const week = carrierHealth({ sent: 200, failed: 40, reachedContacts: 150, optOuts: 3 });
    const day = carrierHealth({ sent: 20, failed: 10, reachedContacts: 10, optOuts: 0 }); // too few texts to judge
    expect(healthKeys("week", week)).toEqual(["week:failure"]);
    expect(healthKeys("day", day)).toEqual([]);
    expect(healthNotice(["week:failure"], { day, week })).toEqual({
      title: "Texting health warning",
      body: "20% of texts sent in the last 7 days failed to deliver (warning level 15%). Carriers may start filtering your numbers. See Reports → SMS performance.",
    });
  });
});
