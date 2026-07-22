import { useState } from "react";
import { Link } from "react-router-dom";
import { Handshake, Inbox, Pencil, Phone, RefreshCw, Send, StickyNote, Trash2, Users, type LucideIcon } from "lucide-react";
import { api, ApiError } from "../api/client";
import { ConfirmDialog, StatusBadge, EmptyState } from "./ui";
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
              <Link to={`/buyers/${r.buyerId}`} className="subtle-link" onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>{r.buyerName}</Link>
              {r.companyName && r.companyName !== r.buyerName && <span className="muted">· {r.companyName}</span>}
              <span className="spacer" />
              {/* Reference-style match meter: 90px bar + mono colored percent. */}
              <span className="ba-match" title={`${r.matchPercent}% buy-box match`}>
                <span className="ba-bar"><span style={{ width: `${Math.min(100, Math.max(0, r.matchPercent))}%`, background: baPctColor(r.matchPercent) }} /></span>
                <span className="ba-pct" style={{ color: baPctColor(r.matchPercent) }}>{r.matchPercent}%</span>
              </span>
              <StatusBadge status={r.status} label={buyerStatusLabel(r.status)} />
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
  if (entries.length === 0) return <p className="muted" style={{ fontSize: 13 }}>No communication logged yet.</p>;
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
        <span className="muted" style={{ fontSize: 12 }}>{fmtDate(entry.occurredAt)}{entry.createdBy ? ` · ${entry.createdBy}` : ""}</span>
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
          {entry.subject && <div style={{ fontWeight: 600, fontSize: 13 }}>{entry.subject}</div>}
          {entry.body && (
            <div className="timeline-body" style={{ fontSize: 13 }}>
              {long && !open ? `${entry.body.slice(0, 120)}… ` : entry.body}
              {long && <button className="link-btn" onClick={() => setOpen((o) => !o)}>{open ? "less" : "more"}</button>}
            </div>
          )}
        </>
      )}
      {err && <span className="error-text" style={{ fontSize: 12 }}>{err}</span>}
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
    <div className="ba-log" style={{ marginTop: 4 }}>
      <Select value={kind} onChange={(v) => setKind(v as CommKind)} width={150} ariaLabel="Entry type"
        options={LOGGABLE.map((k) => ({ value: k.v, label: k.label }))} />
      <input value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} autoFocus />
      <button className="small primary" disabled={busy || !body.trim()} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      <button className="small" disabled={busy} onClick={onCancel}>Cancel</button>
      {err && <span className="error-text">{err}</span>}
    </div>
  );
}
