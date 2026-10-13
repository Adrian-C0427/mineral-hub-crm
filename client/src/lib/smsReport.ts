/**
 * Reports → SMS performance: response types (GET /reports/sms…) and the pure
 * display helpers behind pages/reports/SmsPerformance.tsx. The counting rules
 * live on the server (server/src/domain/smsMetrics.ts); nothing here
 * recomputes a metric — it only labels and formats what the server sends.
 */
import { ALL_PERIOD } from "./period";
import { monthLabel } from "./charts";
import type { DeltaKind } from "./reportDelta";

export interface SmsKpis {
  textsSent: number; textsDelivered: number; textsFailed: number; repliesReceived: number;
  contactsTexted: number; contactsReached: number; contactsResponded: number;
  /** null = N/A (nobody reached). */
  responseRate: number | null;
  optedOut: number; optOutRate: number | null;
  avgTextsPerContact: number | null;
  avgResponseSeconds: number | null; medianResponseSeconds: number | null;
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
  kpis: SmsKpis;
  previous: SmsKpis | null;
  deltas: Record<keyof SmsKpis, number | null> | null;
  deltaKind: Record<keyof SmsKpis, DeltaKind>;
  byTouch: TouchRate[];
  trend: { bucket: TrendBucket; points: TrendPoint[] };
  breakdowns: { senders: BreakdownRow[]; tags: BreakdownRow[]; sources: BreakdownRow[] };
  notes: { reachedTexts: number; unconfirmedTexts: number; inboundFirstContacts: number; lateReplies: number; summariesPending?: number };
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
}

export interface SmsFilterOptions { senders: { id: string; name: string }[]; tags: string[]; sources: string[] }
export interface SmsFilters { senders: string[]; tags: string[]; sources: string[] }
export const EMPTY_SMS_FILTERS: SmsFilters = { senders: [], tags: [], sources: [] };

export type DrillSet = "texted" | "reached" | "responded" | "optedOut" | "noReply" | "lateReply" | "inboundFirst";

export interface SmsContactRow {
  hlId: string; name: string | null; phone: string | null; tags: string[]; source: string | null;
  teamMember: string; firstTextedAt: string | null; textsBeforeReply: number; outcome: string | null;
  outcomeAt: string | null; responseSeconds: number | null; optedOutInHl: boolean; deletedInHl: boolean;
}

export interface SmsTimelineMessage {
  sentAt: string; direction: string; status: string | null;
  statusKind: "received" | "pending" | "failed" | "delivered" | "unconfirmed";
  source: string | null; messageType: string | null; sender: string | null;
}

/** Bars from fewer people than this are marked as a small sample. */
export const SMALL_SAMPLE = 20;

/**
 * The report's query string: the period (or ?period=ALL), the comparison
 * window, and one repeated param per filter value (tags can contain commas).
 */
export function smsQuery(o: { allTime: boolean; range: { from: string; to: string }; cmp: { from: string; to: string } | null; filters: SmsFilters }): string {
  const qs = new URLSearchParams();
  if (o.allTime) qs.set("period", ALL_PERIOD);
  else { qs.set("from", o.range.from); qs.set("to", o.range.to); }
  if (o.cmp && !o.allTime) { qs.set("compareFrom", o.cmp.from); qs.set("compareTo", o.cmp.to); }
  for (const k of ["senders", "tags", "sources"] as const) for (const v of o.filters[k]) qs.append(k, v);
  return qs.toString();
}

/** Replace one filter dimension (a breakdown row drills into just that row). */
export function withFilter(filters: SmsFilters, dim: keyof SmsFilters, key: string): SmsFilters {
  return { ...filters, [dim]: [key] };
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
  INBOUND_FIRST: "Texted us first",
  NOT_REACHED: "Never reached",
};
export const OUTCOME_HINT: Record<string, string> = {
  LATE_REPLY: "Replied after the response window had closed",
  NOT_REACHED: "Every text to this number failed",
  INBOUND_FIRST: "They texted before any outreach text — not counted in response rates",
};
export const outcomeLabel = (o: string | null | undefined) => (o ? OUTCOME_LABEL[o] ?? o : "—");

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
