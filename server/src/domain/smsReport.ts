/**
 * Reports → SMS performance: the pure parts of the report (periods, trend
 * buckets, KPI arithmetic, comparisons, breakdown rows, the stored HighLevel
 * config). The counting rules themselves live in smsMetrics.ts; the SQL that
 * aggregates them lives in routes/smsReports.ts.
 *
 * Dates are UTC calendar days. A period [from, to] covers from 00:00Z up to
 * (not including) to + 1 day 00:00Z.
 */
import { DEFAULT_RESPONSE_WINDOW_DAYS, RESPONSE_WINDOW_OPTIONS, ratio, type TouchOutcomeCount } from "./smsMetrics.js";

export const DAY_MS = 86_400_000;

/** Half-open UTC range: [from, toExclusive). Both at 00:00Z. */
export interface DayRange { from: Date; toExclusive: Date }

/** "YYYY-MM-DD" of a UTC instant. */
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dayFloor = (d: Date) => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);

/** A real calendar day as "YYYY-MM-DD" → its 00:00Z instant; anything else → null. */
export function parseIsoDay(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  if (y < 1900 || y > 2999) return null;
  const t = new Date(Date.UTC(y, mo, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo && t.getUTCDate() === d ? t : null;
}

/** Inclusive days [from, to] → the half-open range; a reversed pair is swapped. */
export function dayRange(from: Date, to: Date): DayRange {
  const [a, b] = from.getTime() <= to.getTime() ? [from, to] : [to, from];
  return { from: dayFloor(a), toExclusive: new Date(dayFloor(b).getTime() + DAY_MS) };
}

/** The inclusive last day of a range, for display. */
export const lastDay = (r: DayRange) => new Date(r.toExclusive.getTime() - DAY_MS);

export const rangeJson = (r: DayRange) => ({ from: isoDay(r.from), to: isoDay(lastDay(r)) });

/**
 * The period a report request asks for. Default: this calendar year (the
 * Deals view's default). ?period=ALL is resolved later against the data
 * (allRange) and never compares.
 */
export function requestedPeriod(q: Record<string, unknown>, now: Date):
  { all: true } | { all: false; range: DayRange; compare: DayRange | null } {
  if (q.period === "ALL") return { all: true };
  const y = now.getUTCFullYear();
  const from = parseIsoDay(q.from) ?? new Date(Date.UTC(y, 0, 1));
  const to = parseIsoDay(q.to) ?? new Date(Date.UTC(y, 11, 31));
  const cf = parseIsoDay(q.compareFrom), ct = parseIsoDay(q.compareTo);
  return { all: false, range: dayRange(from, to), compare: cf && ct ? dayRange(cf, ct) : null };
}

/** "All": the first through the last day any text was sent (today when there are none). */
export function allRange(minSentAt: Date | null, maxSentAt: Date | null, now: Date): DayRange {
  return dayRange(minSentAt ?? now, maxSentAt ?? minSentAt ?? now);
}

// ---------------------------------------------------------------------------
// Trend buckets
// ---------------------------------------------------------------------------

export type TrendBucket = "day" | "week" | "month";

/** Days per bar: up to ~2 months by day, up to ~13 months by week, longer by month. */
export function trendBucket(r: DayRange): TrendBucket {
  const days = Math.round((r.toExclusive.getTime() - r.from.getTime()) / DAY_MS);
  return days <= 62 ? "day" : days <= 400 ? "week" : "month";
}

/** Start of the bucket holding `d` (weeks start Monday, like Postgres date_trunc('week')). */
export function bucketStart(d: Date, b: TrendBucket): Date {
  const day = dayFloor(d);
  if (b === "day") return day;
  if (b === "week") return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
}

/** A bucket's key: "YYYY-MM-DD" (its first day) for day/week buckets, "YYYY-MM" for months. */
export const periodKey = (d: Date, b: TrendBucket) => (b === "month" ? isoDay(d).slice(0, 7) : isoDay(d));

/** Every bucket key the range touches, in order (capped so a bad range can't run away). */
export function bucketKeys(r: DayRange, b: TrendBucket): string[] {
  const out: string[] = [];
  let cur = bucketStart(r.from, b);
  for (let i = 0; i < 2000 && cur.getTime() < r.toExclusive.getTime(); i++) {
    out.push(periodKey(cur, b));
    cur = b === "day" ? new Date(cur.getTime() + DAY_MS)
      : b === "week" ? new Date(cur.getTime() + 7 * DAY_MS)
      : new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return out;
}

export interface TrendPoint { period: string; sent: number; delivered: number; failed: number; inbound: number }

/** One point per bucket of the range; buckets with no texts are zeros. */
export function fillTrend(r: DayRange, b: TrendBucket, rows: readonly TrendPoint[]): TrendPoint[] {
  const byKey = new Map(rows.map((p) => [p.period, p]));
  return bucketKeys(r, b).map((period) => {
    const p = byKey.get(period);
    return { period, sent: p?.sent ?? 0, delivered: p?.delivered ?? 0, failed: p?.failed ?? 0, inbound: p?.inbound ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// KPIs and comparisons
// ---------------------------------------------------------------------------

export interface SmsKpis {
  /** Outbound texts that went out (not pending/scheduled), dated by sentAt. */
  textsSent: number;
  textsDelivered: number;
  textsFailed: number;
  /** Inbound texts, dated by sentAt. */
  repliesReceived: number;
  /** Distinct contacts sent at least one text in the period. */
  contactsTexted: number;
  /** Response cohort: contacts whose first reached text is in the period. */
  contactsReached: number;
  contactsResponded: number;
  responseRate: number | null;
  optedOut: number;
  optOutRate: number | null;
  avgTextsPerContact: number | null;
  avgResponseSeconds: number | null;
  medianResponseSeconds: number | null;
}

export interface VolumeTotals { sent: number; delivered: number; failed: number; inbound: number; contactsTexted: number }
export interface CohortTotals { reached: number; responded: number; optedOut: number; avgSeconds: number | null; medianSeconds: number | null }

/** Sum the cohort's (touches, outcome) rows. */
export function cohortCounts(rows: readonly TouchOutcomeCount[]) {
  let reached = 0, responded = 0, optedOut = 0, lateReplies = 0;
  for (const r of rows) {
    if (r.touches < 1) continue;
    reached += r.count;
    if (r.outcome === "RESPONDED") responded += r.count;
    else if (r.outcome === "OPTED_OUT") optedOut += r.count;
    else if (r.outcome === "LATE_REPLY") lateReplies += r.count;
  }
  return { reached, responded, optedOut, lateReplies };
}

export function computeKpis(v: VolumeTotals, c: CohortTotals): SmsKpis {
  return {
    textsSent: v.sent,
    textsDelivered: v.delivered,
    textsFailed: v.failed,
    repliesReceived: v.inbound,
    contactsTexted: v.contactsTexted,
    contactsReached: c.reached,
    contactsResponded: c.responded,
    responseRate: ratio(c.responded, c.reached),
    optedOut: c.optedOut,
    optOutRate: ratio(c.optedOut, c.reached),
    avgTextsPerContact: ratio(v.sent, v.contactsTexted),
    // A median/average of nobody is N/A, not 0 seconds.
    avgResponseSeconds: c.responded > 0 ? c.avgSeconds : null,
    medianResponseSeconds: c.responded > 0 ? c.medianSeconds : null,
  };
}

export type DeltaKind = "relative" | "points";

/** Rates compare as a point difference; everything else as a relative change. */
export const DELTA_KIND: Record<keyof SmsKpis, DeltaKind> = {
  textsSent: "relative", textsDelivered: "relative", textsFailed: "relative", repliesReceived: "relative",
  contactsTexted: "relative", contactsReached: "relative", contactsResponded: "relative",
  responseRate: "points", optedOut: "relative", optOutRate: "points", avgTextsPerContact: "relative",
  avgResponseSeconds: "relative", medianResponseSeconds: "relative",
};

/** (cur − prev) ÷ prev; null when either side is missing or prev is 0 (no base to compare to). */
export function relativeChange(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

/** cur − prev for rates (0.30 vs 0.25 → 0.05 = 5 points); null when either is N/A. */
export function pointChange(cur: number | null, prev: number | null): number | null {
  return cur == null || prev == null ? null : cur - prev;
}

export function smsDeltas(cur: SmsKpis, prev: SmsKpis): Record<keyof SmsKpis, number | null> {
  const out = {} as Record<keyof SmsKpis, number | null>;
  for (const k of Object.keys(DELTA_KIND) as (keyof SmsKpis)[]) {
    out[k] = DELTA_KIND[k] === "points" ? pointChange(cur[k], prev[k]) : relativeChange(cur[k], prev[k]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Breakdowns and names
// ---------------------------------------------------------------------------

/** Filter/breakdown keys for "no value". */
export const NO_SENDER = "none";
export const NO_TAG = "(no tag)";
export const NO_SOURCE = "(no source)";
export const UNASSIGNED_LABEL = "Automated / unassigned";
export const UNKNOWN_USER_LABEL = "HighLevel user";

export interface HlUser { id: string; name: string; email: string | null }

/** Display name of a HighLevel user id (null/"none" = automated or unassigned). */
export function senderName(id: string | null | undefined, users: readonly HlUser[]): string {
  if (!id || id === NO_SENDER) return UNASSIGNED_LABEL;
  return users.find((u) => u.id === id)?.name || UNKNOWN_USER_LABEL;
}

export interface BreakdownRow {
  key: string;
  name: string;
  contactsReached: number;
  responded: number;
  responseRate: number | null;
  optedOut: number;
  textsSent: number;
  medianResponseSeconds: number | null;
}

export interface CohortGroup { key: string; reached: number; responded: number; optedOut: number; median: number | null }
export interface VolumeGroup { key: string; textsSent: number }

/**
 * Join the cohort side (who was reached / replied, by the contact's credit)
 * with the volume side (texts sent, by the message's sender) of one dimension.
 * Sorted by contacts reached, then texts sent, then name.
 */
export function mergeBreakdown(cohort: readonly CohortGroup[], volume: readonly VolumeGroup[], nameOf: (key: string) => string): BreakdownRow[] {
  const rows = new Map<string, BreakdownRow>();
  const row = (key: string) => {
    let r = rows.get(key);
    if (!r) {
      r = { key, name: nameOf(key), contactsReached: 0, responded: 0, responseRate: null, optedOut: 0, textsSent: 0, medianResponseSeconds: null };
      rows.set(key, r);
    }
    return r;
  };
  for (const c of cohort) {
    const r = row(c.key);
    r.contactsReached += c.reached;
    r.responded += c.responded;
    r.optedOut += c.optedOut;
    r.medianResponseSeconds = c.responded > 0 && c.median != null ? Math.round(c.median) : null;
  }
  for (const v of volume) row(v.key).textsSent += v.textsSent;
  for (const r of rows.values()) r.responseRate = ratio(r.responded, r.contactsReached);
  return [...rows.values()].sort((a, b) =>
    b.contactsReached - a.contactsReached || b.textsSent - a.textsSent || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Stored HighLevel configuration (Integration.config, provider "highlevel")
// ---------------------------------------------------------------------------

export interface HlSyncState {
  phase: "preview" | "importing" | "live" | null;
  previewTexts: number | null;
  imported: number;
  lastRun: { at: string | null; ok: boolean; message: string | null } | null;
}
export interface HlReportConfig {
  locationName: string | null;
  responseWindowDays: number;
  hlUsers: HlUser[];
  sync: HlSyncState;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);

/** Read the parts of the stored config the report uses, tolerating any shape. */
export function readHlConfig(raw: unknown): HlReportConfig {
  const cfg = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const win = int(cfg.responseWindowDays);
  const users = Array.isArray(cfg.hlUsers) ? cfg.hlUsers : [];
  const sync = (cfg.hlSync && typeof cfg.hlSync === "object" ? cfg.hlSync : {}) as Record<string, unknown>;
  const phase = sync.phase === "preview" || sync.phase === "importing" || sync.phase === "live" ? sync.phase : null;
  const preview = (sync.preview && typeof sync.preview === "object" ? sync.preview : {}) as Record<string, unknown>;
  const lastRun = sync.lastRun && typeof sync.lastRun === "object" ? sync.lastRun as Record<string, unknown> : null;
  return {
    locationName: str(cfg.locationName),
    responseWindowDays: win != null && (RESPONSE_WINDOW_OPTIONS as readonly number[]).includes(win) ? win : DEFAULT_RESPONSE_WINDOW_DAYS,
    hlUsers: users.flatMap((u) => {
      const o = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
      const id = str(o.id);
      return id ? [{ id, name: str(o.name) ?? UNKNOWN_USER_LABEL, email: str(o.email) }] : [];
    }),
    sync: {
      phase,
      previewTexts: int(preview.texts),
      imported: int(sync.imported) ?? 0,
      lastRun: lastRun ? { at: str(lastRun.at), ok: lastRun.ok !== false, message: str(lastRun.message) } : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

/** Most values one list filter accepts (each becomes a bound SQL array element). */
export const MAX_FILTER_VALUES = 200;

/**
 * A list param, one value per repetition (?tags=a&tags=b) → trimmed,
 * de-duplicated, capped. Never comma-split: HighLevel tags and sources can
 * contain commas.
 */
export function listParam(v: unknown): string[] {
  if (v == null) return [];
  const raw = Array.isArray(v) ? v : [v];
  const vals = raw.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
  return [...new Set(vals)].slice(0, MAX_FILTER_VALUES);
}

export interface SmsFilters { senders: string[]; tags: string[]; sources: string[] }

export function parseSmsFilters(q: Record<string, unknown>): SmsFilters {
  return { senders: listParam(q.senders), tags: listParam(q.tags), sources: listParam(q.sources) };
}

export const DRILL_SETS = ["texted", "reached", "responded", "optedOut", "noReply", "lateReply", "inboundFirst"] as const;
export type DrillSet = (typeof DRILL_SETS)[number];
