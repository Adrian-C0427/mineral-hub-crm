import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Handshake, Inbox, Pencil, Phone, RefreshCw, Send, StickyNote, Trash2, Users, type LucideIcon } from "lucide-react";
import { api, ApiError } from "../api/client";
import { ConfirmDialog, StatusBadge, EmptyState, UserChip } from "./ui";
import { Select } from "./Select";
import { money, fmtDate } from "../lib/format";
import { BUYER_STATUS_RANK, buyerStatusLabel } from "../lib/buyerStatus";
import type { BuyerActivityRow, CommKind, TimelineEntry } from "../types";

// Clean line icons per entry kind — professional, no emoji.
const KIND_META: Record<CommKind, { icon: LucideIcon; label: string }> = {
  EMAIL_OUT: { icon: Send, label: "Email sent" },
  EMAIL_IN: { icon: Inbox, label: "Email received" },
  PHONE: { icon: Phone, label: "Call" },
  MEETING: { icon: Users, label: "Meeting" },
  NOTE: { icon: StickyNote, label: "Note" },
  NEGOTIATION: { icon: Handshake, label: "Negotiation" },
  STATUS_CHANGE: { icon: RefreshCw, label: "Status change" },
};

/** Match-percent color scale (green / amber / red — mirrors the deal page). */
const baPctColor = (pct: number): string => (pct >= 67 ? "var(--success-ink)" : pct >= 34 ? "var(--warn)" : "var(--danger-ink)");

const LOGGABLE: { v: CommKind; label: string }[] = [
  { v: "PHONE", label: "Call" }, { v: "MEETING", label: "Meeting" },
  { v: "NOTE", label: "Note" }, { v: "NEGOTIATION", label: "Negotiation" },
  { v: "EMAIL_OUT", label: "Email sent" }, { v: "EMAIL_IN", label: "Email received" },
];

