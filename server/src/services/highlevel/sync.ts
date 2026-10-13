/**
 * HighLevel SMS sync — mirrors the org's texting history (HighLevelMessage /
 * HighLevelContact) so Reports can measure outreach. READ-ONLY toward
 * HighLevel; message wording is never stored.
 *
 * One run (runHighLevelSync), in order, each step bounded by the run's time
 * budget so a run can stop between pages and the next one resumes:
 *  1. Users (every 6 h) → config.hlUsers, for sender names in Reports.
 *  2. Messages: a FRESH export query from the persisted createdAt checkpoint
 *     (minus a 2-minute overlap), sortBy createdAt asc, 500 per page. The
 *     export cursor is only followed within this run — it is a point-in-time
 *     token that may expire, so it is never persisted. The checkpoint is saved
 *     after every page, so a crash or a budget stop loses nothing.
 *  3. Live runs re-read the last 72 h once, to pick up delivery-status
 *     changes (HighLevel has no webhook for those).
 *  4. Opportunities: a full pass every live run (all statuses) — funnel step
 *     from the stage name, stage moves recorded as HighLevelStageEvent;
 *     pipelines / tags / time zone are re-read every 6 h (with users).
 *  5. One-time rescan of older texts for segments + wrong-number replies.
 *  6. Summaries (domain/smsMetrics.ts summarizeContact) plus the contact's
 *     minerals / real-estate line (domain/smsScope.ts classifyContact) for
 *     every contact whose messages, tags or opportunities changed, or whose
 *     summary used another response window or Minerals filter.
 *  7. Contact details for new contacts, a daily refresh of contacts texted in
 *     the last 14 days, and a weekly refresh of everyone, spread evenly
 *     (404 → deletedInHl, history kept). A tag change marks the summary.
 *  8. Live runs check carrier health (opt-outs / failed texts, last 24 h and
 *     7 days) and raise one admin notification for a new warning.
 * Writes are idempotent upserts keyed on (organizationId, hlId) and only
 * touch rows whose stored fields actually changed, so overlapping pages and
 * re-runs never duplicate or churn rows.
 *
 * Failures: an auth error flips the integration to ERROR at once (the key was
 * rotated or deleted — retrying can't help); anything else does after
 * FAILURES_BEFORE_ERROR consecutive failed runs. Entering ERROR raises one
 * admin notification. A success clears the failure count and the error.
 *
 * Concurrency: one run per org at a time, guarded by an in-memory set. Like
 * the other schedulers (integrationSync.ts, portalReminders.ts) this assumes
 * a single long-lived API instance (Railway runs one container); a second
 * instance would need a database lock instead.
 */
import { Prisma, type Integration } from "@prisma/client";
import { prisma } from "../../db.js";
import { decryptSecret } from "../secrets.js";
import { logActivity } from "../activityLog.js";
import {
  summarizeContact, carrierHealth, FAILED_STATUSES, PENDING_STATUSES, type SmsMessageInput, type HealthInput,
} from "../../domain/smsMetrics.js";
import { classifyContact, suggestScope } from "../../domain/smsScope.js";
import { desiredCrmTags, tagDiff, CRM_TAGS } from "../../domain/smsTags.js";
import { HighLevelClient, HighLevelError, HL_AUTH_MESSAGE, type HlExportPage, type HlOpportunity } from "./client.js";
import {
  readSyncState, responseWindowOf, toMessageRow, messageChanged, importStartDate, advanceCheckpoint,
  formatStartDate, startDateIgnored, toContactFields, toUserRefs, isDue, phaseAfterRun, storageEstimateMb,
  connectErrorMessage, rescanPatch, tagsChanged, weeklyRefreshLimit, toPipelineRefs, toTagNames, validTimezone,
  readPipelines, readTags, savedScopeOf, effectiveScope, sameScope, isPermissionRefusal, toOpportunityFields,
  unknownStage, planOpportunity, healthKeys, healthAlert, healthNotice, tagRefreshRunning, tagRefreshEtaMinutes, crmTagsEnabledOf,
  PAGE_LIMIT, STATUS_LOOKBACK_MS, USERS_REFRESH_MS, CONTACT_REFRESH_MS, CONTACT_ACTIVE_DAYS, CONTACT_WEEKLY_MS,
  FAILURES_BEFORE_ERROR, META_REFRESH_MS, OPP_PAGE_LIMIT, IMPORT_OPPS_EVERY_MS, SUMMARY_VERSION,
  type HlSyncState, type HlPhase, type HlLastRun, type HlUserRef, type HlPipelineRef, type MessageRow,
  type StoredOpp, type StageEventRow, type HealthWindow, type TagRefreshState, type CrmTagState,
} from "./mapping.js";

export const HIGHLEVEL = "highlevel";
/** Stored key can't be decrypted (server encryption key changed) — like an auth error, only a reconnect fixes it. */
export const HL_KEY_UNREADABLE = "The saved HighLevel key can't be read anymore (the server's encryption key changed). Reconnect with your key.";

/** Rows whose last failure needs a person (new key) before syncing can resume. */
export const needsReconnect = (row: Pick<Integration, "status" | "lastError">): boolean =>
  row.status === "ERROR" && (row.lastError === HL_AUTH_MESSAGE || row.lastError === HL_KEY_UNREADABLE);

export type RunReason = "import" | "scheduled" | "manual" | "settings";

export interface HighLevelRunResult {
  ok: boolean;
  /** True when nothing ran (another run in flight, or not connected). */
  skipped?: boolean;
  message: string;
  phase: HlPhase | null;
}

// --- Connect-time validation ----------------------------------------------------

export type ConnectCheck =
  | { ok: true; location: { id: string; name: string }; users: HlUserRef[]; texts: number }
  | { ok: false; message: string };

/**
 * Validate a key + Location ID before anything is stored: the location must
 * open, and the key must be allowed to read users and texts (the scopes the
 * sync needs). Also returns the preview count (export total at limit 10).
 */
export async function validateHighLevelConnection(token: string, locationId: string): Promise<ConnectCheck> {
  // Interactive: fewer retries so a HighLevel outage fails fast in the modal.
  const client = new HighLevelClient({ token, maxAttempts: 2, maxRetryWaitMs: 5_000 });
  let step: "location" | "users" | "messages" = "location";
  try {
    const location = await client.getLocation(locationId);
    step = "users";
    const users = await client.listUsers(locationId);
    step = "messages";
    const page = await client.exportMessages({ locationId, channel: "SMS", limit: 10 });
    return { ok: true, location: { id: location.id, name: location.name?.trim() || locationId }, users: toUserRefs(users), texts: page.total };
  } catch (e) {
    if (e instanceof HighLevelError) return { ok: false, message: connectErrorMessage(step, e, locationId) };
    throw e;
  }
}

/** The Test button: can the stored key still open the location? */
export async function checkHighLevel(row: Integration): Promise<{ ok: boolean; message: string }> {
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const locationId = typeof cfg.locationId === "string" ? cfg.locationId : "";
  if (typeof cfg._secret !== "string" || !locationId) return { ok: false, message: "No HighLevel key stored. Reconnect HighLevel." };
  let token: string;
  try { token = decryptSecret(cfg._secret); } catch { return { ok: false, message: HL_KEY_UNREADABLE }; }
  try {
    const loc = await new HighLevelClient({ token, maxAttempts: 2, maxRetryWaitMs: 5_000 }).getLocation(locationId);
    return { ok: true, message: `HighLevel key works — connected to ${loc.name?.trim() || locationId}.` };
  } catch (e) {
    return { ok: false, message: e instanceof HighLevelError ? e.message : "HighLevel check failed." };
  }
}

// --- Status (card + polling) ----------------------------------------------------

export interface HighLevelStatus {
  connected: boolean;
  status: "NOT_CONNECTED" | "CONNECTED" | "ERROR";
  locationId: string | null;
  locationName: string | null;
  phase: HlPhase | null;
  preview: { texts: number; at: string } | null;
  imported: number;
  contacts: number;
  lastSyncAt: string | null;
  lastError: string | null;
  lastRun: HlLastRun | null;
  responseWindowDays: number;
  storageEstimateMb: number | null;
  /** Optional read permissions the key lacks (e.g. "opportunities.readonly"). */
  missingScopes: string[];
  /** Mineral Hub's own SMS / Acquisition tags in HighLevel (off unless the owner turns it on). */
  crmTags: {
    enabled: boolean; removing: boolean; working: boolean; pending: number; tagged: number;
    error: "permission" | null; lastWriteAt: string | null; written: number;
  };
  /** "Re-read tags now" — the latest one, while running and after. */
  tagRefresh: {
    running: boolean; startedAt: string; finishedAt: string | null; auto: boolean;
    total: number; done: number; changed: number; etaMinutes: number;
  } | null;
}

