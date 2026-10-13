/**
 * Reports → SMS performance: response types (GET /reports/sms…) and the pure
 * display helpers behind pages/reports/SmsPerformance.tsx. The counting rules
 * live on the server (server/src/domain/smsMetrics.ts); nothing here
 * recomputes a metric — it only labels and formats what the server sends.
 */
import { ALL_PERIOD } from "./period";
import { monthLabel } from "./charts";
import { money } from "./format";
import type { DeltaKind } from "./reportDelta";

/** Which texting the report counts: minerals only (default) or everything. */
export type SmsScope = "minerals" | "all";

export interface SmsKpis {
  textsSent: number; textsDelivered: number; textsFailed: number; repliesReceived: number;
  contactsTexted: number; contactsReached: number; contactsResponded: number;
  /** null = N/A (nobody reached). */
  responseRate: number | null;
  optedOut: number; optOutRate: number | null;
  avgTextsPerContact: number | null;
  avgResponseSeconds: number | null; medianResponseSeconds: number | null;
  /** No reply yet but last texted within the response window: they can still reply and count. */
  stillWaiting: number;
  /** Average texts the people who replied got up to their reply; null = nobody replied. */
  avgTextsBeforeReply: number | null;
  wrongNumbers: number; wrongNumberRate: number | null;
  opportunities: number; interestedRate: number | null; offers: number; offerAcceptanceRate: number | null; closedDeals: number;
  /** Dollars; null = no price per segment set. */
  textingCost: number | null; costPerReply: number | null; costPerOpportunity: number | null; costPerOffer: number | null;
  costPerClosedDeal: number | null;
  medianAnswerSeconds: number | null; answeredWithinHourRate: number | null; neverAnsweredRate: number | null;
}

export type FunnelStepKey = "reached" | "responded" | "opportunity" | "offer" | "accepted" | "contract" | "closed";
export interface SmsFunnel {
  steps: { key: FunnelStepKey; count: number; fromPrevious: number | null; fromReached: number | null }[];
  dead: number;
  /** Opportunities created before the person's first text (left out). */
  preExisting: number;
  interestedRate: number | null; offerAcceptanceRate: number | null;
  contactsPerOffer: number | null; contactsPerClosedDeal: number | null; textsPerClosedDeal: number | null;
  toOpportunity: { avgSeconds: number | null; medianSeconds: number | null };
  toClose: { avgSeconds: number | null; medianSeconds: number | null; known: number; unknown: number };
  /** The funnel's pipelines; null = every pipeline (All texting). */
  pipelines: { id: string; name: string }[] | null;
  /** When stage moves started being recorded (the HighLevel connection date). */
  historySince: string | null;
}
export interface SmsCost {
  pricePerSegment: number | null; segments: number; unknownSegments: number; total: number | null;
  perReply: number | null; perOpportunity: number | null; perOffer: number | null; perClosedDeal: number | null;
}
export interface SmsSpeed {
  responded: number; answered: number; never: number; avgSeconds: number | null; medianSeconds: number | null;
  within5mRate: number | null; within1hRate: number | null; within24hRate: number | null; neverRate: number | null;
  byMember: { key: string; name: string; answered: number; medianSeconds: number | null; within1hRate: number | null }[];
}
export interface SlotCell { dow: number; hour: number; reached: number; responded: number; rate: number | null; small: boolean }
export interface SmsBestTime { timezone: string; fallback: boolean; minSample: number; cells: SlotCell[]; best: SlotCell[] }
export interface QualityRow {
  key: string; name: string; reached: number; responded: number; responseRate: number | null;
  sent: number; delivered: number; deliveryRate: number | null;
  wrongNumber: number; wrongNumberRate: number | null; disconnected: number; disconnectedRate: number | null;
  landline: number; landlineRate: number | null; rotated: number; rotatedRate: number | null; exhausted: number; exhaustedRate: number | null;
}
export interface HealthWindow {
  sent: number; failed: number; reached: number; optOuts: number;
  optOutRate: number | null; failureRate: number | null; warnings: ("optOut" | "failure")[];
}
export interface HealthDay extends HealthWindow { day: string; small: boolean }
export interface SmsCarrierHealth {
  thresholds: { optOutRate: number; failureRate: number; minTexts: number };
  last7: HealthWindow; days: HealthDay[]; breachDays: string[];
}

