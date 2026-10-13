/**
 * Reports → SMS performance: the pure parts of the report (periods, trend
 * buckets, KPI arithmetic, comparisons, breakdown rows, the stored HighLevel
 * config). The counting rules themselves live in smsMetrics.ts; the SQL that
 * aggregates them lives in routes/smsReports.ts.
 *
 * Dates are UTC calendar days. A period [from, to] covers from 00:00Z up to
 * (not including) to + 1 day 00:00Z.
 */
import {
  DEFAULT_RESPONSE_WINDOW_DAYS, HEALTH_MIN_TEXTS, RESPONSE_WINDOW_OPTIONS, carrierHealth, ratio, textingCost,
  type HealthResult, type TouchOutcomeCount,
} from "./smsMetrics.js";
import { phoneTagKinds, suggestScope, type SmsScope } from "./smsScope.js";
import type { FunnelStep } from "./smsFunnel.js";

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
  /** Cohort contacts who hit a wrong number (a flagged reply or an XLeads wrong-number tag). */
  wrongNumbers: number;
  wrongNumberRate: number | null;
  /** Funnel, in people (see funnelSummary). */
  opportunities: number;
  interestedRate: number | null;
  offers: number;
  offerAcceptanceRate: number | null;
  closedDeals: number;
  /** Dollars; null when no price per segment is set. */
  textingCost: number | null;
  costPerReply: number | null;
  costPerOpportunity: number | null;
  costPerOffer: number | null;
  costPerClosedDeal: number | null;
  /** Speed to lead (see speedSummary). */
  medianAnswerSeconds: number | null;
  answeredWithinHourRate: number | null;
  neverAnsweredRate: number | null;
}

export interface VolumeTotals {
  sent: number; delivered: number; failed: number; inbound: number; contactsTexted: number;
  /** Billable segments of the texts sent (a text not yet counted = 1), and how many weren't counted yet. */
  segments?: number; unknownSegments?: number;
}
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

/** The newer sections' headline figures; each is optional so a caller can leave a section out. */
export interface KpiSections {
  wrongNumbers?: number;
  funnel?: FunnelSummary;
  cost?: CostSummary;
  speed?: SpeedSummary;
}

export function computeKpis(v: VolumeTotals, c: CohortTotals, x: KpiSections = {}): SmsKpis {
  const step = (k: FunnelStepKey) => x.funnel?.steps.find((s) => s.key === k)?.count ?? 0;
  const wrong = x.wrongNumbers ?? 0;
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
    wrongNumbers: wrong,
    wrongNumberRate: ratio(wrong, c.reached),
    opportunities: step("opportunity"),
    interestedRate: x.funnel?.interestedRate ?? null,
    offers: step("offer"),
    offerAcceptanceRate: x.funnel?.offerAcceptanceRate ?? null,
    closedDeals: step("closed"),
    textingCost: x.cost?.total ?? null,
    costPerReply: x.cost?.perReply ?? null,
    costPerOpportunity: x.cost?.perOpportunity ?? null,
    costPerOffer: x.cost?.perOffer ?? null,
    costPerClosedDeal: x.cost?.perClosedDeal ?? null,
    medianAnswerSeconds: x.speed?.medianSeconds ?? null,
    answeredWithinHourRate: x.speed?.within1hRate ?? null,
    neverAnsweredRate: x.speed?.neverRate ?? null,
  };
}

export type DeltaKind = "relative" | "points";