/** Contacts still waiting for the running tag re-read (last read before it started). */
const tagRefreshPendingWhere = (org: string, t: TagRefreshState) => ({
  organizationId: org, deletedInHl: false,
  OR: [{ fetchedAt: null }, { fetchedAt: { lt: new Date(t.startedAt) } }],
});

export async function highLevelStatus(organizationId: string): Promise<HighLevelStatus> {
  const row = await prisma.integration.findUnique({ where: { organizationId_provider: { organizationId, provider: HIGHLEVEL } } });
  const cfg = (row?.config ?? {}) as Record<string, unknown>;
  const [imported, contacts] = await Promise.all([
    prisma.highLevelMessage.count({ where: { organizationId } }),
    prisma.highLevelContact.count({ where: { organizationId } }),
  ]);
  const hasState = !!row && cfg.hlSync != null;
  const state = readSyncState(cfg);
  const status = row?.status ?? "NOT_CONNECTED";
  const texts = Math.max(state.preview?.texts ?? 0, imported);
  const t = state.tagRefresh;
  const running = !!t && tagRefreshRunning(state);
  const pending = t && running ? await prisma.highLevelContact.count({ where: tagRefreshPendingWhere(organizationId, t) }) : 0;
  const crm = state.crmTags ?? {};
  const crmEnabled = crmTagsEnabledOf(cfg);
  const [crmPending, crmTagged] = crmEnabled || crm.removing || crm.backlog
    ? await Promise.all([
      prisma.highLevelContact.count({ where: { organizationId, crmTagsPending: true, deletedInHl: false } }),
      countCrmTagged(organizationId),
    ])
    : [0, 0];
  return {
    connected: status !== "NOT_CONNECTED",
    status,
    locationId: typeof cfg.locationId === "string" ? cfg.locationId : null,
    locationName: typeof cfg.locationName === "string" ? cfg.locationName : null,
    phase: hasState ? state.phase : null,
    preview: state.preview ?? null,
    imported,
    contacts,
    lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    lastRun: state.lastRun ?? null,
    responseWindowDays: responseWindowOf(cfg),
    storageEstimateMb: hasState ? storageEstimateMb(texts) : null,
    missingScopes: Array.isArray(state.missingScopes) ? state.missingScopes : [],
    crmTags: {
      enabled: crmEnabled, removing: !!crm.removing, working: !!crm.backlog || !!crm.removing, pending: crmPending, tagged: crmTagged,
      error: crm.error ?? null, lastWriteAt: crm.lastWriteAt ?? null, written: crm.written ?? 0,
    },
    tagRefresh: t ? {
      running, startedAt: t.startedAt, finishedAt: t.finishedAt ?? null, auto: !!t.auto,
      total: t.total, done: running ? Math.max(0, t.total - pending) : t.total, changed: t.changed ?? 0,
      etaMinutes: running ? tagRefreshEtaMinutes(pending) : 0,
    } : null,
  };
}

/**
 * Start "Re-read tags now" for an org: every contact is looked up in
 * HighLevel again (current tags, assignment, opt-out), oldest-read first,
 * in back-to-back runs (the scheduler's catch-up loop), then re-sorted into
 * minerals / real estate / not classified. Only once the import is done —
 * the import itself reads every contact's current tags. Returns false when
 * it can't start (not live) and leaves a running one untouched.
 */
// --- Mineral Hub's own HighLevel tags ------------------------------------------------------

const CRM_TAGS_LOWER = CRM_TAGS.map((t) => t.toLowerCase());

/** Contacts currently carrying at least one CRM tag (HighLevel stores tags lower-cased). */
async function countCrmTagged(organizationId: string): Promise<number> {
  const r = await prisma.$queryRaw<{ n: number }[]>(Prisma.sql`/* hl:crm-tagged */
    SELECT count(*)::int AS n FROM "HighLevelContact" c
    WHERE c."organizationId" = ${organizationId} AND NOT c."deletedInHl"
      AND EXISTS (SELECT 1 FROM unnest(c."tags") t WHERE lower(t) = ANY(${CRM_TAGS_LOWER}::text[]))`);
  return r[0]?.n ?? 0;
}

/**
 * Turn CRM tags on (the settings route calls this after saving
 * crmTagsEnabled = true): every texted contact is checked once, in
 * back-to-back runs — contacts whose tags are already right cost no
 * HighLevel request.
 */
export async function startCrmTagging(organizationId: string): Promise<void> {
  const row = await prisma.integration.findUnique({ where: { organizationId_provider: { organizationId, provider: HIGHLEVEL } } });
  if (!row || row.status === "NOT_CONNECTED") return;
  await prisma.highLevelContact.updateMany({ where: { organizationId, deletedInHl: false, outboundTotal: { gt: 0 } }, data: { crmTagsPending: true } });
  const prev = readSyncState(row.config).crmTags ?? {};
  await saveState(row.id, { crmTags: { ...prev, backlog: true, removing: false, error: null } });
}

/** Turned off: stop writing (tags already in HighLevel stay until "Remove CRM tags"). */
export async function stopCrmTagging(organizationId: string): Promise<void> {
  const row = await prisma.integration.findUnique({ where: { organizationId_provider: { organizationId, provider: HIGHLEVEL } } });
  if (!row) return;
  await prisma.highLevelContact.updateMany({ where: { organizationId, crmTagsPending: true }, data: { crmTagsPending: false } });
  const prev = readSyncState(row.config).crmTags ?? {};
  if (row.status !== "NOT_CONNECTED") await saveState(row.id, { crmTags: { ...prev, backlog: false, removing: false } });
}

/** "Remove CRM tags": take every CRM tag off every contact in HighLevel (the setting is turned off by the caller). */
export async function startCrmTagRemoval(organizationId: string): Promise<void> {
  const row = await prisma.integration.findUnique({ where: { organizationId_provider: { organizationId, provider: HIGHLEVEL } } });
  if (!row || row.status === "NOT_CONNECTED") return;
  await prisma.$executeRaw(Prisma.sql`/* hl:crm-untag */
    UPDATE "HighLevelContact" c SET "crmTagsPending" = true
    WHERE c."organizationId" = ${organizationId} AND NOT c."deletedInHl"
      AND EXISTS (SELECT 1 FROM unnest(c."tags") t WHERE lower(t) = ANY(${CRM_TAGS_LOWER}::text[]))`);
  const prev = readSyncState(row.config).crmTags ?? {};
  await saveState(row.id, { crmTags: { ...prev, backlog: true, removing: true, error: null } });
}

export async function startTagRefresh(organizationId: string, opts: { auto?: boolean } = {}): Promise<boolean> {
  const row = await prisma.integration.findUnique({ where: { organizationId_provider: { organizationId, provider: HIGHLEVEL } } });
  if (!row || row.status === "NOT_CONNECTED") return false;
  const state = readSyncState(row.config);
  if (state.phase !== "live") return false;
  if (tagRefreshRunning(state)) return true;
  const total = await prisma.highLevelContact.count({ where: { organizationId, deletedInHl: false } });
  // Also re-read HighLevel's tag list on the next run, so tags created since
  // the last 6-hourly refresh show up in the Minerals filter.
  await saveState(row.id, {
    tagRefresh: { startedAt: new Date().toISOString(), total, changed: 0, ...(opts.auto ? { auto: true } : {}) },
    metaRefreshAt: undefined,
  });
  return true;
}

// --- The run ----------------------------------------------------------------------

/** Orgs with a run in flight (see the single-instance note at the top). */
const running = new Set<string>();
export const isHighLevelRunning = (organizationId: string) => running.has(organizationId);

/** Thrown when the integration was disconnected mid-run: stop quietly, write nothing more. */
class SyncStopped extends Error {}
/** HighLevel asked us to wait (429 beyond our retry budget, or today's budget nearly spent). */
class SyncPaused extends Error {
  constructor(readonly waitMs: number, message: string) { super(message); }
}

interface Stats {
  newMessages: number; updatedMessages: number; contactsFetched: number; summaries: number;
  opportunities: number; stageMoves: number; rescanned: number;
  /** Contacts whose tags changed when looked up again this run. */
  tagsChanged: number;
  /** Contacts whose CRM tags were written to HighLevel this run. */
  crmTagged: number;
}