export interface TouchRate {
  touch: number; orLater: boolean; received: number; responded: number; rate: number | null;
  cumulativeResponded: number; cumulativeRate: number | null;
}

export type TrendBucket = "day" | "week" | "month";
export interface TrendPoint { period: string; sent: number; delivered: number; failed: number; inbound: number }

export interface BreakdownRow {
  key: string; name: string; contactsReached: number; responded: number; responseRate: number | null;
  optedOut: number; textsSent: number; medianResponseSeconds: number | null;
}

export interface SmsReport {
  range: { from: string; to: string };
  compare: { from: string; to: string } | null;
  windowDays: number;
  scope: SmsScope;
  scopeInfo: { saved: boolean; texted: { minerals: number; realEstate: number; unclassified: number } };
  kpis: SmsKpis;
  previous: SmsKpis | null;
  deltas: Record<keyof SmsKpis, number | null> | null;
  deltaKind: Record<keyof SmsKpis, DeltaKind>;
  byTouch: TouchRate[];
  trend: { bucket: TrendBucket; points: TrendPoint[] };
  funnel: SmsFunnel;
  cost: SmsCost;
  speed: SmsSpeed;
  bestTime: SmsBestTime;
  phoneQuality: { tags: QualityRow[]; sources: QualityRow[] };
  carrierHealth: SmsCarrierHealth;
  breakdowns: { senders: BreakdownRow[]; tags: BreakdownRow[]; sources: BreakdownRow[] };
  notes: {
    reachedTexts: number; unconfirmedTexts: number; inboundFirstContacts: number; lateReplies: number;
    unknownSegments?: number; summariesPending?: number;
  };
}

export interface SmsStatus {
  connected: boolean;
  status: "NOT_CONNECTED" | "CONNECTED" | "ERROR";
  phase: "preview" | "importing" | "live" | null;
  locationName: string | null;
  lastSyncAt: string | null;
  imported: number;
  previewTexts: number | null;
  responseWindowDays: number;
  /** Only for people who manage integrations. */
  lastError: string | null;
  /** Synced history exists (it is kept after a disconnect). */
  hasData: boolean;
  /** An admin saved the minerals filter (false = the suggested one is in use). */
  scopeSaved: boolean;
  /** People ever texted, by business line (not classified yet = unclassified). */
  minerals: number; realEstate: number; unclassified: number;
}

export interface SmsFilterOptions { senders: { id: string; name: string }[]; tags: string[]; sources: string[] }
export interface SmsFilters { senders: string[]; tags: string[]; sources: string[] }
export const EMPTY_SMS_FILTERS: SmsFilters = { senders: [], tags: [], sources: [] };

export type DrillSet = "texted" | "reached" | "responded" | "optedOut" | "noReply" | "lateReply" | "inboundFirst" | "stillWaiting"
  | "wrongNumber" | "unclassified" | "realEstate"
  | "opportunity" | "offer" | "accepted" | "contract" | "closed" | "dead" | "unanswered"
  | "disconnected" | "landline" | "rotated" | "exhausted";
export const FUNNEL_DRILLS: readonly DrillSet[] = ["opportunity", "offer", "accepted", "contract", "closed", "dead"];

/** A table row a drill narrows to, on top of the report filters (Breakdown: sender/tag/source; Phone lists: listTag/source). */
export interface DrillRow { dim: "sender" | "tag" | "source" | "listTag"; key: string }

export interface SmsContactRow {
  hlId: string; name: string | null; phone: string | null; tags: string[]; source: string | null;
  teamMember: string; firstTextedAt: string | null; textsBeforeReply: number; outcome: string | null;
  outcomeAt: string | null; responseSeconds: number | null; optedOutInHl: boolean; deletedInHl: boolean;
  /** Their most recent text either way. */
  lastTextedAt: string | null;
  line: string | null; wrongNumberAt: string | null; wrongNumberTouch: number | null;
  answerSeconds: number | null; answeredBy: string | null;
  /** Funnel lists only. */
  furthestStep: string | null; oppDead: boolean | null;
}

