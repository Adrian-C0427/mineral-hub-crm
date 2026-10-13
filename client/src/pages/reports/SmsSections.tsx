import { useState, type CSSProperties, type ReactNode } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";
import { StatStrip, Segmented, type StatCell } from "../../components/kit";
import { SortableTable, type Column } from "../../components/SortableTable";
import { num, pct } from "../../lib/format";
import { CHART_COLORS } from "../../lib/charts";
import {
  DOW_LABEL, FUNNEL_STEP_LABEL, dayLabel, fmtDuration, fmtPer, heatLevel, hourShort, slotHours, slotLabel,
  type DrillRow, type DrillSet, type FunnelStepKey, type HealthDay, type QualityRow, type SlotCell, type SmsKpis, type SmsReport,
} from "../../lib/smsReport";
import type { DrillSpec } from "./SmsDrill";

/**
 * Reports → SMS performance, the KPI sections added with the minerals scope:
 * funnel & offers, cost, speed to lead, best time to text, phone lists and
 * carrier health. Every figure comes from the server (routes/smsReports.ts);
 * these components only lay it out and open the matching drill-down.
 */

const AXIS_TICK = { fontSize: 11, fill: "var(--ink-4)" };
const COLOR_OPT_OUT = CHART_COLORS[0];
const COLOR_FAILED = CHART_COLORS[3];

/** One KPI tile with its comparison pill (SmsPerformance's `cell`). */
export type KpiCell = (key: keyof SmsKpis, o: {
  label: string; hint?: string; invert?: boolean; tone?: StatCell["tone"]; title?: string; onClick?: () => void;
}) => StatCell;
/** Open a drill-down; `row` narrows it to one table row. */
export type OpenDrill = (spec: DrillSpec, row?: DrillRow) => void;

const rate = (v: number | null | undefined) => (v == null ? "N/A" : pct(v));
/** A plain tile (no comparison) in the report's look. */
function tile(label: string, value: string, o: { sub?: string; title?: string; onClick?: () => void } = {}): StatCell {
  return { label, value: <span className={`rp-val ${value === "N/A" ? "rp-faint" : ""}`}>{value}</span>, sub: o.sub, title: o.title, onClick: o.onClick };
}

// --- Funnel & offers ---------------------------------------------------------

const STEP_SET: Record<FunnelStepKey, DrillSet> = {
  reached: "reached", responded: "responded", opportunity: "opportunity", offer: "offer", accepted: "accepted", contract: "contract", closed: "closed",
};
const STEP_TITLE: Record<FunnelStepKey, string> = {
  reached: "People reached", responded: "People who replied", opportunity: "People who became opportunities",
  offer: "People who got an offer", accepted: "People who accepted an offer", contract: "People under contract", closed: "People whose deal closed",
};