interface Ctx {
  rowId: string;
  org: string;
  locationId: string;
  client: HighLevelClient;
  state: HlSyncState;
  stats: Stats;
  deadline: number;
  /** Pipelines by id (stage names → funnel steps). */
  pipelines: Map<string, HlPipelineRef>;
  /** Pipelines / tags / time zone were re-read this run. */
  metaRefreshed: boolean;
}

const timeLeft = (ctx: Ctx) => Date.now() < ctx.deadline;

/** Merge into the STORED config (other writers — settings, disconnect — may have changed it mid-run). */
async function saveState(rowId: string, patch: Partial<HlSyncState>, extra: Record<string, unknown> = {}): Promise<HlSyncState> {
  const cur = await prisma.integration.findUnique({ where: { id: rowId }, select: { config: true, status: true } });
  if (!cur || cur.status === "NOT_CONNECTED") throw new SyncStopped();
  const cfg = (cur.config ?? {}) as Record<string, unknown>;
  const next: HlSyncState = { ...readSyncState(cfg), ...patch };
  for (const k of Object.keys(next) as (keyof HlSyncState)[]) if (next[k] === undefined) delete next[k];
  await prisma.integration.update({ where: { id: rowId }, data: { config: { ...cfg, ...extra, hlSync: next } as never } });
  return next;
}

/**
 * Upsert one page of messages. New rows are inserted (ON CONFLICT DO NOTHING
 * on (organizationId, hlId)); existing rows are rewritten only when a field
 * changed. Contacts behind new/changed messages get a placeholder row (if
 * unseen) and are marked for a summary recompute.
 */
async function upsertMessages(org: string, rows: MessageRow[]): Promise<{ created: number; updated: number }> {
  if (!rows.length) return { created: 0, updated: 0 };
  const unique = [...new Map(rows.map((r) => [r.hlId, r])).values()];
  const existing = await prisma.highLevelMessage.findMany({
    where: { organizationId: org, hlId: { in: unique.map((r) => r.hlId) } },
    select: {
      id: true, hlId: true, hlContactId: true, conversationId: true, direction: true, messageType: true,
      status: true, source: true, hlUserId: true, optOut: true, wrongNumber: true, segments: true, sentAt: true,
    },
  });
  const byHlId = new Map(existing.map((e) => [e.hlId, e]));
  const toCreate = unique.filter((r) => !byHlId.has(r.hlId));
  const toUpdate = unique.filter((r) => { const p = byHlId.get(r.hlId); return !!p && messageChanged(p, r); });

  let created = 0;
  if (toCreate.length) {
    created = (await prisma.highLevelMessage.createMany({
      data: toCreate.map((r) => ({ organizationId: org, ...r })),
      skipDuplicates: true,
    })).count;
  }
  if (toUpdate.length) {
    await prisma.$transaction(toUpdate.map((r) => {
      const { hlId: _hlId, ...fields } = r;
      return prisma.highLevelMessage.update({ where: { id: byHlId.get(r.hlId)!.id }, data: fields });
    }));
  }

  const touched = new Set<string>();
  for (const r of toCreate) touched.add(r.hlContactId);
  for (const r of toUpdate) { touched.add(r.hlContactId); touched.add(byHlId.get(r.hlId)!.hlContactId); }
  if (touched.size) {
    const ids = [...touched];
    await prisma.highLevelContact.createMany({
      data: ids.map((hlId) => ({ organizationId: org, hlId, summaryDirty: true })),
      skipDuplicates: true,
    });
    await markContactsDirty(org, ids);
  }
  // Reported as delivery updates: rows that changed for more than a newly counted segment / wrong-number flag.
  const updated = toUpdate.filter((r) => messageChanged({ ...byHlId.get(r.hlId)!, segments: r.segments, wrongNumber: r.wrongNumber }, r)).length;
  return { created, updated };
}

/** Flag contacts for a summary (and line) recompute. */
async function markContactsDirty(org: string, hlIds: readonly string[]): Promise<void> {
  if (!hlIds.length) return;
  await prisma.highLevelContact.updateMany({
    where: { organizationId: org, hlId: { in: [...hlIds] }, summaryDirty: false },
    data: { summaryDirty: true },
  });
}

interface Page { rows: MessageRow[]; last: boolean }

/** One export page, oldest first (the export's sort), mapped to mirror rows. */
async function exportPage(ctx: Ctx, opts: { cursor?: string; startDate?: string }): Promise<{ page: HlExportPage; rows: MessageRow[] }> {
  const page = await ctx.client.exportMessages({
    locationId: ctx.locationId, channel: "SMS", limit: PAGE_LIMIT, sortBy: "createdAt", sortOrder: "asc", ...opts,
  });
  return { page, rows: page.messages.map(toMessageRow).filter((r): r is MessageRow => !!r) };
}

/**
 * First page of a query with a startDate. The format is undocumented: try ISO
 * 8601, and on a 400/422 — or if the filter was silently ignored — epoch ms.
 * The format that worked is remembered in hlSync.dateParam.
 */
async function firstPageFrom(ctx: Ctx, start: Date): Promise<{ page: HlExportPage; rows: MessageRow[] }> {
  if (ctx.state.dateParam) return exportPage(ctx, { startDate: formatStartDate(start, ctx.state.dateParam) });
  let iso: Awaited<ReturnType<typeof exportPage>> | null = null;
  try {
    iso = await exportPage(ctx, { startDate: formatStartDate(start, "iso") });
  } catch (e) {
    if (!(e instanceof HighLevelError && e.kind === "badRequest")) throw e;
  }
  if (iso && !startDateIgnored(start, iso.rows)) {
    ctx.state.dateParam = "iso";
    return iso;
  }
  const ms = await exportPage(ctx, { startDate: formatStartDate(start, "ms") });
  ctx.state.dateParam = "ms";
  return ms;
}

/**
 * A fresh export query from `start` (null = the very beginning), page by
 * page. The cursor is followed only within this run; later pages repeat the
 * same filters. Stops early when HighLevel's daily allowance runs low.
 */
async function* pagesFrom(ctx: Ctx, start: Date | null): AsyncGenerator<Page> {
  let cursor: string | undefined;
  for (;;) {
    checkDailyBudget(ctx);
    const { page, rows } = !cursor && start
      ? await firstPageFrom(ctx, start)
      : await exportPage(ctx, { cursor, startDate: start ? formatStartDate(start, ctx.state.dateParam ?? "iso") : undefined });
    const last = !page.nextCursor || page.messages.length === 0;
    yield { rows, last };
    if (last) return;
    cursor = page.nextCursor!;
  }
}

function checkDailyBudget(ctx: Ctx): void {
  if (ctx.client.dailyBudgetLow) {
    throw new SyncPaused(60 * 60_000, "HighLevel's daily request allowance is nearly used up — the sync will continue in about an hour.");
  }
}

/** Step 2: new messages from the checkpoint. Returns whether the import reached the present. */
async function importMessages(ctx: Ctx): Promise<boolean> {
  const initial = ctx.state.checkpoint;
  // Hard stop at twice the budget: never end a run for time before the
  // checkpoint has moved, or a burst of texts inside one overlap window
  // could be re-read forever.
  const hardDeadline = ctx.deadline + (ctx.deadline - Date.now());
  for await (const { rows, last } of pagesFrom(ctx, importStartDate(initial))) {
    const r = await upsertMessages(ctx.org, rows);
    ctx.stats.newMessages += r.created;
    ctx.stats.updatedMessages += r.updated;
    ctx.state.checkpoint = advanceCheckpoint(ctx.state.checkpoint, rows);
    ctx.state.imported = (ctx.state.imported ?? 0) + r.created;
    // Saved after every page: a crash or a budget stop resumes from here.
    await saveState(ctx.rowId, { checkpoint: ctx.state.checkpoint, imported: ctx.state.imported, dateParam: ctx.state.dateParam });
    if (last) return true;
    if (Date.now() >= ctx.deadline && (ctx.state.checkpoint !== initial || Date.now() >= hardDeadline)) return false;
  }
  return true;
}

/** Step 3 (live runs): re-read the last 72 h for delivery-status changes. Returns true when it completed. */
async function refreshRecentStatuses(ctx: Ctx): Promise<boolean> {
  for await (const { rows, last } of pagesFrom(ctx, new Date(Date.now() - STATUS_LOOKBACK_MS))) {
    const r = await upsertMessages(ctx.org, rows);
    ctx.stats.newMessages += r.created;
    ctx.stats.updatedMessages += r.updated;
    ctx.state.imported = (ctx.state.imported ?? 0) + r.created;
    if (last) return true;
    if (!timeLeft(ctx)) return false;
  }
  return true;
}

