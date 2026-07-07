import { useState } from "react";
import { Modal } from "./ui";
import { api, ApiError } from "../api/client";
import { toInputDate } from "../lib/format";
import { BUYER_STATUS_OPTIONS } from "../lib/buyerStatus";
import type { BuyerStatus, UserLite } from "../types";

interface Props {
  dealId: string;
  buyerId: string;
  buyerName: string;
  users: UserLite[];
  initial?: {
    status?: BuyerStatus;
    assignedTeamMemberId?: string | null;
    notes?: string | null;
    dateSent?: string | null;
    nextFollowUpDate?: string | null;
  };
  onClose: () => void;
  onLogged: () => void;
}

export function LogContactModal({ dealId, buyerId, buyerName, users, initial, onClose, onLogged }: Props) {
  const [status, setStatus] = useState<BuyerStatus>(initial?.status ?? "CONTACTED");
  const [assignee, setAssignee] = useState(initial?.assignedTeamMemberId ?? "");
  // Editing an existing contact must preserve its dates — only a brand-new
  // contact defaults dateSent to today. Otherwise every status tweak would
  // rewrite the original send date and wipe the pending follow-up.
  const [dateSent, setDateSent] = useState(initial?.dateSent ? toInputDate(initial.dateSent) : toInputDate(new Date()));
  const [nextFollowUp, setNextFollowUp] = useState(initial?.nextFollowUpDate ? toInputDate(initial.nextFollowUpDate) : "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [amount, setAmount] = useState("");
  const [conditions, setConditions] = useState("");
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
        });
      }
      // Persist the rest of the form (assignee, dates, notes). A recorded offer
      // implies a response was received; otherwise we leave responseReceived as-is.
      await api.post(`/deals/${dealId}/activity`, {
        buyerId,
        status,
        ...(status === "OFFER_RECEIVED" && amount.trim() ? { responseReceived: true } : {}),
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
          {BUYER_STATUS_OPTIONS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Assigned team member</label>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Unassigned</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      {status === "OFFER_RECEIVED" && (
        <>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Enter an amount to record a formal offer, or leave blank to just set the status.</p>
          <div className="field"><label>Offer amount</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label>Conditions</label><textarea rows={2} value={conditions} onChange={(e) => setConditions(e.target.value)} /></div>
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
