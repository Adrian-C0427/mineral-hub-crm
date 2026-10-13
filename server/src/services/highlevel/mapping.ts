/**
 * Pure pieces of the HighLevel sync: API DTO → row mapping, change
 * detection, checkpoint math, scheduling predicates and the phase rule, plus
 * the SMS-KPI pieces — opportunity planning (step, maxRank, stage events),
 * the Minerals filter settings, and the carrier-health notification rule.
 * No I/O here, so every rule is unit tested (mapping.test.ts); sync.ts wires
 * them to the database and the API client.
 */
import {
  isOptOutReply, isWrongNumberReply, smsSegments, RESPONSE_WINDOW_OPTIONS, DEFAULT_RESPONSE_WINDOW_DAYS,
  HEALTH_OPT_OUT_WARN, HEALTH_FAILURE_WARN, type HealthResult,
} from "../../domain/smsMetrics.js";
import { normalizeTag, suggestScope, type SmsScope } from "../../domain/smsScope.js";
import { stageStep, stepRank, type FunnelStep } from "../../domain/smsFunnel.js";
import { normalizePhoneNullable } from "../../domain/phone.js";
import type { HlContact, HlMessage, HlUser, HlOpportunity, HlPipeline, HlTag, HighLevelError } from "./client.js";

export type HlPhase = "preview" | "importing" | "live";

export interface HlLastRun {
  at: string; ok: boolean; newMessages: number; updatedMessages: number; contactsFetched: number;
  summaries: number; ms: number; message: string;
  /** Opportunities read, and stage moves observed, this run. */
  opportunities?: number; stageMoves?: number;
  /** Texts the one-time rescan corrected this run. */
  rescanned?: number;
}

/** Integration.config.hlSync — the sync's bookkeeping (never serialized to clients). */
export interface HlSyncState {
  phase: HlPhase;
  preview?: { texts: number; at: string };
  importStartedAt?: string;
  /** Latest message createdAt (dateAdded) imported, ISO. The resume point. */
  checkpoint?: string;
  imported?: number;
  statusRefreshAt?: string;
  usersRefreshAt?: string;
  /** Which startDate format the export endpoint accepted. */
  dateParam?: "iso" | "ms";
  consecutiveFailures?: number;
  pausedUntil?: string;
  lastRun?: HlLastRun;
  /**
   * One-time re-read of the whole SMS history for rows imported before
   * segments and wrong-number replies were recorded. checkpoint = latest
   * createdAt re-read (ISO), like the import's.
   */
  rescan?: { done: boolean; checkpoint?: string; updated?: number };
  /** Pipelines, tags and the location's time zone (every 6 h). */
  metaRefreshAt?: string;
  /** Last COMPLETE opportunity pass. */
  oppsRefreshAt?: string;
  /** Where an opportunity pass a run couldn't finish resumes. */
  oppsCursor?: { startAfter: number | null; startAfterId: string };
  /** Read permissions the key lacks; those optional steps are skipped until a meta refresh succeeds. */
  missingScopes?: string[];
  /** SUMMARY_VERSION the stored summaries were computed with (older → recompute everyone once). */
  summaryVersion?: number;
  /** Carrier-health warnings already announced, while they last ("day:optOut", "week:failure", …). */
  healthNotified?: string[];
}

/** Integration.config.hlUsers — names for HighLevel user ids in Reports. */
export interface HlUserRef { id: string; name: string; email: string | null }

/** Integration.config.hlPipelines — stage names give each opportunity its funnel step. */
export interface HlPipelineRef { id: string; name: string; stages: { id: string; name: string; position: number }[] }

// --- Cadence ------------------------------------------------------------------