// --- Pipelines, tags, time zone (every 6 h) ---------------------------------------

export const OPPORTUNITIES_SCOPE = "opportunities.readonly";
export const TAGS_SCOPE = "locations/tags.readonly";

/**
 * Re-read the account's pipelines (stage names → funnel steps), tags (the
 * Minerals filter's list) and time zone (Reports' best time to text). The
 * key may lack the two optional permissions: that is recorded in
 * hlSync.missingScopes and the rest of the sync carries on.
 */
async function refreshMeta(ctx: Ctx): Promise<void> {
  // The location read needs the permission every key has — a refusal here is a real auth failure.
  const location = await ctx.client.getLocation(ctx.locationId);
  const missing: string[] = [];
  const optional = async <T>(scope: string, read: () => Promise<T>): Promise<T | null> => {
    try { return await read(); } catch (e) {
      if (isPermissionRefusal(e)) { missing.push(scope); return null; }
      throw e;
    }
  };
  const pipelines = await optional(OPPORTUNITIES_SCOPE, async () => toPipelineRefs(await ctx.client.listPipelines(ctx.locationId)));
  const tags = await optional(TAGS_SCOPE, async () => toTagNames(await ctx.client.listTags(ctx.locationId)));

  const cur = await prisma.integration.findUnique({ where: { id: ctx.rowId }, select: { config: true } });
  const extra: Record<string, unknown> = { locationTimezone: validTimezone(location.timezone) };
  if (pipelines) extra.hlPipelines = pipelines;
  if (tags) extra.hlTags = tags;
  // Without a saved filter, lines follow suggestScope(): new tags or pipelines can change it.
  if (!savedScopeOf(cur?.config)) {
    const before = suggestScope(readTags(cur?.config), readPipelines(cur?.config));
    const after = suggestScope(tags ?? readTags(cur?.config), pipelines ?? readPipelines(cur?.config));
    if (!sameScope(before, after)) {
      await prisma.highLevelContact.updateMany({ where: { organizationId: ctx.org, summaryDirty: false }, data: { summaryDirty: true } });
    }
  }
  ctx.state.missingScopes = missing.length ? missing : undefined;
  ctx.state.metaRefreshAt = new Date().toISOString();
  await saveState(ctx.rowId, { metaRefreshAt: ctx.state.metaRefreshAt, missingScopes: ctx.state.missingScopes }, extra);
  ctx.pipelines = new Map((pipelines ?? readPipelines(cur?.config)).map((p) => [p.id, p]));
  ctx.metaRefreshed = true;
}

/** An optional step was refused mid-run: remember it (the next meta refresh retries) and skip it. */
async function noteMissingScope(ctx: Ctx, scope: string): Promise<void> {
  ctx.state.missingScopes = [...new Set([...(ctx.state.missingScopes ?? []), scope])];
  await saveState(ctx.rowId, { missingScopes: ctx.state.missingScopes });
}

// --- Opportunities ------------------------------------------------------------------

const OPP_SELECT = {
  id: true, hlId: true, hlContactId: true, pipelineId: true, stageId: true, status: true, monetaryValue: true,
  assignedToHlUserId: true, source: true, name: true, step: true, maxRank: true, hlCreatedAt: true, hlUpdatedAt: true,
  lastStageChangeAt: true, offerAt: true, acceptedAt: true, contractAt: true, closedAt: true, deadAt: true, deletedInHl: true,
} as const;

/** Upsert one search page: new opportunities inserted, changed ones rewritten, observed moves recorded. */
async function upsertOpportunities(ctx: Ctx, list: readonly HlOpportunity[]): Promise<void> {
  const rows = [...new Map(list
    .map((o) => toOpportunityFields(o, ctx.pipelines))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => [r.hlId, r])).values()];
  if (!rows.length) return;
  const existing = await prisma.highLevelOpportunity.findMany({
    where: { organizationId: ctx.org, hlId: { in: rows.map((r) => r.hlId) } },
    select: OPP_SELECT,
  });
  const byHlId = new Map(existing.map((e) => [e.hlId, e]));
  const now = new Date();
  const creates: Record<string, unknown>[] = [];
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const events: StageEventRow[] = [];
  const dirty = new Set<string>();
  for (const r of rows) {
    const prev = byHlId.get(r.hlId) ?? null;
    const plan = planOpportunity(prev as StoredOpp | null, r, now);
    if (plan.create) creates.push({ organizationId: ctx.org, ...plan.data });
    else if (plan.data) updates.push({ id: prev!.id, data: plan.data });
    if (plan.event) events.push(plan.event);
    for (const c of plan.dirtyContacts) dirty.add(c);
  }
  if (creates.length) await prisma.highLevelOpportunity.createMany({ data: creates as never, skipDuplicates: true });
  if (updates.length) {
    await prisma.$transaction(updates.map((u) => prisma.highLevelOpportunity.update({ where: { id: u.id }, data: u.data })));
  }
  if (events.length) await prisma.highLevelStageEvent.createMany({ data: events.map((e) => ({ organizationId: ctx.org, ...e })) });
  await markContactsDirty(ctx.org, [...dirty]);
  ctx.stats.opportunities += rows.length;
  ctx.stats.stageMoves += events.length;
}

/** After a complete pass: opportunities HighLevel no longer returns are kept, flagged deletedInHl. */
async function markDeletedOpportunities(ctx: Ctx, seen: ReadonlySet<string>): Promise<void> {
  const stored = await prisma.highLevelOpportunity.findMany({
    where: { organizationId: ctx.org, deletedInHl: false },
    select: { id: true, hlId: true, hlContactId: true },
  });
  const gone = stored.filter((o) => !seen.has(o.hlId));
  for (let i = 0; i < gone.length; i += 500) {
    await prisma.highLevelOpportunity.updateMany({ where: { id: { in: gone.slice(i, i + 500).map((o) => o.id) } }, data: { deletedInHl: true } });
  }
  await markContactsDirty(ctx.org, [...new Set(gone.map((o) => o.hlContactId).filter((c): c is string => !!c))]);
}

/**
 * Step 4: one pass over every opportunity (all statuses), 100 per page. A
 * pass the budget cuts short resumes from HighLevel's startAfter cursor next
 * run. Deletions are only concluded from a pass that ran start to finish in
 * one run and saw at least as many opportunities as HighLevel reported.
 */
async function syncOpportunities(ctx: Ctx): Promise<void> {
  if (ctx.state.missingScopes?.includes(OPPORTUNITIES_SCOPE)) return;
  const resumed = ctx.state.oppsCursor ?? null;
  let cursor: { startAfter: number | null; startAfterId: string } | null = resumed;
  const seen = new Set<string>();
  let total: number | null = null;
  for (;;) {
    checkDailyBudget(ctx);
    let page;
    try {
      page = await ctx.client.searchOpportunities({ locationId: ctx.locationId, limit: OPP_PAGE_LIMIT, ...cursor });
    } catch (e) {
      if (isPermissionRefusal(e)) { await noteMissingScope(ctx, OPPORTUNITIES_SCOPE); return; }
      throw e;
    }
    total ??= page.meta.total;
    // A stage or pipeline added since the last refresh: re-read the names before mapping steps.
    if (!ctx.metaRefreshed && page.opportunities.some((o) => unknownStage(o, ctx.pipelines))) await refreshMeta(ctx);
    await upsertOpportunities(ctx, page.opportunities);
    for (const o of page.opportunities) if (typeof o.id === "string" && o.id) seen.add(o.id);
    const next = page.meta.startAfterId ? { startAfter: page.meta.startAfter, startAfterId: page.meta.startAfterId } : null;
    const stuck = !!next && !!cursor && next.startAfterId === cursor.startAfterId && next.startAfter === cursor.startAfter;
    if (page.opportunities.length < OPP_PAGE_LIMIT || !next || stuck) {
      if (!resumed && (total == null || seen.size >= total)) await markDeletedOpportunities(ctx, seen);
      ctx.state.oppsRefreshAt = new Date().toISOString();
      ctx.state.oppsCursor = undefined;
      await saveState(ctx.rowId, { oppsRefreshAt: ctx.state.oppsRefreshAt, oppsCursor: undefined });
      return;
    }
    cursor = next;
    if (!timeLeft(ctx)) {
      ctx.state.oppsCursor = cursor;
      await saveState(ctx.rowId, { oppsCursor: cursor });
      return;
    }
  }
}

