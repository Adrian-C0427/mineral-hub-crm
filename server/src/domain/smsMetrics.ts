/**
 * SMS outreach metrics — the single definition of what "reached", "responded"
 * and "response after text #n" mean. The HighLevel sync stores one summary per
 * contact (summarizeContact) and Reports aggregates those summaries, so every
 * screen counts the same way.
 *
 * Definitions (shown to users in Reports → SMS performance):
 *  - Reached: an outbound text HighLevel reports as delivered (delivered /
 *    read / opened / clicked). A text still marked "sent" — no delivery
 *    receipt either way — also counts as reached, and Reports discloses how
 *    many reached texts were unconfirmed. Failed / undelivered texts never
 *    count; scheduled / queued / pending texts don't count until they go out.
 *  - Touch n: the contact's n-th REACHED outbound text.
 *  - The outreach sequence ends at the contact's first inbound text. That
 *    reply is:
 *      RESPONDED  — not an opt-out, and within the response window (default
 *                   30 days) of the most recent reached text;
 *      OPTED_OUT  — an opt-out request (STOP, UNSUBSCRIBE, …), which never
 *                   counts as a response;
 *      LATE_REPLY — arrived after the window closed.
 *    A contact with reached texts and no reply is NO_REPLY; one who texted
 *    first is INBOUND_FIRST and is left out of outreach response rates; one
 *    whose every text failed is NOT_REACHED.
 *  - One person, one response: later replies never add to a count.
 *  - Response cohort: a contact belongs to the period of their FIRST reached
 *    text (firstOutboundAt), so a November reply to an October text counts
 *    for October.
 */

export const DEFAULT_RESPONSE_WINDOW_DAYS = 30;
export const RESPONSE_WINDOW_OPTIONS = [7, 14, 30, 60, 90] as const;
/** Touches shown individually; later ones roll into one "n+1 or later" bucket. */
export const TOUCH_BUCKETS = 5;

export type SmsOutcome = "RESPONDED" | "OPTED_OUT" | "LATE_REPLY" | "NO_REPLY" | "INBOUND_FIRST" | "NOT_REACHED";

const DELIVERED = new Set(["delivered", "read", "opened", "clicked"]);
const PENDING = new Set(["pending", "scheduled", "queued"]);
const FAILED = new Set(["failed", "undelivered", "opt_out"]);

const norm = (status: string | null | undefined) => (status ?? "").trim().toLowerCase();

/** A delivery receipt confirmed the text reached the handset. */
export const isDeliveredStatus = (s: string | null | undefined) => DELIVERED.has(norm(s));
/** Not sent yet (scheduled, queued, pending). */
export const isPendingStatus = (s: string | null | undefined) => PENDING.has(norm(s));
/** Sent but rejected / undeliverable. */
export const isFailedStatus = (s: string | null | undefined) => FAILED.has(norm(s));
/** Went out (any final or unconfirmed state) — what "texts sent" counts. */
export const isSentStatus = (s: string | null | undefined) => !isPendingStatus(s);
/** Counts as reaching the contact: delivered, or sent without a receipt. */
export const isReachedStatus = (s: string | null | undefined) => isSentStatus(s) && !isFailedStatus(s);
/** Reached without a delivery receipt (disclosed in Reports). */
export const isUnconfirmedStatus = (s: string | null | undefined) => isReachedStatus(s) && !isDeliveredStatus(s);

// Opt-out requests. Carrier keywords as the whole message, plus the common
// written forms. "Not interested" is a reply, not an opt-out.
const OPT_OUT_WORDS = new Set([
  "stop", "stopall", "stop all", "unsubscribe", "unsub", "cancel", "end", "quit", "optout", "opt out", "revoke",
  "remove", "remove me",
]);
const OPT_OUT_PHRASES = [
  "stop texting", "stop messaging", "stop contacting", "stop sending", "remove me", "take me off", "opt me out",
  "do not text", "dont text", "do not contact", "dont contact", "do not message", "dont message", "unsubscribe",
  "lose my number", "delete my number",
];

/** True when an inbound text asks to stop receiving texts. */
export function isOptOutReply(body: string | null | undefined): boolean {
  if (!body) return false;
  const t = body.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (OPT_OUT_WORDS.has(t)) return true;
  if (/^stop\b/.test(t) && t.split(" ").length <= 6) return true; // "Stop", "STOP please", "stop texting me"
  return OPT_OUT_PHRASES.some((p) => t.includes(p));
}

export interface SmsMessageInput {
  direction: string; // "inbound" | "outbound"
  status: string | null;
  sentAt: Date;
  hlUserId: string | null;
  optOut: boolean;
}

export interface ContactSummary {
  firstOutboundAt: Date | null;
  touches: number;
  unconfirmedTouches: number;
  outcome: SmsOutcome | null;
  outcomeAt: Date | null;
  responseSeconds: number | null;
  creditedHlUserId: string | null;
  outboundTotal: number;
  inboundTotal: number;
  lastMessageAt: Date | null;
}

const DAY_MS = 86_400_000;

/**
 * One contact's outreach summary from their full SMS history (any order).
 * Pure: the same messages and window always give the same summary.
 */