/** Messages per export page (HighLevel's maximum). */
export const PAGE_LIMIT = 500;
/** Each run re-reads this much before the checkpoint, in case HighLevel saved a message slightly out of order. */
export const OVERLAP_MS = 2 * 60_000;
/** Live runs re-read this window to pick up delivery-status changes (no webhook exists for them). */
export const STATUS_LOOKBACK_MS = 72 * 3_600_000;
export const USERS_REFRESH_MS = 6 * 3_600_000;
/** Contacts texted in the last CONTACT_ACTIVE_DAYS get their details re-read this often. */
export const CONTACT_REFRESH_MS = 24 * 3_600_000;
export const CONTACT_ACTIVE_DAYS = 14;
/** A new run's consecutive failure count at which the integration flips to ERROR. */
export const FAILURES_BEFORE_ERROR = 3;
/** Pipelines, tags and time zone are re-read this often (with users). */
export const META_REFRESH_MS = 6 * 3_600_000;
/** Every contact's details (tags) are re-read at least this often. */
export const CONTACT_WEEKLY_MS = 7 * 86_400_000;
/** Opportunities per search page (HighLevel's maximum). */
export const OPP_PAGE_LIMIT = 100;
/** While importing (runs back to back), the opportunity pass runs at most this often. */
export const IMPORT_OPPS_EVERY_MS = 15 * 60_000;
/**
 * Version of the summary rules (summarizeContact + the business line). Bump it
 * when a rule changes: the next run marks every contact for a recompute.
 * 2 = wrong-number replies, speed to lead, minerals / real-estate line.
 */
export const SUMMARY_VERSION = 2;

// --- Config -------------------------------------------------------------------

const PHASES = new Set<HlPhase>(["preview", "importing", "live"]);

/** The stored hlSync state, tolerant of missing / malformed config. */
export function readSyncState(config: unknown): HlSyncState {
  const raw = (config && typeof config === "object" ? (config as Record<string, unknown>).hlSync : null) as Partial<HlSyncState> | null;
  if (!raw || typeof raw !== "object") return { phase: "preview" };
  return { ...raw, phase: raw.phase && PHASES.has(raw.phase) ? raw.phase : "preview" };
}

/** The org's response window: a valid stored option, else the default (30 days). */
export function responseWindowOf(config: unknown): number {
  const v = config && typeof config === "object" ? (config as Record<string, unknown>).responseWindowDays : undefined;
  return typeof v === "number" && (RESPONSE_WINDOW_OPTIONS as readonly number[]).includes(v) ? v : DEFAULT_RESPONSE_WINDOW_DAYS;
}

/**
 * A HighLevel Location ID from what the owner pasted: the bare id, or any
 * HighLevel address containing "/location/<id>" (white-label domains too).
 */
export function parseLocationId(input: string | null | undefined): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  const fromUrl = /\/location\/([A-Za-z0-9]+)/.exec(s);
  const id = fromUrl ? fromUrl[1] : s;
  return /^[A-Za-z0-9]{10,40}$/.test(id) ? id : null;
}

// --- Messages -----------------------------------------------------------------

/**
 * What the mirror stores for one SMS. No wording: `body` is read once for the
 * opt-out / wrong-number flags and the segment count, then dropped.
 */
export interface MessageRow {
  hlId: string;
  hlContactId: string;
  conversationId: string | null;
  direction: string;
  messageType: string | null;
  status: string | null;
  source: string | null;
  hlUserId: string | null;
  optOut: boolean;
  /** Inbound reply saying we texted the wrong person (never also an opt-out). */
  wrongNumber: boolean;
  /** Billable SMS segments of the body. */
  segments: number;
  sentAt: Date;
}