/** Rates compare as a point difference; everything else as a relative change. */
export const DELTA_KIND: Record<keyof SmsKpis, DeltaKind> = {
  textsSent: "relative", textsDelivered: "relative", textsFailed: "relative", repliesReceived: "relative",
  contactsTexted: "relative", contactsReached: "relative", contactsResponded: "relative",
  responseRate: "points", optedOut: "relative", optOutRate: "points", avgTextsPerContact: "relative",
  avgResponseSeconds: "relative", medianResponseSeconds: "relative",
  wrongNumbers: "relative", wrongNumberRate: "points",
  opportunities: "relative", interestedRate: "points", offers: "relative", offerAcceptanceRate: "points", closedDeals: "relative",
  textingCost: "relative", costPerReply: "relative", costPerOpportunity: "relative", costPerOffer: "relative", costPerClosedDeal: "relative",
  medianAnswerSeconds: "relative", answeredWithinHourRate: "points", neverAnsweredRate: "points",
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
export interface HlPipeline { id: string; name: string }
export interface HlReportConfig {
  locationName: string | null;
  responseWindowDays: number;
  hlUsers: HlUser[];
  sync: HlSyncState;
  /** The saved minerals filter; null = not saved yet (the sync then uses suggestScope). */
  scope: SmsScope | null;
  /** Dollars per billable SMS segment; null = not set. */
  pricePerSegment: number | null;
  /** The HighLevel location's IANA time zone, when known and valid. */
  locationTimezone: string | null;
  hlPipelines: HlPipeline[];
  hlTags: string[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : null);

/** A saved scope, or null when absent or malformed (every list must be a string array). */
function readScope(v: unknown): SmsScope | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const mineralTags = strings(o.mineralTags), realEstateTags = strings(o.realEstateTags), mineralPipelineIds = strings(o.mineralPipelineIds);
  return mineralTags && realEstateTags && mineralPipelineIds ? { mineralTags, realEstateTags, mineralPipelineIds } : null;
}

/** True for a time zone this runtime (and so Postgres, which uses the same IANA names) knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Read the parts of the stored config the report uses, tolerating any shape. */
export function readHlConfig(raw: unknown): HlReportConfig {
  const cfg = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const win = int(cfg.responseWindowDays);
  const users = Array.isArray(cfg.hlUsers) ? cfg.hlUsers : [];
  const sync = (cfg.hlSync && typeof cfg.hlSync === "object" ? cfg.hlSync : {}) as Record<string, unknown>;
  const phase = sync.phase === "preview" || sync.phase === "importing" || sync.phase === "live" ? sync.phase : null;
  const preview = (sync.preview && typeof sync.preview === "object" ? sync.preview : {}) as Record<string, unknown>;
  const lastRun = sync.lastRun && typeof sync.lastRun === "object" ? sync.lastRun as Record<string, unknown> : null;
  const price = cfg.pricePerSegment;
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
    scope: readScope(cfg.scope),
    pricePerSegment: typeof price === "number" && Number.isFinite(price) && price >= 0 ? price : null,
    locationTimezone: isValidTimeZone(cfg.locationTimezone) ? cfg.locationTimezone : null,
    hlPipelines: (Array.isArray(cfg.hlPipelines) ? cfg.hlPipelines : []).flatMap((p) => {
      const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      const id = str(o.id);
      return id ? [{ id, name: str(o.name) ?? "HighLevel pipeline" }] : [];
    }),
    hlTags: strings(cfg.hlTags) ?? [],
  };
}

/** The minerals filter in force: the saved one, else the same suggestion the sync classifies with. */
export const effectiveScope = (cfg: HlReportConfig): SmsScope => cfg.scope ?? suggestScope(cfg.hlTags, cfg.hlPipelines);

/** Which texting a report counts: minerals only (the default) or everything. */
export type ReportScope = "minerals" | "all";
export const parseReportScope = (v: unknown): ReportScope => (v === "all" ? "all" : "minerals");