export function BuyerActivitySection({
  dealId, rows, onChanged, onEdit, onRecordOffer, canEdit = true, dealClosed = false,
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
  /** The deal is in stage CLOSED: closing set the winning buyer to Closed and
   *  every status is final, so the section says so and stops offering
   *  "Record offer". */
  dealClosed?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const sorted = [...rows].sort(
    (a, b) => (BUYER_STATUS_RANK[a.status] - BUYER_STATUS_RANK[b.status]) || b.matchPercent - a.matchPercent,
  );

  if (rows.length === 0) return <EmptyState title="No buyers contacted yet">Use Match Recommendations below to start outreach.</EmptyState>;

  return (
    <div className="ba-table">
      {dealClosed && (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>Deal closed — statuses are final.</p>
      )}
      {/* One grid shared by the header and every row; the rows expand into the
          buyer's details, log form and full communication timeline. */}
      <div className="ba-cols ba-headrow" aria-hidden="true">
        <span>Buyer</span><span>Status</span><span>Match</span><span className="ba-right">Offer</span>
        <span>Follow-up</span><span>Last activity</span><span />
      </div>
      {sorted.map((r) => {
        const isOpen = open === r.id;
        return (
          <div key={r.id} className={`ba-row ${isOpen ? "open" : ""} ${r.status === "PASSED" ? "row-dimmed" : ""}`}>
            <div className="ba-head ba-cols" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
              <span className="ba-buyer">
                <ChevronRight size={14} className="ba-caret" aria-hidden="true" />
                <span className="ba-buyer-text">
                  <Link to={`/buyers/${r.buyerId}`} className="subtle-link ba-name" onClick={(e) => e.stopPropagation()}>{r.buyerName}</Link>
                  {r.companyName && r.companyName !== r.buyerName && <span className="ba-sub">{r.companyName}</span>}
                </span>
              </span>
              <span><StatusBadge status={r.status} label={buyerStatusLabel(r.status)} /></span>
              {/* Match meter: bar + coloured percent. */}
              <span className="ba-match" title={`${r.matchPercent}% buy-box match`}>
                <span className="ba-bar"><span style={{ width: `${Math.min(100, Math.max(0, r.matchPercent))}%`, background: baPctColor(r.matchPercent) }} /></span>
                <span className="ba-pct" style={{ color: baPctColor(r.matchPercent) }}>{r.matchPercent}%</span>
              </span>
              <span className={`ba-amount ${r.offerAmount != null ? "" : "dim"}`}>{r.offerAmount != null ? money(r.offerAmount) : "—"}</span>
              <span className="ba-date">{fmtDate(r.nextFollowUpDate)}</span>
              <span className="ba-date">{fmtDate(r.lastActivityDate)}</span>
              <span className="ba-actions">
                {onRecordOffer && !dealClosed && r.status !== "PASSED" && r.status !== "CLOSED" && (
                  <button className="small" onClick={(e) => { e.stopPropagation(); onRecordOffer(r); }}>Record offer</button>
                )}
                {canEdit && <button className="small" onClick={(e) => { e.stopPropagation(); onEdit(r); }}>Update</button>}
              </span>
            </div>
            {isOpen && (
              <div className="ba-body">
                <div className="ba-kvs">
                  <div className="ba-kv"><span className="k">Assigned</span><span className="v">{r.assignedTeamMember ? <UserChip user={r.assignedTeamMember} size={16} /> : "—"}</span></div>
                  <div className="ba-kv"><span className="k">Response received</span><span className="v">{r.responseReceived ? "Yes" : "No"}</span></div>
                  <div className="ba-kv"><span className="k">Next follow-up</span><span className="v">{fmtDate(r.nextFollowUpDate)}</span></div>
                  <div className="ba-kv"><span className="k">Notes</span><span className="v">{r.notes || "—"}</span></div>
                </div>
                {canEdit && <LogEntryForm dealId={dealId} buyerId={r.buyerId} onLogged={onChanged} />}
                <Timeline entries={r.timeline} dealId={dealId} buyerId={r.buyerId} canEdit={canEdit} onChanged={onChanged} />
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

function Timeline({ entries, dealId, buyerId, canEdit, onChanged }: {
  entries: TimelineEntry[]; dealId: string; buyerId: string; canEdit: boolean; onChanged: () => void;
}) {
  if (entries.length === 0) return <p className="muted ba-none">No communication logged yet.</p>;
  return (
    <ul className="timeline">
      {entries.map((e) => <TimelineItem key={e.id} entry={e} dealId={dealId} buyerId={buyerId} canEdit={canEdit} onChanged={onChanged} />)}
    </ul>
  );
}

function TimelineItem({ entry, dealId, buyerId, canEdit, onChanged }: {
  entry: TimelineEntry; dealId: string; buyerId: string; canEdit: boolean; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const long = (entry.body?.length ?? 0) > 120;
  const meta = KIND_META[entry.kind] ?? { icon: StickyNote, label: entry.kind };
  const Icon = meta.icon;
  // System-generated status changes can be removed but not rewritten.
  const editable = canEdit && entry.kind !== "STATUS_CHANGE";

  async function remove() {
    setBusy(true); setErr(null);
    try {
      await api.del(`/deals/${dealId}/activity/${buyerId}/messages/${entry.id}`);
      setConfirmDelete(false);
      onChanged();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Failed to delete"); setBusy(false); }
  }

  return (
    <li className="timeline-item">
      <div className="timeline-meta">
        <span className="timeline-kind"><Icon size={13} strokeWidth={2} aria-hidden="true" /> {meta.label}</span>
        <span className="timeline-when">{fmtDate(entry.occurredAt)}{entry.createdBy ? ` · ${entry.createdBy}` : ""}</span>
        <span className="timeline-actions">
          {editable && !editing && (
            <button className="icon-btn timeline-act" title="Edit entry" aria-label="Edit entry" onClick={() => { setErr(null); setEditing(true); }}>
              <Pencil size={13} />
            </button>
          )}
          {canEdit && !editing && (
            <button className="icon-btn timeline-act danger" title="Delete entry" aria-label="Delete entry" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={13} />
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <EditEntryForm
          entry={entry} dealId={dealId} buyerId={buyerId}
          onCancel={() => setEditing(false)}
          onSaved={() => { setEditing(false); onChanged(); }}
        />
      ) : (
        <>
          {entry.subject && <div className="timeline-subject">{entry.subject}</div>}
          {entry.body && (
            <div className="timeline-body">
              {long && !open ? `${entry.body.slice(0, 120)}… ` : entry.body}
              {long && <button className="link-btn" onClick={() => setOpen((o) => !o)}>{open ? "less" : "more"}</button>}
            </div>
          )}
        </>
      )}
      {err && <span className="error-text timeline-err">{err}</span>}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this timeline entry?"
          confirmLabel={busy ? "Deleting…" : "Delete"}
          danger busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={remove}
          message={<p style={{ marginTop: 0 }}>The {meta.label.toLowerCase()} entry from {fmtDate(entry.occurredAt)} will be permanently removed from this buyer's history.</p>}
        />
      )}
    </li>
  );
}

/** Inline editor for a logged entry — same fields as logging, saved via PATCH. */
function EditEntryForm({ entry, dealId, buyerId, onCancel, onSaved }: {
  entry: TimelineEntry; dealId: string; buyerId: string; onCancel: () => void; onSaved: () => void;
}) {
  const [kind, setKind] = useState<CommKind>(entry.kind);
  const [body, setBody] = useState(entry.body ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!body.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.patch(`/deals/${dealId}/activity/${buyerId}/messages/${entry.id}`, { kind, body: body.trim() });
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Failed to save"); setBusy(false); }
  }

  return (
    <div className="ba-log ba-log-edit">
      <Select value={kind} onChange={(v) => setKind(v as CommKind)} width={150} ariaLabel="Entry type"
        options={LOGGABLE.map((k) => ({ value: k.v, label: k.label }))} />
      <input value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} autoFocus />
      <button className="small primary" disabled={busy || !body.trim()} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      <button className="small" disabled={busy} onClick={onCancel}>Cancel</button>
      {err && <span className="error-text">{err}</span>}
    </div>
  );
}
