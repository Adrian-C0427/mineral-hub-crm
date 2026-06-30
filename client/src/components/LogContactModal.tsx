import { useState } from "react";
import { Modal } from "./ui";
import { api, ApiError } from "../api/client";
import type { ResponseStatus } from "../types";

interface Props {
  dealId: string;
  buyerId: string;
  buyerName: string;
  onClose: () => void;
  onLogged: () => void;
}

const STATUSES: { v: ResponseStatus; label: string }[] = [
  { v: "PENDING", label: "Awaiting response" },
  { v: "INTERESTED", label: "Interested" },
  { v: "NOT_INTERESTED", label: "Not Interested" },
  { v: "PASSED", label: "Passed" },
  { v: "OFFER_MADE", label: "Offer Made" },
];

export function LogContactModal({ dealId, buyerId, buyerName, onClose, onLogged }: Props) {
  const [status, setStatus] = useState<ResponseStatus>("PENDING");
  const [dateSent, setDateSent] = useState(new Date().toISOString().slice(0, 10));
  const [nextFollowUp, setNextFollowUp] = useState("");
  const [notes, setNotes] = useState("");
  const [amount, setAmount] = useState("");
  const [conditions, setConditions] = useState("");
  const [expiration, setExpiration] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (status === "OFFER_MADE") {
        if (!amount.trim()) { setError("Offer amount is required"); setBusy(false); return; }
        // Offer Made creates a full Offer record (which also syncs the activity row).
        await api.post("/offers", {
          dealId, buyerId,
          amount: Number(amount),
          conditions: conditions || null,
          expirationDate: expiration || null,
        });
      } else {
        await api.post(`/deals/${dealId}/activity`, {
          buyerId,
          responseStatus: status,
          dateSent: dateSent || null,
          nextFollowUpDate: nextFollowUp || null,
          notes: notes || null,
        });
      }
      onLogged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to log contact");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Log contact — ${buyerName}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </>
      }
    >
      <div className="field">
        <label>Response status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value as ResponseStatus)}>
          {STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
      </div>
      {status === "OFFER_MADE" ? (
        <>
          <div className="field"><label>Offer amount *</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label>Conditions</label><textarea rows={2} value={conditions} onChange={(e) => setConditions(e.target.value)} /></div>
          <div className="field"><label>Expiration date</label><input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} /></div>
        </>
      ) : (
        <>
          <div className="field"><label>Date sent</label><input type="date" value={dateSent} onChange={(e) => setDateSent(e.target.value)} /></div>
          <div className="field"><label>Next follow-up</label><input type="date" value={nextFollowUp} onChange={(e) => setNextFollowUp(e.target.value)} /></div>
          <div className="field"><label>Internal notes</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