export interface SmsTimelineMessage {
  sentAt: string; direction: string; status: string | null;
  statusKind: "received" | "pending" | "failed" | "delivered" | "unconfirmed";
  source: string | null; messageType: string | null; sender: string | null;
  /** Inbound only: how the reply was read (its wording is never stored). */
  replyKind?: "reply" | "optOut" | "wrongNumber" | null;
}

/** Bars from fewer people than this are marked as a small sample. */
export const SMALL_SAMPLE = 20;

/**
 * The report's query string: the period (or ?period=ALL), the comparison
 * window, the scope, and one repeated param per filter value (tags can
 * contain commas).
 */
export function smsQuery(o: {
  allTime: boolean; range: { from: string; to: string }; cmp: { from: string; to: string } | null; filters: SmsFilters; scope?: SmsScope;
}): string {
  const qs = new URLSearchParams();
  if (o.allTime) qs.set("period", ALL_PERIOD);
  else { qs.set("from", o.range.from); qs.set("to", o.range.to); }
  if (o.cmp && !o.allTime) { qs.set("compareFrom", o.cmp.from); qs.set("compareTo", o.cmp.to); }
  qs.set("scope", o.scope ?? "minerals");
  for (const k of ["senders", "tags", "sources"] as const) for (const v of o.filters[k]) qs.append(k, v);
  return qs.toString();
}

/** The report's query narrowed to one table row (on top of its filters, so the list matches the row). */
export function withRow(query: string, row: DrillRow): string {
  const qs = new URLSearchParams(query);
  qs.set("rowDim", row.dim);
  qs.set("rowKey", row.key);
  return qs.toString();
}

