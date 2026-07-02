import { useState } from "react";
import { Modal } from "./ui";
import { api, ApiError } from "../api/client";
import { toInputDate } from "../lib/format";
import type { BuyerStatus, UserLite } from "../types";

interface Props {
  dealId: string;
  buyerId: string;
  buyerName: string;
  users: UserLite[];
  initial?: {
    status?: BuyerStatus;
    assignedTeamMemberId?: string | null;
    responseReceived?: boolean;
    notes?: string | null;
    dateSent?: string | null;
    nextFollowUpDate?: string | null;
  };
  onClose: () => void;
  onLogged: () => void;
}

const STATUSES: { v: BuyerStatus; label: string }[] = [
  { v: "CONTACTED", label: "Contacted" },
  { v: "INTERESTED", label: "Interested" },
  { v: "REVIEWING", label: "Reviewing" },
  { v: "OFFER_RECEIVED", label: "Offer Received" },
  { v: "NEGOTIATING", label: "Negotiating" },
  { v: "PASSED", label: "Passed" },
  { v: "CLOSED", label: "Closed" },
];

export function LogContactModal({ dealId, buyerId, buyerName, users, initial, onClose, onLogged }: Props) {
  const [status, setStatus] = useState<BuyerStatus>(initial?.status ?? "CONTACTED");
  const [assignee, setAssignee] = useState(initial?.assignedTeamMemberId ?? "");
  const [responseReceived, setResponseReceived] = useState(initial?.responseReceived ?? false);
  // Editing an existing contact must preserve its dates — only a brand-new
  // contact defaults dateSent to today. Otherwise every status tweak would
  // rewrite the original send date and wipe the pending follow-up.
  const [dateSent, setDateSent] = useState(initial?.dateSent ? toInputDate(initial.dateSent) : toInputDate(new Date()));
  const [nextFollowUp, setNextFollowUp] = useState(initial?.nextFollowUpDate ? toInputDate(initial.nextFollowUpDate) : "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [amount, setAmount] = useState("");
  const [conditions, setConditions] = useState("");
  const [expiration, setExpiration] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (status === "OFFER_RECEIVED" && amount.trim()) {
        // A concrete offer amount records a formal Offer (which also sets the
        // buyer status to Offer Received on the activity row).
        await api.post("/offers", {
          dealId, buyerId,
          amount: Number(amount),
          conditions: conditions || null,
          expirationDate: expiration || null,
        });
      }
      // Always persist the rest of the form (assignee, response received,
      // dates, notes) — previously the offer branch silently discarded them.
      // An offer implies a response was received.
      await api.post(`/deals/${dealId}/activity`, {
        buyerId,
        status,
        responseReceived: status === "OFFER_RECEIVED" && amount.trim() ? true : responseReceived,
        assignedTeamMemberId: assignee || null,
        dateSent: dateSent || null,
        nextFollowUpDate: nextFollowUp || null,
        notes: notes || null,
      });
      onLogged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to log contact");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Update buyer — ${buyerName}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </>
      }
    >
      <div className="field">
        <label>Status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value as BuyerStatus)}>
          {STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Assigned team member</label>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Response</label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", fontSize: 14 }}>
            <input type="checkbox" checked={responseReceived} onChange={(e) => setResponseReceived(e.target.checked)} /> Response received
          </label>
        </div>
      </div>
      {status === "OFFER_RECEIVED" && (
        <>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Enter an amount to record a formal offer, or leave blank to just set the status.</p>
          <div className="field"><label>Offer amount</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label>Conditions</label><textarea rows={2} value={conditions} onChange={(e) => setConditions(e.target.value)} /></div>
          <div className="field"><label>Expiration date</label><input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} /></div>
        </>
      )}
      <div className="grid-2">
        <div className="field"><label>Date sent</label><input type="date" value={dateSent} onChange={(e) => setDateSent(e.target.value)} /></div>
        <div className="field"><label>Next follow-up</label><input type="date" value={nextFollowUp} onChange={(e) => setNextFollowUp(e.target.value)} /></div>
      </div>
      <div className="field"><label>Internal notes</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
