import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { Banner, EmptyState, Spinner } from "../../components/ui";
import { StatStrip, Segmented, type StatCell } from "../../components/kit";
import { SortableTable, type Column } from "../../components/SortableTable";
import { CollapsibleSection } from "../../components/CollapsibleSection";
import { fmtDate, fmtDateTime, num, pct } from "../../lib/format";
import { CHART_COLORS } from "../../lib/charts";
import {
  BUCKET_LABEL, SCOPE_LABEL, SMALL_SAMPLE, fmtCost, fmtDuration, smsQuery, touchLabel, trendLabel, trendTitle, withRow,
  type BreakdownRow, type DrillRow, type SmsFilterOptions, type SmsFilters, type SmsKpis, type SmsReport, type SmsScope, type SmsStatus,
  type TouchRate, type TrendBucket, type TrendPoint,
} from "../../lib/smsReport";
import { DeltaPill } from "./DeltaPill";
import { SmsDrill, type DrillSpec } from "./SmsDrill";
import {
  BestTimeSection, CarrierHealthSection, CostSection, FunnelSection, PhoneListsSection, SpeedSection, healthWarning,
} from "./SmsSections";

const AXIS_TICK = { fontSize: 11, fill: "var(--ink-4)" };
/** The Carrier health section, for the warning banner's link. */
const HEALTH_ID = "sms-carrier-health";
const COLOR_SENT = CHART_COLORS[0];
const COLOR_REPLY = CHART_COLORS[1];

/** The SMS filter choices (team members incl. Automated / unassigned, tags, sources) of the scope's contacts. */
export function useSmsFilterOptions(enabled: boolean, scope: SmsScope): SmsFilterOptions | null {
  const [loaded, setLoaded] = useState<{ scope: SmsScope; opts: SmsFilterOptions } | null>(null);
  useEffect(() => {
    if (!enabled || loaded?.scope === scope) return;
    let live = true;
    api.get<SmsFilterOptions>(`/reports/sms/filters?scope=${scope}`)
      .then((opts) => { if (live) setLoaded({ scope, opts }); })
      .catch(() => {});
    return () => { live = false; };
  }, [enabled, scope, loaded?.scope]);
  // The other scope's choices stay usable until this scope's arrive.
  return loaded?.opts ?? null;
}

/** Connection state; re-checked every 20s while the first import runs. */
function useSmsStatus(): { status: SmsStatus | null; failed: boolean } {
  const [status, setStatus] = useState<SmsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const load = () => api.get<SmsStatus>("/reports/sms/status")
      .then((s) => {
        if (!live) return;
        setStatus(s);
        setFailed(false);
        if (s.phase === "importing") timer = window.setTimeout(load, 20_000);
      })
      .catch(() => { if (live) setFailed(true); });
    load();
    return () => { live = false; window.clearTimeout(timer); };
  }, []);
  return { status, failed };
}

/** Display value of each KPI (current period or the comparison window). */
const KPI_FMT: Record<keyof SmsKpis, (k: SmsKpis) => string> = {
  textsSent: (k) => num(k.textsSent), textsDelivered: (k) => num(k.textsDelivered), textsFailed: (k) => num(k.textsFailed),
  repliesReceived: (k) => num(k.repliesReceived), contactsTexted: (k) => num(k.contactsTexted),
  contactsReached: (k) => num(k.contactsReached), contactsResponded: (k) => num(k.contactsResponded),
  responseRate: (k) => (k.responseRate == null ? "N/A" : pct(k.responseRate)), optedOut: (k) => num(k.optedOut),
  optOutRate: (k) => (k.optOutRate == null ? "N/A" : pct(k.optOutRate)),
  avgTextsPerContact: (k) => (k.avgTextsPerContact == null ? "N/A" : String(Number(k.avgTextsPerContact.toFixed(1)))),
  avgResponseSeconds: (k) => fmtDuration(k.avgResponseSeconds), medianResponseSeconds: (k) => fmtDuration(k.medianResponseSeconds),
  wrongNumbers: (k) => num(k.wrongNumbers), wrongNumberRate: (k) => (k.wrongNumberRate == null ? "N/A" : pct(k.wrongNumberRate)),
  opportunities: (k) => num(k.opportunities), interestedRate: (k) => (k.interestedRate == null ? "N/A" : pct(k.interestedRate)),
  offers: (k) => num(k.offers), offerAcceptanceRate: (k) => (k.offerAcceptanceRate == null ? "N/A" : pct(k.offerAcceptanceRate)),
  closedDeals: (k) => num(k.closedDeals),
  textingCost: (k) => fmtCost(k.textingCost), costPerReply: (k) => fmtCost(k.costPerReply), costPerOpportunity: (k) => fmtCost(k.costPerOpportunity),
  costPerOffer: (k) => fmtCost(k.costPerOffer), costPerClosedDeal: (k) => fmtCost(k.costPerClosedDeal),
  medianAnswerSeconds: (k) => fmtDuration(k.medianAnswerSeconds),
  answeredWithinHourRate: (k) => (k.answeredWithinHourRate == null ? "N/A" : pct(k.answeredWithinHourRate)),
  neverAnsweredRate: (k) => (k.neverAnsweredRate == null ? "N/A" : pct(k.neverAnsweredRate)),
};