// --- One-time rescan ------------------------------------------------------------------

/** Write corrected segments / wrong-number flags for one page; returns how many rows changed. */
async function applyRescan(org: string, rows: readonly MessageRow[]): Promise<number> {
  if (!rows.length) return 0;
  const existing = await prisma.highLevelMessage.findMany({
    where: { organizationId: org, hlId: { in: rows.map((r) => r.hlId) } },
    select: { id: true, hlId: true, hlContactId: true, segments: true, wrongNumber: true },
  });
  const byHlId = new Map(existing.map((e) => [e.hlId, e]));
  const writes: { id: string; data: { segments: number; wrongNumber: boolean } }[] = [];
  const dirty = new Set<string>();
  for (const r of rows) {
    const prev = byHlId.get(r.hlId);
    const patch = prev ? rescanPatch(prev, r) : null;
    if (!prev || !patch || writes.some((w) => w.id === prev.id)) continue;
    writes.push({ id: prev.id, data: patch });
    // Segments don't change a summary; a wrong-number reply does.
    if (prev.wrongNumber !== patch.wrongNumber) dirty.add(prev.hlContactId);
  }
  if (writes.length) await prisma.$transaction(writes.map((w) => prisma.highLevelMessage.update({ where: { id: w.id }, data: w.data })));
  await markContactsDirty(org, [...dirty]);
  return writes.length;
}

/**
 * Step 5 (live runs, until done): re-read the whole SMS history once,
 * oldest first from hlSync.rescan.checkpoint, and fill segments + the
 * wrong-number flag on rows imported before they existed. Nothing else on a
 * row changes. Gets at most ~60% of what's left of the run, so summaries and
 * contact lookups still happen; like the import, a run never stops for time
 * before its checkpoint has moved.
 */
async function rescanHistory(ctx: Ctx): Promise<void> {
  let r = ctx.state.rescan;
  if (r?.done) return;
  if (!r) {
    const pending = await prisma.highLevelMessage.count({ where: { organizationId: ctx.org, segments: null } });
    if (!pending) {
      ctx.state.rescan = { done: true, updated: 0 };
      await saveState(ctx.rowId, { rescan: ctx.state.rescan });
      return;
    }
    r = { done: false, updated: 0 };
  }
  const initial = r.checkpoint;
  const softDeadline = Date.now() + Math.max(0, ctx.deadline - Date.now()) * 0.6;
  for await (const { rows, last } of pagesFrom(ctx, importStartDate(r.checkpoint))) {
    const changed = await applyRescan(ctx.org, rows);
    ctx.stats.rescanned += changed;
    r = { done: last, checkpoint: advanceCheckpoint(r.checkpoint, rows), updated: (r.updated ?? 0) + changed };
    ctx.state.rescan = r;
    await saveState(ctx.rowId, { rescan: r, dateParam: ctx.state.dateParam });
    if (last) return;
    if (Date.now() >= softDeadline && (r.checkpoint !== initial || Date.now() >= ctx.deadline)) return;
  }
}

// --- Summaries ------------------------------------------------------------------------

const SUMMARY_BATCH = 200;

/** Contacts whose stored summary is stale: messages changed, or computed with another window. */
const staleSummaryWhere = (org: string, windowDays: number) => ({
  organizationId: org,
  OR: [{ summaryDirty: true }, { summaryWindowDays: null }, { summaryWindowDays: { not: windowDays } }],
});

/**
 * Step 6: recompute outreach summaries in batches (summarizeContact is the
 * single counting rule) together with each contact's line (classifyContact
 * over its tags and its live opportunities' pipelines). The window and the
 * Minerals filter are re-read per batch, and a contact is only marked clean
 * if nothing (e.g. a settings change) touched it since it was read.
 */
async function recomputeSummaries(ctx: Ctx): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    if (i > 0 && !timeLeft(ctx)) return;
    // Re-read the settings: the owner may change them while this run is going.
    const cur = await prisma.integration.findUnique({ where: { id: ctx.rowId }, select: { config: true } });
    const windowDays = responseWindowOf(cur?.config);
    const { scope } = effectiveScope(cur?.config);
    const batch = await prisma.highLevelContact.findMany({
      where: staleSummaryWhere(ctx.org, windowDays),
      select: { id: true, hlId: true, tags: true, smsOptedOut: true, updatedAt: true },
      orderBy: { id: "asc" },
      take: SUMMARY_BATCH,
    });
    if (!batch.length) return;
    const ids = batch.map((b) => b.hlId);
    const [msgs, opps] = await Promise.all([
      prisma.highLevelMessage.findMany({
        where: { organizationId: ctx.org, hlContactId: { in: ids } },
        select: { hlContactId: true, direction: true, status: true, sentAt: true, hlUserId: true, optOut: true, wrongNumber: true, source: true },
      }),
      prisma.highLevelOpportunity.findMany({
        where: { organizationId: ctx.org, hlContactId: { in: ids }, deletedInHl: false },
        select: { hlContactId: true, pipelineId: true, step: true },
      }),
    ]);
    // CRM tags (when on, or being removed): does HighLevel need a change for this contact?
    const crm = readSyncState(cur?.config).crmTags ?? {};
    const tagging = crmTagsEnabledOf(cur?.config) || !!crm.removing;
    const mineralSteps = new Map<string, string[]>();
    for (const o of opps) {
      if (!o.hlContactId || !scope.mineralPipelineIds.includes(o.pipelineId)) continue;
      mineralSteps.set(o.hlContactId, [...(mineralSteps.get(o.hlContactId) ?? []), o.step]);
    }
    const byContact = new Map<string, SmsMessageInput[]>();
    for (const m of msgs) {
      const list = byContact.get(m.hlContactId) ?? [];
      list.push(m);
      byContact.set(m.hlContactId, list);
    }
    const pipelinesOf = new Map<string, string[]>();
    for (const o of opps) {
      if (!o.hlContactId) continue;
      const list = pipelinesOf.get(o.hlContactId) ?? [];
      list.push(o.pipelineId);
      pipelinesOf.set(o.hlContactId, list);
    }
    await prisma.$transaction(batch.map((b) => {
      const s = summarizeContact(byContact.get(b.hlId) ?? [], windowDays);
      const line = classifyContact(b.tags, pipelinesOf.get(b.hlId) ?? [], scope);
      const want = !tagging || crm.removing ? [] : desiredCrmTags({
        touches: s.touches, outcome: s.outcome, smsOptedOut: b.smsOptedOut,
        opportunities: (mineralSteps.get(b.hlId) ?? []).map((step) => ({ step })),
      });
      const diff = tagging ? tagDiff(b.tags, want) : { add: [], remove: [] };
      return prisma.highLevelContact.updateMany({
        where: { id: b.id, updatedAt: b.updatedAt },
        data: {
          ...s, line, summaryDirty: false, summaryWindowDays: windowDays,
          ...(tagging ? { crmTagsPending: diff.add.length + diff.remove.length > 0 } : {}),
        },
      });
    }));
    ctx.stats.summaries += batch.length;
  }
}

// --- Contact details ---------------------------------------------------------------------

const FIRST_FETCH_PER_RUN = 600;
/** Upper bound per run for "Re-read tags now" (the run's time budget is the real limit). */
const TAG_REFRESH_PER_RUN = 2_000;
const REFRESH_PER_RUN = 150;
const CONTACT_CONCURRENCY = 4;

/**
 * Step 7: contact details — new contacts first, then (live) the daily refresh
 * of recently texted ones and the weekly refresh of everyone (so tags renamed
 * in HighLevel show up within a week, a few contacts per run). A changed tag
 * list marks the contact's summary (its line depends on its tags).
 */
