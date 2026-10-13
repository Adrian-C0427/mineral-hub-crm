/**
 * Whole sync runs (runHighLevelSync) against an in-memory stand-in for the
 * Prisma tables it touches and a scripted HighLevel account. The clock only
 * moves when the fake HighLevel "answers", so run budgets are deterministic.
 * Covers the SMS-KPI additions: the opportunity pass (first sight vs an
 * observed move, events once, deletions only after a complete pass), the
 * one-time rescan's checkpoint, the minerals line written with each summary,
 * the weekly contact refresh, optional permissions, and carrier-health
 * notifications.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma, type Integration } from "@prisma/client";

type Row = Record<string, unknown>;

const CRM_LOWER = vi.hoisted(() => new Set([
  "sms - text 1 sent", "sms - text 2 sent", "sms - text 3 sent", "sms - text 4+ sent",
  "sms - responded - text 1", "sms - responded - text 2", "sms - responded - text 3", "sms - responded - text 4+",
  "acquisition - interested", "acquisition - offer made", "acquisition - offer accepted", "acquisition - deal created",
  "acquisition - deal closed", "acquisition - not interested", "acquisition - do not contact",
]));

const mem = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {};
  let seq = 0;
  const state = {
    health: { sent: 0, failed: 0, reached: 0, optOuts: 0 } as Record<string, number>,
    /** Called when the summary step reads messages (to simulate a settings change mid-run). */
    onSummaryRead: null as null | (() => void),
    /** Raw SQL the run sent ($queryRaw tagged-template arguments). */
    raw: [] as unknown[][],
  };
  const isPlain = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);
  const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
  const cmp = (a: unknown, b: unknown) => (a instanceof Date ? a.getTime() : (a as number)) - (b instanceof Date ? b.getTime() : (b as number));
  function match(row: Row, where: Row | undefined): boolean {
    for (const [k, cond] of Object.entries(where ?? {})) {
      if (k === "OR") { if (!(cond as Row[]).some((c) => match(row, c))) return false; continue; }
      if (k === "AND") { if (!(cond as Row[]).every((c) => match(row, c))) return false; continue; }
      if (isPlain(cond) && k.includes("_")) { if (!match(row, cond)) return false; continue; } // compound unique key
      const v = row[k];
      if (isPlain(cond)) {
        for (const [op, x] of Object.entries(cond)) {
          if (op === "in" && !(x as unknown[]).some((y) => eq(v, y))) return false;
          if (op === "notIn" && (x as unknown[]).some((y) => eq(v, y))) return false;
          if (op === "not" && (v == null || (x !== null && eq(v, x)))) return false; // SQL: NULL <> x is not true
          if (op === "lt" && !(v != null && cmp(v, x) < 0)) return false;
          if (op === "gt" && !(v != null && cmp(v, x) > 0)) return false;
          if (op === "gte" && !(v != null && cmp(v, x) >= 0)) return false;
        }
      } else if (!eq(v, cond)) return false;
    }
    return true;
  }
  const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });
  const DEFAULTS: Record<string, Row> = {
    highLevelContact: { tags: [], summaryDirty: true, deletedInHl: false, fetchedAt: null, outboundTotal: 0, summaryWindowDays: null, line: null, crmTagsPending: false, smsOptedOut: false, touches: 0, outcome: null },
    highLevelMessage: { segments: null, wrongNumber: false, optOut: false },
    highLevelOpportunity: { deletedInHl: false, maxRank: 1, offerAt: null, acceptedAt: null, contractAt: null, closedAt: null, deadAt: null },
  };
  const create = (name: string, data: Row): Row => {
    const now = new Date();
    const row = { ...DEFAULTS[name], id: `id${String(++seq).padStart(6, "0")}`, createdAt: now, updatedAt: now, ...data };
    (tables[name] ??= []).push(row);
    return row;
  };
  const write = (row: Row, data: Row) => Object.assign(row, data, { updatedAt: new Date() });
  const model = (name: string) => ({
    findUnique: async ({ where, select }: { where: Row; select?: Row }) => { const r = (tables[name] ?? []).find((x) => match(x, where)); return r ? pick(r, select) : null; },
    findFirst: async ({ where, select }: { where: Row; select?: Row }) => { const r = (tables[name] ?? []).find((x) => match(x, where)); return r ? pick(r, select) : null; },
    findMany: async ({ where, select, orderBy, take }: { where?: Row; select?: Row; orderBy?: Row; take?: number }) => {
      if (name === "highLevelMessage" && where && "hlContactId" in where) state.onSummaryRead?.();
      let rows = (tables[name] ?? []).filter((x) => match(x, where));
      if (orderBy) {
        const [[k, dir]] = Object.entries(orderBy);
        rows = [...rows].sort((a, b) => (cmp(a[k] ?? 0, b[k] ?? 0) || String(a[k]).localeCompare(String(b[k]))) * (dir === "desc" ? -1 : 1));
      }
      return rows.slice(0, take ?? rows.length).map((r) => pick(r, select));
    },
    count: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).filter((x) => match(x, where)).length,
    create: async ({ data }: { data: Row }) => create(name, data),
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const d of data) {
        if (skipDuplicates && d.hlId && (tables[name] ?? []).some((x) => x.organizationId === d.organizationId && x.hlId === d.hlId)) continue;
        create(name, d); count++;
      }
      return { count };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = (tables[name] ?? []).find((x) => match(x, where));
      if (!r) throw new Error(`${name}.update: no row`);
      return write(r, data);
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = (tables[name] ?? []).filter((x) => match(x, where));
      for (const r of rows) write(r, data);
      return { count: rows.length };
    },
  });
  const prisma = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => {
      if (key === "$transaction") return (ops: Promise<unknown>[]) => Promise.all(ops);
      if (key === "$queryRaw") return async (...args: unknown[]) => {
        if (JSON.stringify(args).includes("hl:crm-tagged")) {
          const n = (tables.highLevelContact ?? []).filter((c) => !c.deletedInHl && (c.tags as string[]).some((t) => CRM_LOWER.has(t.toLowerCase()))).length;
          return [{ n }];
        }
        state.raw.push(args); return [state.health];
      };
      if (key === "$executeRaw") return async (...args: unknown[]) => {
        if (!JSON.stringify(args).includes("hl:crm-untag")) return 0;
        let n = 0;
        for (const c of tables.highLevelContact ?? []) {
          if (!c.deletedInHl && (c.tags as string[]).some((t) => CRM_LOWER.has(t.toLowerCase()))) { c.crmTagsPending = true; n++; }
        }
        return n;
      };
      return model(key);
    },
  });
  const reset = () => {
    for (const k of Object.keys(tables)) delete tables[k];
    seq = 0; state.onSummaryRead = null; state.raw = []; state.health = { sent: 0, failed: 0, reached: 0, optOuts: 0 };
  };
  return { tables, prisma, state, reset, create };
});