type Dim = "senders" | "tags" | "sources";
const DIM_LABEL: Record<Dim, string> = { senders: "Team member", tags: "Tag", sources: "Source" };

interface ViewProps {
  allTime: boolean;
  range: { from: string; to: string };
  cmp: { from: string; to: string } | null;
  filters: SmsFilters;
  /** "Team member: Maria" … for the summary card. */
  filterChips: string[];
  /** The report header mark (same as the Deals view). */
  execIcon: ReactNode;
  /** Minerals only (default) or all texting, and the switch's setter. */
  scope: SmsScope;
  onScope: (s: SmsScope) => void;
}

/**
 * Reports → SMS performance: outreach volume, response rates (overall and by
 * text number), time to first reply, opt-outs, the trend, and breakdowns by
 * team member / tag / source — read from the org's HighLevel sync.
 */
export function SmsPerformance(props: ViewProps) {
  const { allTime, range, cmp, filters, scope } = props;
  const { status, failed: statusFailed } = useSmsStatus();
  const [data, setData] = useState<SmsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const query = useMemo(() => smsQuery({ allTime, range, cmp, filters, scope }), [allTime, range, cmp, filters, scope]);
  const reportable = !!status && (status.connected || status.hasData);
  // While the first import runs, each status poll that shows more texts refreshes the numbers.
  const importTick = status?.phase === "importing" ? status.imported : 0;

  useEffect(() => {
    if (!reportable || (!allTime && (!range.from || !range.to))) return;
    let live = true;
    setLoading(true);
    // Debounced like the Deals view: rapid filter picks coalesce into one request.
    const t = window.setTimeout(() => {
      api.get<SmsReport>(`/reports/sms?${query}`)
        .then((d) => { if (live) { setData(d); setError(false); } })
        .catch(() => { if (live) setError(true); })
        .finally(() => { if (live) setLoading(false); });
    }, 300);
    return () => { live = false; window.clearTimeout(t); };
  }, [query, reportable, allTime, range.from, range.to, importTick]);

  if (statusFailed) return <Banner kind="error">Could not load SMS performance. Try again in a moment.</Banner>;
  if (!status) return <Spinner label="Checking the HighLevel connection…" />;
  return <SmsReportView {...props} status={status} data={data} loading={loading} error={error} query={query} />;
}