/** Business lines as stored on HighLevelContact.line; anything else (or null, not classified yet) is unclassified. */
export function lineCounts(rows: readonly { line: string | null; n: number }[]) {
  const out = { minerals: 0, realEstate: 0, unclassified: 0 };
  for (const r of rows) {
    if (r.line === "minerals") out.minerals += r.n;
    else if (r.line === "real_estate") out.realEstate += r.n;
    else out.unclassified += r.n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Funnel (HighLevel opportunities), cost, speed to lead
// ---------------------------------------------------------------------------

/** Funnel steps in people, in order. "responded" = replied (the response cohort). */
export const FUNNEL_STEP_KEYS = ["reached", "responded", "opportunity", "offer", "accepted", "contract", "closed"] as const;
export type FunnelStepKey = (typeof FUNNEL_STEP_KEYS)[number];

export interface FunnelCounts {
  reached: number; responded: number; opportunity: number; offer: number; accepted: number; contract: number; closed: number;
  /** People whose every counted opportunity is dead now. */
  dead: number;
  /** Opportunities left out because they were created before the person's first text. */
  preExisting: number;
  /** Texts sent to everyone in the cohort (outboundTotal), for texts per closed deal. */
  cohortTexts: number;
  /** Seconds from the first text to the first counted opportunity / to closing. */
  toOpportunity: { avg: number | null; median: number | null };
  toClose: { avg: number | null; median: number | null; known: number };
}

export interface FunnelSummary {
  steps: { key: FunnelStepKey; count: number; fromPrevious: number | null; fromReached: number | null }[];
  dead: number;
  preExisting: number;
  interestedRate: number | null;
  offerAcceptanceRate: number | null;
  contactsPerOffer: number | null;
  contactsPerClosedDeal: number | null;
  textsPerClosedDeal: number | null;
  toOpportunity: { avgSeconds: number | null; medianSeconds: number | null };
  toClose: { avgSeconds: number | null; medianSeconds: number | null; known: number; unknown: number };
}

const secs = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.max(0, Math.round(v)));

/**
 * Step-to-step and overall conversion. People can reach a step without the
 * one before it (an opportunity from a phone call, say), so a step is not
 * forced to be smaller than the previous one.
 */
export function funnelSummary(f: FunnelCounts): FunnelSummary {
  let prev: number | null = null;
  const steps = FUNNEL_STEP_KEYS.map((key) => {
    const count = f[key];
    const s = { key, count, fromPrevious: prev == null ? null : ratio(count, prev), fromReached: ratio(count, f.reached) };
    prev = count;
    return s;
  });
  return {
    steps,
    dead: f.dead,
    preExisting: f.preExisting,
    interestedRate: ratio(f.opportunity, f.reached),
    offerAcceptanceRate: ratio(f.accepted, f.offer),
    contactsPerOffer: ratio(f.reached, f.offer),
    contactsPerClosedDeal: ratio(f.reached, f.closed),
    textsPerClosedDeal: ratio(f.cohortTexts, f.closed),
    toOpportunity: f.opportunity > 0
      ? { avgSeconds: secs(f.toOpportunity.avg), medianSeconds: secs(f.toOpportunity.median) }
      : { avgSeconds: null, medianSeconds: null },
    toClose: {
      avgSeconds: f.toClose.known > 0 ? secs(f.toClose.avg) : null,
      medianSeconds: f.toClose.known > 0 ? secs(f.toClose.median) : null,
      known: f.toClose.known,
      unknown: Math.max(0, f.closed - f.toClose.known),
    },
  };
}

/** Per-person opportunity flags (one row of the funnel lateral) → the furthest step, and whether it's dead now. */
export function furthestStep(x: { n: number; offer: boolean; accepted: boolean; contract: boolean; closed: boolean; alive: number }):
  { step: FunnelStep; dead: boolean } | null {
  if (!x.n) return null;
  const step: FunnelStep = x.closed ? "closed" : x.contract ? "contract" : x.accepted ? "accepted" : x.offer ? "offer" : "opportunity";
  return { step, dead: x.alive === 0 };
}

export interface CostSummary {
  pricePerSegment: number | null;
  segments: number;
  /** Texts whose segments weren't counted yet (each counted as one). */
  unknownSegments: number;
  total: number | null;
  perReply: number | null;
  perOpportunity: number | null;
  perOffer: number | null;
  perClosedDeal: number | null;
}

/**
 * Texting cost = billable segments sent in the period × the price. Results
 * (replies, opportunities…) are the period's response cohort, so the cost per
 * result mixes send dates with first-text dates — the report says so.
 */
export function costSummary(segments: number, unknownSegments: number, price: number | null,
  results: { responded: number; opportunities: number; offers: number; closed: number }): CostSummary {
  const total = textingCost(segments, price);
  const per = (n: number) => (total == null ? null : ratio(total, n));
  return {
    pricePerSegment: price, segments, unknownSegments, total,
    perReply: per(results.responded), perOpportunity: per(results.opportunities), perOffer: per(results.offers), perClosedDeal: per(results.closed),
  };
}

export interface SpeedCounts {
  /** Cohort contacts who replied (RESPONDED). */
  responded: number;
  /** Of those, answered by a team member's text (replyAnsweredSeconds set). */
  answered: number;
  within5m: number; within1h: number; within24h: number;
  avg: number | null; median: number | null;
}
export interface SpeedSummary {
  responded: number; answered: number; never: number;
  avgSeconds: number | null; medianSeconds: number | null;
  within5mRate: number | null; within1hRate: number | null; within24hRate: number | null; neverRate: number | null;
}

/** Speed to lead: shares are of everyone who replied, so "never answered" completes the picture. */
export function speedSummary(s: SpeedCounts): SpeedSummary {
  const never = Math.max(0, s.responded - s.answered);
  return {
    responded: s.responded, answered: s.answered, never,
    avgSeconds: s.answered > 0 ? secs(s.avg) : null,
    medianSeconds: s.answered > 0 ? secs(s.median) : null,
    within5mRate: ratio(s.within5m, s.responded),
    within1hRate: ratio(s.within1h, s.responded),
    within24hRate: ratio(s.within24h, s.responded),
    neverRate: ratio(never, s.responded),
  };
}

// ---------------------------------------------------------------------------
// Best time to text, phone-list quality, carrier health
// ---------------------------------------------------------------------------

/** Slots with fewer people than this are shown muted and never called "best". */
export const BEST_TIME_MIN_SAMPLE = 20;

/** One weekday × hour slot of first texts (dow 1 = Monday … 7 = Sunday, ISO; hour 0–23 local). */
export interface SlotCount { dow: number; hour: number; reached: number; responded: number }
export interface SlotCell extends SlotCount { rate: number | null; small: boolean }

export function bestTimeGrid(rows: readonly SlotCount[], minSample = BEST_TIME_MIN_SAMPLE, top = 3): { cells: SlotCell[]; best: SlotCell[] } {
  const cells = rows
    .filter((r) => r.dow >= 1 && r.dow <= 7 && r.hour >= 0 && r.hour <= 23 && r.reached > 0)
    .map((r) => ({ ...r, rate: ratio(r.responded, r.reached), small: r.reached < minSample }))
    .sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  const best = cells
    .filter((c) => !c.small && c.responded > 0)
    .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.reached - a.reached || a.dow - b.dow || a.hour - b.hour)
    .slice(0, top);
  return { cells, best };
}