async function fetchContacts(ctx: Ctx): Promise<void> {
  const now = Date.now();
  const select = { id: true, hlId: true, tags: true } as const;
  const firsts = await prisma.highLevelContact.findMany({
    where: { organizationId: ctx.org, fetchedAt: null, deletedInHl: false },
    select,
    orderBy: { createdAt: "asc" },
    take: FIRST_FETCH_PER_RUN,
  });
  const live = ctx.state.phase === "live";
  const refresh = live ? await prisma.highLevelContact.findMany({
    where: {
      organizationId: ctx.org, deletedInHl: false,
      fetchedAt: { lt: new Date(now - CONTACT_REFRESH_MS) },
      lastMessageAt: { gte: new Date(now - CONTACT_ACTIVE_DAYS * 86_400_000) },
    },
    select,
    orderBy: { fetchedAt: "asc" },
    take: REFRESH_PER_RUN,
  }) : [];
  const weekly = live ? await prisma.highLevelContact.findMany({
    where: { organizationId: ctx.org, deletedInHl: false, fetchedAt: { lt: new Date(now - CONTACT_WEEKLY_MS) } },
    select,
    orderBy: { fetchedAt: "asc" },
    take: weeklyRefreshLimit(await prisma.highLevelContact.count({ where: { organizationId: ctx.org, deletedInHl: false } })),
  }) : [];
  // "Re-read tags now": everyone last read before it started, oldest first.
  const t = ctx.state.tagRefresh;
  const retag = live && t && tagRefreshRunning(ctx.state) ? await prisma.highLevelContact.findMany({
    where: tagRefreshPendingWhere(ctx.org, t),
    select,
    orderBy: { fetchedAt: "asc" },
    take: TAG_REFRESH_PER_RUN,
  }) : [];
  const queue = [...new Map([...firsts, ...refresh, ...retag, ...weekly].map((c) => [c.id, c])).values()];
  let failure: unknown = null;
  let next = 0;
  const worker = async () => {
    while (!failure && next < queue.length && timeLeft(ctx)) {
      const c = queue[next++];
      try {
        checkDailyBudget(ctx);
        let data: Record<string, unknown>;
        try {
          const fields = toContactFields(await ctx.client.getContact(c.hlId));
          const changed = tagsChanged(c.tags, fields.tags);
          if (changed) ctx.stats.tagsChanged++;
          data = { ...fields, deletedInHl: false, ...(changed ? { summaryDirty: true } : {}) };
        } catch (e) {
          if (e instanceof HighLevelError && e.kind === "notFound") data = { deletedInHl: true }; // deleted in HighLevel: keep the row and its history
          else if (e instanceof HighLevelError && e.kind === "badRequest") {
            // HighLevel refuses this one contact: skip it (until the daily refresh) rather than stall the whole sync.
            console.warn(`[highlevel] contact ${c.hlId} lookup refused (HTTP ${e.status}): ${e.detail ?? ""}`);
            data = {};
          } else throw e;
        }
        await prisma.highLevelContact.update({ where: { id: c.id }, data: { ...data, fetchedAt: new Date() } });
        ctx.stats.contactsFetched++;
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: CONTACT_CONCURRENCY }, worker));
  if (failure) throw failure;
}

// --- Writing CRM tags ------------------------------------------------------------------------

const CRM_TAGS_PER_RUN = 2_000;
const CRM_TAG_CONCURRENCY = 2;

/**
 * Step 7b: put each pending contact's CRM tags right in HighLevel — add the
 * missing ones, remove the ones that no longer apply, nothing else (see
 * domain/smsTags.ts). Desired tags come from the contact's CURRENT summary
 * and minerals opportunities, so a contact whose summary is still being
 * recomputed waits a run. A refused write (the key lacks contacts.write)
 * stops this step for the run and is shown on the card — the rest of the
 * sync carries on.
 */
async function writeCrmTags(ctx: Ctx): Promise<void> {
  const cur = await prisma.integration.findUnique({ where: { id: ctx.rowId }, select: { config: true } });
  const enabled = crmTagsEnabledOf(cur?.config);
  const crm = readSyncState(cur?.config).crmTags ?? {};
  if (!enabled && !crm.removing) return;
  const { scope } = effectiveScope(cur?.config);
  const batch = await prisma.highLevelContact.findMany({
    where: { organizationId: ctx.org, crmTagsPending: true, deletedInHl: false, summaryDirty: false },
    select: { id: true, hlId: true, tags: true, touches: true, outcome: true, smsOptedOut: true, updatedAt: true },
    orderBy: { updatedAt: "asc" },
    take: CRM_TAGS_PER_RUN,
  });
  if (!batch.length) return;
  const opps = crm.removing ? [] : await prisma.highLevelOpportunity.findMany({
    where: { organizationId: ctx.org, hlContactId: { in: batch.map((b) => b.hlId) }, deletedInHl: false, pipelineId: { in: scope.mineralPipelineIds } },
    select: { hlContactId: true, step: true },
  });
  const steps = new Map<string, { step: string }[]>();
  for (const o of opps) if (o.hlContactId) steps.set(o.hlContactId, [...(steps.get(o.hlContactId) ?? []), { step: o.step }]);

  let refused = false;
  let failure: unknown = null;
  let next = 0;
  const worker = async () => {
    while (!refused && !failure && next < batch.length && timeLeft(ctx)) {
      const c = batch[next++];
      const want = crm.removing ? [] : desiredCrmTags({ touches: c.touches, outcome: c.outcome, smsOptedOut: c.smsOptedOut, opportunities: steps.get(c.hlId) ?? [] });
      const { add, remove } = tagDiff(c.tags, want);
      try {
        if (add.length || remove.length) {
          checkDailyBudget(ctx);
          if (add.length) await ctx.client.addContactTags(c.hlId, add);
          if (remove.length) await ctx.client.removeContactTags(c.hlId, remove);
          ctx.stats.crmTagged++;
        }
        const removed = new Set(remove.map((t) => t.toLowerCase()));
        const tags = [...c.tags.filter((t) => !removed.has(t.toLowerCase())), ...add];
        // Only clear the flag if nothing re-marked the contact meanwhile.
        await prisma.highLevelContact.updateMany({ where: { id: c.id, updatedAt: c.updatedAt }, data: { tags, crmTagsPending: false } });
      } catch (e) {
        if (e instanceof HighLevelError && e.kind === "auth") { refused = true; return; } // reads work, so this is the missing write permission
        if (e instanceof HighLevelError && e.kind === "notFound") {
          await prisma.highLevelContact.update({ where: { id: c.id }, data: { deletedInHl: true, crmTagsPending: false } });
          continue;
        }
        if (e instanceof HighLevelError && e.kind === "badRequest") {
          console.warn(`[highlevel] tag write refused for contact ${c.hlId} (HTTP ${e.status}): ${e.detail ?? ""}`);
          await prisma.highLevelContact.update({ where: { id: c.id }, data: { crmTagsPending: false } });
          continue;
        }
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: CRM_TAG_CONCURRENCY }, worker));
  const patch: CrmTagState = {
    ...crm,
    written: (crm.written ?? 0) + ctx.stats.crmTagged,
    ...(ctx.stats.crmTagged ? { lastWriteAt: new Date().toISOString() } : {}),
    ...(refused ? { error: "permission" as const, errorAt: new Date().toISOString() } : ctx.stats.crmTagged ? { error: null } : {}),
  };
  ctx.state.crmTags = patch;
  await saveState(ctx.rowId, { crmTags: patch });
  if (failure) throw failure;
}