/** A stored mirror row as read back (segments is null on rows imported before it existed). */
export type StoredMessage = Omit<MessageRow, "hlId" | "segments" | "wrongNumber"> & {
  hlId?: string; segments: number | null; wrongNumber: boolean;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One export DTO → a mirror row, or null when it lacks what the metrics need. */
export function toMessageRow(m: HlMessage): MessageRow | null {
  const hlId = str(m.id);
  const hlContactId = str(m.contactId);
  const direction = str(m.direction)?.toLowerCase() ?? null;
  const sentAt = m.dateAdded ? new Date(m.dateAdded) : null;
  if (!hlId || !hlContactId || !sentAt || Number.isNaN(sentAt.getTime())) return null;
  if (direction !== "inbound" && direction !== "outbound") return null;
  return {
    hlId,
    hlContactId,
    conversationId: str(m.conversationId),
    direction,
    messageType: str(m.messageType),
    status: str(m.status)?.toLowerCase() ?? null,
    source: str(m.source),
    hlUserId: str(m.userId),
    ...bodyFlags(direction, m.body),
    sentAt,
  };
}

/** The flags a body yields (shared by the import and the one-time rescan). */
export function bodyFlags(direction: string, body: string | null | undefined): Pick<MessageRow, "optOut" | "wrongNumber" | "segments"> {
  const optOut = direction === "inbound" && isOptOutReply(body);
  return { optOut, wrongNumber: direction === "inbound" && !optOut && isWrongNumberReply(body), segments: smsSegments(body) };
}

/**
 * The one-time rescan's write for a stored row: only segments and the
 * wrong-number flag, and only when they differ. null = nothing to write.
 */
export function rescanPatch(prev: Pick<StoredMessage, "segments" | "wrongNumber">, next: Pick<MessageRow, "segments" | "wrongNumber">):
  { segments: number; wrongNumber: boolean } | null {
  return prev.segments === next.segments && prev.wrongNumber === next.wrongNumber
    ? null : { segments: next.segments, wrongNumber: next.wrongNumber };
}

/** True when a stored row differs from the API's current version (only then is it written). */
export function messageChanged(prev: StoredMessage, next: MessageRow): boolean {
  return prev.status !== next.status
    || prev.wrongNumber !== next.wrongNumber
    || prev.segments !== next.segments
    || prev.hlUserId !== next.hlUserId
    || prev.source !== next.source
    || prev.messageType !== next.messageType
    || prev.conversationId !== next.conversationId
    || prev.direction !== next.direction
    || prev.hlContactId !== next.hlContactId
    || prev.optOut !== next.optOut
    || prev.sentAt.getTime() !== next.sentAt.getTime();
}

// --- Checkpoint ---------------------------------------------------------------

/** Where a run's fresh export query starts: the checkpoint minus the overlap (null = from the beginning). */
export function importStartDate(checkpoint: string | null | undefined): Date | null {
  if (!checkpoint) return null;
  const t = Date.parse(checkpoint);
  return Number.isFinite(t) ? new Date(t - OVERLAP_MS) : null;
}

/** The checkpoint after a page: the latest createdAt seen (never moves backwards). */
export function advanceCheckpoint(prev: string | null | undefined, rows: readonly { sentAt: Date }[]): string | undefined {
  let best = prev ? Date.parse(prev) : NaN;
  for (const r of rows) {
    const t = r.sentAt.getTime();
    if (!Number.isFinite(best) || t > best) best = t;
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : undefined;
}

/** startDate as the export endpoint accepts it (format undocumented: ISO first, epoch ms fallback). */
export const formatStartDate = (d: Date, mode: "iso" | "ms"): string => (mode === "ms" ? String(d.getTime()) : d.toISOString());

/**
 * With sortBy=createdAt asc, a working startDate filter never returns a
 * message older than the start. One that does means the format was ignored.
 */
export function startDateIgnored(start: Date, rows: readonly { sentAt: Date }[]): boolean {
  return rows.length > 0 && rows[0].sentAt.getTime() < start.getTime() - 60_000;
}

// --- Contacts -----------------------------------------------------------------

export interface ContactFields {
  name: string | null;
  phone: string | null;
  phoneDigits: string | null;
  email: string | null;
  source: string | null;
  tags: string[];
  assignedToHlUserId: string | null;
  smsOptedOut: boolean;
  hlDateAdded: Date | null;
  hlDateUpdated: Date | null;
}

const date = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** HighLevel DND: all channels (dnd) or SMS specifically (active / permanent). */
export function smsOptedOut(c: Pick<HlContact, "dnd" | "dndSettings">): boolean {
  if (c.dnd === true) return true;
  const s = (c.dndSettings?.SMS?.status ?? "").toLowerCase();
  return s === "active" || s === "permanent";
}

export function toContactFields(c: HlContact): ContactFields {
  const joined = [str(c.firstName), str(c.lastName)].filter(Boolean).join(" ");
  const tags = Array.isArray(c.tags) ? [...new Set(c.tags.map((t) => str(t)).filter((t): t is string => !!t))] : [];
  return {
    name: str(c.name) ?? str(c.contactName) ?? (joined || null),
    phone: str(c.phone),
    phoneDigits: normalizePhoneNullable(c.phone),
    email: str(c.email)?.toLowerCase() ?? null,
    source: str(c.source),
    tags,
    assignedToHlUserId: str(c.assignedTo),
    smsOptedOut: smsOptedOut(c),
    hlDateAdded: date(c.dateAdded),
    hlDateUpdated: date(c.dateUpdated),
  };
}

/** True when two tag lists differ (case / spacing ignored, order ignored). */
export function tagsChanged(prev: readonly string[], next: readonly string[]): boolean {
  const a = new Set(prev.map(normalizeTag));
  const b = new Set(next.map(normalizeTag));
  if (a.size !== b.size) return true;
  for (const t of a) if (!b.has(t)) return true;
  return false;
}

/**
 * How many contacts a run re-reads for the weekly refresh: enough that every
 * contact comes round within a week of 15-minute runs (600 runs ≈ 6.25 days),
 * at least 10 and at most 200 — spread evenly, never a burst.
 */
export function weeklyRefreshLimit(totalContacts: number): number {
  return Math.min(200, Math.max(10, Math.ceil(Math.max(0, totalContacts) / 600)));
}

export function toUserRefs(users: readonly HlUser[]): HlUserRef[] {
  return users
    .filter((u) => str(u.id) && !u.deleted)
    .map((u) => ({
      id: u.id.trim(),
      name: str(u.name) ?? ([str(u.firstName), str(u.lastName)].filter(Boolean).join(" ") || str(u.email) || "HighLevel user"),
      email: str(u.email)?.toLowerCase() ?? null,
    }));
}

// --- Scheduling & phase -------------------------------------------------------

/** Never done, unparseable, or older than intervalMs. */
export function isDue(lastIso: string | null | undefined, intervalMs: number, now: number): boolean {
  const t = lastIso ? Date.parse(lastIso) : NaN;
  return !Number.isFinite(t) || now - t >= intervalMs;
}

/** True while a pause HighLevel asked for (rate limit / daily budget) is still running. */
export function isPaused(state: HlSyncState, now: number): boolean {
  const t = state.pausedUntil ? Date.parse(state.pausedUntil) : NaN;
  return Number.isFinite(t) && t > now;
}

/**
 * The import is done ("live") once every message up to now is in, every
 * contact has its details, and every summary is current — so Reports never
 * show a half-imported account as if it were complete.
 */
export function phaseAfterRun(phase: HlPhase, p: { messagesCaughtUp: boolean; pendingContacts: number; dirtySummaries: number }): HlPhase {
  if (phase !== "importing") return phase;
  return p.messagesCaughtUp && p.pendingContacts === 0 && p.dirtySummaries === 0 ? "live" : "importing";
}

/** Rough database footprint of the mirror for `texts` messages (rows + indexes + their contacts). */
export function storageEstimateMb(texts: number): number {
  if (!texts || texts < 0) return 0;
  return Math.max(0.1, Math.round((texts * 650) / 100_000) / 10);
}

// --- Messages for people ------------------------------------------------------

/** The connect form's error for a failed step, in words the owner can act on. */
export function connectErrorMessage(step: "location" | "users" | "messages", e: HighLevelError, locationId: string): string {
  const detail = e.detail ?? "";
  if (e.kind === "auth") {
    if (/scope/i.test(detail) || step !== "location") {
      const scopes = step === "users" ? "users.readonly"
        : step === "messages" ? "conversations.readonly and conversations/message.readonly"
        : "locations.readonly";
      return `The key was accepted, but it isn't allowed to read ${step === "users" ? "your team members" : step === "messages" ? "your texts" : "this location"}. In HighLevel, edit the Private Integration and tick ${scopes}, then try again.`;
    }
    if (e.status === 403 || /location/i.test(detail)) {
      return `This key can't open location ${locationId}. Make sure the Location ID comes from the same HighLevel sub-account the key was created in.`;
    }
    return "HighLevel rejected this key. Copy it again from Settings → Private Integrations — it starts with “pit-”.";
  }
  if (step === "location" && (e.kind === "notFound" || e.kind === "badRequest")) {
    return `HighLevel couldn't find a location with ID ${locationId}. Copy it from Settings → Business Profile, or from the address bar after /location/.`;
  }
  return e.message;
}

// --- Pipelines, tags, time zone -------------------------------------------------

export function toPipelineRefs(pipelines: readonly HlPipeline[]): HlPipelineRef[] {
  return pipelines
    .filter((p) => str(p.id))
    .map((p) => ({
      id: p.id.trim(),
      name: str(p.name) ?? "Untitled pipeline",
      stages: (Array.isArray(p.stages) ? p.stages : [])
        .filter((st) => str(st?.id))
        .map((st, i) => ({ id: st.id!.trim(), name: str(st.name) ?? "Untitled stage", position: typeof st.position === "number" ? st.position : i }))
        .sort((a, b) => a.position - b.position),
    }));
}

/** Tag names as HighLevel spells them, one per normalized name, A→Z. */
export function toTagNames(tags: readonly HlTag[]): string[] {
  const byKey = new Map<string, string>();
  for (const t of tags) {
    const name = str(t?.name);
    if (name && !byKey.has(normalizeTag(name))) byKey.set(normalizeTag(name), name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** An IANA time zone the runtime understands (HighLevel also uses aliases like "US/Central"), else null. */
export function validTimezone(tz: string | null | undefined): string | null {
  const z = str(tz);
  if (!z) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return z; } catch { return null; }
}

const cfgOf = (config: unknown): Record<string, unknown> =>
  (config && typeof config === "object" ? config as Record<string, unknown> : {});

export function readPipelines(config: unknown): HlPipelineRef[] {
  const v = cfgOf(config).hlPipelines;
  return Array.isArray(v) ? (v as HlPipelineRef[]).filter((p) => p && typeof p.id === "string") : [];
}

export function readTags(config: unknown): string[] {
  const v = cfgOf(config).hlTags;
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

const strList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? v as string[] : null;

/** The org's saved Minerals filter, or null when none is saved (or it's malformed). */
export function savedScopeOf(config: unknown): SmsScope | null {
  const v = cfgOf(config).scope as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== "object") return null;
  const mineralTags = strList(v.mineralTags), realEstateTags = strList(v.realEstateTags), mineralPipelineIds = strList(v.mineralPipelineIds);
  return mineralTags && realEstateTags && mineralPipelineIds ? { mineralTags, realEstateTags, mineralPipelineIds } : null;
}

/** The scope the sync classifies with: the saved one, else suggestScope() from HighLevel's tags and pipelines. */
export function effectiveScope(config: unknown): { scope: SmsScope; saved: boolean } {
  const saved = savedScopeOf(config);
  return saved ? { scope: saved, saved: true } : { scope: suggestScope(readTags(config), readPipelines(config)), saved: false };
}

/** Same filter (lists compared as sets of normalized values). */
export function sameScope(a: SmsScope, b: SmsScope): boolean {
  const eq = (x: readonly string[], y: readonly string[], f: (s: string) => string) => {
    const sx = new Set(x.map(f)), sy = new Set(y.map(f));
    return sx.size === sy.size && [...sx].every((v) => sy.has(v));
  };
  const id = (s: string) => s;
  return eq(a.mineralTags, b.mineralTags, normalizeTag) && eq(a.realEstateTags, b.realEstateTags, normalizeTag)
    && eq(a.mineralPipelineIds, b.mineralPipelineIds, id);
}

/** Dollars per SMS segment, or null when not set. */
export function pricePerSegmentOf(config: unknown): number | null {
  const v = cfgOf(config).pricePerSegment;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * A Minerals filter from the settings form, cleaned: tags normalized and
 * de-duplicated, pipelines de-duplicated. Refused (with a message for the
 * admin) when a tag is on both lists or a pipeline isn't one of the
 * account's (when the account's pipelines are known).
 */
export function cleanScope(input: SmsScope, pipelines: readonly HlPipelineRef[]):
  { ok: true; scope: SmsScope } | { ok: false; message: string } {
  const tags = (list: readonly string[]) => [...new Set(list.map(normalizeTag).filter(Boolean))];
  const mineralTags = tags(input.mineralTags);
  const realEstateTags = tags(input.realEstateTags);
  const both = mineralTags.find((t) => realEstateTags.includes(t));
  if (both) return { ok: false, message: `The tag “${both}” can't be both minerals and real estate. Pick one.` };
  const mineralPipelineIds = [...new Set(input.mineralPipelineIds.map((p) => p.trim()).filter(Boolean))];
  if (pipelines.length) {
    const known = new Set(pipelines.map((p) => p.id));
    if (mineralPipelineIds.some((id) => !known.has(id))) {
      return { ok: false, message: "One of the pipelines is no longer in HighLevel. Reopen this window and try again." };
    }
  }
  return { ok: true, scope: { mineralTags, realEstateTags, mineralPipelineIds } };
}

/** A HighLevel refusal that means "this key may not read that" (a missing optional permission). */
export const isPermissionRefusal = (e: unknown): e is HighLevelError =>
  !!e && typeof e === "object" && (e as HighLevelError).name === "HighLevelError" && (e as HighLevelError).kind === "auth";

// --- Opportunities --------------------------------------------------------------

/** What the mirror stores for one opportunity, from the search DTO. */
export interface OppFields {
  hlId: string;
  hlContactId: string | null;
  pipelineId: string;
  stageId: string | null;
  status: string | null;
  monetaryValue: number | null;
  assignedToHlUserId: string | null;
  source: string | null;
  name: string | null;
  step: FunnelStep;
  hlCreatedAt: Date | null;
  hlUpdatedAt: Date | null;
  lastStageChangeAt: Date | null;
  /** Not stored — dates a won / lost step. */
  lastStatusChangeAt: Date | null;
  /**
   * Not stored — how far the STAGE says it got, ignoring a lost / abandoned
   * status (lost at "Offer Made" still had an offer). Never past contract
   * for a lost deal.
   */
  stageRank: number;
}

/** A stored opportunity as read back. */
export interface StoredOpp {
  hlContactId: string | null;
  pipelineId: string;
  stageId: string | null;
  status: string | null;
  monetaryValue: number | null;
  assignedToHlUserId: string | null;
  source: string | null;
  name: string | null;
  step: string;
  maxRank: number;
  hlCreatedAt: Date | null;
  hlUpdatedAt: Date | null;
  lastStageChangeAt: Date | null;
  offerAt: Date | null;
  acceptedAt: Date | null;
  contractAt: Date | null;
  closedAt: Date | null;
  deadAt: Date | null;
  deletedInHl: boolean;
}

/** The column holding when the sync first saw an opportunity at a step (negotiating / not_accepted have none). */
export const STEP_TIMESTAMP: Partial<Record<FunnelStep, "offerAt" | "acceptedAt" | "contractAt" | "closedAt" | "deadAt">> = {
  offer: "offerAt", accepted: "acceptedAt", contract: "contractAt", closed: "closedAt", dead: "deadAt",
};

/** Won / lost / abandoned set the step regardless of stage. */
const statusDriven = (status: string | null) => status === "won" || status === "lost" || status === "abandoned";

/** One search DTO → mirror fields (step from the stage and pipeline names), or null without an id / pipeline. */
export function toOpportunityFields(o: HlOpportunity, pipelines: ReadonlyMap<string, HlPipelineRef>): OppFields | null {
  const hlId = str(o.id);
  const pipelineId = str(o.pipelineId);
  if (!hlId || !pipelineId) return null;
  const stageId = str(o.pipelineStageId);
  const status = str(o.status)?.toLowerCase() ?? null;
  const pipeline = pipelines.get(pipelineId);
  const stageName = stageId ? pipeline?.stages.find((st) => st.id === stageId)?.name : null;
  const value = typeof o.monetaryValue === "number" && Number.isFinite(o.monetaryValue) ? o.monetaryValue : null;
  return {
    hlId,
    hlContactId: str(o.contactId) ?? str(o.contact?.id),
    pipelineId,
    stageId,
    status,
    monetaryValue: value,
    assignedToHlUserId: str(o.assignedTo),
    source: str(o.source),
    name: str(o.name),
    step: stageStep(stageName, pipeline?.name, status),
    stageRank: Math.min(stepRank(stageStep(stageName, pipeline?.name, null)), status === "lost" || status === "abandoned" ? stepRank("contract") : Infinity),
    hlCreatedAt: date(o.createdAt),
    hlUpdatedAt: date(o.updatedAt),
    lastStageChangeAt: date(o.lastStageChangeAt),
    lastStatusChangeAt: date(o.lastStatusChangeAt),
  };
}

/** True when the opportunity's pipeline or stage isn't in the stored pipeline list (it changed since the last refresh). */
export const unknownStage = (o: HlOpportunity, pipelines: ReadonlyMap<string, HlPipelineRef>): boolean => {
  const p = pipelines.get(str(o.pipelineId) ?? "");
  const stageId = str(o.pipelineStageId);
  return !p || (!!stageId && !p.stages.some((st) => st.id === stageId));
};

export interface StageEventRow {
  opportunityHlId: string; pipelineId: string; fromStageId: string | null; toStageId: string | null;
  fromStep: string | null; toStep: string; at: Date;
}

export interface OppPlan {
  /** Fields to write (all of them on create); null = nothing changed. */
  data: Record<string, unknown> | null;
  create: boolean;
  /** An observed move to record (never on first sight). */
  event: StageEventRow | null;
  /** Contacts whose minerals / real-estate line may change (their opportunities' pipelines changed). */
  dirtyContacts: string[];
}

const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * What to write for one opportunity seen in a pass.
 *  - First sight: store it; maxRank = its step's rank (at least "opportunity");
 *    the current step's timestamp comes from HighLevel (lastStageChangeAt, or
 *    lastStatusChangeAt for won / lost). No stage event — the move happened
 *    before we were watching.
 *  - Seen again at another stage / pipeline (or a status that changes the
 *    step): one HighLevelStageEvent, dated by HighLevel's change time when it
 *    moved forward, else now; the new step's timestamp is set if still empty
 *    (earlier steps are left as they are).
 *  - maxRank never goes down, so an offer that later died is still an offer;
 *    it also counts the stage a lost / abandoned opportunity was left at.
 */
export function planOpportunity(prev: StoredOpp | null, next: OppFields, now: Date): OppPlan {
  const { lastStatusChangeAt, stageRank, ...fields } = next;
  const rank = Math.max(stepRank(next.step), stageRank);
  const tsField = STEP_TIMESTAMP[next.step];
  if (!prev) {
    const at = statusDriven(next.status) ? (lastStatusChangeAt ?? next.lastStageChangeAt) : next.lastStageChangeAt;
    return {
      create: true,
      data: { ...fields, maxRank: Math.max(stepRank("opportunity"), rank), ...(tsField ? { [tsField]: at } : {}) },
      event: null,
      dirtyContacts: next.hlContactId ? [next.hlContactId] : [],
    };
  }
  const stageMoved = prev.stageId !== next.stageId || prev.pipelineId !== next.pipelineId;
  const statusMoved = prev.status !== next.status && prev.step !== next.step;
  let event: StageEventRow | null = null;
  const data: Record<string, unknown> = {};
  if (stageMoved || statusMoved) {
    // HighLevel's own change time, when it actually moved past what we stored.
    const reported = stageMoved ? next.lastStageChangeAt : lastStatusChangeAt;
    const fresh = !!reported && (!stageMoved || !prev.lastStageChangeAt || reported.getTime() > prev.lastStageChangeAt.getTime());
    const at = fresh ? reported! : now;
    event = {
      opportunityHlId: next.hlId, pipelineId: next.pipelineId, fromStageId: prev.stageId, toStageId: next.stageId,
      fromStep: prev.step, toStep: next.step, at,
    };
    if (tsField && !prev[tsField]) data[tsField] = at;
  }
  const maxRank = Math.max(prev.maxRank, rank);
  if (maxRank !== prev.maxRank) data.maxRank = maxRank;
  for (const k of ["hlContactId", "pipelineId", "stageId", "status", "monetaryValue", "assignedToHlUserId", "source", "name", "step"] as const) {
    if (prev[k] !== fields[k]) data[k] = fields[k];
  }
  for (const k of ["hlCreatedAt", "hlUpdatedAt", "lastStageChangeAt"] as const) {
    if (!sameTime(prev[k], fields[k])) data[k] = fields[k];
  }
  if (prev.deletedInHl) data.deletedInHl = false;
  const lineMayChange = prev.pipelineId !== next.pipelineId || prev.hlContactId !== next.hlContactId || prev.deletedInHl;
  const dirtyContacts = lineMayChange ? [...new Set([prev.hlContactId, next.hlContactId].filter((c): c is string => !!c))] : [];
  return { create: false, data: Object.keys(data).length ? data : null, event, dirtyContacts };
}

// --- Carrier health -------------------------------------------------------------

export type HealthWindow = "day" | "week";
/** One active warning, e.g. "week:failure". */
export type HealthKey = `${HealthWindow}:${"optOut" | "failure"}`;

export const healthKeys = (window: HealthWindow, r: HealthResult): HealthKey[] => r.warnings.map((w) => `${window}:${w}` as HealthKey);

/**
 * Whether to raise a carrier-health notification. A warning is announced
 * once while it lasts; at most one notification a day (a warning that appears
 * inside that day waits and is announced the next day if it's still there).
 * `remember` is what to store as already announced.
 */
export function healthAlert(notified: readonly string[], active: readonly string[], notifiedInLastDay: boolean):
  { notify: string[] | null; remember: string[] } {
  const still = notified.filter((k) => active.includes(k));
  const fresh = active.filter((k) => !still.includes(k));
  if (fresh.length && !notifiedInLastDay) return { notify: [...active], remember: [...active] };
  return { notify: null, remember: still };
}

const pct = (v: number | null) => `${((v ?? 0) * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

/** The notification's wording for the active warnings (plain English for the owner). */
export function healthNotice(keys: readonly string[], results: Record<HealthWindow, HealthResult>): { title: string; body: string } {
  const when = (w: HealthWindow) => (w === "day" ? "in the last 24 hours" : "in the last 7 days");
  const lines: string[] = [];
  for (const w of ["week", "day"] as const) {
    const r = results[w];
    if (keys.includes(`${w}:optOut`)) lines.push(`${pct(r.optOutRate)} of the people texted ${when(w)} opted out (warning level ${pct(HEALTH_OPT_OUT_WARN)}).`);
    if (keys.includes(`${w}:failure`)) lines.push(`${pct(r.failureRate)} of texts sent ${when(w)} failed to deliver (warning level ${pct(HEALTH_FAILURE_WARN)}).`);
  }
  return {
    title: "Texting health warning",
    body: `${lines.join(" ")} Carriers may start filtering your numbers. See Reports → SMS performance.`,
  };
}