/** Phone-quality groups of the report (landline includes "sms incapable"). */
export const PHONE_GROUPS = ["wrongNumber", "disconnected", "landline", "rotated", "exhausted"] as const;
export type PhoneGroup = (typeof PHONE_GROUPS)[number];
export type PhoneTagSets = Record<PhoneGroup | "any", string[]>;

/**
 * The org's actual tag strings per phone-quality group, classified once with
 * smsScope.ts phoneTagKinds() — so SQL matches them exactly (array overlap)
 * instead of re-running the tag rules on every contact.
 */
export function phoneTagSets(tags: readonly string[]): PhoneTagSets {
  const out: PhoneTagSets = { wrongNumber: [], disconnected: [], landline: [], rotated: [], exhausted: [], any: [] };
  for (const tag of new Set(tags)) {
    const kinds = phoneTagKinds([tag]);
    if (!kinds.size) continue;
    out.any.push(tag);
    if (kinds.has("wrongNumber")) out.wrongNumber.push(tag);
    if (kinds.has("disconnected")) out.disconnected.push(tag);
    if (kinds.has("landline") || kinds.has("smsIncapable")) out.landline.push(tag);
    if (kinds.has("rotated")) out.rotated.push(tag);
    if (kinds.has("exhausted")) out.exhausted.push(tag);
  }
  return out;
}

export interface QualityCohortGroup {
  key: string; reached: number; responded: number;
  wrongNumber: number; disconnected: number; landline: number; rotated: number; exhausted: number;
}
export interface QualityVolumeGroup { key: string; sent: number; delivered: number }
export interface QualityRow extends QualityCohortGroup {
  name: string;
  sent: number; delivered: number; deliveryRate: number | null;
  responseRate: number | null; wrongNumberRate: number | null; disconnectedRate: number | null;
  landlineRate: number | null; rotatedRate: number | null; exhaustedRate: number | null;
}

