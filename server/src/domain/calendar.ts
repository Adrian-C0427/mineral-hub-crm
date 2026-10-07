import { resolveDealDates, type DealDateInputs } from "./dates.js";

/**
 * Calendar — the pure parts (no database): day keys, the requested range, the
 * starter types, and the mapping of deals / buyer follow-ups / tasks into the
 * read-only entries shown next to hand-entered events.
 *
 * Every date here is a CALENDAR DAY. Days are stored at UTC midnight and are
 * only ever parsed and formatted in UTC, so an entry never slides onto the
 * neighbouring day (the same convention as task due dates and deal dates).
 */

export const CALENDAR_MAX_RANGE_DAYS = 400;

const MS_PER_DAY = 86_400_000;

/** "YYYY-MM-DD" → UTC midnight, or null. Rejects impossible days (Feb 31) and
 *  absurd-but-parseable years (0202). */
export function parseDayKey(v: unknown): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2100) return null;
  return d.toISOString().slice(0, 10) === v ? d : null;
}

/** Date → "YYYY-MM-DD" (UTC). */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type CalendarRange =
  | { ok: true; from: Date; /** Exclusive upper bound: the day after `to`. */ endExclusive: Date; fromKey: string; toKey: string }
  | { ok: false; error: string };

/** Validate ?from=&to= (both inclusive, at most CALENDAR_MAX_RANGE_DAYS days). */
export function parseCalendarRange(fromRaw: unknown, toRaw: unknown): CalendarRange {
  const from = parseDayKey(fromRaw);
  const to = parseDayKey(toRaw);
  if (!from || !to) return { ok: false, error: "from and to must be dates in YYYY-MM-DD format" };
  if (to.getTime() < from.getTime()) return { ok: false, error: "to must be on or after from" };
  const days = Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1;
  if (days > CALENDAR_MAX_RANGE_DAYS) return { ok: false, error: `Date range cannot exceed ${CALENDAR_MAX_RANGE_DAYS} days` };
  return { ok: true, from, endExclusive: new Date(to.getTime() + MS_PER_DAY), fromKey: dayKey(from), toKey: dayKey(to) };
}