/** The SMS view for a loaded status (and report, once it arrives). */
export function SmsReportView({ filterChips, execIcon, scope, onScope, status, data, loading, error, query }: ViewProps & {
  status: SmsStatus; data: SmsReport | null; loading: boolean; error: boolean; query: string;
}) {
  const nav = useNavigate();
  const { user, can } = useAuth();
  const canManage = can("manageApiIntegrations");
  const [dim, setDim] = useState<Dim>("senders");
  const [drill, setDrill] = useState<(DrillSpec & { query: string }) | null>(null);
  const reportable = status.connected || status.hasData;

  const settingsLink = <Link to="/settings/integrations" className="link-btn">Settings → Integrations</Link>;
  // Where the minerals filter, price and response window are set.
  const hlSettings = canManage ? <><Link to="/settings/integrations" className="link-btn">Settings → Integrations</Link> → HighLevel</> : <>Settings → Integrations → HighLevel (ask an admin)</>;
  if (!reportable) {
    return (
      <div className="panel">
        <EmptyState title="See how your text outreach is performing">
          <p>
            Connect your HighLevel account and this page shows how many texts went out, how many people replied — overall and
            after the 1st, 2nd and 3rd text — how quickly they replied, who asked to stop, and how each team member, tag and
            source is doing. The CRM only reads from HighLevel; it never sends texts or changes anything there.
          </p>
          {canManage
            ? <button type="button" className="primary sms-connect" onClick={() => nav("/settings/integrations")}>Connect HighLevel</button>
            : <p className="muted">Ask an admin to connect HighLevel in Settings → Integrations.</p>}
        </EmptyState>
      </div>
    );
  }

  const banners: ReactNode[] = [];
  const location = status.locationName ? <> ({status.locationName})</> : null;
  if (!status.connected) {
    banners.push(
      <Banner key="off" kind="warn">
        <b>HighLevel is disconnected.</b> These numbers are the texting history synced before it was disconnected
        {status.lastSyncAt && <> (last synced {fmtDateTime(status.lastSyncAt)})</>}.
        {canManage ? <> Reconnect it in {settingsLink}.</> : <> Ask an admin to reconnect it.</>}
      </Banner>,
    );
  } else if (status.status === "ERROR") {
    banners.push(
      <Banner key="err" kind="warn">
        <b>HighLevel sync has a problem</b>, so these numbers may be out of date
        {status.lastSyncAt && <> (last synced {fmtDateTime(status.lastSyncAt)})</>}.
        {canManage
          ? <>{status.lastError && <> HighLevel said: “{status.lastError}”.</>} Check it in {settingsLink}.</>
          : <> An admin can check it in Settings → Integrations.</>}
      </Banner>,
    );
  }
  if (status.connected && status.phase === "preview") {
    banners.push(
      <Banner key="preview" kind="info">
        <b>HighLevel is connected{location}.</b>
        {status.previewTexts != null && <> About {num(status.previewTexts)} texts are ready to import.</>}
        {canManage ? <> Start the import in {settingsLink}</> : <> An admin can start the import in Settings → Integrations</>} — the numbers appear here once it runs.
      </Banner>,
    );
  }
  if (status.connected && status.phase === "importing") {
    banners.push(
      <Banner key="importing" kind="info">
        <b>Importing your HighLevel texting history</b> — {num(status.imported)} texts so far
        {status.previewTexts != null && status.previewTexts > 0 && <> of about {num(status.previewTexts)}</>}. The numbers fill in as it runs.
      </Banner>,
    );
  }
  if (scope === "minerals" && status.hasData && status.minerals === 0 && status.realEstate + status.unclassified > 0) {
    banners.push(
      <Banner key="no-minerals" kind="info">
        <b>Nobody texted is sorted into minerals yet</b>, so “Minerals only” shows nothing. {num(status.unclassified)} texted{" "}
        {status.unclassified === 1 ? "person isn't" : "people aren't"} classified — choose your minerals tags and pipelines in {hlSettings}, or{" "}
        <button type="button" className="link-btn sms-inline-btn" onClick={() => onScope("all")}>switch to All texting</button>.
      </Banner>,
    );
  }
  const healthText = data ? healthWarning(data.carrierHealth) : null;
  if (healthText) {
    banners.push(
      <Banner key="health" kind="warn">
        <b>Carrier warning:</b> {healthText} Carriers can start filtering texts from numbers like this.{" "}
        <button type="button" className="link-btn sms-inline-btn"
          onClick={() => document.getElementById(HEALTH_ID)?.scrollIntoView({ behavior: "smooth", block: "start" })}>See Carrier health</button>
      </Banner>,
    );
  }
  if (error && data) banners.push(<Banner key="stale" kind="error">Could not refresh the numbers — showing the last ones loaded.</Banner>);
  const pendingRecount = data?.notes.summariesPending ?? 0;
  if (pendingRecount > 0) {
    banners.push(
      <Banner key="recount" kind="info">
        {num(pendingRecount)} {pendingRecount === 1 ? "contact is" : "contacts are"} being recounted after a settings change — response numbers update after the next sync.
      </Banner>,
    );
  }

  if (!status.hasData) {
    return (
      <div className="rp-body">
        {banners}
        <div className="panel"><EmptyState title="No texts imported yet">Numbers appear here as soon as the HighLevel import brings in your texting history.</EmptyState></div>
      </div>
    );
  }
  if (error && !data) return <div className="rp-body">{banners}<Banner kind="error">Could not load SMS performance for this period.</Banner></div>;
  if (!data) return <div className="rp-body">{banners}<Spinner label="Building the SMS report…" /></div>;

  const k = data.kpis;
  const periodLabel = `${fmtDate(data.range.from)} – ${fmtDate(data.range.to)}`;
  const open = (spec: DrillSpec, row?: DrillRow) => setDrill({ ...spec, query: row ? withRow(query, row) : query });
  const split = data.scopeInfo.texted;

  /** One KPI tile: value + comparison pill (points for rates), hint and the prior value when comparing. */
  function cell(key: keyof SmsKpis, o: {
    label: string; hint?: string; invert?: boolean; tone?: StatCell["tone"]; title?: string; onClick?: () => void;
  }): StatCell {
    const d = data!.deltas?.[key];
    const text = KPI_FMT[key](k);
    const prior = data!.previous ? `Prior ${KPI_FMT[key](data!.previous)}` : null;
    return {
      label: o.label,
      value: (
        <>
          <span className={`rp-val ${text === "N/A" ? "rp-faint" : ""}`}>{text}</span>
          {d != null && <DeltaPill d={d} kind={data!.deltaKind[key]} invert={o.invert} />}
        </>
      ),
      tone: text === "N/A" ? undefined : o.tone,
      sub: [o.hint, prior].filter(Boolean).join(" · ") || undefined,
      title: o.title,
      onClick: o.onClick,
    };
  }

  const outreach: StatCell[] = [
    cell("textsSent", {
      label: "Texts sent", hint: `${num(k.textsDelivered)} delivered · ${num(k.textsFailed)} failed`,
      title: "Every text that went out in the period, including ones that failed. Scheduled texts count once they go out.",
      onClick: () => open({ title: "People texted", set: "texted" }),
    }),
    cell("contactsTexted", {
      label: "Contacts texted", hint: "Sent at least one text",
      onClick: () => open({ title: "People texted", set: "texted" }),
    }),
    cell("avgTextsPerContact", {
      label: "Texts per contact", hint: "Texts sent ÷ contacts texted",
      onClick: () => open({ title: "People texted", set: "texted" }),
    }),
    cell("repliesReceived", {
      label: "Replies received", hint: "Every text that came back",
      title: "All incoming texts in the period, follow-up messages included. Response rates count each person once.",
    }),
  ];
  const responses: StatCell[] = [
    cell("contactsReached", {
      label: "Contacts reached", hint: "First text delivered in this period",
      title: "People whose first delivered text (or text sent with no receipt either way) is in this period. Their replies count here even if they come later.",
      onClick: () => open({ title: "People reached", set: "reached" }),
    }),
    cell("contactsResponded", {
      label: "Contacts who replied", hint: `Within ${data.windowDays} days of a text`,
      onClick: () => open({ title: "People who replied", set: "responded" }),
    }),
    cell("responseRate", {
      label: "Response rate", tone: "success",
      hint: k.contactsReached ? `${num(k.contactsResponded)} of ${num(k.contactsReached)} reached` : "Nobody reached in this period",
      onClick: () => open({ title: "People who replied", set: "responded" }),
    }),
    cell("medianResponseSeconds", {
      label: "Time to first reply", invert: true,
      hint: k.avgResponseSeconds == null ? "No replies in this period" : `Typical (median) · average ${fmtDuration(k.avgResponseSeconds)}`,
      title: "From the first text that reached someone to their reply. Half of the replies came faster than this.",
      onClick: () => open({ title: "People who replied", set: "responded" }),
    }),
    cell("optOutRate", {
      label: "Opt-out rate", invert: true,
      hint: `${num(k.optedOut)} asked to stop`,
      title: "People whose first reply asked to stop (STOP, unsubscribe, remove me…) — never counted as a response.",
      onClick: () => open({ title: "People who asked to stop", set: "optedOut" }),
    }),
    cell("wrongNumberRate", {
      label: "Wrong-number rate", invert: true,
      hint: `${num(k.wrongNumbers)} ${k.wrongNumbers === 1 ? "person" : "people"} reached`,
      title: "People who replied that we had the wrong person, or whose number XLeads tagged as a wrong number. Not a response — the outreach carries on with their next number.",
      onClick: () => open({ title: "Wrong numbers", set: "wrongNumber" }),
    }),
  ];

  const bdRows = data.breakdowns[dim];
  const bdCols: Column<BreakdownRow>[] = [
    { key: "name", header: DIM_LABEL[dim], type: "text", minWidth: 160, value: (r) => r.name,
      render: (r) => (r.key.startsWith("(") || r.key === "none" ? <span className="muted">{r.name}</span> : <strong>{r.name}</strong>) },
    { key: "reached", header: "Reached", type: "number", align: "right", value: (r) => r.contactsReached, render: (r) => num(r.contactsReached) },
    { key: "replied", header: "Replied", type: "number", align: "right", value: (r) => r.responded, render: (r) => num(r.responded) },
    { key: "rate", header: "Response rate", type: "number", align: "right", value: (r) => r.responseRate,
      render: (r) => (r.responseRate == null ? <span className="muted">N/A</span> : pct(r.responseRate)) },
    { key: "stop", header: "Asked to stop", type: "number", align: "right", value: (r) => r.optedOut, render: (r) => num(r.optedOut) },
    { key: "sent", header: "Texts sent", type: "number", align: "right", value: (r) => r.textsSent, render: (r) => num(r.textsSent) },
    { key: "median", header: "Typical time to reply", type: "number", align: "right", value: (r) => r.medianResponseSeconds,
      render: (r) => (r.medianResponseSeconds == null ? <span className="muted">—</span> : fmtDuration(r.medianResponseSeconds)) },
  ];
  const ROW_DIM: Record<Dim, DrillRow["dim"]> = { senders: "sender", tags: "tag", sources: "source" };
  const drillRow = (r: BreakdownRow) => open({ title: `People reached · ${r.name}`, set: "reached" }, { dim: ROW_DIM[dim], key: r.key });
  const cntLink = (n: number, set: DrillSpec["set"], title: string) =>
    n > 0 ? <button type="button" className="link-btn sms-inline-btn" onClick={() => open({ title, set })}>{num(n)}</button> : <>{num(n)}</>;

  return (
    <div className="rp-body sms-body">
      {banners}

      <section className="exec-card">
        {execIcon}
        <div style={{ minWidth: 0 }}>
          <div className="exec-title">{user?.organization?.name ?? "Mineral Hub"} · SMS performance report</div>
          <p className="exec-text">
            <b>Summary.</b> Over this period the team sent <b>{num(k.textsSent)}</b> {k.textsSent === 1 ? "text" : "texts"} to{" "}
            <b>{num(k.contactsTexted)}</b> {k.contactsTexted === 1 ? "person" : "people"}.{" "}
            {k.contactsReached > 0 ? (
              <>
                Of the <b>{num(k.contactsReached)}</b> {k.contactsReached === 1 ? "person" : "people"} first reached in this period,{" "}
                <b>{num(k.contactsResponded)}</b> replied (<b className="pos">{pct(k.responseRate)}</b>) and <b>{num(k.optedOut)}</b> asked to stop
                ({pct(k.optOutRate)}).
                {k.medianResponseSeconds != null && <> The typical reply came <b>{fmtDuration(k.medianResponseSeconds)}</b> after the first text.</>}
              </>
            ) : <>Nobody was reached for the first time in this period.</>}
            {k.opportunities > 0 && <> <b>{num(k.opportunities)}</b> became {k.opportunities === 1 ? "an opportunity" : "opportunities"}, <b>{num(k.offers)}</b> got an offer and <b>{num(k.closedDeals)}</b> closed.</>}
            {k.textingCost != null && <> Texting cost <b>{fmtCost(k.textingCost)}</b>.</>}
            {data.compare && <> Compared to {fmtDate(data.compare.from)} – {fmtDate(data.compare.to)}.</>}
          </p>
          <p className="exec-text exec-filters">
            <b>{SCOPE_LABEL[scope]}.</b>{" "}
            {scope === "minerals" ? (
              <>
                Counting the {num(split.minerals)} {split.minerals === 1 ? "person" : "people"} texted in this period who are sorted into minerals.
                {" "}Left out: {cntLink(split.realEstate, "realEstate", "Real-estate people texted")} real estate and{" "}
                {cntLink(split.unclassified, "unclassified", "People texted who aren't classified")} not classified.
              </>
            ) : (
              <>
                People texted in this period: {num(split.minerals)} minerals, {cntLink(split.realEstate, "realEstate", "Real-estate people texted")} real estate,{" "}
                {cntLink(split.unclassified, "unclassified", "People texted who aren't classified")} not classified.
              </>
            )}
            {!data.scopeInfo.saved && <> The minerals filter is still the suggested one (county and “mineral” tags, pipelines named “Minerals”) — review it in {hlSettings}.</>}
          </p>
          <p className="exec-text exec-filters">
            {periodLabel} · from HighLevel{status.locationName && <> · {status.locationName}</>}
            {status.lastSyncAt && <> · last synced {fmtDateTime(status.lastSyncAt)}</>}
            {loading && <> · updating…</>}
          </p>
          {filterChips.length > 0 && <p className="exec-text exec-filters"><b>Filters:</b> {filterChips.join(" · ")}</p>}
        </div>
      </section>

      <div className="rp-kgroup">
        <div className="rp-kgroup-label">Outreach</div>
        <StatStrip min={200} cells={outreach} />
      </div>
      <div className="rp-kgroup">
        <div className="rp-kgroup-label">Responses</div>
        <StatStrip min={200} cells={responses} />
      </div>

      <div className="chart-grid">
        <section className="panel rp-chart">
          <div className="rp-chart-head">
            <div>
              <h3>Response by text number</h3>
              <span className="rp-chart-sub">People first reached in this period</span>
            </div>
          </div>
          {k.contactsReached === 0 ? <p className="rp-empty">Nobody was reached for the first time in this period.</p> : (
            <TouchChart rows={data.byTouch}
              onPick={(t) => open({ title: `Replied after ${touchLabel(t).toLowerCase()}`, set: "responded", touch: t.touch })} />
          )}
          <div className="cl">
            <span className="cl-item"><span className="cl-dot" style={{ background: COLOR_SENT }} />Replied after this text</span>
            <span className="cl-item"><span className="cl-line" style={{ background: COLOR_REPLY }} />Replied by this text (total)</span>
            <span className="cl-item"><span className="cl-dot sms-small-dot" style={{ borderColor: COLOR_SENT }} />Fewer than {SMALL_SAMPLE} people got it</span>
          </div>
          <p className="sms-caption">
            Bars: of the people who got this text without having replied yet, the share who replied after it. Line: the share of
            everyone reached who had replied by then.
          </p>
        </section>

        <section className="panel rp-chart">
          <div className="rp-chart-head">
            <div>
              <h3>Texting volume</h3>
              <span className="rp-chart-sub">{BUCKET_LABEL[data.trend.bucket]} · texts sent vs replies received</span>
            </div>
          </div>
          {k.textsSent === 0 && k.repliesReceived === 0 ? <p className="rp-empty">No texts in this period.</p>
            : <VolumeChart points={data.trend.points} bucket={data.trend.bucket} />}
          <div className="cl">
            <span className="cl-item"><span className="cl-dot" style={{ background: COLOR_SENT }} />Texts sent</span>
            <span className="cl-item"><span className="cl-dot" style={{ background: COLOR_REPLY }} />Replies received</span>
          </div>
        </section>
      </div>

      <FunnelSection data={data} cell={cell} open={open} settings={hlSettings} />
      <CostSection data={data} cell={cell} settings={hlSettings} />
      <SpeedSection data={data} cell={cell} open={open} />
      <BestTimeSection data={data} />
      <PhoneListsSection data={data} open={open} />
      <CarrierHealthSection data={data} id={HEALTH_ID} />

      <section className="panel rp-chart sms-breakdown">
        <div className="rp-chart-head">
          <div>
            <h3>Breakdown</h3>
            <span className="rp-chart-sub">
              {dim === "tags"
                ? "A contact with several tags counts under each of them, so the rows can add up to more than the total."
                : dim === "senders"
                  ? "Replies are credited to whoever sent the person's first text (or the contact's assignee for automated texts)."
                  : "The HighLevel Source field — often the list a contact came from."}
            </span>
          </div>
          <Segmented ariaLabel="Breakdown by" value={dim} onChange={setDim}
            options={[{ value: "senders", label: "Team member" }, { value: "tags", label: "Tag" }, { value: "sources", label: "Source" }]} />
        </div>
        <SortableTable columns={bdCols} rows={bdRows} rowKey={(r) => r.key} onRowClick={drillRow}
          empty="No texting activity in this period." />
      </section>

      <CollapsibleSection title="How these numbers are counted" sub="Plain-English definitions for every figure on this page">
        <ul className="sms-howto">
          <li>
            <b>Minerals only / All texting.</b> Your HighLevel account also does real-estate texting, so by default every figure counts only people
            sorted into minerals: anyone in a minerals pipeline or carrying a minerals tag. Otherwise a real-estate tag makes them real estate, and
            anyone else is “not classified” — shown separately so nothing goes missing. The tags and pipelines are chosen in {hlSettings}.
            “All texting” counts everyone.
          </li>
          <li><b>Texts sent</b> counts every text that went out in the period, including ones that failed. Texts that are still scheduled don’t count until they go out.</li>
          <li>
            <b>Reached</b> means HighLevel reported the text as delivered — or still shows it as “sent” with no delivery receipt either way.
            Failed texts never count. The response rates below count {num(data.notes.reachedTexts)} texts (each person’s texts up to
            their first reply); {num(data.notes.unconfirmedTexts)} of them had no delivery receipt and are counted as reached.
          </li>
          <li>
            <b>Replied</b> means the person’s first text back came within <b>{data.windowDays} days</b> of our latest text. The response window
            is set in {canManage ? settingsLink : "Settings → Integrations"} → HighLevel.{" "}
            {data.notes.lateReplies > 0
              ? <button type="button" className="link-btn" onClick={() => open({ title: "People who replied late", set: "lateReply" })}>{num(data.notes.lateReplies)} {data.notes.lateReplies === 1 ? "person" : "people"} replied after the window</button>
              : "Nobody replied after the window"} — shown as “Replied late”, not as a response.
          </li>
          <li><b>One person = one response.</b> Follow-up messages in the same conversation never add to response numbers. (“Replies received” counts every incoming text.)</li>
          <li><b>Opt-outs are counted separately.</b> A first reply asking to stop (STOP, unsubscribe, remove me…) is an opt-out, never a response.</li>
          <li>
            <b>Response numbers belong to the period of the person’s first text.</b> Someone first texted in October who replies in November counts
            for October. Texting volume (sent, delivered, replies received) uses the date each text was sent.
          </li>
          <li>
            <b>People who texted first are left out</b> of response rates —{" "}
            {data.notes.inboundFirstContacts > 0
              ? <button type="button" className="link-btn" onClick={() => open({ title: "People who texted us first", set: "inboundFirst" })}>{num(data.notes.inboundFirstContacts)} in this period</button>
              : "none in this period"}.
          </li>
          <li><b>Time to first reply</b> runs from the first text that reached the person to their reply. “Typical” is the median: half of the replies came faster.</li>
          <li>
            <b>Wrong numbers</b> are people who replied that we had the wrong person, or whose number XLeads tagged “wrong number”. That reply is
            not a response and doesn't end the outreach — XLeads usually moves on to the person's next number.
          </li>
          <li>
            <b>Funnel &amp; offers</b> come from the stage each person's HighLevel opportunity is in (minerals pipelines in “Minerals only”). A person
            counts once, at the furthest step reached; offers that later died still count as offers. Opportunities created before the person's
            first text aren't credited to texting.
          </li>
          <li>
            <b>Cost</b> is billable text segments sent × your price per segment. A long text or one with an emoji costs more than one segment.
            Incoming texts aren't charged in these figures. Cost is dated by the day texts were sent; results by each person's first text.
          </li>
          <li>
            <b>Speed to lead</b> runs from a person's reply to the next text a team member typed. Automated follow-ups don't count as an answer.
          </li>
          <li>
            <b>Best time to text</b> compares response rates by the weekday and hour of each person's first text. Hours with fewer than{" "}
            {data.bestTime.minSample} people are greyed out and never called “best”.
          </li>
          <li>
            <b>Phone lists</b> read the tags XLeads' phone-rotation workflows add. “Needed 2nd/3rd number” means XLeads switched to another of the
            person's numbers; “All numbers used up” means none of them worked.
          </li>
          <li>
            <b>Carrier health</b> checks each day's opt-out rate (people who asked to stop ÷ people reached) and failure rate (failed ÷ sent) against
            the levels where carriers tend to start filtering: {pct(data.carrierHealth.thresholds.optOutRate)} and {pct(data.carrierHealth.thresholds.failureRate)}.
            Days with fewer than {num(data.carrierHealth.thresholds.minTexts)} texts aren't judged. It always counts all texting.
          </li>
          <li>
            <b>Team members:</b> a reply is credited to whoever sent the person’s first text; for automated texts, to the person the contact is assigned to
            in HighLevel; otherwise “Automated / unassigned”. Texts sent are credited to the sender, or the assignee for automated texts.
          </li>
          <li>
            Still waiting on a reply:{" "}
            <button type="button" className="link-btn" onClick={() => open({ title: "People with no reply yet", set: "noReply" })}>see who hasn’t replied</button>.
          </li>
        </ul>
      </CollapsibleSection>

      {drill && <SmsDrill spec={drill} query={drill.query} periodLabel={periodLabel} onClose={() => setDrill(null)} />}
    </div>
  );
}