/** Phone-list quality per tag or source: people-based shares of those reached, delivery from the texts. */
export function mergeQuality(cohort: readonly QualityCohortGroup[], volume: readonly QualityVolumeGroup[], nameOf: (key: string) => string): QualityRow[] {
  const rows = new Map<string, QualityRow>();
  const row = (key: string) => {
    let r = rows.get(key);
    if (!r) {
      r = {
        key, name: nameOf(key), reached: 0, responded: 0, wrongNumber: 0, disconnected: 0, landline: 0, rotated: 0, exhausted: 0,
        sent: 0, delivered: 0, deliveryRate: null, responseRate: null, wrongNumberRate: null, disconnectedRate: null,
        landlineRate: null, rotatedRate: null, exhaustedRate: null,
      };
      rows.set(key, r);
    }
    return r;
  };
  for (const c of cohort) {
    const r = row(c.key);
    r.reached += c.reached; r.responded += c.responded; r.wrongNumber += c.wrongNumber; r.disconnected += c.disconnected;
    r.landline += c.landline; r.rotated += c.rotated; r.exhausted += c.exhausted;
  }
  for (const v of volume) { const r = row(v.key); r.sent += v.sent; r.delivered += v.delivered; }
  for (const r of rows.values()) {
    r.deliveryRate = ratio(r.delivered, r.sent);
    r.responseRate = ratio(r.responded, r.reached);
    r.wrongNumberRate = ratio(r.wrongNumber, r.reached);
    r.disconnectedRate = ratio(r.disconnected, r.reached);
    r.landlineRate = ratio(r.landline, r.reached);
    r.rotatedRate = ratio(r.rotated, r.reached);
    r.exhaustedRate = ratio(r.exhausted, r.reached);
  }
  return [...rows.values()].sort((a, b) => b.reached - a.reached || b.sent - a.sent || a.name.localeCompare(b.name));
}

export interface HealthCounts { sent: number; failed: number; reached: number; optOuts: number }
export interface HealthDay extends HealthCounts, HealthResult { day: string; /** Too few texts to judge (carrierHealth ignores it). */ small: boolean }

/** carrierHealth over one window, keeping the counts beside the rates. */
export const healthOf = (c: HealthCounts): HealthCounts & HealthResult =>
  ({ ...c, ...carrierHealth({ sent: c.sent, failed: c.failed, reachedContacts: c.reached, optOuts: c.optOuts }) });

/** One point per UTC day of the range (empty days are zeros) and the days that breached a threshold. */
export function healthDays(r: DayRange, rows: readonly (HealthCounts & { day: string })[]): { days: HealthDay[]; breachDays: string[] } {
  const byDay = new Map(rows.map((x) => [x.day, x]));
  const days = bucketKeys(r, "day").map((day) => {
    const x = byDay.get(day);
    const h = healthOf({ sent: x?.sent ?? 0, failed: x?.failed ?? 0, reached: x?.reached ?? 0, optOuts: x?.optOuts ?? 0 });
    return { day, ...h, small: h.sent < HEALTH_MIN_TEXTS };
  });
  return { days, breachDays: days.filter((d) => d.warnings.length > 0).map((d) => d.day) };
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

export const DRILL_SETS = [
  "texted", "reached", "responded", "optedOut", "noReply", "lateReply", "inboundFirst",
  // Wrong numbers, and the people outside "minerals" texted in the period.
  "wrongNumber", "unclassified", "realEstate",
  // Funnel steps (people at or past the step), dead opportunities, replies no team member answered.
  "opportunity", "offer", "accepted", "contract", "closed", "dead", "unanswered",
  // Phone-list quality (XLeads phone-rotation tags).
  "disconnected", "landline", "rotated", "exhausted",
] as const;
export type DrillSet = (typeof DRILL_SETS)[number];

/** Drill sets that list people texted in the period (not the response cohort). */
export const TEXTED_SETS: readonly DrillSet[] = ["texted", "unclassified", "realEstate"];
export const FUNNEL_SETS: readonly DrillSet[] = ["opportunity", "offer", "accepted", "contract", "closed", "dead"];

/**
 * A table row a drill narrows to, on top of the report filters (so the list
 * matches the row even when a filter picks several tags):
 * sender / tag / source = the Breakdown table; listTag = the Phone lists table,
 * whose "(no tag)" row means "no list tag" (phone-rotation tags aren't lists).
 */
export const DRILL_ROW_DIMS = ["sender", "tag", "source", "listTag"] as const;
export type DrillRowDim = (typeof DRILL_ROW_DIMS)[number];
export function drillRow(q: Record<string, unknown>): { dim: DrillRowDim; key: string } | null {
  const dim = (DRILL_ROW_DIMS as readonly string[]).includes(String(q.rowDim)) ? q.rowDim as DrillRowDim : null;
  // Not trimmed: a tag is matched exactly as the row showed it.
  const key = typeof q.rowKey === "string" && q.rowKey.length <= 500 ? q.rowKey : "";
  return dim && key ? { dim, key } : null;
}
