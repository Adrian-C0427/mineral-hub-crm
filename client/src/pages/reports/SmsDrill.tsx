import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import { Banner, ChipList, Modal, Spinner } from "../../components/ui";
import { Tag } from "../../components/kit";
import { SortableTable, type Column } from "../../components/SortableTable";
import { fmtDate, fmtDateLocal, fmtDateTime, num } from "../../lib/format";
import { formatPhone } from "../../lib/phone";
import {
  FUNNEL_DRILLS, OUTCOME_HINT, STATUS_KIND_LABEL, fmtDuration, furthestStepLabel, outcomeLabel, sentByLabel, wrongNumberLabel,
  type DrillSet, type SmsContactRow, type SmsTimelineMessage,
} from "../../lib/smsReport";

/** What a drill-down lists: one set of contacts for the report's period + filters. */
export interface DrillSpec { title: string; set: DrillSet; touch?: number }

const PAGE = 50;

const NO_ACCESS = (
  <Banner kind="info">
    You need contact access to see who these people are. Ask an admin to give your role the <b>View contacts</b> permission.
  </Banner>
);

/**
 * The people behind an SMS number: a paged contact list, and for any one of
 * them the texting timeline (when, which way, delivery status, who or what
 * sent it). Message wording is never stored in the CRM.
 */
export function SmsDrill({ spec, query, periodLabel, onClose }: {
  spec: DrillSpec;
  /** The report's query string (period + filters), as the report itself used. */
  query: string;
  periodLabel: string;
  onClose: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; rows: SmsContactRow[] } | null>(null);
  const [error, setError] = useState<"forbidden" | "failed" | null>(null);
  const [open, setOpen] = useState<SmsContactRow | null>(null);

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams(query);
    qs.set("set", spec.set);
    if (spec.touch != null) qs.set("touch", String(spec.touch));
    qs.set("limit", String(PAGE));
    qs.set("offset", String(offset));
    setError(null);
    api.get<{ total: number; rows: SmsContactRow[] }>(`/reports/sms/contacts?${qs}`)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof ApiError && e.status === 403 ? "forbidden" : "failed"); });
    return () => { live = false; };
  }, [query, spec.set, spec.touch, offset]);

  const cols: Column<SmsContactRow>[] = [
    { key: "name", header: "Name", type: "text", minWidth: 150, value: (r) => r.name ?? "",
      render: (r) => (
        <span className="sms-who">
          {r.name ? <strong>{r.name}</strong> : <span className="muted">Unknown contact</span>}
          {r.deletedInHl && <span className="muted" title="This contact was deleted in HighLevel; their history is kept"> · deleted in HighLevel</span>}
        </span>
      ) },
    { key: "phone", header: "Phone", type: "text", value: (r) => r.phone ?? "", render: (r) => (r.phone ? formatPhone(r.phone) : "—") },
    { key: "tags", header: "Tags", type: "text", value: (r) => r.tags.join(", "), render: (r) => <ChipList items={r.tags} max={3} /> },
    { key: "source", header: "Source", type: "text", value: (r) => r.source ?? "", render: (r) => r.source ?? <span className="muted">—</span> },
    { key: "member", header: "Team member", type: "text", value: (r) => r.teamMember },
    { key: "first", header: "First texted", type: "date", value: (r) => r.firstTextedAt, render: (r) => fmtDateLocal(r.firstTextedAt) },
    { key: "touches", header: "Texts before reply", type: "number", align: "right", value: (r) => r.textsBeforeReply,
      render: (r) => (r.textsBeforeReply > 0 ? num(r.textsBeforeReply) : "—") },
    { key: "outcome", header: "Outcome", type: "text", value: (r) => outcomeLabel(r.outcome),
      render: (r) => <span title={r.outcome ? OUTCOME_HINT[r.outcome] : undefined}>{outcomeLabel(r.outcome)}</span> },
    { key: "time", header: "Time to reply", type: "number", align: "right", value: (r) => r.responseSeconds,
      render: (r) => (r.responseSeconds == null ? "—" : fmtDuration(r.responseSeconds)) },
    // Set-specific columns: what put the person on this list.
    ...(FUNNEL_DRILLS.includes(spec.set) ? [{
      key: "step", header: "Furthest step", type: "text" as const, value: (r: SmsContactRow) => furthestStepLabel(r.furthestStep, r.oppDead),
    }] : []),
    ...(spec.set === "stillWaiting" || spec.set === "noReply" ? [{
      key: "last", header: "Last texted", type: "date" as const, value: (r: SmsContactRow) => r.lastTextedAt,
      render: (r: SmsContactRow) => fmtDateLocal(r.lastTextedAt),
    }] : []),
    ...(spec.set === "wrongNumber" ? [{
      key: "wrong", header: "Wrong number", type: "text" as const, value: (r: SmsContactRow) => wrongNumberLabel(r),
    }] : []),
    ...(spec.set === "responded" || spec.set === "unanswered" ? [{
      key: "answer", header: "Answered by a person", type: "number" as const, align: "right" as const, value: (r: SmsContactRow) => r.answerSeconds,
      render: (r: SmsContactRow) => (r.answerSeconds == null ? <span className="muted">Not yet</span> : <>{fmtDuration(r.answerSeconds)}{r.answeredBy && <span className="muted"> · {r.answeredBy}</span>}</>),
    }] : []),
  ];

  const total = data?.total ?? 0;
  return (
    <Modal title={spec.title} wide onClose={onClose}
      subtitle={data && !open ? <>{num(total)} {total === 1 ? "person" : "people"} · {periodLabel} · the report's filters apply</> : periodLabel}>
      {error === "forbidden" ? NO_ACCESS : error === "failed" ? <Banner kind="error">Could not load these contacts. Try again in a moment.</Banner>
        : open ? <SmsTimeline contact={open} onBack={() => setOpen(null)} />
        : !data ? <Spinner label="Loading contacts…" /> : (
          <>
            <SortableTable columns={cols} rows={data.rows} rowKey={(r) => r.hlId} onRowClick={setOpen} empty="Nobody in this group for the period." />
            {total > PAGE && (
              <div className="sms-pager">
                <span>Showing {num(offset + 1)}–{num(Math.min(offset + PAGE, total))} of {num(total)} · newest first</span>
                <span className="va-pager">
                  <button type="button" className="small" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>Previous</button>
                  <button type="button" className="small" disabled={offset + PAGE >= total} onClick={() => setOffset((o) => o + PAGE)}>Next</button>
                </span>
              </div>
            )}
          </>
        )}
    </Modal>
  );
}