/** The scripted HighLevel account. */
const hl = vi.hoisted(() => ({
  messages: [] as Row[],
  opportunities: [] as Row[],
  pipelines: [] as Row[],
  tags: [] as string[],
  contacts: new Map<string, Row>(),
  exportPageSize: 500,
  /** Milliseconds each call "takes" (moves the fake clock). */
  costMs: { export: 0, opps: 0 } as Record<string, number>,
  refuse: new Set<string>(), // "opps" | "pipelines" | "tags"
  calls: [] as { kind: string; params: Row }[],
}));

vi.mock("../../db.js", () => ({ prisma: mem.prisma }));
vi.mock("../secrets.js", () => ({ decryptSecret: () => "pit-test" }));
vi.mock("../activityLog.js", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("./client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client.js")>();
  const tick = (kind: string) => { const ms = hl.costMs[kind] ?? 0; if (ms) vi.setSystemTime(Date.now() + ms); };
  class FakeClient {
    dailyRemaining = null;
    requests = 0;
    get dailyBudgetLow() { return false; }
    async getLocation(id: string) { hl.calls.push({ kind: "location", params: {} }); return { id, name: "Loc", timezone: "America/Chicago" }; }
    async listUsers() { return []; }
    async listPipelines() {
      hl.calls.push({ kind: "pipelines", params: {} });
      if (hl.refuse.has("pipelines")) throw new real.HighLevelError("auth", { status: 401, detail: "The token is not authorized for this scope." });
      return hl.pipelines;
    }
    async listTags() {
      if (hl.refuse.has("tags")) throw new real.HighLevelError("auth", { status: 401, detail: "The token is not authorized for this scope." });
      return hl.tags.map((name) => ({ name }));
    }
    async addContactTags(id: string, tags: string[]) {
      hl.calls.push({ kind: "addTags", params: { id, tags } });
      if (hl.refuse.has("write")) throw new real.HighLevelError("auth", { status: 403, detail: "The token is not authorized for this scope." });
      // Like HighLevel: a tag the location doesn't have when the request arrives
      // is created — by EVERY request in flight that adds it (a duplicate entry).
      const missing = tags.map((t) => t.toLowerCase()).filter((t) => !hl.tags.includes(t));
      await Promise.resolve(); await Promise.resolve(); // in flight: another write can start meanwhile
      hl.tags.push(...missing);
      const c = hl.contacts.get(id) ?? {};
      const have = new Set(((c.tags as string[]) ?? []).map((t) => t.toLowerCase()));
      c.tags = [...((c.tags as string[]) ?? []), ...tags.map((t) => t.toLowerCase()).filter((t) => !have.has(t))]; // HighLevel lower-cases tags
      hl.contacts.set(id, c);
    }
    async removeContactTags(id: string, tags: string[]) {
      hl.calls.push({ kind: "removeTags", params: { id, tags } });
      if (hl.refuse.has("write")) throw new real.HighLevelError("auth", { status: 403, detail: "The token is not authorized for this scope." });
      const c = hl.contacts.get(id) ?? {};
      const drop = new Set(tags.map((t) => t.toLowerCase()));
      c.tags = ((c.tags as string[]) ?? []).filter((t) => !drop.has(t.toLowerCase()));
      hl.contacts.set(id, c);
    }
    async getContact(id: string) {
      const c = hl.contacts.get(id);
      if (!c) throw new real.HighLevelError("notFound", { status: 404 });
      return { id, ...c };
    }
    async exportMessages(p: { startDate?: string; cursor?: string; limit?: number }) {
      hl.calls.push({ kind: "export", params: { ...p } });
      tick("export");
      const from = p.startDate ? Date.parse(p.startDate) : -Infinity;
      const all = hl.messages.filter((m) => Date.parse(m.dateAdded as string) >= from)
        .sort((a, b) => Date.parse(a.dateAdded as string) - Date.parse(b.dateAdded as string));
      const at = p.cursor ? Number(p.cursor) : 0;
      const page = all.slice(at, at + hl.exportPageSize);
      return { messages: page, nextCursor: at + hl.exportPageSize < all.length ? String(at + hl.exportPageSize) : null, total: all.length };
    }
    async searchOpportunities(p: { limit: number; startAfter?: number | null; startAfterId?: string | null }) {
      hl.calls.push({ kind: "opps", params: { ...p } });
      if (hl.refuse.has("opps")) throw new real.HighLevelError("auth", { status: 401, detail: "The token is not authorized for this scope." });
      tick("opps");
      const key = (o: Row) => [Date.parse(o.createdAt as string), o.id as string] as const;
      const all = [...hl.opportunities].sort((a, b) => key(a)[0] - key(b)[0] || String(a.id).localeCompare(String(b.id)));
      const rest = p.startAfterId
        ? all.filter((o) => key(o)[0] > p.startAfter! || (key(o)[0] === p.startAfter && String(o.id) > p.startAfterId!))
        : all;
      const page = rest.slice(0, p.limit);
      const last = page[page.length - 1];
      return {
        opportunities: page,
        meta: { total: all.length, startAfter: last ? key(last)[0] : null, startAfterId: last ? (last.id as string) : null, nextPage: null },
      };
    }
  }
  return { ...real, HighLevelClient: FakeClient };
});

