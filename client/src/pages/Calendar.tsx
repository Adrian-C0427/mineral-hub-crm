import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { Modal, showToast } from "../components/ui";
import { Segmented } from "../components/kit";
import { Select, type SelectOption } from "../components/Select";
import { DateField } from "../components/DateField";
import { useAuth } from "../auth/AuthContext";
import { useIsPhonePortrait } from "../lib/mobile";

/* ------------------------------------------------------------------ types --
 * The /calendar contract. Hand-entered events are editable; closings,
 * follow-ups, tasks and reminders arrive read-only with an in-app `href`. */
interface CalType { id: string; name: string; color: string; sortOrder: number; systemKey: string | null; eventCount: number }
interface CalEvent {
  id: string;
  source: "event" | "closing" | "followup" | "task" | "reminder";
  readOnly: boolean;
  title: string;
  typeId: string | null;
  date: string;
  allDay: boolean;
  start: string | null;
  end: string | null;
  link: { kind: "deal" | "buyer" | "contact"; id: string; label: string } | null;
  assignee: { id: string; name: string } | null;
  notes: string | null;
  done: boolean;
  href: string | null;
}
interface CalData { types: CalType[]; events: CalEvent[] }
type View = "month" | "week" | "agenda";
/** An event plus everything the views print for it. */
interface Ev extends CalEvent { typeName: string; color: string; t: string; when: string; sub: string }
interface FormState {
  id: string | null; title: string; typeId: string | null; date: string; start: string; end: string;
  allDay: boolean; link: string; who: string; notes: string;
}
interface Named { id: string; name: string }
interface People { deals: Named[]; buyers: Named[]; users: Named[] }
type TypeEdit = { mode: "edit"; id: string; value: string } | { mode: "add"; value: string } | { mode: "color"; id: string } | null;

const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MS = MON.map((m) => m.slice(0, 3));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PALETTE = ["#22C55E", "#EF4444", "#3B82F6", "#A855F7", "#F59E0B", "#F97316", "#14B8A6", "#EC4899"];
const VIEWS: { value: View; label: string }[] = [{ value: "month", label: "Month" }, { value: "week", label: "Week" }, { value: "agenda", label: "Agenda" }];
/** Events without a type (or whose type was removed) print as neutral "Other". */
const OTHER_COLOR = "var(--ink-3)";
const PX = 52; // week view: pixels per hour

