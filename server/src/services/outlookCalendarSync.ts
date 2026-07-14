/**
 * Outlook Calendar sync — mirrors deal deadlines to the connected calendar.
 *
 * Each sync (manual "Sync now" or the hourly/daily scheduler) walks the org's
 * ACTIVE deals, resolves their effective deadlines (domain/dates.ts), and
 * upserts one all-day event per (deal, deadline kind) via Microsoft Graph.
 * The dealId:kind → {eventId, date} map lives in the integration's config
 * JSON, so date changes PATCH the existing event and deals that close or die
 * get their events deleted — the calendar always reflects the pipeline.
 */
import type { Integration, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { getFreshAccessToken } from "./integrationOAuth.js";
import { resolveDealDates } from "../domain/dates.js";
import { TERMINAL_STAGE_KEYS } from "../domain/stages.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_EVENTS = 300; // hard ceiling per org — a calendar, not a data dump

export interface DeadlineEvent {
  key: string; // `${dealId}:${kind}`
  subject: string;
  /** yyyy-mm-dd (all-day event on this date). */
  date: string;
  link: string;
}

interface EventMapEntry { id: string; date: string }
type EventMap = Record<string, EventMapEntry>;

const KINDS: { kind: string; label: string; pick: (d: ReturnType<typeof resolveDealDates>) => Date | null }[] = [
  { kind: "findBuyerBy", label: "Find buyer by", pick: (d) => d.findBuyerByDate },
  { kind: "originalClosing", label: "Original closing", pick: (d) => d.originalClosingDate },
  { kind: "finalClosing", label: "Final closing", pick: (d) => d.finalClosingDate },
];

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Pure planner: active deals → the deadline events that should exist. Exported for tests. */
export function planDeadlineEvents(
  deals: {
    id: string; name: string; dateUnderContract: Date | null; originalClosingDate: Date | null;
    findBuyerByDateOverride: Date | null; finalClosingDateOverride: Date | null;
  }[],
): DeadlineEvent[] {
  const out: DeadlineEvent[] = [];
  for (const deal of deals) {
    const resolved = resolveDealDates(deal);
    for (const { kind, label, pick } of KINDS) {
      const date = pick(resolved);
      if (!date) continue;
      out.push({
        key: `${deal.id}:${kind}`,
        subject: `${deal.name} — ${label} (Mineral Hub)`,
        date: isoDay(date),
        link: `/deals/${deal.id}`,
      });
    }
  }
  return out.slice(0, MAX_EVENTS);
}

async function graphRequest(token: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404 && method === "DELETE") return {}; // already gone — fine
  const json = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, unknown>);
  if (!res.ok) {
    const err = (json.error ?? {}) as { message?: string };
    throw new Error(`Calendar API returned ${res.status}${err.message ? `: ${err.message}` : ""}`);
  }
  return json;
}

function eventBody(e: DeadlineEvent, appUrl: string) {
  // All-day events: end is the exclusive next day.
  const end = new Date(`${e.date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    subject: e.subject,
    isAllDay: true,
    start: { dateTime: `${e.date}T00:00:00`, timeZone: "UTC" },
    end: { dateTime: `${isoDay(end)}T00:00:00`, timeZone: "UTC" },
    isReminderOn: true,
    body: { contentType: "text", content: `Deal deadline tracked by Mineral Hub: ${appUrl}${e.link}` },
  };
}

export interface CalendarSyncResult { created: number; updated: number; removed: number }

/** Reconcile the connected calendar with current deal deadlines. */
export async function syncOutlookCalendar(row: Integration, appUrl: string): Promise<CalendarSyncResult> {
  const token = await getFreshAccessToken(row);

  const deals = await prisma.deal.findMany({
    where: { organizationId: row.organizationId, stage: { notIn: [...TERMINAL_STAGE_KEYS] } },
    select: {
      id: true, name: true, dateUnderContract: true, originalClosingDate: true,
      findBuyerByDateOverride: true, finalClosingDateOverride: true,
    },
  });
  const wanted = planDeadlineEvents(deals);
  const wantedByKey = new Map(wanted.map((e) => [e.key, e]));

  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const map: EventMap = (cfg.eventMap as EventMap | undefined) ?? {};
  const nextMap: EventMap = {};
  const result: CalendarSyncResult = { created: 0, updated: 0, removed: 0 };

  // Delete events whose deal/deadline no longer exists (closed, dead, cleared).
  for (const [key, entry] of Object.entries(map)) {
    if (wantedByKey.has(key)) continue;
    await graphRequest(token, "DELETE", `/me/events/${encodeURIComponent(entry.id)}`).catch(() => {});
    result.removed++;
  }

  for (const e of wanted) {
    const existing = map[e.key];
    if (!existing) {
      const created = await graphRequest(token, "POST", "/me/events", eventBody(e, appUrl));
      nextMap[e.key] = { id: String(created.id), date: e.date };
      result.created++;
    } else if (existing.date !== e.date) {
      try {
        await graphRequest(token, "PATCH", `/me/events/${encodeURIComponent(existing.id)}`, eventBody(e, appUrl));
        nextMap[e.key] = { id: existing.id, date: e.date };
        result.updated++;
      } catch {
        // Event was deleted by hand — recreate it.
        const created = await graphRequest(token, "POST", "/me/events", eventBody(e, appUrl));
        nextMap[e.key] = { id: String(created.id), date: e.date };
        result.created++;
      }
    } else {
      nextMap[e.key] = existing;
    }
  }

  // Merge-preserve config: it also carries the encrypted token bundle.
  const latest = await prisma.integration.findUnique({ where: { id: row.id }, select: { config: true } });
  const merged = { ...((latest?.config ?? {}) as Record<string, unknown>), eventMap: nextMap };
  await prisma.integration.update({ where: { id: row.id }, data: { config: merged as unknown as Prisma.InputJsonValue } });

  return result;
}