/** Seconds as a plain duration: "under a minute", "12 min", "5.5 hrs", "2.3 days"; N/A for none. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "N/A";
  const s = Math.max(0, seconds);
  if (s < 60) return "under a minute";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const one = (v: number) => Number(v.toFixed(1));
  if (s < 48 * 3600) { const h = one(s / 3600); return `${h} ${h === 1 ? "hr" : "hrs"}`; }
  return `${one(s / 86400)} days`;
}

/** A trend bucket's axis label: "Oct 3" (a day, or the Monday a week starts), "Oct ’26" (a month). */
export function trendLabel(period: string, bucket: TrendBucket): string {
  if (bucket === "month") return monthLabel(period);
  const d = new Date(`${period}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return period;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Tooltip title for a bucket: "Oct 3, 2026", "Week of Oct 5, 2026", "Oct ’26". */
export function trendTitle(period: string, bucket: TrendBucket): string {
  if (bucket === "month") return monthLabel(period);
  const d = new Date(`${period}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return period;
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return bucket === "week" ? `Week of ${day}` : day;
}

export const BUCKET_LABEL: Record<TrendBucket, string> = { day: "Daily", week: "Weekly (weeks start Monday)", month: "Monthly" };

/** "Text 1" … "Text 5", then "6th or later". */
export function touchLabel(t: Pick<TouchRate, "touch" | "orLater">, short = false): string {
  if (!t.orLater) return `Text ${t.touch}`;
  return short ? `${t.touch}th+` : `${t.touch}th or later`;
}

/** How a contact's outreach ended, in plain words. */
export const OUTCOME_LABEL: Record<string, string> = {
  RESPONDED: "Replied",
  OPTED_OUT: "Asked to stop",
  LATE_REPLY: "Replied late",
  NO_REPLY: "No reply yet",
  WRONG_NUMBER: "Wrong number",
  INBOUND_FIRST: "Texted us first",
  NOT_REACHED: "Never reached",
};
export const OUTCOME_HINT: Record<string, string> = {
  LATE_REPLY: "Replied after the response window had closed",
  WRONG_NUMBER: "The only replies said we had the wrong person — not counted as a response",
  NOT_REACHED: "Every text to this number failed",
  INBOUND_FIRST: "They texted before any outreach text — not counted in response rates",
};
export const outcomeLabel = (o: string | null | undefined) => (o ? OUTCOME_LABEL[o] ?? o : "—");
/** Why a person is on the wrong-number list: their reply (after which text), or only an XLeads tag. */
export const wrongNumberLabel = (r: Pick<SmsContactRow, "wrongNumberAt" | "wrongNumberTouch">) =>
  r.wrongNumberAt ? `Replied so after text ${r.wrongNumberTouch ?? "?"}` : "XLeads wrong-number tag";

export const STATUS_KIND_LABEL: Record<SmsTimelineMessage["statusKind"], string> = {
  received: "Received",
  delivered: "Delivered",
  unconfirmed: "Sent — no delivery receipt",
  failed: "Failed",
  pending: "Scheduled (not sent yet)",
};

const SOURCE_LABEL: Record<string, string> = {
  workflow: "Automation (workflow)",
  campaign: "Automation (campaign)",
  bulk_actions: "Bulk send",
  api: "Automation (API)",
  app: "HighLevel app",
};

/** Who or what sent a text, for the timeline: the contact, a person, or an automation. */
export function sentByLabel(m: Pick<SmsTimelineMessage, "direction" | "sender" | "source">): { label: string; automated: boolean } {
  if (m.direction === "inbound") return { label: "The contact", automated: false };
  if (m.sender) {
    const how = m.source === "bulk_actions" ? " (bulk send)" : m.source === "workflow" || m.source === "campaign" ? " (automation)" : "";
    return { label: `${m.sender}${how}`, automated: how === " (automation)" };
  }
  return { label: (m.source && SOURCE_LABEL[m.source]) ?? "Automation", automated: true };
}

// ---------------------------------------------------------------------------
// Scope, funnel, cost, best time
// ---------------------------------------------------------------------------

export const SCOPE_LABEL: Record<SmsScope, string> = { minerals: "Minerals only", all: "All texting" };
export const LINE_LABEL: Record<string, string> = { minerals: "Minerals", real_estate: "Real estate", unclassified: "Not classified" };
export const lineLabel = (l: string | null | undefined) => LINE_LABEL[l ?? "unclassified"] ?? LINE_LABEL.unclassified;

/** Funnel steps, in people. */
export const FUNNEL_STEP_LABEL: Record<FunnelStepKey, string> = {
  reached: "Reached", responded: "Replied", opportunity: "Opportunity", offer: "Offer made",
  accepted: "Offer accepted", contract: "Under contract", closed: "Closed",
};
/** A person's furthest opportunity step, for drill lists. */
export function furthestStepLabel(step: string | null | undefined, dead: boolean | null | undefined): string {
  if (!step) return "—";
  const label = FUNNEL_STEP_LABEL[step as FunnelStepKey] ?? step;
  return dead ? `${label} · now dead` : label;
}

/** Dollars to the cent; tiny per-result costs read "under 1¢"; null = N/A. */
export function fmtCost(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  if (v > 0 && v < 0.005) return "under 1¢";
  return money(v, { cents: true });
}

/** "135.7", "4"; null = N/A. */
export const fmtPer = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? "N/A" : Number(v.toFixed(1)).toLocaleString("en-US");

/** An average always to one decimal: "1.4", "2.0", "1,234.6"; null = N/A. */
export const fmtAvg1 = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? "N/A" : v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** ISO weekday (1 = Monday) → "Mon". */
export const DOW_LABEL = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Hour of day → "9 AM", "12 PM", "5 PM". */
export function hourLabel(h: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${ampm}`;
}
export const slotLabel = (c: Pick<SlotCell, "dow" | "hour">) => `${DOW_LABEL[c.dow] ?? "?"} ${hourLabel(c.hour)}`;
/** Hour of day for a narrow grid column → "12a", "9a", "12p", "5p". */
export const hourShort = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`;

/** The hours a best-time grid shows: the first through the last hour anyone was first texted (none → 8 AM–6 PM). */
export function slotHours(cells: readonly Pick<SlotCell, "hour">[]): number[] {
  if (!cells.length) return Array.from({ length: 11 }, (_, i) => 8 + i);
  const lo = Math.min(...cells.map((c) => c.hour)), hi = Math.max(...cells.map((c) => c.hour));
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/**
 * Shade of a best-time cell, 0–1: its response rate against the best rate
 * among cells with enough people (small samples never set the scale).
 */
export function heatLevel(rate: number | null, cells: readonly Pick<SlotCell, "rate" | "small">[]): number {
  const max = Math.max(0, ...cells.filter((c) => !c.small && c.rate != null).map((c) => c.rate as number));
  if (rate == null || max <= 0) return 0;
  return Math.max(0, Math.min(1, rate / max));
}

/** "Sep 30" for a carrier-health day key. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