// --- Carrier health --------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * A UTC instant for a "timestamp without time zone" column. A bare Date
 * parameter is sent as timestamptz, which Postgres compares in the SESSION's
 * time zone — not necessarily UTC (as in Reports' smsReports.ts).
 */
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

/** Texts sent / failed, contacts reached and contacts who opted out in [from, to) — all texting, every line. */
export async function healthInput(org: string, from: Date, to: Date): Promise<HealthInput> {
  const st = Prisma.sql`lower(btrim(coalesce(m."status", '')))`;
  const pending = Prisma.sql`${st} IN (${Prisma.join([...PENDING_STATUSES])})`;
  const failed = Prisma.sql`${st} IN (${Prisma.join([...FAILED_STATUSES])})`;
  const rows = await prisma.$queryRaw<{ sent: number; failed: number; reached: number; optOuts: number }[]>`
    SELECT
      count(*) FILTER (WHERE m."direction" = 'outbound' AND NOT (${pending}))::int AS "sent",
      count(*) FILTER (WHERE m."direction" = 'outbound' AND ${failed})::int AS "failed",
      count(DISTINCT m."hlContactId") FILTER (WHERE m."direction" = 'outbound' AND NOT (${pending}) AND NOT (${failed}))::int AS "reached",
      count(DISTINCT m."hlContactId") FILTER (WHERE m."direction" = 'inbound' AND m."optOut")::int AS "optOuts"
    FROM "HighLevelMessage" m
    WHERE m."organizationId" = ${org} AND m."sentAt" >= ${ts(from)} AND m."sentAt" < ${ts(to)}`;
  const r = rows[0] ?? { sent: 0, failed: 0, reached: 0, optOuts: 0 };
  return { sent: r.sent, failed: r.failed, reachedContacts: r.reached, optOuts: r.optOuts };
}

/**
 * Step 8 (live runs): carrier health over the last 24 hours and 7 days. A
 * NEW warning raises one admin notification ("sms_health", mutable in
 * notification settings) — at most one a day; a warning is announced once
 * while it lasts (healthAlert).
 */
async function checkCarrierHealth(ctx: Ctx): Promise<void> {
  const now = new Date();
  const [day, week] = await Promise.all([
    healthInput(ctx.org, new Date(now.getTime() - DAY_MS), now),
    healthInput(ctx.org, new Date(now.getTime() - 7 * DAY_MS), now),
  ]);
  const results: Record<HealthWindow, ReturnType<typeof carrierHealth>> = { day: carrierHealth(day), week: carrierHealth(week) };
  const active = [...healthKeys("day", results.day), ...healthKeys("week", results.week)];
  const notified = ctx.state.healthNotified ?? [];
  if (!active.length && !notified.length) return;
  const anyFresh = active.some((k) => !notified.includes(k));
  const recent = anyFresh ? await prisma.notification.findFirst({
    where: { organizationId: ctx.org, type: "sms_health", createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
    select: { id: true },
  }) : null;
  const { notify, remember } = healthAlert(notified, active, !!recent);
  if (notify) {
    const { title, body } = healthNotice(notify, results);
    await prisma.notification.create({
      data: { organizationId: ctx.org, userId: null, type: "sms_health", title, body, link: "/reports?view=sms" },
    });
    await logActivity({ eventType: "integration.sms_health", summary: `HighLevel texting health warning: ${body}`, organizationId: ctx.org });
  }
  if (remember.length !== notified.length || remember.some((k) => !notified.includes(k))) {
    ctx.state.healthNotified = remember.length ? remember : undefined;
    await saveState(ctx.rowId, { healthNotified: ctx.state.healthNotified });
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;

function successMessage(phase: HlPhase, finished: boolean, s: Stats, imported: number, contacts: number, previewTexts: number | undefined): string {
  if (finished) return `Import finished: ${plural(imported, "text", "texts")} from ${plural(contacts, "contact", "contacts")}.`;
  if (phase === "importing") {
    const of = previewTexts && previewTexts > imported ? ` of about ${fmt(previewTexts)}` : "";
    return `Importing… ${fmt(imported)}${of} texts so far; ${plural(s.contactsFetched, "contact", "contacts")} looked up this round.`;
  }
  const parts = [
    s.newMessages ? plural(s.newMessages, "new text", "new texts") : "no new texts",
    s.updatedMessages ? plural(s.updatedMessages, "delivery update", "delivery updates") : null,
    s.stageMoves ? plural(s.stageMoves, "pipeline stage change", "pipeline stage changes") : null,
    s.contactsFetched ? plural(s.contactsFetched, "contact refreshed", "contacts refreshed") : null,
    s.rescanned ? plural(s.rescanned, "older text re-checked for wrong numbers and cost", "older texts re-checked for wrong numbers and cost") : null,
  ].filter(Boolean);
  return `Up to date — ${parts.join(", ")}.`;
}

/**
 * One bounded sync run for an org's HighLevel connection. Never throws:
 * failures are recorded on the row and returned as { ok: false }.
 */
export async function runHighLevelSync(row: Integration, opts: { budgetMs: number; reason: RunReason }): Promise<HighLevelRunResult> {
  const org = row.organizationId;
  if (running.has(org)) {
    return { ok: true, skipped: true, message: "A HighLevel sync is already running — check back in a minute.", phase: readSyncState(row.config).phase };
  }
  running.add(org);
  const startedAt = Date.now();
  const stats: Stats = { newMessages: 0, updatedMessages: 0, contactsFetched: 0, summaries: 0, opportunities: 0, stageMoves: 0, rescanned: 0, tagsChanged: 0, crmTagged: 0 };
  let fresh: Integration | null = null;
  let state: HlSyncState = readSyncState(row.config);
  try {
    // The caller's row may be stale (scheduler tick, background loop).
    fresh = await prisma.integration.findUnique({ where: { id: row.id } });
    if (!fresh || fresh.status === "NOT_CONNECTED") return { ok: false, skipped: true, message: "HighLevel isn't connected.", phase: null };
    const cfg = (fresh.config ?? {}) as Record<string, unknown>;
    state = readSyncState(cfg);
    const locationId = typeof cfg.locationId === "string" ? cfg.locationId : "";
    if (typeof cfg._secret !== "string" || !locationId) throw new HighLevelError("auth", { detail: "no stored key or location" });
    let token: string;
    try { token = decryptSecret(cfg._secret); } catch { throw new KeyUnreadable(); }
    const ctx: Ctx = {
      rowId: fresh.id, org, locationId, client: new HighLevelClient({ token }), state: { ...state }, stats,
      deadline: startedAt + opts.budgetMs,
      pipelines: new Map(readPipelines(cfg).map((p) => [p.id, p])), metaRefreshed: false,
    };

    if (state.phase === "preview") {
      // Before the import starts, a sync only refreshes the preview count.
      const page = await ctx.client.exportMessages({ locationId, channel: "SMS", limit: 10 });
      const message = `Found ${plural(page.total, "text", "texts")} in HighLevel. Nothing has been imported yet.`;
      await saveState(fresh.id, {
        preview: { texts: page.total, at: new Date().toISOString() }, consecutiveFailures: 0, pausedUntil: undefined,
        lastRun: { at: new Date().toISOString(), ok: true, ...stats, ms: Date.now() - startedAt, message },
      });
      await prisma.integration.updateMany({ where: { id: fresh.id, status: { not: "NOT_CONNECTED" } }, data: { status: "CONNECTED", lastError: null } });
      return { ok: true, message, phase: "preview" };
    }

    // 1. Team members (sender names in Reports), pipelines, tags and time zone.
    if (isDue(state.usersRefreshAt, USERS_REFRESH_MS, startedAt)) {
      const users = toUserRefs(await ctx.client.listUsers(locationId));
      await saveState(fresh.id, { usersRefreshAt: new Date().toISOString() }, { hlUsers: users });
    }
    if (isDue(state.metaRefreshAt, META_REFRESH_MS, startedAt)) await refreshMeta(ctx);
    // 2. New messages from the checkpoint.
    const caughtUp = await importMessages(ctx);
    // While a tag re-read runs back to back, the per-run extras keep their
    // usual 15-minute rhythm instead of repeating every minute.
    const retagging = tagRefreshRunning(state);
    // 3. Delivery-status refresh — at most once per live run.
    let statusRefreshAt = state.statusRefreshAt;
    if (caughtUp && state.phase === "live" && (!retagging || isDue(state.statusRefreshAt, IMPORT_OPPS_EVERY_MS, startedAt))
      && timeLeft(ctx) && await refreshRecentStatuses(ctx)) {
      statusRefreshAt = new Date().toISOString();
    }
    // 4. Opportunities — every live run; while importing (runs back to back) every 15 minutes.
    const oppsDue = (state.phase === "live" && !retagging) || isDue(ctx.state.oppsRefreshAt, IMPORT_OPPS_EVERY_MS, startedAt);
    if (oppsDue && timeLeft(ctx)) await syncOpportunities(ctx);
    // Summaries computed under older rules (before wrong numbers, speed to
    // lead and the minerals line existed) are recomputed once.
    if (state.summaryVersion !== SUMMARY_VERSION) {
      await prisma.highLevelContact.updateMany({ where: { organizationId: org, summaryDirty: false }, data: { summaryDirty: true } });
      ctx.state.summaryVersion = SUMMARY_VERSION;
      await saveState(fresh.id, { summaryVersion: SUMMARY_VERSION });
    }
    // 5. The one-time rescan of older texts (live only; the import already records both).
    if (state.phase === "live" && caughtUp && timeLeft(ctx)) await rescanHistory(ctx);
    // 6. Summaries, then 7. contact details (the slow part — summaries first
    // so a budget stop never leaves Reports with stale counts).
    await recomputeSummaries(ctx);
    if (timeLeft(ctx)) await fetchContacts(ctx);
    // 7b. Mineral Hub's own tags (only when the owner turned them on, or is removing them).
    if (state.phase === "live" && timeLeft(ctx)) await writeCrmTags(ctx);
    // 8. Carrier health (all texting) — a few aggregate queries, no HighLevel requests.
    if (state.phase === "live") await checkCarrierHealth(ctx);

    // Phase: importing → live once messages, contacts and summaries are complete.
    const windowDays = responseWindowOf((await prisma.integration.findUnique({ where: { id: fresh.id }, select: { config: true } }))?.config);
    const [pendingContacts, dirtySummaries, imported, contacts] = await Promise.all([
      prisma.highLevelContact.count({ where: { organizationId: org, fetchedAt: null, deletedInHl: false } }),
      prisma.highLevelContact.count({ where: staleSummaryWhere(org, windowDays) }),
      prisma.highLevelMessage.count({ where: { organizationId: org } }),
      prisma.highLevelContact.count({ where: { organizationId: org } }),
    ]);
    const phase = phaseAfterRun(state.phase, { messagesCaughtUp: caughtUp, pendingContacts, dirtySummaries });
    const finished = state.phase === "importing" && phase === "live";
    // "Re-read tags now": done once nobody is left to look up and their
    // summaries (and minerals line) are recomputed.
    let tagRefresh: TagRefreshState | undefined;
    let retagMessage = "";
    const t = ctx.state.tagRefresh;
    if (t && tagRefreshRunning(ctx.state)) {
      const left = await prisma.highLevelContact.count({ where: tagRefreshPendingWhere(org, t) });
      const changed = (t.changed ?? 0) + stats.tagsChanged;
      const done = left === 0 && dirtySummaries === 0;
      tagRefresh = { ...t, changed, ...(done ? { finishedAt: new Date().toISOString() } : {}) };
      retagMessage = done
        ? ` Tags re-read for ${plural(t.total, "contact", "contacts")} — ${plural(changed, "contact's tags", "contacts' tags")} changed.`
        : ` Re-reading tags: ${(t.total - left).toLocaleString("en-US")} of ${plural(t.total, "contact", "contacts")} done.`;
      if (done) {
        await logActivity({ eventType: "integration.tags_refreshed", summary: `HighLevel tags re-read for ${plural(t.total, "contact", "contacts")} (${changed.toLocaleString("en-US")} changed)`, organizationId: org });
      }
    }
    // CRM tags: runs stay back to back while contacts are waiting to be (re)tagged.
    let crmTags: CrmTagState | undefined;
    let crmMessage = "";
    const crmNow = ctx.state.crmTags ?? {};
    const taggingOn = crmTagsEnabledOf((await prisma.integration.findUnique({ where: { id: fresh.id }, select: { config: true } }))?.config);
    if (state.phase === "live" && (taggingOn || crmNow.removing || crmNow.backlog)) {
      const left = await prisma.highLevelContact.count({ where: { organizationId: org, crmTagsPending: true, deletedInHl: false } });
      // A refused write (missing permission) stops the back-to-back runs; the
      // 15-minute run keeps retrying, and the first success resumes them.
      const stalled = crmNow.error === "permission";
      crmTags = { ...crmNow, backlog: left > 0 && !stalled, ...(left === 0 ? { removing: false } : {}) };
      if (crmNow.removing && left === 0) {
        await logActivity({ eventType: "integration.crm_tags_removed", summary: "Mineral Hub's SMS / Acquisition tags were removed from HighLevel", organizationId: org });
      }
    }
    if (stats.crmTagged) crmMessage = ` ${plural(stats.crmTagged, "contact's tags", "contacts' tags")} updated in HighLevel.`;
    if (ctx.state.crmTags?.error === "permission") crmMessage = " HighLevel refused to add tags — the key needs the contacts.write permission.";
    const message = successMessage(phase, finished, stats, imported, contacts, state.preview?.texts) + retagMessage + crmMessage;
    await saveState(fresh.id, {
      phase, imported, statusRefreshAt, consecutiveFailures: 0, pausedUntil: undefined,
      ...(tagRefresh ? { tagRefresh } : {}),
      ...(crmTags ? { crmTags } : {}),
      lastRun: { at: new Date().toISOString(), ok: true, ...stats, ms: Date.now() - startedAt, message },
    });
    await prisma.integration.updateMany({
      where: { id: fresh.id, status: { not: "NOT_CONNECTED" } },
      data: { status: "CONNECTED", lastError: null, lastSyncAt: new Date() },
    });
    if (finished) {
      await logActivity({ eventType: "integration.import_finished", summary: `HighLevel import finished: ${plural(imported, "text", "texts")} from ${plural(contacts, "contact", "contacts")}`, organizationId: org });
    }
    return { ok: true, message, phase };
  } catch (e) {
    if (e instanceof SyncStopped) return { ok: false, skipped: true, message: "HighLevel was disconnected.", phase: null };
    if (!fresh) {
      console.error(`[highlevel] sync could not start for org ${org}:`, e instanceof Error ? e.message : e);
      return { ok: false, message: "The HighLevel sync could not start. It will try again automatically.", phase: state.phase };
    }
    try {
      return await recordFailure(fresh, stats, startedAt, e);
    } catch (inner) {
      if (inner instanceof SyncStopped) return { ok: false, skipped: true, message: "HighLevel was disconnected.", phase: null };
      console.error(`[highlevel] could not record sync failure for org ${org}:`, inner instanceof Error ? inner.message : inner);
      return { ok: false, message: "The HighLevel sync failed. It will try again automatically.", phase: state.phase };
    }
  } finally {
    running.delete(org);
  }
}

class KeyUnreadable extends Error {}

/** Record a failed run: pause for rate limits, count failures, enter ERROR (with one notification) when warranted. */
async function recordFailure(row: Integration, stats: Stats, startedAt: number, e: unknown): Promise<HighLevelRunResult> {
  const at = new Date().toISOString();
  const ms = Date.now() - startedAt;
  const state = readSyncState((await prisma.integration.findUnique({ where: { id: row.id }, select: { config: true } }))?.config);

  // HighLevel asked us to slow down: not a connection problem — pause and resume later.
  const rateLimited = e instanceof HighLevelError && e.kind === "rateLimit";
  if (e instanceof SyncPaused || rateLimited) {
    const waitMs = e instanceof SyncPaused ? e.waitMs : Math.max(60_000, (e as HighLevelError).retryAfterMs ?? 60_000);
    const message = e instanceof SyncPaused ? e.message : (e as HighLevelError).message;
    await saveState(row.id, {
      pausedUntil: new Date(Date.now() + waitMs).toISOString(),
      lastRun: { at, ok: true, ...stats, ms, message },
    });
    return { ok: true, message, phase: state.phase };
  }

  const auth = e instanceof KeyUnreadable || (e instanceof HighLevelError && e.kind === "auth");
  const message = e instanceof KeyUnreadable ? HL_KEY_UNREADABLE
    : e instanceof HighLevelError ? e.message
    : "The HighLevel sync hit an unexpected problem. It will try again automatically.";
  const kind = e instanceof HighLevelError ? `${e.kind}${e.status ? ` ${e.status}` : ""}${e.detail ? ` (${e.detail})` : ""}` : e instanceof Error ? e.message : String(e);
  console.error(`[highlevel] sync failed for org ${row.organizationId}: ${kind}`);

  const failures = (state.consecutiveFailures ?? 0) + 1;
  await saveState(row.id, { consecutiveFailures: failures, lastRun: { at, ok: false, ...stats, ms, message } });
  if (auth || failures >= FAILURES_BEFORE_ERROR) {
    const current = await prisma.integration.findUnique({ where: { id: row.id }, select: { status: true } });
    const entering = current?.status !== "ERROR";
    await prisma.integration.updateMany({ where: { id: row.id, status: { not: "NOT_CONNECTED" } }, data: { status: "ERROR", lastError: message } });
    if (entering && current?.status) await raiseErrorNotification(row.organizationId, message);
  }
  return { ok: false, message, phase: state.phase };
}

/** One untargeted admin notification per outage (no duplicate while one is unread). */
async function raiseErrorNotification(organizationId: string, message: string): Promise<void> {
  const open = await prisma.notification.findFirst({
    where: { organizationId, type: "integration_error", link: "/settings/integrations", userId: null, readAt: null },
    select: { id: true },
  });
  if (!open) {
    await prisma.notification.create({
      data: {
        organizationId, userId: null, type: "integration_error",
        title: "HighLevel sync stopped",
        body: message,
        link: "/settings/integrations",
      },
    });
  }
  await logActivity({ eventType: "integration.error", summary: `Integration HighLevel sync stopped: ${message}`, organizationId });
}