// Calendar days are plain local dates and "YYYY-MM-DD" keys — never parsed as
// UTC instants, so a day cannot shift across timezones.
const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k: string) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => keyOf(a) === keyOf(b);
const dayDiff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 864e5);
const mins = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
function fmtT(t: string | null): string {
  if (!t) return "All day";
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}${m ? ":" + pad(m) : ""}${h >= 12 ? "p" : "a"}`;
}
const timeRange = (e: CalEvent) => (e.allDay || !e.start ? "All day" : fmtT(e.start) + (e.end ? " – " + fmtT(e.end) : ""));
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const plural = (n: number) => `${n} event${n === 1 ? "" : "s"}`;
const errText = (e: unknown) => (e instanceof ApiError && e.message ? e.message : "Something went wrong. Please try again.");
/** Event-type colours are data: pass them to CSS, which derives the tints. */
const tint = (color: string) => ({ "--c": color }) as CSSProperties;

/** "Deadlines ahead" lists hard dates: closings plus any type named as a
 *  deadline, expiry or due date (the starter Contract deadline / Option expiry). */
const isDeadlineType = (t: CalType | undefined) => !!t && (t.systemKey === "closing" || /deadline|expir|clos|\bdue\b/i.test(t.name));

const SOURCE_NOTE: Record<CalEvent["source"], string> = {
  event: "", closing: "From deal · closing date", followup: "From deal · buyer follow-up", task: "From tasks", reminder: "From reminders",
};

const Ico = ({ d, s = 14, w = 2 }: { d: string; s?: number; w?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I_PREV = "M15 6l-6 6 6 6", I_NEXT = "M9 6l6 6-6 6", I_PLUS = "M12 5v14M5 12h14", I_X = "M6 6l12 12M18 6L6 18";
const I_SLIDERS = "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4";

/** One inclusive date range from the API. Keeps the last answer on screen
 *  while the next one loads; `enabled: false` skips the request entirely. */
function useCalRange(from: string, to: string, nonce: number, enabled = true, announce = false): CalData | null {
  const [data, setData] = useState<CalData | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.get<CalData>(`/calendar?from=${from}&to=${to}`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live && announce) showToast(e instanceof ApiError && e.message ? e.message : "Could not load the calendar.", "error"); });
    return () => { live = false; };
  }, [from, to, nonce, enabled, announce]);
  return enabled ? data : null;
}

export function Calendar() {
  const { can, user } = useAuth();
  const phone = useIsPhonePortrait();
  const canEdit = can("editDeals");
  const canTypes = can("manageOrgSettings");

  const today = useMemo(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }, []);
  const [view, setView] = useState<View>("month");
  const [cur, setCur] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [sel, setSel] = useState(today);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [typesOpen, setTypesOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [people, setPeople] = useState<People | null>(null);
  const peopleAsked = useRef(false);

  // Week view "now" line follows the clock.
  const [nowMin, setNowMin] = useState(() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); });
  useEffect(() => {
    const id = window.setInterval(() => { const n = new Date(); setNowMin(n.getHours() * 60 + n.getMinutes()); }, 60000);
    return () => window.clearInterval(id);
  }, []);

  const isMonth = view === "month", isWeek = view === "week", isAgenda = view === "agenda";
  const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  const rows = Math.ceil((first.getDay() + new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate()) / 7);
  const weekStart = addDays(cur, -cur.getDay());
  const weekEnd = addDays(weekStart, 6);

  // Visible range (the month grid asks for its full six-week window), the week
  // after the selected day when that falls outside it, and the next 30 days.
  const vFrom = keyOf(isMonth ? gridStart : isWeek ? weekStart : cur);
  const vTo = keyOf(isMonth ? addDays(gridStart, 41) : isWeek ? weekEnd : addDays(cur, 13));
  const sFrom = keyOf(sel), sTo = keyOf(addDays(sel, 7));
  const main = useCalRange(vFrom, vTo, nonce, true, true);
  const around = useCalRange(sFrom, sTo, nonce, sFrom < vFrom || sTo > vTo);
  const ahead = useCalRange(keyOf(today), keyOf(addDays(today, 30)), nonce);

  const types = useMemo(
    () => [...((main || ahead)?.types ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [main, ahead],
  );
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t] as const)), [types]);
  const events = useMemo(() => {
    const m = new Map<string, CalEvent>();
    [ahead, around, main].forEach((d) => d?.events.forEach((e) => m.set(e.id, e)));
    return Array.from(m.values());
  }, [main, around, ahead]);

  const deco = (e: CalEvent): Ev => {
    const t = e.typeId ? typeById.get(e.typeId) : undefined;
    const typeName = t ? t.name : "Other";
    return {
      ...e, typeName, color: t ? t.color : OTHER_COLOR, t: e.allDay ? "All day" : fmtT(e.start), when: timeRange(e),
      sub: [e.link?.label, e.assignee?.name].filter(Boolean).join(" · ") || typeName,
    };
  };

  const byDay = useMemo(() => {
    const out: Record<string, CalEvent[]> = {};
    events
      .filter((e) => !(e.typeId && hidden[e.typeId]))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.start || "").localeCompare(b.start || "") || a.title.localeCompare(b.title))
      .forEach((e) => { (out[e.date] = out[e.date] || []).push(e); });
    return out;
  }, [events, hidden]);
  const dayEvents = (d: Date) => (byDay[keyOf(d)] || []).map(deco);

  /* ------------------------------------------------------------ navigation */
  let rangeLabel = `${MON[cur.getMonth()]} ${cur.getFullYear()}`;
  if (isWeek) {
    rangeLabel = `${MS[weekStart.getMonth()]} ${weekStart.getDate()} – ${weekStart.getMonth() !== weekEnd.getMonth() ? MS[weekEnd.getMonth()] + " " : ""}${weekEnd.getDate()}`
      + (phone ? "" : `, ${weekEnd.getFullYear()}`);
  }
  if (isAgenda) {
    const e2 = addDays(cur, 13);
    rangeLabel = `${MS[cur.getMonth()]} ${cur.getDate()} – ${phone && e2.getMonth() === cur.getMonth() ? "" : MS[e2.getMonth()] + " "}${e2.getDate()}`;
  }
  const step = (dir: number) => setCur(isMonth ? new Date(cur.getFullYear(), cur.getMonth() + dir, 1) : addDays(cur, (isWeek ? 7 : 14) * dir));
  const goToday = () => { setCur(isMonth ? new Date(today.getFullYear(), today.getMonth(), 1) : today); setSel(today); };
  const pickView = (v: View) => { setView(v); setCur(v === "month" ? new Date(sel.getFullYear(), sel.getMonth(), 1) : sel); };

  /* ------------------------------------------------------------- view data */
  const cells = Array.from({ length: rows * 7 }, (_, i) => {
    const d = addDays(gridStart, i);
    return { d, key: keyOf(d), evs: dayEvents(d), inMonth: d.getMonth() === cur.getMonth(), isToday: sameDay(d, today), isSel: sameDay(d, sel), last: i % 7 === 6 };
  });

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(weekStart, i), evs = dayEvents(d);
    return { d, key: keyOf(d), dow: DOW[i], isToday: sameDay(d, today), isSel: sameDay(d, sel), evs, allDay: evs.filter((e) => e.allDay || !e.start), timed: evs.filter((e) => !e.allDay && !!e.start) };
  });
  // 7a–7p as designed; the grid grows only when an event falls outside it.
  let H0 = 7, H1 = 19;
  weekDays.forEach((wd) => wd.timed.forEach((e) => {
    const s = mins(e.start!), en = e.end ? mins(e.end) : s + 60;
    H0 = Math.min(H0, Math.floor(s / 60)); H1 = Math.min(24, Math.max(H1, Math.ceil(en / 60)));
  }));
  const hours = Array.from({ length: H1 - H0 + 1 }, (_, i) => ({ label: fmtT(`${pad(H0 + i)}:00`), top: i * PX }));
  const gridH = (H1 - H0) * PX;
  const nowTop = nowMin >= H0 * 60 && nowMin <= H1 * 60 ? ((nowMin - H0 * 60) / 60) * PX : null;

  const agendaDays = Array.from({ length: 14 }, (_, i) => addDays(cur, i))
    .map((d) => ({ d, key: keyOf(d), evs: dayEvents(d), isToday: sameDay(d, today) }))
    .filter((x) => x.evs.length > 0);

  const selEvents = dayEvents(sel);
  const selIsToday = sameDay(sel, today);
  const selLabel = selIsToday ? "Today" : `${DOW[sel.getDay()]}, ${MS[sel.getMonth()]} ${sel.getDate()}`;
  const selFull = `${DOW[sel.getDay()]}, ${MON[sel.getMonth()]} ${sel.getDate()}`;
  const selSub = selEvents.length ? plural(selEvents.length) : selIsToday ? `${MON[sel.getMonth()]} ${sel.getDate()}` : "Nothing scheduled";
  const weekAhead: (Ev & { day: string })[] = [];
  for (let i = 1; i <= 7 && weekAhead.length < 4; i++) {
    const d = addDays(sel, i);
    dayEvents(d).forEach((e) => { if (weekAhead.length < 4) weekAhead.push({ ...e, day: d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" }) }); });
  }
  const deadlines = events
    .filter((e) => !e.done && isDeadlineType(e.typeId ? typeById.get(e.typeId) : undefined))
    .map((e) => ({ e, d: parseKey(e.date) }))
    .filter((x) => { const dd = dayDiff(x.d, today); return dd >= 0 && dd <= 30; })
    .sort((a, b) => a.d.getTime() - b.d.getTime() || a.e.title.localeCompare(b.e.title))
    .slice(0, 5)
    .map(({ e, d }) => {
      const dd = dayDiff(d, today);
      return { ...deco(e), mon: MS[d.getMonth()], n: d.getDate(), due: dd === 0 ? "Today" : dd === 1 ? "Tomorrow" : `in ${dd}d`, tone: dd <= 2 ? "soon" : dd <= 7 ? "near" : "" };
    });

  /* --------------------------------------------------------------- actions */
  const reload = () => setNonce((n) => n + 1);
  const open = (e: CalEvent) => setDetailId(e.id);

  // Deal / buyer / teammate lists for the form, fetched the first time it opens.
  function ensurePeople() {
    if (peopleAsked.current) return;
    peopleAsked.current = true;
    const list = (path: string, allowed: boolean) => (allowed ? api.get<Named[]>(path).catch(() => [] as Named[]) : Promise.resolve([] as Named[]));
    Promise.all([list("/deals", can("viewDeals")), list("/buyers", can("viewBuyers")), list("/users", true)])
      .then(([deals, buyers, users]) => setPeople({
        deals: deals.map((x) => ({ id: x.id, name: x.name })), buyers: buyers.map((x) => ({ id: x.id, name: x.name })), users: users.map((x) => ({ id: x.id, name: x.name })),
      }));
  }
  function openNew() {
    const follow = types.find((t) => t.systemKey === "follow") || types[0];
    ensurePeople();
    setForm({ id: null, title: "", typeId: follow ? follow.id : null, date: keyOf(sel), start: "10:00", end: "11:00", allDay: false, link: "", who: user?.id ?? "", notes: "" });
  }
  function openEdit(e: CalEvent) {
    ensurePeople();
    setDetailId(null);
    setForm({
      id: e.id, title: e.title, typeId: e.typeId, date: e.date, start: e.start || "10:00", end: e.start ? e.end || "" : "11:00", allDay: e.allDay,
      link: e.link && e.link.kind !== "contact" ? `${e.link.kind}:${e.link.id}` : "", who: e.assignee?.id ?? "", notes: e.notes ?? "",
    });
  }
  async function removeEvent(e: CalEvent) {
    try { await api.del(`/calendar/events/${e.id}`); setDetailId(null); showToast("Event deleted"); reload(); }
    catch (err) { showToast(errText(err), "error"); }
  }
  async function toggleDone(e: CalEvent) {
    try { await api.patch(`/calendar/events/${e.id}`, { done: !e.done }); setDetailId(null); showToast(e.done ? "Marked open" : "Marked done"); reload(); }
    catch (err) { showToast(errText(err), "error"); }
  }

  const detailRaw = detailId ? events.find((e) => e.id === detailId) : undefined;
  const detail = detailRaw ? deco(detailRaw) : null;
  const editing = form && form.id ? events.find((e) => e.id === form.id) : undefined;

  /* ----------------------------------------------------------------- parts */
  const chips = (
    <div className="cal-chips">
      {types.map((t) => {
        const on = !hidden[t.id];
        return (
          <button key={t.id} type="button" className={`cal-b cal-chip ${on ? "" : "off"}`} aria-pressed={on}
            onClick={() => setHidden((h) => ({ ...h, [t.id]: !h[t.id] }))}>
            <span className="cal-chip-sw" style={on ? { background: t.color } : undefined} />{t.name}
            {!phone && <span className="cal-chip-n">{t.eventCount}</span>}
          </button>
        );
      })}
      {canTypes && (
        <button type="button" className="cal-b cal-manage" onClick={() => setTypesOpen(true)}>
          {!phone && <Ico d={I_SLIDERS} s={13} w={1.8} />}Manage types
        </button>
      )}
    </div>
  );
  const viewSwitch = <Segmented className="cal-views" ariaLabel="Calendar view" options={VIEWS} value={view} onChange={pickView} />;
  const newBtn = canEdit && (
    <button type="button" className="cal-b cal-new" onClick={openNew}><Ico d={I_PLUS} w={2.2} />New event</button>
  );

  /** Row with a colour bar: the selected day's events and the week ahead. */
  const barRow = (e: Ev, right: string) => (
    <button key={e.id} type="button" className={`cal-b cal-row ${e.done ? "is-done" : ""}`} onClick={() => open(e)}>
      <span className="cal-bar" style={{ background: e.color }} />
      <span className="cal-row-main">
        <span className="cal-row-top"><span className="cal-row-title">{e.title}</span><span className="cal-row-t">{right}</span></span>
        <span className="cal-row-sub">{e.sub}</span>
      </span>
    </button>
  );
  /** Phone card: title over "when · who". */
  const card = (e: Ev) => (
    <button key={e.id} type="button" className={`cal-b cal-card ${e.done ? "is-done" : ""}`} onClick={() => open(e)}>
      <span className="cal-bar" style={{ background: e.color }} />
      <span className="cal-card-main">
        <span className="cal-card-title">{e.title}</span>
        <span className="cal-card-meta"><span className="cal-card-when">{e.when}</span><span className="cal-card-sub">{e.sub}</span></span>
      </span>
    </button>
  );
  /** Phone card for the week ahead: title with the day on the right. */
  const aheadCard = (e: Ev & { day: string }) => (
    <button key={e.id} type="button" className={`cal-b cal-card ${e.done ? "is-done" : ""}`} onClick={() => open(e)}>
      <span className="cal-bar" style={{ background: e.color }} />
      <span className="cal-card-main">
        <span className="cal-card-top"><span className="cal-card-title one">{e.title}</span><span className="cal-card-day">{e.day}</span></span>
        <span className="cal-card-sub">{e.sub}</span>
      </span>
    </button>
  );
  const deadlineList = deadlines.map((e) => (
    <button key={e.id} type="button" className="cal-b cal-dl" onClick={() => open(e)}>
      <span className="cal-dl-date"><span>{e.mon}</span><b>{e.n}</b></span>
      <span className="cal-dl-main"><span className="cal-dl-title">{e.title}</span><span className="cal-dl-sub">{e.sub}</span></span>
      <span className={`cal-dl-due ${e.tone}`}>{e.due}</span>
    </button>
  ));
  const emptyNote = <div className="cal-none">Nothing scheduled. Coming up this week:</div>;

  const dialogs = (
    <>
      {detail && (
        <EventDetail e={detail} phone={phone} canEdit={canEdit} onClose={() => setDetailId(null)}
          onEdit={() => openEdit(detail)} onDelete={() => removeEvent(detail)} onDone={() => toggleDone(detail)} />
      )}
      {form && (
        <EventForm initial={form} current={editing} types={types} people={people} phone={phone} self={user ? { id: user.id, name: user.name } : null}
          onClose={() => setForm(null)}
          onSaved={(date, edited) => { setForm(null); setSel(parseKey(date)); showToast(edited ? "Event updated" : "Event added"); reload(); }} />
      )}
      {typesOpen && <TypesManager types={types} phone={phone} onClose={() => setTypesOpen(false)} onChanged={reload} />}
    </>
  );

  /* ----------------------------------------------------------------- phone */
  if (phone) {
    const dayList = (
      <div className="cal-cards">
        {selEvents.map(card)}
        {selEvents.length === 0 && <>{emptyNote}{weekAhead.map(aheadCard)}</>}
      </div>
    );
    return (
      <div className="cal-page cal-phone">
        <div className="cal-mhead"><h1>Calendar</h1>{newBtn}</div>
        {viewSwitch}
        <div className="cal-mnav">
          <button type="button" className="cal-b cal-mnav-btn" aria-label="Previous" onClick={() => step(-1)}><Ico d={I_PREV} s={15} /></button>
          <div className="cal-mnav-mid">
            <span className="cal-range">{rangeLabel}</span>
            <button type="button" className="cal-b cal-mtoday" onClick={goToday}>Today</button>
          </div>
          <button type="button" className="cal-b cal-mnav-btn" aria-label="Next" onClick={() => step(1)}><Ico d={I_NEXT} s={15} /></button>
        </div>
        {chips}

        {isMonth && (
          <>
            <section className="cal-panel">
              <div className="cal-mdows">{DOW.map((d) => <div key={d}>{d}</div>)}</div>
              <div className="cal-mgrid">
                {cells.map((c) => (
                  <button key={c.key} type="button" aria-label={c.d.toDateString()} aria-pressed={c.isSel}
                    className={`cal-b cal-mcell ${c.inMonth ? "" : "out"} ${c.isSel ? "sel" : ""} ${c.isToday ? "today" : ""}`} onClick={() => setSel(c.d)}>
                    <span className="cal-mnum">{c.d.getDate()}</span>
                    <span className="cal-dots">{c.evs.slice(0, 3).map((e) => <span key={e.id} style={{ background: e.color }} />)}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="cal-msel">
              <div className="cal-msel-head">
                <div className="cal-msel-l"><span className="cal-msel-title">{selLabel}</span><span className="cal-msel-sub">{selFull}</span></div>
                <span className="cal-msel-sub">{selSub}</span>
              </div>
              {dayList}
            </section>
            <section className="cal-panel">
              <div className="cal-panel-head"><span className="cal-panel-title">Deadlines ahead</span><span className="cal-panel-sub">Next 30 days</span></div>
              <div className="cal-panel-list">{deadlineList}</div>
            </section>
          </>
        )}

        {isWeek && (
          <>
            <section className="cal-panel cal-mweek">
              <div className="cal-mweek-grid">
                {weekDays.map((d) => (
                  <button key={d.key} type="button" aria-pressed={d.isSel} className={`cal-b cal-mday ${d.isSel ? "sel" : ""} ${d.isToday ? "today" : ""}`} onClick={() => setSel(d.d)}>
                    <span className="cal-mday-dow">{d.dow}</span>
                    <span className="cal-mday-num">{d.d.getDate()}</span>
                    <span className="cal-dots">{[...d.allDay, ...d.timed].slice(0, 3).map((e) => <span key={e.id} style={{ background: e.color }} />)}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="cal-msel">
              <div className="cal-msel-head"><span className="cal-msel-title">{selFull}</span><span className="cal-msel-sub">{selSub}</span></div>
              {dayList}
            </section>
          </>
        )}

        {isAgenda && (
          <section className="cal-magenda">
            {agendaDays.map((d) => (
              <div key={d.key} className={`cal-magenda-day ${d.isToday ? "today" : ""}`}>
                <div className="cal-magenda-head"><span className="cal-magenda-dow">{DOW[d.d.getDay()]} {d.d.getDate()}</span><span className="cal-magenda-mon">{MON[d.d.getMonth()]}</span></div>
                <div className="cal-cards">{d.evs.map(card)}</div>
              </div>
            ))}
            {agendaDays.length === 0 && <div className="cal-magenda-empty">Nothing scheduled in this range.</div>}
          </section>
        )}
        {dialogs}
      </div>
    );
  }

  /* --------------------------------------------------------------- desktop */
  return (
    <div className="cal-page">
      <div className="cal-head">
        <div className="cal-head-l">
          <h1>Calendar</h1>
          <div className="cal-nav">
            <button type="button" className="cal-b cal-nav-btn prev" aria-label="Previous" onClick={() => step(-1)}><Ico d={I_PREV} /></button>
            <button type="button" className="cal-b cal-today" onClick={goToday}>Today</button>
            <button type="button" className="cal-b cal-nav-btn next" aria-label="Next" onClick={() => step(1)}><Ico d={I_NEXT} /></button>
          </div>
          <span className="cal-range">{rangeLabel}</span>
        </div>
        <div className="cal-head-r">{viewSwitch}{newBtn}</div>
      </div>
      {chips}

      <div className="cal-layout">
        {isMonth && (
          <section className="cal-panel cal-month">
            <div className="cal-dows">{DOW.map((d) => <div key={d}>{d}</div>)}</div>
            <div className="cal-grid">
              {cells.map((c) => (
                <div key={c.key} className={`cal-cell ${c.inMonth ? "" : "out"} ${c.isSel ? "sel" : ""} ${c.isToday ? "today" : ""} ${c.last ? "last" : ""}`} onClick={() => setSel(c.d)}>
                  <div className="cal-cell-top">
                    <span className="cal-num">{c.d.getDate()}</span>
                    {c.isSel && <span className="cal-sel-dot" />}
                  </div>
                  {c.evs.slice(0, 3).map((e) => (
                    <button key={e.id} type="button" className={`cal-b cal-ev ${e.done ? "is-done" : ""}`} title={`${e.t} · ${e.title}`} onClick={() => open(e)}>
                      <span className="cal-ev-dot" style={{ background: e.color }} /><span className="cal-ev-title">{e.title}</span>
                    </button>
                  ))}
                  {c.evs.length > 3 && <span className="cal-more">+{c.evs.length - 3} more</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {isWeek && (
          <section className="cal-panel cal-week">
            <div className="cal-wrow cal-whead">
              <div />
              {weekDays.map((d) => (
                <button key={d.key} type="button" className={`cal-b cal-wday ${d.isToday ? "today" : ""}`} onClick={() => setSel(d.d)}>
                  <span className="cal-wday-dow">{d.dow}</span><span className="cal-wday-num">{d.d.getDate()}</span>
                </button>
              ))}
            </div>
            <div className="cal-wrow cal-wallday">
              <div className="cal-wallday-label">All day</div>
              {weekDays.map((d) => (
                <div key={d.key} className="cal-wallday-col">
                  {d.allDay.map((e) => (
                    <button key={e.id} type="button" className={`cal-b cal-wad ${e.done ? "is-done" : ""}`} style={{ borderLeftColor: e.color }} title={e.title} onClick={() => open(e)}>{e.title}</button>
                  ))}
                </div>
              ))}
            </div>
            <div className="cal-wrow">
              <div className="cal-whours" style={{ height: gridH }}>
                {hours.map((h) => <span key={h.top} style={{ top: h.top }}>{h.label}</span>)}
              </div>
              {weekDays.map((d) => (
                <div key={d.key} className={`cal-wcol ${d.isSel ? "sel" : ""}`} style={{ height: gridH }}>
                  {hours.map((h) => <span key={h.top} className="cal-wline" style={{ top: h.top }} />)}
                  {d.isToday && nowTop != null && <span className="cal-now" style={{ top: nowTop }}><span /></span>}
                  {d.timed.map((e) => {
                    const s = mins(e.start!), en = e.end ? mins(e.end) : s + 60;
                    return (
                      <button key={e.id} type="button" className={`cal-b cal-wev ${e.done ? "is-done" : ""}`} title={e.title} onClick={() => open(e)}
                        style={{ top: ((s - H0 * 60) / 60) * PX, height: Math.max(26, ((en - s) / 60) * PX - 2), borderLeftColor: e.color }}>
                        <span className="cal-wev-title">{e.title}</span><span className="cal-wev-range">{e.when}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        )}

        {isAgenda && (
          <section className="cal-panel cal-agenda">
            {agendaDays.map((d) => (
              <div key={d.key} className={`cal-aday ${d.isToday ? "today" : ""}`}>
                <div className="cal-aday-date">
                  <span className="cal-aday-dow">{DOW[d.d.getDay()]}</span><span className="cal-aday-num">{d.d.getDate()}</span><span className="cal-aday-mon">{MON[d.d.getMonth()]}</span>
                </div>
                <div className="cal-aday-list">
                  {d.evs.map((e) => (
                    <button key={e.id} type="button" className={`cal-b cal-arow ${e.done ? "is-done" : ""}`} onClick={() => open(e)}>
                      <span className="cal-arow-t">{e.t}</span>
                      <span className="cal-arow-main">
                        <span className="cal-arow-sw" style={{ background: e.color }} />
                        <span className="cal-arow-text"><span className="cal-arow-title">{e.title}</span><span className="cal-arow-sub">{e.sub}</span></span>
                      </span>
                      <span className="cal-tag" style={tint(e.color)}>{e.typeName}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {agendaDays.length === 0 && <div className="cal-agenda-empty">Nothing scheduled in this range.</div>}
          </section>
        )}

        <aside className="cal-side">
          <section className="cal-panel">
            <div className="cal-panel-head sel">
              <div className="cal-panel-headl"><span className="cal-panel-title">{selLabel}</span><span className="cal-panel-sub">{selSub}</span></div>
              {canEdit && <button type="button" className="cal-b cal-add" onClick={openNew}>+ Add</button>}
            </div>
            <div className="cal-panel-list">
              {selEvents.map((e) => barRow(e, e.t))}
              {selEvents.length === 0 && <>{emptyNote}{weekAhead.map((e) => barRow(e, e.day))}</>}
            </div>
          </section>
          <section className="cal-panel cal-deadlines">
            <div className="cal-panel-head"><span className="cal-panel-title">Deadlines ahead</span><span className="cal-panel-sub">Next 30 days</span></div>
            <div className="cal-panel-list">{deadlineList}</div>
          </section>
        </aside>
      </div>
      {dialogs}
    </div>
  );
}

/* ----------------------------------------------------------- event detail */
function EventDetail({ e, phone, canEdit, onClose, onEdit, onDelete, onDone }: {
  e: Ev; phone: boolean; canEdit: boolean; onClose: () => void; onEdit: () => void; onDelete: () => Promise<void>; onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const d = parseKey(e.date);
  const when = `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()} · ${e.when}`;
  const linkTo = e.link ? `/${e.link.kind === "deal" ? "deals" : e.link.kind === "buyer" ? "buyers" : "contacts"}/${e.link.id}` : null;
  const link = e.link && linkTo ? <Link className="cal-dlink" to={linkTo}>{e.link.label}</Link> : <span className="cal-dnone">—</span>;
  const who = e.assignee
    ? <span className="cal-who"><span className="cal-ini">{initials(e.assignee.name)}</span>{e.assignee.name}</span>
    : <span className="cal-dnone">Unassigned</span>;
  const act = (fn: () => Promise<void>) => async () => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  const doneLabel = e.done ? "Mark open" : "Mark done";

  let footer: ReactNode;
  if (e.readOnly) {
    // Drawn from a deal, task or reminder: it is changed where it lives.
    footer = (
      <>
        <span className="cal-src">{SOURCE_NOTE[e.source]}</span>
        {e.href && <Link className="cal-btn is-primary" to={e.href}>Open</Link>}
      </>
    );
  } else if (canEdit) {
    footer = phone ? (
      <>
        <button type="button" className="cal-b cal-btn is-danger" disabled={busy} onClick={act(onDelete)}>Delete</button>
        <span className="cal-grow" />
        <button type="button" className="cal-b cal-btn" disabled={busy} onClick={act(onDone)}>{doneLabel}</button>
        <button type="button" className="cal-b cal-btn is-primary" disabled={busy} onClick={onEdit}>Edit</button>
      </>
    ) : (
      <>
        <button type="button" className="cal-b cal-btn is-danger" disabled={busy} onClick={act(onDelete)}>Delete</button>
        <div className="cal-foot-r">
          <button type="button" className="cal-b cal-btn" disabled={busy} onClick={onEdit}>Edit</button>
          <button type="button" className="cal-b cal-btn is-primary" disabled={busy} onClick={act(onDone)}>{doneLabel}</button>
        </div>
      </>
    );
  }

  return (
    <Modal title={e.title} onClose={onClose} footer={footer}
      subtitle={<><span className="cal-tag cal-dtag" style={tint(e.color)}><span className="cal-dtag-sw" />{e.typeName}</span><span className="cal-dwhen">{when}</span></>}>
      <div className={`cal-dlg cal-detail ${e.done ? "is-done" : ""}`}>
        {phone ? (
          <>
            <div className="cal-dcards">
              <div className="cal-dcard"><span className="cal-dk">Linked to</span>{link}</div>
              <div className="cal-dcard"><span className="cal-dk">Assigned to</span>{who}</div>
            </div>
            {e.notes && <div className="cal-dnotes"><span className="cal-dk">Notes</span><p>{e.notes}</p></div>}
          </>
        ) : (
          <div className="cal-dgrid">
            <span className="cal-dk">When</span><span className="cal-dv">{when}</span>
            <span className="cal-dk">Linked to</span>{link}
            <span className="cal-dk">Assigned</span>{who}
            {e.notes && <><span className="cal-dk">Notes</span><span className="cal-dnote">{e.notes}</span></>}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- event form */
function EventForm({ initial, current, types, people, phone, self, onClose, onSaved }: {
  initial: FormState; current: CalEvent | undefined; types: CalType[]; people: People | null; phone: boolean; self: Named | null;
  onClose: () => void; onSaved: (date: string, edited: boolean) => void;
}) {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const id = window.setTimeout(() => titleRef.current?.focus(), 60); return () => window.clearTimeout(id); }, []);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const canSave = !!f.title.trim() && !!f.date && (f.allDay || !!f.start);

  // The saved link / assignee always has an option, even before the lists load
  // (or when the record is no longer in them).
  const linkOpts = useMemo(() => {
    const opts: SelectOption[] = [
      ...(people?.deals ?? []).map((x) => ({ value: `deal:${x.id}`, label: x.name, hint: "Deal" })),
      ...(people?.buyers ?? []).map((x) => ({ value: `buyer:${x.id}`, label: x.name, hint: "Buyer" })),
    ];
    const l = current?.link;
    if (l && l.kind !== "contact" && !opts.some((o) => o.value === `${l.kind}:${l.id}`)) opts.push({ value: `${l.kind}:${l.id}`, label: l.label, hint: l.kind === "deal" ? "Deal" : "Buyer" });
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: "", label: "None" }, ...opts];
  }, [people, current]);
  const whoOpts = useMemo(() => {
    const opts: SelectOption[] = (people?.users ?? []).map((x) => ({ value: x.id, label: x.name }));
    [self, current?.assignee ?? null].forEach((p) => { if (p && !opts.some((o) => o.value === p.id)) opts.push({ value: p.id, label: p.name }); });
    return opts.sort((a, b) => a.label.localeCompare(b.label));
  }, [people, current, self]);

  async function save() {
    if (!canSave || busy) return;
    if (!f.allDay && f.end && f.end <= f.start) { showToast("The end time must be after the start time.", "error"); return; }
    const cut = f.link.indexOf(":"), kind = f.link.slice(0, cut), linkId = f.link.slice(cut + 1);
    const body = {
      title: f.title.trim(), typeId: f.typeId, date: f.date, allDay: f.allDay,
      start: f.allDay ? null : f.start, end: f.allDay ? null : f.end || null,
      dealId: kind === "deal" ? linkId : null, buyerId: kind === "buyer" ? linkId : null,
      assignedToId: f.who || null, notes: f.notes.trim() || null,
    };
    setBusy(true);
    try {
      if (f.id) await api.patch(`/calendar/events/${f.id}`, body); else await api.post("/calendar/events", body);
      onSaved(f.date, !!f.id);
    } catch (err) { setBusy(false); showToast(errText(err), "error"); }
  }

  const req = phone ? <span className="cal-req"> *</span> : null;
  const title = (
    <label className="cal-f"><span className="cal-fl">Title{req}</span>
      <input ref={titleRef} className="cal-input" value={f.title} maxLength={200} placeholder="e.g. Closing — Randall Madden" onChange={(e) => set("title", e.target.value)} />
    </label>
  );
  const type = (
    <div className="cal-f"><span className="cal-fl">Type</span>
      <div className="cal-topts">
        {types.map((t) => (
          <button key={t.id} type="button" className={`cal-b cal-topt ${f.typeId === t.id ? "on" : ""}`} aria-pressed={f.typeId === t.id} onClick={() => set("typeId", t.id)}>
            <span className="cal-topt-sw" style={{ background: t.color }} />{t.name}
          </button>
        ))}
      </div>
    </div>
  );
  const date = <div className="cal-f"><span className="cal-fl">Date{req}</span><DateField value={f.date} onChange={(v) => set("date", v)} ariaLabel="Date" /></div>;
  const time = (k: "start" | "end", label: string) => (
    <label className="cal-f"><span className="cal-fl">{label}</span>
      <input type="time" className="cal-input cal-time" value={f[k]} disabled={f.allDay} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  const sw = <span className={`cal-sw ${f.allDay ? "on" : ""}`}><span /></span>;
  const link = (
    <div className="cal-f"><span className="cal-fl">Link to deal or buyer</span>
      <Select options={linkOpts} value={f.link} onChange={(v) => set("link", v)} searchable ariaLabel="Link to deal or buyer" searchPlaceholder="Search deals and buyers…" />
    </div>
  );
  const who = (
    <div className="cal-f"><span className="cal-fl">Assigned to</span>
      <Select options={whoOpts} value={f.who} onChange={(v) => set("who", v)} searchable ariaLabel="Assigned to" placeholder="Unassigned" />
    </div>
  );
  const notes = (
    <label className="cal-f"><span className="cal-fl">Notes</span>
      <textarea className="cal-input cal-area" rows={3} maxLength={4000} value={f.notes} placeholder={phone ? "Anything the team should know" : "Optional"} onChange={(e) => set("notes", e.target.value)} />
    </label>
  );

  return (
    <Modal title={f.id ? "Edit event" : "New event"} onClose={onClose} dirty={dirty}
      footer={
        <>
          <button type="button" className="cal-b cal-btn cal-btn-lg" onClick={onClose}>Cancel</button>
          <button type="button" className={`cal-b cal-btn cal-btn-lg is-primary ${canSave ? "" : "off"}`} disabled={!canSave || busy} onClick={save}>{f.id ? "Save changes" : "Add event"}</button>
        </>
      }>
      <div className="cal-dlg cal-form">
        {phone ? (
          <>
            {title}{type}{date}
            <div className="cal-allday-row"><span className="cal-fl">All day</span>
              <button type="button" className="cal-b cal-allday" role="switch" aria-checked={f.allDay} aria-label="All day" onClick={() => set("allDay", !f.allDay)}>{sw}</button>
            </div>
            <div className="cal-f2">{time("start", "Starts")}{time("end", "Ends")}</div>
            {link}{who}{notes}
          </>
        ) : (
          <>
            {title}{type}
            <div className="cal-f3">{date}{time("start", "Start")}{time("end", "End")}</div>
            <button type="button" className="cal-b cal-allday" role="switch" aria-checked={f.allDay} onClick={() => set("allDay", !f.allDay)}>{sw}All day</button>
            <div className="cal-f2">{link}{who}</div>
            {notes}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- event types */
function TypesManager({ types, phone, onClose, onChanged }: { types: CalType[]; phone: boolean; onClose: () => void; onChanged: () => void }) {
  const [tf, setTf] = useState<TypeEdit>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmType = confirmId ? types.find((t) => t.id === confirmId) : undefined;
  const value = tf && tf.mode !== "color" ? tf.value : "";
  const ready = !!value.trim();

  async function run(fn: () => Promise<unknown>, done?: string) {
    if (busy) return;
    setBusy(true);
    try { await fn(); setTf(null); setConfirmId(null); if (done) showToast(done); onChanged(); }
    catch (err) { showToast(errText(err), "error"); }
    finally { setBusy(false); }
  }
  const saveEdit = () => { if (tf && tf.mode === "edit" && ready) run(() => api.patch(`/calendar/types/${tf.id}`, { name: tf.value.trim() }), "Type renamed"); };
  const addType = () => { if (tf && tf.mode === "add" && ready) run(() => api.post("/calendar/types", { name: tf.value.trim() }), "Type added"); };
  const removeType = (id: string) => run(() => api.del(`/calendar/types/${id}`), "Type removed");
  // Escape in a name field cancels the edit, not the whole dialog.
  const onKey = (commit: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setTf(null); }
  };
  const setValue = (v: string) => setTf((s) => (s && s.mode !== "color" ? { ...s, value: v } : s));
  const nameInput = (commit: () => void, placeholder: string) => (
    <input className="cal-input cal-tinput" autoFocus value={value} maxLength={60} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey(commit)} />
  );
  const cancelBtn = <button type="button" className="cal-b cal-tcancel" onClick={() => setTf(null)}>Cancel</button>;
  const addOn = !!tf && tf.mode === "add";
  const addRow = (placeholder: string) => (
    <div className="cal-tadd-row">
      {nameInput(addType, placeholder)}
      <button type="button" className={`cal-b cal-tsave ${ready ? "on" : ""}`} onClick={addType}>Add</button>
      {cancelBtn}
    </div>
  );
  const addBtn = (
    <button type="button" className="cal-b cal-tadd" onClick={() => setTf({ mode: "add", value: "" })}><Ico d={I_PLUS} s={phone ? 14 : 13} w={phone ? 2.2 : 2} />Add type</button>
  );

  const rows = types.map((t) => {
    const editing = !!tf && tf.mode === "edit" && tf.id === t.id;
    const colorOpen = !!tf && tf.mode === "color" && tf.id === t.id;
    const startEdit = () => setTf({ mode: "edit", id: t.id, value: t.name });
    const remove = () => { if (t.eventCount) { setTf(null); setConfirmId(t.id); } else removeType(t.id); };
    const colorBtn = (
      <button type="button" className={`cal-b cal-tcolor-btn ${colorOpen ? "open" : ""}`} aria-label={phone ? "Change color" : "Type color"}
        onClick={(e) => { e.stopPropagation(); setTf(colorOpen ? null : { mode: "color", id: t.id }); }}>
        <span style={{ background: t.color }} />
      </button>
    );
    const pop = colorOpen && (
      <div className="cal-tpop">
        {PALETTE.map((c) => (
          <button key={c} type="button" aria-label="Color" className={`cal-b cal-tsw ${c.toLowerCase() === t.color.toLowerCase() ? "on" : ""}`} style={{ background: c, color: c }}
            onClick={(e) => { e.stopPropagation(); run(() => api.patch(`/calendar/types/${t.id}`, { color: c })); }} />
        ))}
      </div>
    );
    const edit = <>{nameInput(saveEdit, "Type name")}<button type="button" className={`cal-b cal-tsave ${ready ? "on" : ""}`} onClick={saveEdit}>Save</button>{cancelBtn}</>;
    if (phone) {
      return (
        <div key={t.id} className="cal-trow">
          {colorBtn}{pop}
          {editing ? edit : (
            <>
              <div className="cal-tinfo"><span className="cal-tinfo-name">{t.name}</span><span className="cal-tinfo-n">{plural(t.eventCount)}</span></div>
              <button type="button" className="cal-b cal-ticon" aria-label="Rename" onClick={startEdit}><Ico d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4" s={15} w={1.8} /></button>
              <button type="button" className="cal-b cal-ticon del" aria-label="Remove" onClick={remove}><Ico d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" s={15} w={1.8} /></button>
            </>
          )}
        </div>
      );
    }
    return (
      <div key={t.id} className="cal-trow">
        <div className="cal-tcolor">{colorBtn}{pop}</div>
        {editing ? <div className="cal-tedit">{edit}</div> : (
          <div className="cal-tname">
            <span>{t.name}</span>
            <button type="button" className="cal-b cal-tpencil" title="Rename type" aria-label="Rename type" onClick={startEdit}><Ico d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" s={13} w={1.8} /></button>
          </div>
        )}
        <span className="cal-tcount">{plural(t.eventCount)}</span>
        <button type="button" className="cal-b cal-tdel" title="Remove type" aria-label="Remove type" onClick={remove}><Ico d={I_X} /></button>
      </div>
    );
  });
  const closeColor = () => { if (tf && tf.mode === "color") setTf(null); };

  return (
    <>
      <Modal title="Event types" subtitle={phone ? "Rename, recolor or remove" : undefined} onClose={onClose}
        footer={phone ? (addOn ? addRow("New type name") : addBtn) : <button type="button" className="cal-b cal-btn cal-btn-lg is-primary" onClick={onClose}>Done</button>}>
        <div className="cal-dlg cal-types" onClick={closeColor}>
          {phone ? (
            <>{rows}{types.length === 0 && <div className="cal-tnone">No event types yet.</div>}</>
          ) : (
            <>
              <div className="cal-tintro">
                <div className="cal-tintro-h"><span /><b>Types</b></div>
                <p>Rename, recolor, add, or remove event types. Types are used for color coding and the filter chips.</p>
              </div>
              <div className="cal-tlist">
                {rows}
                {types.length === 0 && <div className="cal-tnone">No event types yet. Add the first one below.</div>}
                {addOn ? addRow("Type name") : addBtn}
              </div>
            </>
          )}
        </div>
      </Modal>
      {confirmType && (
        <Modal title="Remove event type?" onClose={() => setConfirmId(null)}>
          <div className="cal-dlg cal-confirm">
            {phone ? (
              <>
                <div className="cal-confirm-h"><span style={{ background: confirmType.color }} /><b>Remove “{confirmType.name}”?</b></div>
                <p>{plural(confirmType.eventCount)} will lose this type and show as Other. This can't be undone.</p>
              </>
            ) : (
              <>
                <div className="cal-confirm-title">Remove event type?</div>
                <div className="cal-confirm-chip"><span style={{ background: confirmType.color }} /><b>{confirmType.name}</b><i>· {plural(confirmType.eventCount)}</i></div>
                <p>Events using this type will be kept and shown as <strong>Other</strong>. This cannot be undone.</p>
              </>
            )}
            <div className="cal-confirm-foot">
              <button type="button" className="cal-b cal-btn cal-btn-lg" onClick={() => setConfirmId(null)}>Cancel</button>
              <button type="button" className="cal-b cal-btn cal-btn-lg is-remove" disabled={busy} onClick={() => removeType(confirmType.id)}>Remove type</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