export function summarizeContact(messages: readonly SmsMessageInput[], windowDays = DEFAULT_RESPONSE_WINDOW_DAYS): ContactSummary {
  // Chronological; on a timestamp tie the outbound text goes first (a reply
  // can't precede the text it answers).
  const msgs = [...messages].sort((a, b) =>
    a.sentAt.getTime() - b.sentAt.getTime() || (a.direction === "outbound" ? -1 : 0) - (b.direction === "outbound" ? -1 : 0));
  const out: ContactSummary = {
    firstOutboundAt: null, touches: 0, unconfirmedTouches: 0, outcome: null, outcomeAt: null,
    responseSeconds: null, creditedHlUserId: null, outboundTotal: 0, inboundTotal: 0,
    lastMessageAt: msgs.length ? msgs[msgs.length - 1].sentAt : null,
  };
  for (const m of msgs) {
    if (m.direction === "outbound") { if (isSentStatus(m.status)) out.outboundTotal++; }
    else if (m.direction === "inbound") out.inboundTotal++;
  }

  let lastTouchAt: Date | null = null;
  let anySent = false;
  // Texts marked failed before any reply: if the person replies anyway, the
  // failure receipt was wrong and those texts did reach them.
  const failedBefore: SmsMessageInput[] = [];
  for (const m of msgs) {
    if (m.direction === "outbound") {
      if (!isSentStatus(m.status)) continue; // not sent yet
      anySent = true;
      if (isFailedStatus(m.status)) { failedBefore.push(m); continue; }
      if (out.touches === 0) { out.firstOutboundAt = m.sentAt; out.creditedHlUserId = m.hlUserId ?? null; }
      out.touches++;
      if (isUnconfirmedStatus(m.status)) out.unconfirmedTouches++;
      lastTouchAt = m.sentAt;
      continue;
    }
    if (m.direction !== "inbound") continue;
    if (out.touches === 0 && failedBefore.length) {
      // Promote the "failed" texts to unconfirmed touches (see above).
      out.firstOutboundAt = failedBefore[0].sentAt;
      out.creditedHlUserId = failedBefore[0].hlUserId ?? null;
      out.touches = failedBefore.length;
      out.unconfirmedTouches = failedBefore.length;
      lastTouchAt = failedBefore[failedBefore.length - 1].sentAt;
    }
    if (out.touches === 0 || !lastTouchAt || !out.firstOutboundAt) {
      out.outcome = "INBOUND_FIRST";
      out.outcomeAt = m.sentAt;
      return out;
    }
    out.outcomeAt = m.sentAt;
    if (m.optOut) out.outcome = "OPTED_OUT";
    else if (m.sentAt.getTime() - lastTouchAt.getTime() <= windowDays * DAY_MS) {
      out.outcome = "RESPONDED";
      out.responseSeconds = Math.max(0, Math.round((m.sentAt.getTime() - out.firstOutboundAt.getTime()) / 1000));
    } else out.outcome = "LATE_REPLY";
    return out;
  }
  out.outcome = out.touches > 0 ? "NO_REPLY" : anySent ? "NOT_REACHED" : null;
  return out;
}

/** Aggregated cohort rows: how many contacts ended with `outcome` after `touches` reached texts. */
export interface TouchOutcomeCount { touches: number; outcome: string | null; count: number }

export interface TouchRate {
  /** 1..TOUCH_BUCKETS, then TOUCH_BUCKETS + 1 for "that many or later". */
  touch: number;
  orLater: boolean;
  /** Contacts who received this text before replying or opting out. */
  received: number;
  /** Of those, contacts whose FIRST response came after this text. */
  responded: number;
  /** responded ÷ received; null when nobody received it. */
  rate: number | null;
  /** Contacts who had responded by this text, all touches so far. */
  cumulativeResponded: number;
  /** cumulativeResponded ÷ contacts reached (the whole cohort); null when empty. */
  cumulativeRate: number | null;
}

/**
 * Response after text #n vs cumulative response rate, from cohort counts.
 *  - rate(n) = first responded after text n ÷ received text n without having
 *    responded or opted out before it.
 *  - cumulativeRate(n) = responded by text n ÷ everyone reached.
 */
export function touchRates(rows: readonly TouchOutcomeCount[], buckets = TOUCH_BUCKETS): TouchRate[] {
  const cohort = rows.reduce((s, r) => (r.touches >= 1 ? s + r.count : s), 0);
  const result: TouchRate[] = [];
  let cumulative = 0;
  for (let n = 1; n <= buckets + 1; n++) {
    const orLater = n === buckets + 1;
    const received = rows.reduce((s, r) => (r.touches >= n ? s + r.count : s), 0);
    const responded = rows.reduce((s, r) =>
      (r.outcome === "RESPONDED" && (orLater ? r.touches >= n : r.touches === n) ? s + r.count : s), 0);
    cumulative += responded;
    result.push({
      touch: n, orLater, received, responded,
      rate: received ? responded / received : null,
      cumulativeResponded: cumulative,
      cumulativeRate: cohort ? cumulative / cohort : null,
    });
  }
  return result;
}

/** a ÷ b, or null (shown as N/A) when b is 0. */
export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