interface TouchRow extends TouchRate { label: string; ratePct: number | null; cumPct: number | null; small: boolean }

function TouchTip({ active, payload }: { active?: boolean; payload?: { payload: TouchRow }[] }) {
  if (!active || !payload?.length) return null;
  const t = payload[0].payload;
  return (
    <div className="rp-tip">
      <div className="rp-tip-t">{t.orLater ? `${t.touch}th text or later` : `Text ${t.touch}`}</div>
      <div className="rp-tip-row"><span>Got this text</span><b>{num(t.received)} {t.received === 1 ? "person" : "people"}</b></div>
      <div className="rp-tip-row"><span><i style={{ background: COLOR_SENT }} />Replied after it</span><b>{num(t.responded)} · {t.rate == null ? "N/A" : pct(t.rate)}</b></div>
      <div className="rp-tip-row"><span><i style={{ background: COLOR_REPLY }} />Replied by this text</span><b>{num(t.cumulativeResponded)} · {t.cumulativeRate == null ? "N/A" : pct(t.cumulativeRate)}</b></div>
      {t.small && <div className="sms-tip-note">Small sample — fewer than {SMALL_SAMPLE} people got this text.</div>}
    </div>
  );
}

/** Bars = replied after text n (of those who got it); line = replied by text n (of everyone reached). */
function TouchChart({ rows, onPick }: { rows: TouchRate[]; onPick: (t: TouchRate) => void }) {
  const data: TouchRow[] = rows.map((t) => ({
    ...t, label: touchLabel(t, true),
    ratePct: t.rate == null ? null : t.rate * 100,
    cumPct: t.cumulativeRate == null ? null : t.cumulativeRate * 100,
    small: t.received < SMALL_SAMPLE,
  }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--line-faint)" />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={(v: number) => `${v}%`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
        <Tooltip content={<TouchTip />} cursor={{ fill: "var(--chart-col-hover)" }} isAnimationActive={false} wrapperStyle={{ outline: "none", zIndex: 50 }} />
        <Bar dataKey="ratePct" name="Replied after this text" radius={[3, 3, 0, 0]} maxBarSize={44} isAnimationActive={false} cursor="pointer"
          onClick={(e: { payload?: TouchRow }) => { if (e?.payload && e.payload.responded > 0) onPick(e.payload); }}>
          {data.map((d, i) => (
            <Cell key={i} fill={COLOR_SENT} fillOpacity={d.small ? 0.25 : 1}
              stroke={d.small ? COLOR_SENT : "none"} strokeDasharray={d.small ? "3 3" : undefined} strokeWidth={d.small ? 1 : 0} />
          ))}
        </Bar>
        <Line type="linear" dataKey="cumPct" name="Replied by this text" stroke={COLOR_REPLY} strokeWidth={2.2}
          dot={{ r: 3, fill: COLOR_REPLY, strokeWidth: 0 }} connectNulls isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

interface VolRow extends TrendPoint { label: string; title: string }

function VolumeTip({ active, payload }: { active?: boolean; payload?: { payload: VolRow }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rp-tip">
      <div className="rp-tip-t">{p.title}</div>
      <div className="rp-tip-row"><span><i style={{ background: COLOR_SENT }} />Texts sent</span><b>{num(p.sent)}</b></div>
      <div className="rp-tip-row"><span>Delivered</span><b>{num(p.delivered)}</b></div>
      <div className="rp-tip-row"><span>Failed</span><b>{num(p.failed)}</b></div>
      <div className="rp-tip-row"><span><i style={{ background: COLOR_REPLY }} />Replies received</span><b>{num(p.inbound)}</b></div>
    </div>
  );
}

function VolumeChart({ points, bucket }: { points: TrendPoint[]; bucket: TrendBucket }) {
  const rows: VolRow[] = points.map((p) => ({ ...p, label: trendLabel(p.period, bucket), title: trendTitle(p.period, bucket) }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }} barGap={1}>
        <CartesianGrid vertical={false} stroke="var(--line-faint)" />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={12} />
        <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} />
        <Tooltip content={<VolumeTip />} cursor={{ fill: "var(--chart-col-hover)" }} isAnimationActive={false} wrapperStyle={{ outline: "none", zIndex: 50 }} />
        <Bar dataKey="sent" name="Texts sent" fill={COLOR_SENT} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
        <Bar dataKey="inbound" name="Replies received" fill={COLOR_REPLY} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