export function FunnelSection({ data, cell, open, settings }: { data: SmsReport; cell: KpiCell; open: OpenDrill; settings: ReactNode }) {
  const f = data.funnel;
  const k = data.kpis;
  const reached = f.steps[0]?.count ?? 0;
  const noPipelines = f.pipelines != null && f.pipelines.length === 0;
  const where = f.pipelines == null ? "every HighLevel pipeline"
    : noPipelines ? "no minerals pipelines chosen" : `${f.pipelines.map((p) => p.name).join(", ")} ${f.pipelines.length === 1 ? "pipeline" : "pipelines"}`;
  const cells: StatCell[] = [
    cell("interestedRate", {
      label: "Interested rate", tone: "success",
      hint: `${num(k.opportunities)} ${k.opportunities === 1 ? "opportunity" : "opportunities"} of ${num(reached)} reached`,
      title: "People who became an opportunity in HighLevel ÷ people reached.",
      onClick: () => open({ title: STEP_TITLE.opportunity, set: "opportunity" }),
    }),
    cell("offerAcceptanceRate", {
      label: "Offer acceptance", hint: `${num(f.steps.find((s) => s.key === "accepted")?.count ?? 0)} of ${num(k.offers)} offers accepted`,
      title: "Offers accepted (or further along) ÷ offers made.",
      onClick: () => open({ title: STEP_TITLE.accepted, set: "accepted" }),
    }),
    cell("closedDeals", {
      label: "Closed deals", hint: "People whose deal closed",
      onClick: () => open({ title: STEP_TITLE.closed, set: "closed" }),
    }),
    tile("Contacts per offer", fmtPer(f.contactsPerOffer), { sub: "People reached for each offer made" }),
    tile("Contacts per closed deal", fmtPer(f.contactsPerClosedDeal), { sub: "People reached for each closed deal" }),
    tile("Texts per closed deal", fmtPer(f.textsPerClosedDeal), { sub: "Texts sent to them ÷ closed deals" }),
    tile("Time to opportunity", fmtDuration(f.toOpportunity.medianSeconds), {
      sub: f.toOpportunity.avgSeconds == null ? "No opportunities yet" : `Typical (median) · average ${fmtDuration(f.toOpportunity.avgSeconds)}`,
      title: "From the first text that reached the person to the day their opportunity was created.",
    }),
    tile("Time to close", fmtDuration(f.toClose.medianSeconds), {
      sub: f.toClose.unknown > 0 ? `Typical · ${num(f.toClose.unknown)} closed with no closing date` : f.toClose.known ? `Typical · average ${fmtDuration(f.toClose.avgSeconds)}` : "No closed deals yet",
      title: "From the first text to the day the deal reached a closed stage.",
    }),
  ];
  return (
    <>
      <div className="rp-kgroup">
        <div className="rp-kgroup-label">Funnel &amp; offers</div>
        <StatStrip min={180} cells={cells} />
      </div>
      <section className="panel rp-chart sms-funnel">
        <div className="rp-chart-head">
          <div>
            <h3>From first text to closed deal</h3>
            <span className="rp-chart-sub">People first reached in this period · opportunities in {where}</span>
          </div>
        </div>
        {noPipelines ? (
          <p className="rp-empty">No minerals pipelines are chosen yet, so there are no opportunities to count. Choose them in {settings}.</p>
        ) : reached === 0 ? <p className="rp-empty">Nobody was reached for the first time in this period.</p> : (
          <div className="sms-funnel-rows">
            {f.steps.map((s, i) => (
              <button key={s.key} type="button" className="sms-funnel-row" disabled={s.count === 0}
                onClick={() => open({ title: STEP_TITLE[s.key], set: STEP_SET[s.key] })}
                title={s.count ? `See the ${num(s.count)} ${s.count === 1 ? "person" : "people"}` : undefined}>
                <span className="sms-funnel-l">{FUNNEL_STEP_LABEL[s.key]}</span>
                <span className="sms-funnel-bar">
                  <i className={i === 0 ? "" : "sub"} style={{ width: `${s.count ? Math.max(0.8, (s.count / reached) * 100) : 0}%` }} />
                </span>
                <span className="sms-funnel-n">{num(s.count)}</span>
                <span className="sms-funnel-c">
                  {i === 0 ? "everyone reached"
                    : i === 1 ? <><b>{rate(s.fromReached)}</b> of reached</>
                    : <><b>{rate(s.fromPrevious)}</b> of {FUNNEL_STEP_LABEL[f.steps[i - 1].key].toLowerCase()} · {rate(s.fromReached)} of reached</>}
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="sms-caption">
          Each person counts once, at the furthest step any of their opportunities reached — an offer that later died still counts as an offer.
          {" "}{f.dead > 0
            ? <button type="button" className="link-btn sms-inline-btn" onClick={() => open({ title: "People whose opportunities are dead", set: "dead" })}>{num(f.dead)} {f.dead === 1 ? "person's" : "people's"} opportunities are all dead now.</button>
            : "No opportunities are dead."}
          {f.preExisting > 0 && <> {num(f.preExisting)} {f.preExisting === 1 ? "opportunity was" : "opportunities were"} created before the person's first text and {f.preExisting === 1 ? "is" : "are"} left out.</>}
        </p>
        <p className="sms-caption">
          HighLevel only shares an opportunity's current stage, so stage moves are known from
          {f.historySince ? <> {new Date(f.historySince).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}, when HighLevel was connected</> : " the day HighLevel was connected"}.
          An opportunity that went past a step and back before then shows only where it stood when the CRM first saw it.
        </p>
      </section>
    </>
  );
}

// --- Cost ---------------------------------------------------------------------

export function CostSection({ data, cell, settings }: { data: SmsReport; cell: KpiCell; settings: ReactNode }) {
  const c = data.cost;
  const noPrice = c.pricePerSegment == null;
  // Up is bad for every cost.
  const money = (key: keyof SmsKpis, label: string, hint: string): StatCell => cell(key, { label, hint, invert: true });
  return (
    <div className="rp-kgroup">
      <div className="rp-kgroup-label">Cost</div>
      <StatStrip min={180} cells={[
        money("textingCost", "Texting cost", noPrice ? "Needs your price per text" : `${num(c.segments)} segments × $${c.pricePerSegment}`),
        money("costPerReply", "Cost per reply", `${num(data.kpis.contactsResponded)} replied`),
        money("costPerOpportunity", "Cost per interested seller", `${num(data.kpis.opportunities)} opportunities`),
        money("costPerOffer", "Cost per offer", `${num(data.kpis.offers)} offers`),
        money("costPerClosedDeal", "Cost per closed deal", `${num(data.kpis.closedDeals)} closed`),
      ]} />
      <p className="sms-caption">
        {noPrice
          ? <>Costs need your price per text segment — set it in {settings}. </>
          : <>Cost = billable text segments sent × ${c.pricePerSegment} per segment. </>}
        Cost is dated by the day each text was sent; replies, offers and deals belong to the period of each person's first text.
        Incoming texts aren't charged in these figures.
        {c.unknownSegments > 0 && <> {num(c.unknownSegments)} {c.unknownSegments === 1 ? "text hasn't" : "texts haven't"} been measured yet and {c.unknownSegments === 1 ? "is" : "are"} counted as one segment each.</>}
      </p>
    </div>
  );
}

// --- Speed to lead ------------------------------------------------------------

type MemberRow = SmsReport["speed"]["byMember"][number];

export function SpeedSection({ data, cell, open }: { data: SmsReport; cell: KpiCell; open: OpenDrill }) {
  const s = data.speed;
  const cols: Column<MemberRow>[] = [
    { key: "name", header: "Team member", type: "text", minWidth: 160, value: (r) => r.name,
      render: (r) => (r.key === "none" ? <span className="muted">{r.name}</span> : <strong>{r.name}</strong>) },
    { key: "answered", header: "Replies answered", type: "number", align: "right", value: (r) => r.answered, render: (r) => num(r.answered) },
    { key: "median", header: "Typical time to answer", type: "number", align: "right", value: (r) => r.medianSeconds, render: (r) => fmtDuration(r.medianSeconds) },
    { key: "hour", header: "Of those, within 1 hr", type: "number", align: "right", value: (r) => r.within1hRate, render: (r) => rate(r.within1hRate) },
  ];
  return (
    <>
      <div className="rp-kgroup">
        <div className="rp-kgroup-label">Speed to lead</div>
        <StatStrip min={180} cells={[
          cell("medianAnswerSeconds", {
            label: "Time to answer", invert: true,
            hint: s.answered ? `Typical (median) · average ${fmtDuration(s.avgSeconds)}` : "No replies answered in this period",
            title: "From a person's reply to the next text a team member typed. Automated follow-ups don't count.",
          }),
          tile("Answered within 5 min", rate(s.within5mRate), { sub: `of ${num(s.responded)} replies` }),
          cell("answeredWithinHourRate", { label: "Answered within 1 hr", tone: "success", hint: `of ${num(s.responded)} replies` }),
          tile("Answered within 24 hrs", rate(s.within24hRate), { sub: `of ${num(s.responded)} replies` }),
          cell("neverAnsweredRate", {
            label: "Never answered by a person", invert: true, hint: `${num(s.never)} ${s.never === 1 ? "reply" : "replies"}`,
            onClick: s.never > 0 ? () => open({ title: "Replies no team member answered", set: "unanswered" }) : undefined,
          }),
        ]} />
      </div>
      {s.byMember.length > 0 && (
        <section className="panel rp-chart">
          <div className="rp-chart-head">
            <div>
              <h3>Speed to lead by team member</h3>
              <span className="rp-chart-sub">Who typed the first answer to each reply</span>
            </div>
          </div>
          <SortableTable columns={cols} rows={s.byMember} rowKey={(r) => r.key} empty="No replies answered in this period." />
        </section>
      )}
    </>
  );
}

// --- Best time to text ----------------------------------------------------------

export function BestTimeSection({ data }: { data: SmsReport }) {
  const b = data.bestTime;
  const hours = slotHours(b.cells);
  const byKey = new Map(b.cells.map((c) => [`${c.dow}-${c.hour}`, c]));
  const tip = (c: SlotCell) =>
    `${slotLabel(c)}: ${num(c.reached)} ${c.reached === 1 ? "person" : "people"} first texted, ${num(c.responded)} replied (${rate(c.rate)})`
    + (c.small ? ` — fewer than ${b.minSample} people, not enough to judge` : "");
  return (
    <section className="panel rp-chart sms-besttime">
      <div className="rp-chart-head">
        <div>
          <h3>Best time to text</h3>
          <span className="rp-chart-sub">
            Response rate by the day and hour of each person's first text · {b.fallback
              ? "hours in UTC (HighLevel's location time zone isn't known yet)"
              : <>hours in {b.timezone.replace(/_/g, " ")} (your HighLevel location's time zone)</>}
          </span>
        </div>
      </div>
      {b.cells.length === 0 ? <p className="rp-empty">Nobody was reached for the first time in this period.</p> : (
        <>
          <div className="sms-best">
            <span className="sms-best-label">Best times</span>
            {b.best.length === 0
              ? <span className="muted">Not enough people in any one hour yet (needs {b.minSample}+).</span>
              : b.best.map((c) => (
                <span key={`${c.dow}-${c.hour}`} className="sms-best-chip" title={tip(c)}>
                  {slotLabel(c)} <b>{rate(c.rate)}</b> <span className="muted">of {num(c.reached)}</span>
                </span>
              ))}
          </div>
          <div className="sms-heat-wrap">
            <div className="sms-heat" style={{ gridTemplateColumns: `40px repeat(${hours.length}, minmax(34px, 1fr))` } as CSSProperties}
              role="table" aria-label="Response rate by weekday and hour">
              <div className="sms-heat-row" role="row">
                <span className="sms-heat-corner" role="columnheader" />
                {hours.map((h) => <span key={h} className="sms-heat-h" role="columnheader">{hourShort(h)}</span>)}
              </div>
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <div key={d} className="sms-heat-row" role="row">
                  <span className="sms-heat-d" role="rowheader">{DOW_LABEL[d]}</span>
                  {hours.map((h) => {
                    const c = byKey.get(`${d}-${h}`);
                    if (!c) return <span key={h} className="sms-heat-cell empty" role="cell" />;
                    return (
                      <span key={h} role="cell" title={tip(c)}
                        className={`sms-heat-cell ${c.small ? "small" : ""}`}
                        style={{ "--heat": c.small ? 0 : heatLevel(c.rate, b.cells) } as CSSProperties}>
                        {c.rate == null ? "" : `${Math.round(c.rate * 100)}%`}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="cl">
            <span className="cl-item"><span className="sms-heat-key" style={{ "--heat": 0.15 } as CSSProperties} />Fewer replies</span>
            <span className="cl-item"><span className="sms-heat-key" style={{ "--heat": 1 } as CSSProperties} />More replies</span>
            <span className="cl-item"><span className="sms-heat-key small" />Fewer than {b.minSample} people — not enough to judge</span>
          </div>
        </>
      )}
    </section>
  );
}

// --- Phone lists ------------------------------------------------------------------

type QualityDim = "tags" | "sources";

export function PhoneListsSection({ data, open }: { data: SmsReport; open: OpenDrill }) {
  const [dim, setDim] = useState<QualityDim>("tags");
  const rows = data.phoneQuality[dim];
  const rowDim = dim === "tags" ? "listTag" : "source";
  const label = dim === "tags" ? "List tag" : "Source";
  /** A share with its people count, opening the people behind it. */
  const share = (r: QualityRow, n: number, v: number | null, set: DrillSet, title: string) =>
    n > 0
      ? <button type="button" className="link-btn sms-cell-btn" title={`${num(n)} ${n === 1 ? "person" : "people"}`}
          onClick={(e) => { e.stopPropagation(); open({ title: `${title} · ${r.name}`, set }, { dim: rowDim, key: r.key }); }}>{rate(v)}</button>
      : <span className={v == null ? "muted" : undefined}>{rate(v)}</span>;
  const cols: Column<QualityRow>[] = [
    { key: "name", header: label, type: "text", minWidth: 160, value: (r) => r.name,
      render: (r) => (r.key.startsWith("(") ? <span className="muted">{r.name}</span> : <strong>{r.name}</strong>) },
    { key: "reached", header: "People reached", type: "number", align: "right", value: (r) => r.reached, render: (r) => num(r.reached) },
    { key: "delivery", header: "Delivered", type: "number", align: "right", value: (r) => r.deliveryRate,
      render: (r) => <span title={`${num(r.delivered)} of ${num(r.sent)} texts`}>{rate(r.deliveryRate)}</span> },
    { key: "wrong", header: "Wrong number", type: "number", align: "right", value: (r) => r.wrongNumberRate,
      render: (r) => share(r, r.wrongNumber, r.wrongNumberRate, "wrongNumber", "Wrong numbers") },
    { key: "disc", header: "Disconnected", type: "number", align: "right", value: (r) => r.disconnectedRate,
      render: (r) => share(r, r.disconnected, r.disconnectedRate, "disconnected", "Disconnected numbers") },
    { key: "land", header: "Landline / can't text", type: "number", align: "right", value: (r) => r.landlineRate,
      render: (r) => share(r, r.landline, r.landlineRate, "landline", "Landlines and numbers that can't text") },
    { key: "rot", header: "Needed 2nd/3rd number", type: "number", align: "right", value: (r) => r.rotatedRate,
      render: (r) => share(r, r.rotated, r.rotatedRate, "rotated", "Moved to a 2nd or 3rd number") },
    { key: "exh", header: "All numbers used up", type: "number", align: "right", value: (r) => r.exhaustedRate,
      render: (r) => share(r, r.exhausted, r.exhaustedRate, "exhausted", "Every number used up") },
    { key: "resp", header: "Response rate", type: "number", align: "right", value: (r) => r.responseRate,
      render: (r) => share(r, r.responded, r.responseRate, "responded", "People who replied") },
  ];
  return (
    <section className="panel rp-chart sms-breakdown sms-quality">
      <div className="rp-chart-head">
        <div>
          <h3>Phone lists</h3>
          <span className="rp-chart-sub">
            How good each list's numbers are, from the tags XLeads' phone-rotation workflows add (wrong number-1, disconnected number-2,
            landline, switch phone (2), all numbers exhausted…). Shares are of the people first reached in this period; Delivered is
            delivered ÷ sent texts.
          </span>
        </div>
        <Segmented ariaLabel="Phone lists by" value={dim} onChange={setDim}
          options={[{ value: "tags", label: "By tag" }, { value: "sources", label: "By source" }]} />
      </div>
      <SortableTable columns={cols} rows={rows} rowKey={(r) => r.key}
        onRowClick={(r) => open({ title: `People reached · ${r.name}`, set: "reached" }, { dim: rowDim, key: r.key })}
        empty="Nobody was reached for the first time in this period." />
    </section>
  );
}

// --- Carrier health -------------------------------------------------------------------

interface HealthPoint extends HealthDay {
  label: string; optPct: number | null; failPct: number | null;
  /** Rolling 7 days ending this day (what's plotted — single days are too noisy). */
  w7: { sent: number; failed: number; reached: number; optOuts: number };
}

/** Plot a rolling rate once its 7 days hold this many texts (warnings still need HEALTH_MIN_TEXTS). */
const CHART_MIN_TEXTS = 30;

/** Rolling 7-day totals per day; the rate is left blank until the window holds enough texts to judge. */
function rollingHealth(days: readonly HealthDay[], minTexts: number): Pick<HealthPoint, "w7" | "optPct" | "failPct">[] {
  return days.map((_, i) => {
    const w = days.slice(Math.max(0, i - 6), i + 1);
    const sum = (k: "sent" | "failed" | "reached" | "optOuts") => w.reduce((t, d) => t + d[k], 0);
    const w7 = { sent: sum("sent"), failed: sum("failed"), reached: sum("reached"), optOuts: sum("optOuts") };
    const enough = w7.sent >= minTexts;
    return {
      w7,
      optPct: enough && w7.reached > 0 ? (w7.optOuts / w7.reached) * 100 : null,
      failPct: enough ? (w7.failed / w7.sent) * 100 : null,
    };
  });
}

function HealthTip({ active, payload, minTexts }: { active?: boolean; payload?: { payload: HealthPoint }[]; minTexts: number }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rp-tip">
      <div className="rp-tip-t">{p.label}</div>
      <div className="rp-tip-row"><span>7 days to this day</span><b>{p.failPct == null ? "too few texts" : `${num(p.w7.sent)} texts`}</b></div>
      {p.failPct != null && <div className="rp-tip-row"><span><i style={{ background: COLOR_FAILED }} />Failed (7 days)</span><b>{rate(p.failPct / 100)}</b></div>}
      {p.optPct != null && <div className="rp-tip-row"><span><i style={{ background: COLOR_OPT_OUT }} />Asked to stop (7 days)</span><b>{rate(p.optPct / 100)}</b></div>}
      <div className="rp-tip-t" style={{ marginTop: 6 }}>This day</div>
      <div className="rp-tip-row"><span>Texts sent</span><b>{num(p.sent)}</b></div>
      <div className="rp-tip-row"><span><i style={{ background: COLOR_FAILED }} />Failed</span><b>{num(p.failed)} · {rate(p.failureRate)}</b></div>
      <div className="rp-tip-row"><span><i style={{ background: COLOR_OPT_OUT }} />Asked to stop</span><b>{num(p.optOuts)} of {num(p.reached)} · {rate(p.optOutRate)}</b></div>
      {p.small && p.sent > 0 && <div className="sms-tip-note">This day alone had fewer than {minTexts} texts — too few to judge by itself.</div>}
      {p.warnings.length > 0 && <div className="sms-tip-note">Over the {p.warnings.map((w) => (w === "optOut" ? "opt-out" : "failure")).join(" and ")} limit.</div>}
    </div>
  );
}

/** A day's dot: solid when that single day went over a limit, none otherwise. */
const healthDot = (color: string, key: "optOut" | "failure") => (props: { cx?: number; cy?: number; payload?: HealthPoint; index?: number }) => {
  const { cx, cy, payload: p } = props;
  if (cx == null || cy == null || !p || p.sent === 0) return <g key={props.index} />;
  if (p.warnings.includes(key)) return <circle key={props.index} cx={cx} cy={cy} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />;
  return <g key={props.index} />;
};

/** The carrier-health banner text, or null when nothing breached. */
export function healthWarning(h: SmsReport["carrierHealth"]): string | null {
  const parts: string[] = [];
  if (h.last7.warnings.includes("optOut")) parts.push(`${rate(h.last7.optOutRate)} of people reached in the last 7 days asked to stop (the warning level is ${pct(h.thresholds.optOutRate)})`);
  if (h.last7.warnings.includes("failure")) parts.push(`${rate(h.last7.failureRate)} of texts failed in the last 7 days (the warning level is ${pct(h.thresholds.failureRate)})`);
  if (h.breachDays.length) {
    const shown = h.breachDays.slice(0, 4).map(dayLabel).join(", ");
    parts.push(`${num(h.breachDays.length)} ${h.breachDays.length === 1 ? "day" : "days"} in this period went over a limit (${shown}${h.breachDays.length > 4 ? "…" : ""})`);
  }
  return parts.length ? `${parts.join("; ")}.` : null;
}

export function CarrierHealthSection({ data, id }: { data: SmsReport; id: string }) {
  const h = data.carrierHealth;
  const rolled = rollingHealth(h.days, CHART_MIN_TEXTS);
  const pts: HealthPoint[] = h.days.map((d, i) => ({ ...d, label: dayLabel(d.day), ...rolled[i] }));
  const any = pts.some((p) => p.sent > 0);
  const top = Math.max(h.thresholds.failureRate * 100 * 1.3, ...pts.map((p) => Math.max(p.optPct ?? 0, p.failPct ?? 0)));
  const l7 = h.last7;
  return (
    <section id={id} className="panel rp-chart sms-health">
      <div className="rp-chart-head">
        <div>
          <h3>Carrier health</h3>
          <span className="rp-chart-sub">
            Opt-out and failure rates over the 7 days up to each day, for ALL texting from your numbers (the minerals switch and filters don't apply — carriers judge the numbers). Solid dots: a single day over a limit.
          </span>
        </div>
      </div>
      <StatStrip min={170} cells={[
        { ...tile("Opt-outs, last 7 days", rate(l7.optOutRate), { sub: `${num(l7.optOuts)} of ${num(l7.reached)} people reached · limit ${pct(h.thresholds.optOutRate)}` }),
          tone: l7.warnings.includes("optOut") ? "danger" : undefined },
        { ...tile("Failed texts, last 7 days", rate(l7.failureRate), { sub: `${num(l7.failed)} of ${num(l7.sent)} texts · limit ${pct(h.thresholds.failureRate)}` }),
          tone: l7.warnings.includes("failure") ? "danger" : undefined },
        { ...tile("Days over a limit", num(h.breachDays.length), { sub: "In this period" }), tone: h.breachDays.length ? "warn" : undefined },
      ]} />
      {!any ? <p className="rp-empty">No texts in this period.</p> : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={pts} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line-faint)" />
            <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={16} />
            <YAxis domain={[0, Math.ceil(top / 5) * 5]} tickFormatter={(v: number) => `${v}%`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
            <Tooltip content={<HealthTip minTexts={h.thresholds.minTexts} />} cursor={{ stroke: "var(--line-3)" }} isAnimationActive={false} wrapperStyle={{ outline: "none", zIndex: 50 }} />
            <ReferenceLine y={h.thresholds.optOutRate * 100} stroke={COLOR_OPT_OUT} strokeDasharray="4 4" strokeOpacity={0.7} ifOverflow="extendDomain" />
            <ReferenceLine y={h.thresholds.failureRate * 100} stroke={COLOR_FAILED} strokeDasharray="4 4" strokeOpacity={0.7} ifOverflow="extendDomain" />
            <Line type="linear" dataKey="optPct" name="Opt-out rate" stroke={COLOR_OPT_OUT} strokeWidth={2} dot={healthDot(COLOR_OPT_OUT, "optOut")}
              activeDot={{ r: 4 }} isAnimationActive={false} />
            <Line type="linear" dataKey="failPct" name="Failure rate" stroke={COLOR_FAILED} strokeWidth={2} dot={healthDot(COLOR_FAILED, "failure")}
              activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
      <div className="cl">
        <span className="cl-item"><span className="cl-line" style={{ background: COLOR_OPT_OUT }} />Opt-out rate (people who asked to stop ÷ people reached)</span>
        <span className="cl-item"><span className="cl-line" style={{ background: COLOR_FAILED }} />Failure rate (failed ÷ sent)</span>
        <span className="cl-item"><span className="cl-line dashed" />Warning level (dashed)</span>
        <span className="cl-item">Gaps: fewer than {CHART_MIN_TEXTS} texts in those 7 days</span>
      </div>
    </section>
  );
}