import { runHighLevelSync, highLevelStatus, startTagRefresh, startCrmTagging, startCrmTagRemoval } from "./sync.js";
import { SUMMARY_VERSION } from "./mapping.js";

const ORG = "org1";
const T0 = Date.parse("2026-10-12T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

const PIPELINES = [
  { id: "pMin", name: "Minerals", stages: [{ id: "s1", name: "Needs Offer", position: 0 }, { id: "s2", name: "Offer Made", position: 1 }, { id: "s4", name: "Dead", position: 2 }] },
  { id: "pRE", name: "On-Market", stages: [{ id: "r1", name: "Listed", position: 0 }] },
];

/** A connected, live integration whose bookkeeping is all current (each test opens the part it exercises). */
function seedIntegration(hlSync: Row = {}, cfg: Row = {}): void {
  mem.create("integration", {
    organizationId: ORG, provider: "highlevel", status: "CONNECTED", lastError: null, lastSyncAt: null, connectedAt: null,
    config: {
      _secret: "v1:x", locationId: "loc1", responseWindowDays: 30, hlPipelines: PIPELINES, hlTags: ["leon county", "dispo"],
      ...cfg,
      hlSync: {
        phase: "live", checkpoint: iso(T0 - 10 * DAY), dateParam: "iso", usersRefreshAt: iso(T0), metaRefreshAt: iso(T0),
        statusRefreshAt: iso(T0), rescan: { done: true }, summaryVersion: SUMMARY_VERSION, ...hlSync,
      },
    },
  });
}
const integration = () => mem.tables.integration[0] as unknown as Integration;
const hlSync = () => (integration().config as Row).hlSync as Row;
const run = (budgetMs = 50_000) => runHighLevelSync(integration(), { budgetMs, reason: "manual" });
const rows = (t: string) => (mem.tables[t] ?? []) as Row[];
const contact = (hlId: string) => rows("highLevelContact").find((c) => c.hlId === hlId)!;
const opp = (hlId: string) => rows("highLevelOpportunity").find((o) => o.hlId === hlId)!;

const hlOpp = (id: string, over: Row = {}): Row => ({
  id, name: `Owner ${id}`, pipelineId: "pMin", pipelineStageId: "s1", status: "open", contactId: `c_${id}`,
  createdAt: iso(T0 - 20 * DAY), updatedAt: iso(T0 - 5 * DAY), lastStageChangeAt: iso(T0 - 5 * DAY), lastStatusChangeAt: iso(T0 - 20 * DAY), ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  mem.reset();
  Object.assign(hl, { messages: [], opportunities: [], pipelines: PIPELINES, tags: ["leon county", "dispo"], exportPageSize: 500, calls: [] });
  hl.contacts.clear();
  hl.costMs = { export: 0, opps: 0 };
  hl.refuse.clear();
});
afterEach(() => vi.useRealTimers());

describe("opportunity pass", () => {
  it("first sight stores the step with no event; an observed move adds exactly one event; re-runs add nothing", async () => {
    seedIntegration();
    hl.opportunities = [hlOpp("o1"), hlOpp("o2", { pipelineStageId: "s2" }), hlOpp("o3", { status: "won", lastStatusChangeAt: iso(T0 - 2 * DAY) })];
    expect((await run()).ok).toBe(true);
    expect(rows("highLevelOpportunity")).toHaveLength(3);
    expect(opp("o1")).toMatchObject({ step: "opportunity", maxRank: 1, offerAt: null });
    expect(opp("o2")).toMatchObject({ step: "offer", maxRank: 2, offerAt: new Date(T0 - 5 * DAY) });
    expect(opp("o3")).toMatchObject({ step: "closed", maxRank: 6, closedAt: new Date(T0 - 2 * DAY) });
    expect(rows("highLevelStageEvent")).toHaveLength(0);

    // Someone moves o1 to "Offer Made" in HighLevel.
    vi.setSystemTime(T0 + 3_600_000);
    Object.assign(hl.opportunities[0], { pipelineStageId: "s2", lastStageChangeAt: iso(T0 + 1_800_000) });
    await run();
    expect(rows("highLevelStageEvent")).toEqual([expect.objectContaining({
      organizationId: ORG, opportunityHlId: "o1", pipelineId: "pMin", fromStageId: "s1", toStageId: "s2",
      fromStep: "opportunity", toStep: "offer", at: new Date(T0 + 1_800_000),
    })]);
    expect(opp("o1")).toMatchObject({ step: "offer", maxRank: 2, offerAt: new Date(T0 + 1_800_000) });

    await run();
    await run();
    expect(rows("highLevelStageEvent")).toHaveLength(1);
    expect(rows("highLevelOpportunity")).toHaveLength(3);
    expect(hlSync().lastRun).toMatchObject({ ok: true, opportunities: 3, stageMoves: 0 });
  });

  it("flags opportunities missing from a complete pass as deletedInHl (kept), and re-classifies their contacts", async () => {
    seedIntegration();
    mem.create("highLevelContact", { organizationId: ORG, hlId: "c_o2", tags: [], summaryDirty: false, summaryWindowDays: 30 });
    hl.opportunities = [hlOpp("o1"), hlOpp("o2")];
    await run();
    expect(contact("c_o2").line).toBe("minerals"); // its opportunity is in the Minerals pipeline (suggested filter)
    hl.opportunities = [hlOpp("o1")];
    await run();
    expect(opp("o2")).toMatchObject({ deletedInHl: true });
    expect(opp("o1")).toMatchObject({ deletedInHl: false });
    expect(contact("c_o2").line).toBe("unclassified");
    // It comes back: un-flagged, no stage event (same stage).
    hl.opportunities = [hlOpp("o1"), hlOpp("o2")];
    await run();
    expect(opp("o2")).toMatchObject({ deletedInHl: false });
    expect(rows("highLevelStageEvent")).toHaveLength(0);
  });

  it("a pass the budget cuts short resumes from the cursor, and only a pass done in one run concludes deletions", async () => {
    seedIntegration();
    hl.opportunities = Array.from({ length: 150 }, (_, i) => hlOpp(`o${String(i).padStart(3, "0")}`, { createdAt: iso(T0 - 30 * DAY + i * 60_000) }));
    mem.create("highLevelOpportunity", { organizationId: ORG, hlId: "gone", pipelineId: "pMin", step: "opportunity" });
    hl.costMs.opps = 60_000; // each page outlasts the 50 s budget
    await run();
    expect(rows("highLevelOpportunity")).toHaveLength(101);
    expect(hlSync().oppsCursor).toEqual({ startAfter: Date.parse(iso(T0 - 30 * DAY + 99 * 60_000)), startAfterId: "o099" });
    await run();
    expect(rows("highLevelOpportunity")).toHaveLength(151);
    expect(hlSync().oppsCursor).toBeUndefined();
    expect(opp("gone").deletedInHl).toBe(false); // the pass spanned two runs: no conclusion
    hl.costMs.opps = 1_000;
    await run();
    expect(opp("gone").deletedInHl).toBe(true);
  });

  it("a key without opportunities.readonly is noted and the rest of the sync carries on", async () => {
    seedIntegration({ metaRefreshAt: undefined });
    hl.refuse.add("pipelines").add("opps");
    const r = await run();
    expect(r.ok).toBe(true);
    expect(integration().status).toBe("CONNECTED");
    expect(hlSync().missingScopes).toEqual(["opportunities.readonly"]);
    expect(hl.calls.filter((c) => c.kind === "opps")).toHaveLength(0); // skipped until a meta refresh succeeds
    expect((await highLevelStatus(ORG)).missingScopes).toEqual(["opportunities.readonly"]);
    expect((integration().config as Row).locationTimezone).toBe("America/Chicago");
  });
});

describe("one-time rescan", () => {
  const msg = (n: number, over: Row = {}): Row => ({
    id: `m${n}`, contactId: "c1", dateAdded: iso(T0 - 30 * DAY + n * 3_600_000), direction: "outbound", status: "delivered",
    source: "workflow", body: "Hi, any interest in an offer on your minerals?", ...over,
  });

  it("re-reads the history from a checkpoint across runs and fills only segments + wrong numbers", async () => {
    seedIntegration({ rescan: undefined, checkpoint: iso(T0 - 30 * DAY + 6 * 3_600_000) });
    hl.messages = [
      msg(1), msg(2, { direction: "inbound", body: "Wrong number", source: undefined }), msg(3, { body: "x".repeat(200) }),
      msg(4, { body: "Thanks 🙂" }), msg(5, { direction: "inbound", body: "Who is this?", source: undefined }), msg(6),
    ];
    for (const m of hl.messages) {
      mem.create("highLevelMessage", {
        organizationId: ORG, hlId: m.id, hlContactId: "c1", direction: m.direction, status: "delivered", source: m.source ?? null,
        messageType: null, conversationId: null, hlUserId: null, optOut: false, sentAt: new Date(m.dateAdded as string),
      });
    }
    mem.create("highLevelContact", { organizationId: ORG, hlId: "c1", tags: [], summaryDirty: false, summaryWindowDays: 30, fetchedAt: new Date(T0) });
    hl.exportPageSize = 2;
    hl.costMs.export = 10_000;
    await run(); // import (10 s) + status refresh (10 s), then the rescan gets ~60% of the 30 s left: two pages
    expect(hlSync().rescan).toEqual({ done: false, checkpoint: iso(T0 - 30 * DAY + 4 * 3_600_000), updated: 4 });
    // (#6 was also re-read by the import's 2-minute overlap, which rewrites a changed row in full.)
    expect(rows("highLevelMessage").map((m) => m.segments)).toEqual([1, 1, 2, 1, null, 1]);
    expect(rows("highLevelMessage").map((m) => m.wrongNumber)).toEqual([false, true, false, false, false, false]);
    // The wrong-number reply re-ran the contact's summary: no longer a response.
    expect(contact("c1")).toMatchObject({ outcome: "RESPONDED", wrongNumberAt: new Date(hl.messages[1].dateAdded as string), wrongNumberTouch: 1 });

    hl.calls = [];
    await run();
    const rescanCall = hl.calls.filter((c) => c.kind === "export")[2];
    expect(rescanCall.params.startDate).toBe(iso(T0 - 30 * DAY + 4 * 3_600_000 - 2 * 60_000)); // checkpoint − 2 min overlap
    expect(hlSync().rescan).toEqual({ done: true, checkpoint: iso(T0 - 30 * DAY + 6 * 3_600_000), updated: 5 });
    expect(rows("highLevelMessage").map((m) => m.segments)).toEqual([1, 1, 2, 1, 1, 1]);
    // Nothing else on a row changed.
    expect(rows("highLevelMessage").every((m) => m.optOut === false && m.status === "delivered")).toBe(true);

    hl.calls = [];
    await run();
    expect(hl.calls.filter((c) => c.kind === "export")).toHaveLength(2); // import + status refresh only
  });

  it("is marked done at once when every row already has its segments", async () => {
    seedIntegration({ rescan: undefined });
    mem.create("highLevelMessage", { organizationId: ORG, hlId: "m1", hlContactId: "c1", direction: "outbound", segments: 1, sentAt: new Date(T0 - DAY) });
    await run();
    expect(hlSync().rescan).toEqual({ done: true, updated: 0 });
  });
});

describe("summaries and the minerals line", () => {
  const seedContact = (hlId: string, tags: string[], extra: Row = {}) =>
    mem.create("highLevelContact", { organizationId: ORG, hlId, tags, summaryDirty: true, fetchedAt: new Date(T0), ...extra });
  const seedMsg = (hlContactId: string, minutes: number, over: Row) => mem.create("highLevelMessage", {
    organizationId: ORG, hlId: `${hlContactId}_${minutes}`, hlContactId, status: "delivered", source: null, hlUserId: null,
    optOut: false, wrongNumber: false, segments: 1, sentAt: new Date(T0 - 5 * DAY + minutes * 60_000), ...over,
  });

  it("writes the line from tags + live opportunities' pipelines, and the new summary columns", async () => {
    seedIntegration();
    seedContact("cTag", ["Leon County"]);
    seedContact("cRE", ["dispo"]);
    seedContact("cPipe", []);
    seedContact("cDeleted", []);
    seedContact("cNone", ["wrong number-1"]);
    mem.create("highLevelOpportunity", { organizationId: ORG, hlId: "oP", hlContactId: "cPipe", pipelineId: "pMin", step: "opportunity" });
    mem.create("highLevelOpportunity", { organizationId: ORG, hlId: "oD", hlContactId: "cDeleted", pipelineId: "pMin", step: "opportunity", deletedInHl: true });
    // cTag: text → "wrong number" → text → real reply → a team member answers 4 minutes later.
    seedMsg("cTag", 0, { direction: "outbound", source: "workflow" });
    seedMsg("cTag", 10, { direction: "inbound", wrongNumber: true });
    seedMsg("cTag", 60, { direction: "outbound", source: "workflow" });
    seedMsg("cTag", 90, { direction: "inbound" });
    seedMsg("cTag", 94, { direction: "outbound", source: "app", hlUserId: "u2" });
    hl.opportunities = [hlOpp("oP", { contactId: "cPipe" })];
    await run();
    const line = (id: string) => contact(id).line;
    // Suggested filter (nothing saved): "… county" tags and the "Minerals" pipeline; nothing is real estate yet.
    expect([line("cTag"), line("cRE"), line("cPipe"), line("cDeleted"), line("cNone")]).toEqual(["minerals", "unclassified", "minerals", "unclassified", "unclassified"]);
    expect(contact("cTag")).toMatchObject({
      outcome: "RESPONDED", touches: 2, wrongNumberAt: new Date(T0 - 5 * DAY + 10 * 60_000), wrongNumberTouch: 1,
      replyAnsweredSeconds: 240, answeredByHlUserId: "u2", summaryDirty: false, summaryWindowDays: 30,
    });

    // The owner saves a filter (settings write the config, then mark everyone).
    const cfg = integration().config as Row;
    integration().config = { ...cfg, scope: { mineralTags: [], realEstateTags: ["dispo"], mineralPipelineIds: ["pMin"] } } as never;
    for (const c of rows("highLevelContact")) c.summaryDirty = true;
    await run();
    expect([line("cTag"), line("cRE"), line("cPipe")]).toEqual(["unclassified", "real_estate", "minerals"]);
  });

  it("a filter saved while a batch is being computed is not lost", async () => {
    seedIntegration();
    seedContact("cRE", ["dispo"]);
    let fired = false;
    mem.state.onSummaryRead = () => {
      if (fired) return;
      fired = true;
      // Mid-batch: the settings route saves a filter, then marks every contact (bumping updatedAt).
      const cfg = integration().config as Row;
      integration().config = { ...cfg, scope: { mineralTags: [], realEstateTags: ["dispo"], mineralPipelineIds: [] } } as never;
      Object.assign(contact("cRE"), { summaryDirty: true, updatedAt: new Date(Date.now() + 1) });
    };
    await run();
    expect(contact("cRE")).toMatchObject({ line: "real_estate", summaryDirty: false });
  });

  it("recomputes every summary once when the rules version changes", async () => {
    seedIntegration({ summaryVersion: 1 });
    seedContact("c1", ["leon county"], { summaryDirty: false, summaryWindowDays: 30, line: null });
    await run();
    expect(contact("c1")).toMatchObject({ line: "minerals", summaryDirty: false });
    expect(hlSync().summaryVersion).toBe(SUMMARY_VERSION);
  });
});

describe("weekly contact refresh", () => {
  it("re-reads contacts not looked at for a week, a few per run; a tag change marks the summary", async () => {
    seedIntegration();
    for (let i = 0; i < 15; i++) {
      const hlId = `c${String(i).padStart(2, "0")}`;
      mem.create("highLevelContact", {
        organizationId: ORG, hlId, tags: ["old list"], summaryDirty: false, summaryWindowDays: 30, line: "unclassified",
        fetchedAt: new Date(T0 - 8 * DAY + i * 60_000), lastMessageAt: new Date(T0 - 60 * DAY),
      });
      hl.contacts.set(hlId, { tags: i === 0 ? ["old list", "Leon County"] : ["old list"] });
    }
    await run();
    const fresh = rows("highLevelContact").filter((c) => (c.fetchedAt as Date).getTime() >= T0);
    expect(fresh).toHaveLength(10); // weeklyRefreshLimit: at least 10, spread over the week
    expect(contact("c00")).toMatchObject({ tags: ["old list", "Leon County"], summaryDirty: true });
    expect(contact("c05")).toMatchObject({ summaryDirty: false }); // same tags: no recompute
    await run();
    expect(contact("c00")).toMatchObject({ line: "minerals", summaryDirty: false });
    expect(rows("highLevelContact").filter((c) => (c.fetchedAt as Date).getTime() >= T0)).toHaveLength(15);
  });
});

describe("re-read tags now", () => {
  const seed = (n: number, newTagEvery: number) => {
    for (let i = 0; i < n; i++) {
      const hlId = `t${String(i).padStart(2, "0")}`;
      mem.create("highLevelContact", {
        organizationId: ORG, hlId, tags: ["old list"], summaryDirty: false, summaryWindowDays: 30, line: "unclassified",
        fetchedAt: new Date(T0 - 60 * 60_000), lastMessageAt: new Date(T0 - 60 * DAY),
      });
      hl.contacts.set(hlId, { tags: i % newTagEvery === 0 ? ["old list", "minerals"] : ["old list"] });
    }
  };

  it("looks everyone up again, re-sorts them with the new tag, and finishes by itself", async () => {
    seedIntegration({}, { scope: { mineralTags: ["minerals"], realEstateTags: [], mineralPipelineIds: [] } });
    seed(30, 2);
    // Read an hour ago, so neither the daily nor the weekly refresh would pick them up.
    await run();
    expect(rows("highLevelContact").filter((c) => (c.tags as string[]).includes("minerals"))).toHaveLength(0);

    vi.setSystemTime(T0 + 60_000);
    expect(await startTagRefresh(ORG)).toBe(true);
    expect(hlSync().tagRefresh).toMatchObject({ total: 30, changed: 0 });
    expect(hlSync().metaRefreshAt).toBeUndefined(); // HighLevel's tag list is re-read too
    expect((await highLevelStatus(ORG)).tagRefresh).toMatchObject({ running: true, done: 0, total: 30, etaMinutes: 1 });

    await run();
    expect(rows("highLevelContact").filter((c) => (c.tags as string[]).includes("minerals"))).toHaveLength(15);
    // Everyone looked up; their summaries (and minerals line) come next run, so it isn't finished yet.
    expect((await highLevelStatus(ORG)).tagRefresh).toMatchObject({ running: true, done: 30 });

    await run();
    expect(rows("highLevelContact").filter((c) => c.line === "minerals")).toHaveLength(15);
    const t = (await highLevelStatus(ORG)).tagRefresh!;
    expect(t).toMatchObject({ running: false, done: 30, total: 30, changed: 15, etaMinutes: 0 });
    expect(t.finishedAt).not.toBeNull();
    expect((hlSync().lastRun as Row).message).toMatch(/Tags re-read for 30 contacts — 15 contacts' tags changed/);

    // Finished: later runs leave it alone and look nobody up again.
    hl.calls.length = 0;
    await run();
    expect(hlSync().tagRefresh).toMatchObject({ changed: 15 });
  });

  it("won't start before the import is done, and a second start leaves the running one as it is", async () => {
    seedIntegration({ phase: "importing" });
    expect(await startTagRefresh(ORG)).toBe(false);
    expect(hlSync().tagRefresh).toBeUndefined();
    (hlSync() as Row).phase = "live";
    seed(4, 1);
    expect(await startTagRefresh(ORG)).toBe(true);
    const first = { ...(hlSync().tagRefresh as Row) };
    vi.setSystemTime(T0 + 5 * 60_000);
    expect(await startTagRefresh(ORG)).toBe(true);
    expect(hlSync().tagRefresh).toEqual(first);
  });
});

describe("Mineral Hub's own tags in HighLevel", () => {
  const SCOPE = { mineralTags: ["minerals"], realEstateTags: [], mineralPipelineIds: ["pMin"] };
  /** A contact with a real text history: O = delivered outbound text, I = reply, S = STOP. */
  const seedContact = (hlId: string, texts: string, tags: string[] = ["minerals"]) => {
    mem.create("highLevelContact", {
      organizationId: ORG, hlId, tags: [...tags], summaryDirty: true, line: null,
      fetchedAt: new Date(T0), lastMessageAt: new Date(T0 - DAY),
    });
    [...texts].forEach((k, i) => mem.create("highLevelMessage", {
      organizationId: ORG, hlId: `${hlId}_${i}`, hlContactId: hlId, direction: k === "O" ? "outbound" : "inbound",
      status: "delivered", source: "workflow", hlUserId: null, optOut: k === "S", wrongNumber: false, segments: 1,
      sentAt: new Date(T0 - 10 * DAY + i * DAY),
    }));
    hl.contacts.set(hlId, { tags: [...tags] });
  };
  const hlTags = (id: string) => (hl.contacts.get(id)!.tags as string[]);
  const writes = () => hl.calls.filter((c) => c.kind === "addTags" || c.kind === "removeTags");

  it("writes each contact's tags from its texts and minerals opportunities, only what's missing, and never twice", async () => {
    seedIntegration({}, { scope: SCOPE, crmTagsEnabled: true });
    seedContact("r2", "OOI");
    seedContact("n5", "OOOOO");
    seedContact("off", "OI", ["minerals", "sms - text 1 sent", "acquisition - interested", "probate"]);
    seedContact("stop", "OS");
    hl.opportunities = [
      hlOpp("o1", { contactId: "off", pipelineId: "pMin", pipelineStageId: "s2" }),
      hlOpp("o2", { contactId: "off", pipelineId: "pRE", pipelineStageId: "r1", status: "won" }), // real-estate pipeline: ignored
    ];
    await startCrmTagging(ORG);
    expect(hlSync().crmTags).toMatchObject({ backlog: true, removing: false });
    await run(); await run(); // summaries + opportunities first, then the writes
    expect(hlTags("r2")).toEqual(["minerals", "sms - text 1 sent", "sms - text 2 sent", "sms - responded - text 2"]);
    expect(hlTags("n5")).toEqual(["minerals", "sms - text 1 sent", "sms - text 2 sent", "sms - text 3 sent", "sms - text 4+ sent"]);
    // Only the changes: Responded - Text 1 and Offer Made added, Interested removed; probate untouched.
    expect(hlTags("off")).toEqual(["minerals", "sms - text 1 sent", "probate", "sms - responded - text 1", "acquisition - offer made"]);
    expect(hlTags("stop")).toEqual(["minerals", "sms - text 1 sent", "acquisition - do not contact"]);
    expect(rows("highLevelContact").every((c) => c.crmTagsPending === false)).toBe(true);
    expect(hlSync().crmTags).toMatchObject({ backlog: false, written: 4, error: null });
    expect((await highLevelStatus(ORG)).crmTags).toMatchObject({ enabled: true, pending: 0, tagged: 4, written: 4 });

    hl.calls.length = 0;
    await startCrmTagging(ORG); // switched off and on again: everyone re-checked, nothing re-written
    await run();
    expect(writes()).toHaveLength(0);
  });

  it("creates each brand-new tag once: the first write that adds it runs alone", async () => {
    seedIntegration({}, { scope: SCOPE, crmTagsEnabled: true });
    for (const id of ["a", "b", "c", "d", "e"]) seedContact(id, "OO");
    await startCrmTagging(ORG);
    await run(); await run();
    for (const id of ["a", "b", "c", "d", "e"]) expect(hlTags(id)).toEqual(["minerals", "sms - text 1 sent", "sms - text 2 sent"]);
    // Two writes adding a tag HighLevel doesn't have yet would each create it (seen in production).
    expect(hl.tags.filter((t) => t.startsWith("sms - "))).toEqual(["sms - text 1 sent", "sms - text 2 sent"]);
    expect(hlSync().crmTags).toMatchObject({ written: 5 });
  });

  it("follows a stage move: the contact's Acquisition tag changes on the next runs", async () => {
    seedIntegration({}, { scope: SCOPE, crmTagsEnabled: true });
    seedContact("c1", "OI");
    hl.opportunities = [hlOpp("o1", { contactId: "c1", pipelineStageId: "s1" })];
    await startCrmTagging(ORG);
    await run(); await run();
    expect(hlTags("c1")).toContain("acquisition - interested");
    hl.opportunities = [hlOpp("o1", { contactId: "c1", pipelineStageId: "s2", lastStageChangeAt: iso(T0) })];
    await run(); await run();
    expect(hlTags("c1")).toContain("acquisition - offer made");
    expect(hlTags("c1")).not.toContain("acquisition - interested");
  });

  it("a key without contacts.write: noted on the card, the rest of the sync carries on, and it resumes once allowed", async () => {
    seedIntegration({}, { scope: SCOPE, crmTagsEnabled: true });
    seedContact("c1", "OO");
    hl.refuse.add("write");
    await startCrmTagging(ORG);
    await run();
    const r = await run();
    expect(r.ok).toBe(true);
    expect(integration().status).toBe("CONNECTED");
    expect(hlSync().crmTags).toMatchObject({ error: "permission", backlog: false });
    expect((await highLevelStatus(ORG)).crmTags).toMatchObject({ error: "permission", pending: 1 });
    hl.refuse.delete("write");
    await run();
    expect(hlTags("c1")).toContain("sms - text 2 sent");
    expect(hlSync().crmTags).toMatchObject({ error: null });
  });

  it("Remove CRM tags takes only Mineral Hub's tags off, then stops", async () => {
    seedIntegration({}, { scope: SCOPE, crmTagsEnabled: false });
    seedContact("c1", "OOI", ["minerals", "sms - text 1 sent", "sms - responded - text 2", "acquisition - deal closed", "leon county"]);
    seedContact("c2", "O");
    await run(); // summaries
    await startCrmTagRemoval(ORG);
    expect(rows("highLevelContact").filter((c) => c.crmTagsPending).map((c) => c.hlId)).toEqual(["c1"]);
    await run();
    expect(hlTags("c1")).toEqual(["minerals", "leon county"]);
    expect(writes()).toHaveLength(1);
    expect(hlSync().crmTags).toMatchObject({ removing: false, backlog: false });
  });

  it("does nothing while switched off", async () => {
    seedIntegration({}, { scope: SCOPE });
    seedContact("c1", "OOI");
    await run(); await run();
    expect(writes()).toHaveLength(0);
    expect(contact("c1").crmTagsPending).toBe(false);
  });
});

describe("carrier health", () => {
  const BREACH = { sent: 200, failed: 40, reached: 150, optOuts: 1 };
  const notes = () => rows("notification").filter((n) => n.type === "sms_health");

  it("one notification for a new warning, none while it lasts, the next only a day later", async () => {
    seedIntegration();
    mem.state.health = { ...BREACH };
    await run();
    expect(notes()).toEqual([expect.objectContaining({
      organizationId: ORG, userId: null, type: "sms_health", link: "/reports?view=sms", title: "Texting health warning",
      body: expect.stringMatching(/^20% of texts sent in the last 7 days failed to deliver \(warning level 15%\)\. 20% of texts sent in the last 24 hours failed/),
    })]);
    expect(hlSync().healthNotified).toEqual(["day:failure", "week:failure"]);
    await run();
    await run();
    expect(notes()).toHaveLength(1);

    // Clears, then comes back within the day: no second notification yet.
    mem.state.health = { sent: 200, failed: 2, reached: 190, optOuts: 1 };
    await run();
    expect(hlSync().healthNotified).toBeUndefined();
    mem.state.health = { ...BREACH };
    vi.setSystemTime(T0 + 6 * 3_600_000);
    await run();
    expect(notes()).toHaveLength(1);
    vi.setSystemTime(T0 + 25 * 3_600_000);
    await run();
    expect(notes()).toHaveLength(2);
  });

  it("queries the last 24 hours and 7 days as UTC instants (the database session may not be in UTC)", async () => {
    seedIntegration();
    await run();
    const queries = mem.state.raw.map(([strings, ...values]) => Prisma.sql(strings as TemplateStringsArray, ...values));
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.sql).toMatch(/"sentAt" >= \?::timestamp AND m\."sentAt" < \?::timestamp/);
      expect(q.values).toContain(iso(T0));
    }
    expect(queries[0].values).toContain(iso(T0 - DAY));
    expect(queries[1].values).toContain(iso(T0 - 7 * DAY));
  });

  it("is only checked on live runs", async () => {
    seedIntegration({ phase: "importing" });
    mem.state.health = { ...BREACH };
    await run();
    expect(notes()).toHaveLength(0);
  });
});
