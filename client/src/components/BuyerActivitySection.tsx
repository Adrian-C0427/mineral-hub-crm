import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { StatusBadge, EmptyState } from "./ui";
import { Select } from "./Select";
import { money, fmtDate } from "../lib/format";
import { BUYER_STATUS_RANK } from "../lib/buyerStatus";
import type { BuyerActivityRow, CommKind, TimelineEntry } from "../types";

const KIND_LABEL: Record<CommKind, string> = {
  EMAIL_OUT: "✉ Email sent", EMAIL_IN: "✉ Email received", PHONE: "☎ Call",
  MEETING: "👥 Meeting", NOTE: "📝 Note", NEGOTIATION: "🤝 Negotiation", STATUS_CHANGE: "● Status change",
};

/** Match-percent color scale (green / amber / red — mirrors the deal page). */
const baPctColor = (pct: number): string => (pct >= 67 ? "#4ade80" : pct >= 34 ? "#f59e0b" : "#f87171");

const LOGGABLE: { v: CommKind; label: string }[] = [
  { v: "PHONE", label: "Call" }, { v: "MEETING", label: "Meeting" },
  { v: "NOTE", label: "Note" }, { v: "NEGOTIATION", label: "Negotiation" },
  { v: "EMAIL_OUT", label: "Email sent" }, { v: "EMAIL_IN", label: "Email received" },
];

export function BuyerActivitySection({
  dealId, rows, onChanged, onEdit, onRecordOffer, canEdit = true,
}: {
  dealId: string;
  rows: BuyerActivityRow[];
  onChanged: () => void;
  onEdit: (row: BuyerActivityRow) => void;
  /** Opens the update modal pre-set to Offer Received — a discoverable path to
   *  recording an offer instead of hiding it behind the status dropdown. */
  onRecordOffer?: (row: BuyerActivityRow) => void;
  /** False for read-only users: hides Update and the inline log form (whose
   *  POSTs would just 403). */
  canEdit?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const sorted = [...rows].sort(
    (a, b) => (BUYER_STATUS_RANK[a.status] - BUYER_STATUS_RANK[b.status]) || b.matchPercent - a.matchPercent,
  );

  if (rows.length === 0) return <EmptyState title="No buyers contacted yet">Use Match Recommendations below to start outreach.</EmptyState>;

  return (
    <div className="ba-list">
      {sorted.map((r) => {
        const isOpen = open === r.id;
        return (
          <div key={r.id} className={`ba-row ${r.status === "PASSED" ? "row-dimmed" : ""}`}>
            <div className="ba-head" onClick={() => setOpen(isOpen ? null : r.id)}>
              <span className="ba-caret">{isOpen ? "▾" : "▸"}</span>
              <Link to={`/buyers/${r.buyerId}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>{r.buyerName}</Link>
              {r.companyName && r.companyName !== r.buyerName && <span className="muted">· {r.companyName}</span>}
              <span className="spacer" />
              {/* Reference-style match meter: 90px bar + mono colored percent. */}
              <span className="ba-match" title={`${r.matchPercent}% buy-box match`}>
                <span className="ba-bar"><span style={{ width: `${Math.min(100, Math.max(0, r.matchPercent))}%`, background: baPctColor(r.matchPercent) }} /></span>
                <span className="ba-pct" style={{ color: baPctColor(r.matchPercent) }}>{r.matchPercent}%</span>
              </span>
              <StatusBadge status={r.status} />
              {r.offerAmount != null && <span className="ba-amount">{money(r.offerAmount)}</span>}
              <span className="ba-date">{fmtDate(r.lastActivityDate)}</span>
              {onRecordOffer && r.status !== "PASSED" && r.status !== "CLOSED" && (
                <button className="small" onClick={(e) => { e.stopPropagation(); onRecordOffer(r); }}>Record offer</button>
              )}
              {canEdit && <button className="small" onClick={(e) => { e.stopPropagation(); onEdit(r); }}>Update</button>}
            </div>
            {isOpen && (
              <div className="ba-body">
                <div className="dd-grid" style={{ marginBottom: 8 }}>
                  <div className="kv"><span className="k">Assigned</span><span className="v">{r.assignedTeamMember?.name ?? "—"}</span></div>
                  <div className="kv"><span className="k">Response received</span><span className="v">{r.responseReceived ? "Yes" : "No"}</span></div>
                  <div className="kv"><span className="k">Next follow-up</span><span className="v">{fmtDate(r.nextFollowUpDate)}</span></div>
                  <div className="kv"><span className="k">Notes</span><span className="v">{r.notes || "—"}</span></div>
                </div>
                {canEdit && <LogEntryForm dealId={dealId} buyerId={r.buyerId} onLogged={onChanged} />}
                <Timeline entries={r.timeline} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LogEntryForm({ dealId, buyerId, onLogged }: { dealId: string; buyerId: string; onLogged: () => void }) {
  const [kind, setKind] = useState<CommKind>("NOTE");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!body.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.post(`/deals/${dealId}/activity/${buyerId}/messages`, { kind, body: body.trim() });
      setBody("");
      onLogged();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Failed to log"); }
    finally { setBusy(false); }
  }

  return (
    <div className="ba-log">
      <Select value={kind} onChange={(v) => setKind(v as CommKind)} width={150} ariaLabel="Activity type"
        options={LOGGABLE.map((k) => ({ value: k.v, label: k.label }))} />
      <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Log a call, meeting, note, or negotiation…" onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
      <button className="small primary" disabled={busy || !body.trim()} onClick={save}>Add</button>
      {err && <span className="error-text">{err}</span>}
    </div>
  );
}

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return <p className="muted" style={{ fontSize: 13 }}>No communication logged yet.</p>;
  return (
    <ul className="timeline">
      {entries.map((e) => <TimelineItem key={e.id} entry={e} />)}
    </ul>
  );
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const [open, setOpen] = useState(false);
  const long = (entry.body?.length ?? 0) > 120;
  return (
    <li className="timeline-item">
      <div className="timeline-meta">
        <span className="timeline-kind">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
        <span className="muted" style={{ fontSize: 12 }}>{fmtDate(entry.occurredAt)}{entry.createdBy ? ` · ${entry.createdBy}` : ""}</span>
      </div>
      {entry.subject && <div style={{ fontWeight: 600, fontSize: 13 }}>{entry.subject}</div>}
      {entry.body && (
        <div className="timeline-body" style={{ fontSize: 13 }}>
          {long && !open ? `${entry.body.slice(0, 120)}… ` : entry.body}
          {long && <button className="link-btn" onClick={() => setOpen((o) => !o)}>{open ? "less" : "more"}</button>}
        </div>
      )}
    </li>
  );
}