const STATUS_TONE: Record<SmsTimelineMessage["statusKind"], "neutral" | "accent" | "success" | "warn" | "danger"> = {
  received: "accent", delivered: "success", unconfirmed: "neutral", failed: "danger", pending: "warn",
};

/** One contact's texting history, oldest first. */
function SmsTimeline({ contact, onBack }: { contact: SmsContactRow; onBack: () => void }) {
  const [data, setData] = useState<{ messages: SmsTimelineMessage[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<"forbidden" | "failed" | null>(null);
  useEffect(() => {
    let live = true;
    api.get<{ messages: SmsTimelineMessage[]; truncated: boolean }>(`/reports/sms/contacts/${encodeURIComponent(contact.hlId)}/messages`)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof ApiError && e.status === 403 ? "forbidden" : "failed"); });
    return () => { live = false; };
  }, [contact.hlId]);

  const cols: Column<SmsTimelineMessage & { i: number }>[] = [
    { key: "when", header: "Date & time", type: "date", value: (m) => m.sentAt, render: (m) => fmtDateTime(m.sentAt) },
    { key: "dir", header: "Direction", type: "text", value: (m) => m.direction,
      render: (m) => (m.direction !== "inbound" ? "Sent"
        : m.replyKind === "wrongNumber" ? <span className="sms-by">Received <Tag tone="warn">Wrong number</Tag></span>
        : m.replyKind === "optOut" ? <span className="sms-by">Received <Tag tone="danger">Asked to stop</Tag></span>
        : "Received") },
    { key: "status", header: "Status", type: "text", value: (m) => STATUS_KIND_LABEL[m.statusKind],
      render: (m) => <Tag tone={STATUS_TONE[m.statusKind]}>{STATUS_KIND_LABEL[m.statusKind]}</Tag> },
    { key: "by", header: "Sent by", type: "text", value: (m) => sentByLabel(m).label,
      render: (m) => {
        const s = sentByLabel(m);
        return (
          <span className="sms-by">
            {s.label}
            {m.direction === "outbound" && <span className="muted">{s.automated ? "Automation" : "Person"}</span>}
          </span>
        );
      } },
  ];

  return (
    <div className="sms-timeline">
      <button type="button" className="link-btn sms-back" onClick={onBack}>← Back to the list</button>
      <div className="sms-tl-head">
        <div className="sms-tl-name">{contact.name ?? "Unknown contact"}</div>
        <div className="sms-tl-meta">
          <span>{contact.phone ? formatPhone(contact.phone) : "No phone on file"}</span>
          <span>Team member: {contact.teamMember}</span>
          {contact.source && <span>Source: {contact.source}</span>}
          <span>Outcome: <b>{outcomeLabel(contact.outcome)}</b>{contact.responseSeconds != null && <> after {fmtDuration(contact.responseSeconds)}</>}</span>
          {contact.firstTextedAt && <span>First reached {fmtDate(contact.firstTextedAt)}</span>}
        </div>
        {contact.tags.length > 0 && <ChipList items={contact.tags} />}
      </div>
      <p className="muted sms-tl-note">Message wording isn't copied into the CRM — open this conversation in HighLevel to read it.</p>
      {error === "forbidden" ? NO_ACCESS : error === "failed" ? <Banner kind="error">Could not load this contact's texts.</Banner>
        : !data ? <Spinner label="Loading texts…" /> : (
          <>
            {data.truncated && <Banner kind="info">Showing the most recent 1,000 texts.</Banner>}
            <SortableTable columns={cols} rows={data.messages.map((m, i) => ({ ...m, i }))} rowKey={(m) => String(m.i)} empty="No texts on record." />
          </>
        )}
    </div>
  );
}