/** Is a "YYYY-MM-DD" key inside an inclusive key range? (Keys sort as text.) */
export function dayKeyInRange(key: string, fromKey: string, toKey: string): boolean {
  return key >= fromKey && key <= toKey;
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** The types every organization starts with, in display order. `systemKey`
 *  ties the read-only entries to a type so they keep its colour after a rename. */
export const STARTER_TYPES: ReadonlyArray<{ name: string; color: string; systemKey: string | null }> = [
  { name: "Closing", color: "#22C55E", systemKey: "closing" },
  { name: "Contract deadline", color: "#EF4444", systemKey: null },
  { name: "Follow-up", color: "#3B82F6", systemKey: "follow" },
  { name: "Title & diligence", color: "#A855F7", systemKey: null },
  { name: "Option expiry", color: "#F97316", systemKey: null },
];

/** Colours offered for a new type; the first one not already in use is picked. */
export const TYPE_PALETTE = ["#22C55E", "#EF4444", "#3B82F6", "#A855F7", "#F59E0B", "#F97316", "#14B8A6", "#EC4899"] as const;

export function nextTypeColor(usedColors: string[]): string {
  const used = new Set(usedColors.map((c) => c.toUpperCase()));
  return TYPE_PALETTE.find((c) => !used.has(c)) ?? TYPE_PALETTE[usedColors.length % TYPE_PALETTE.length];
}

/**
 * Time rules for a hand-entered event (checked on the final, merged values):
 * an all-day event carries no times; otherwise a start is required and an end,
 * when given, must be after it. Returns an error message, or null when valid.
 */
export function eventTimeError(e: { allDay: boolean; start: string | null; end: string | null }): string | null {
  if (e.allDay) return null;
  if (!e.start) return "A start time is required unless the event is all day";
  if (e.end && e.end <= e.start) return "End time must be after the start time";
  return null;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export type CalSource = "event" | "closing" | "followup" | "task" | "reminder";
export interface CalLink { kind: "deal" | "buyer" | "contact"; id: string; label: string }
export interface CalPerson { id: string; name: string }
export interface CalEntry {
  id: string;
  source: CalSource;
  readOnly: boolean;
  title: string;
  typeId: string | null;
  date: string;
  allDay: boolean;
  start: string | null;
  end: string | null;
  link: CalLink | null;
  assignee: CalPerson | null;
  notes: string | null;
  done: boolean;
  href: string | null;
}

export interface EventRow {
  id: string; title: string; typeId: string | null; date: Date; allDay: boolean;
  startTime: string | null; endTime: string | null; notes: string | null; completedAt: Date | null;
  deal: { id: string; name: string } | null;
  buyer: { id: string; name: string } | null;
  assignedTo: CalPerson | null;
}

/** Which linked records the caller may see by name ("View deals" / "View buyers"). */
export interface LinkVisibility { deals: boolean; buyers: boolean }
const SEE_ALL: LinkVisibility = { deals: true, buyers: true };

/**
 * A hand-entered CalendarEvent row. Every org member reads the calendar, so a
 * deal or buyer link is dropped for a caller who cannot see that kind of
 * record — otherwise an event would hand them a name the Deals or Buyers page
 * withholds. The event itself still shows.
 */
export function eventEntry(e: EventRow, can: LinkVisibility = SEE_ALL): CalEntry {
  const deal = can.deals ? e.deal : null;
  const buyer = can.buyers ? e.buyer : null;
  return {
    id: e.id,
    source: "event",
    readOnly: false,
    title: e.title,
    typeId: e.typeId,
    date: dayKey(e.date),
    allDay: e.allDay,
    start: e.allDay ? null : e.startTime,
    end: e.allDay ? null : e.endTime,
    link: deal ? { kind: "deal", id: deal.id, label: deal.name } : buyer ? { kind: "buyer", id: buyer.id, label: buyer.name } : null,
    assignee: e.assignedTo ? { id: e.assignedTo.id, name: e.assignedTo.name } : null,
    notes: e.notes,
    done: e.completedAt != null,
    href: null,
  };
}

const derived = (p: Pick<CalEntry, "id" | "source" | "title" | "typeId" | "date" | "link" | "assignee" | "notes" | "done" | "href">): CalEntry => ({
  ...p, readOnly: true, allDay: true, start: null, end: null,
});

export interface ClosingDealRow extends DealDateInputs {
  id: string; name: string; stage: string;
  /** Manual "Closing with buyer" date; absent/null = no buyer-closing entry. */
  buyerClosingDate?: Date | null;
}

/**
 * A deal's closing entries.
 *  - "Closing": the Closing date exactly as entered on the deal
 *    (originalClosingDate). Never a calculated, extended or stage-move date.
 *  - "Extended closing": ONLY when the user explicitly extended the closing
 *    (the Extend action — or a hand-set final date — stores
 *    finalClosingDateOverride). The auto "Closing + 15 days" that
 *    resolveDealDates derives for every dated deal is NOT an extension and
 *    is never shown here. The date itself still comes from resolveDealDates
 *    (the same value the deal page shows), never re-derived.
 *  - "Closing with buyer": the manual buyer-side date, when set.
 * Dead deals yield nothing.
 */
export function closingEntries(deal: ClosingDealRow, closingTypeId: string | null): CalEntry[] {
  if (deal.stage === "DEAD") return [];
  const closingKey = deal.originalClosingDate ? dayKey(deal.originalClosingDate) : null;
  const extended = deal.finalClosingDateOverride != null;
  const { finalClosingDate } = resolveDealDates(deal);
  const extendedKey = extended && finalClosingDate ? dayKey(finalClosingDate) : null;
  const buyerKey = deal.buyerClosingDate ? dayKey(deal.buyerClosingDate) : null;
  const base = {
    source: "closing" as const, typeId: closingTypeId, assignee: null, notes: null,
    link: { kind: "deal" as const, id: deal.id, label: deal.name },
    done: deal.stage === "CLOSED",
    href: `/deals/${deal.id}`,
  };
  const out: CalEntry[] = [];
  if (closingKey) out.push(derived({ ...base, id: `closing:${deal.id}:closing`, title: `Closing — ${deal.name}`, date: closingKey }));
  if (extendedKey) out.push(derived({ ...base, id: `closing:${deal.id}:extended`, title: `Extended closing — ${deal.name}`, date: extendedKey }));
  if (buyerKey) out.push(derived({ ...base, id: `closing:${deal.id}:buyer`, title: `Closing with buyer — ${deal.name}`, date: buyerKey }));
  return out;
}

export interface FollowUpRow {
  id: string; nextFollowUpDate: Date | null; notes?: string | null;
  deal: { id: string; name: string; stage: string };
  buyer: { name: string };
  assignedTeamMember: CalPerson | null;
}

/** A buyer follow-up on a deal that is still open (not Closed / Dead). */
export function followUpEntry(a: FollowUpRow, followTypeId: string | null): CalEntry | null {
  if (!a.nextFollowUpDate || a.deal.stage === "CLOSED" || a.deal.stage === "DEAD") return null;
  return derived({
    id: `followup:${a.id}`,
    source: "followup",
    title: `Follow up — ${a.buyer.name}`,
    typeId: followTypeId,
    date: dayKey(a.nextFollowUpDate),
    link: { kind: "deal", id: a.deal.id, label: a.deal.name },
    assignee: a.assignedTeamMember ? { id: a.assignedTeamMember.id, name: a.assignedTeamMember.name } : null,
    notes: null,
    done: false,
    href: `/deals/${a.deal.id}`,
  });
}

export interface TaskRow {
  id: string; kind: string; title: string | null; body: string; dueDate: Date | null; completedAt: Date | null;
  assignedTo: CalPerson | null;
  contact: { id: string; firstName: string | null; lastName: string | null; entityName: string | null } | null;
}

/** An open contact task / reminder (or a standalone Dashboard task) with a due date. */
export function taskEntry(t: TaskRow, followTypeId: string | null): CalEntry | null {
  if (!t.dueDate || t.completedAt || (t.kind !== "TASK" && t.kind !== "REMINDER")) return null;
  const reminder = t.kind === "REMINDER";
  // Same naming as the Tasks widget: the title doubles as the body when no details were given.
  const title = t.title ?? t.body;
  const contactName = t.contact ? [t.contact.firstName, t.contact.lastName].filter(Boolean).join(" ") || t.contact.entityName || "Contact" : null;
  return derived({
    id: `${reminder ? "reminder" : "task"}:${t.id}`,
    source: reminder ? "reminder" : "task",
    title,
    typeId: followTypeId,
    date: dayKey(t.dueDate),
    link: t.contact ? { kind: "contact", id: t.contact.id, label: contactName! } : null,
    assignee: t.assignedTo ? { id: t.assignedTo.id, name: t.assignedTo.name } : null,
    notes: t.title && t.body && t.body !== t.title ? t.body : null,
    done: false,
    // A contact task opens on the contact's workspace; a standalone one on the Dashboard.
    href: t.contact ? `/contacts/${t.contact.id}?task=${t.id}` : `/?task=${t.id}`,
  });
}

/** Day, then all-day first, then start time, then title. */
export function sortEntries(entries: CalEntry[]): CalEntry[] {
  return [...entries].sort(
    (a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || (a.start ?? "").localeCompare(b.start ?? "") || a.title.localeCompare(b.title),
  );
}
