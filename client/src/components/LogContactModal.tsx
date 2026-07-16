import { useState } from "react";
import { Modal } from "./ui";
import { Select } from "./Select";
import { api, ApiError } from "../api/client";
import { toInputDate } from "../lib/format";
import { BUYER_STATUS_OPTIONS } from "../lib/buyerStatus";
import type { BuyerStatus, UserLite } from "../types";
import { MoneyInput } from "./MoneyInput";
import { DateField } from "./DateField";

interface Props {
  dealId: string;
  buyerId: string;
  buyerName: string;
  users: UserLite[];
  /** The deal's total NRA / NMA, enabling the per-acre pricing shortcuts. */
  dealNra?: number | null;
  dealNma?: number | null;
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

/** price × total, rounded to the cent, as a MoneyInput-friendly string. */
function computeAmount(price: string, total: number): string {
  const p = Number(price);
  if (!isFinite(p) || p <= 0) return "";
  return String(Math.round(p * total * 100) / 100);
}

export function LogContactModal({ dealId, buyerId, buyerName, users, dealNra, dealNma, initial, onClose, onLogged }: Props) {
  const [status, setStatus] = useState<BuyerStatus>(initial?.status ?? "CONTACTED");
  const [assignee, setAssignee] = useState(initial?.assignedTeamMemberId ?? "");
  // Editing an existing contact must preserve its dates — only a brand-new
  // contact defaults dateSent to today. Otherwise every status tweak would
  // rewrite the original send date and wipe the pending follow-up.
  const [dateSent, setDateSent] = useState(initial?.dateSent ? toInputDate(initial.dateSent) : toInputDate(new Date()));
  const [nextFollowUp, setNextFollowUp] = useState(initial?.nextFollowUpDate ? toInputDate(initial.nextFollowUpDate) : "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [amount, setAmount] = useState("");
  // Optional pricing shortcuts: entering either per-acre price auto-fills the
  // amount (price × deal total). Manual amount entry stays fully supported —
  // whichever field was edited last wins.
  const [pricePerNra, setPricePerNra] = useState("");
  const [pricePerNma, setPricePerNma] = useState("");
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
      dirty={notes.trim() !== (initial?.notes ?? "").trim() || amount.trim() !== "" || conditions.trim() !== ""}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </>
      }
    >
      <div className="field">
        <label>Status</label>
        <Select value={status} onChange={(v) => setStatus(v as BuyerStatus)} ariaLabel="Status"
          options={BUYER_STATUS_OPTIONS.map((s) => ({ value: s.v, label: s.label }))} />
      </div>
      <div className="field">
        <label>Assigned team member</label>
        <Select value={assignee} onChange={setAssignee} placeholder="Unassigned" clearable searchable ariaLabel="Assigned team member"
          options={users.map((u) => ({ value: u.id, label: u.name }))} />
      </div>
      {status === "OFFER_RECEIVED" && (
        <>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Enter an amount to record a formal offer, or leave blank to just set the status.</p>
          <div className="grid-2">
            <div className="field">
              <label>Price per NRA <span className="muted" style={{ textTransform: "none" }}>(optional)</span></label>
              <MoneyInput value={pricePerNra} ariaLabel="Price per NRA" disabled={dealNra == null}
                onChange={(v) => { setPricePerNra(v); setPricePerNma(""); if (dealNra != null) setAmount(computeAmount(v, dealNra)); }} />
              <span className="muted" style={{ fontSize: 11.5 }}>
                {dealNra != null ? `× ${dealNra} NRA` : "Deal has no NRA set"}
              </span>
            </div>
            <div className="field">
              <label>Price per NMA <span className="muted" style={{ textTransform: "none" }}>(optional)</span></label>
              <MoneyInput value={pricePerNma} ariaLabel="Price per NMA" disabled={dealNma == null}
                onChange={(v) => { setPricePerNma(v); setPricePerNra(""); if (dealNma != null) setAmount(computeAmount(v, dealNma)); }} />
              <span className="muted" style={{ fontSize: 11.5 }}>
                {dealNma != null ? `× ${dealNma} NMA` : "Deal has no NMA set"}
              </span>
            </div>
          </div>
          <div className="field">
            <label>Offer amount</label>
            <MoneyInput value={amount} ariaLabel="Offer amount"
              onChange={(v) => { setAmount(v); setPricePerNra(""); setPricePerNma(""); }} />
          </div>
          <div className="field"><label>Conditions</label><textarea rows={2} value={conditions} onChange={(e) => setConditions(e.target.value)} /></div>
        </>
      )}
      <div className="grid-2">
        <div className="field"><label>Date sent</label><DateField value={dateSent} onChange={(v) => setDateSent(v)} /></div>
        <div className="field"><label>Next follow-up</label><DateField value={nextFollowUp} onChange={(v) => setNextFollowUp(v)} /></div>
      </div>
      <div className="field"><label>Internal notes</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
