/**
 * Pure pieces of the HighLevel sync: API DTO → row mapping, change
 * detection, checkpoint math, scheduling predicates and the phase rule.
 * No I/O here, so every rule is unit tested (mapping.test.ts); sync.ts wires
 * them to the database and the API client.
 */
import { isOptOutReply, RESPONSE_WINDOW_OPTIONS, DEFAULT_RESPONSE_WINDOW_DAYS } from "../../domain/smsMetrics.js";
import { normalizePhoneNullable } from "../../domain/phone.js";
import type { HlContact, HlMessage, HlUser, HighLevelError } from "./client.js";

export type HlPhase = "preview" | "importing" | "live";

export interface HlLastRun {
  at: string; ok: boolean; newMessages: number; updatedMessages: number; contactsFetched: number;
  summaries: number; ms: number; message: string;
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
}

/** Integration.config.hlUsers — names for HighLevel user ids in Reports. */
export interface HlUserRef { id: string; name: string; email: string | null }

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

/** What the mirror stores for one SMS. No wording: `body` is read once for optOut, then dropped. */
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
  sentAt: Date;
}

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
    optOut: direction === "inbound" && isOptOutReply(m.body),
    sentAt,
  };
}

/** True when a stored row differs from the API's current version (only then is it written). */
export function messageChanged(prev: Omit<MessageRow, "hlId"> & { hlId?: string }, next: MessageRow): boolean {
  return prev.status !== next.status
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
