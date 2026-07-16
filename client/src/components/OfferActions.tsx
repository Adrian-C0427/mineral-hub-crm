import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { api } from "../api/client";
import { Modal, ConfirmDialog, showToast } from "./ui";
import { MoneyInput } from "./MoneyInput";
import { DateField } from "./DateField";
import { Select } from "./Select";
import { money, toInputDate } from "../lib/format";

export interface OfferRow {
  id: string;
  buyer: { id: string; name: string };
  amount: number;
  status: string;
  conditions: string | null;
  expirationDate: string | null;
}

const STATUS_OPTIONS = ["ACTIVE", "REJECTED", "EXPIRED", "COUNTERED", "WITHDRAWN"].map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }));

/**
 * Edit / delete controls for one row of a deal's Offers table (deal page and
 * mineral-asset page share it). Edits and deletions flow straight into every
 * derived number — best offer, profit estimates, dashboard, reports — because
 * those are computed from the offers relation at read time.
 */
export function OfferRowActions({ offer, accepted, onChanged }: { offer: OfferRow; accepted: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="icon-btn" title="Edit offer" aria-label={`Edit ${offer.buyer.name}'s offer`} onClick={() => setEditing(true)}><Pencil size={14} /></button>
      <button className="icon-btn" title="Delete offer" aria-label={`Delete ${offer.buyer.name}'s offer`} onClick={() => setDeleting(true)}><Trash2 size={14} /></button>
      {editing && <EditOfferModal offer={offer} accepted={accepted} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />}
      {deleting && (
        <ConfirmDialog
          title="Delete this offer?"
          confirmLabel={busy ? "Deleting…" : "Delete"}
          busy={busy}
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api.del(`/offers/${offer.id}`);
              setDeleting(false);
              showToast("Offer deleted.");
              onChanged();
            } finally { setBusy(false); }
          }}
          message={
            <>
              <p style={{ marginTop: 0 }}>
                <strong>{offer.buyer.name}</strong>'s offer of <strong>{money(offer.amount)}</strong> will be permanently removed
                from this deal and from all related calculations, summaries and reports.
              </p>
              {accepted && (
                <p className="muted" style={{ marginBottom: 0 }}>
                  This is the <strong>accepted</strong> offer — deleting it also clears the deal's accepted-offer selection
                  (profit estimates fall back to the best remaining offer).
                </p>
              )}
            </>
          }
        />
      )}
    </>
  );
}

function EditOfferModal({ offer, accepted, onClose, onSaved }: { offer: OfferRow; accepted: boolean; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState(String(offer.amount));
  const [status, setStatus] = useState(offer.status);
  const [expiration, setExpiration] = useState(toInputDate(offer.expirationDate));
  const [conditions, setConditions] = useState(offer.conditions ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const amt = Number(amount.replace(/[^0-9.-]/g, ""));
    if (!isFinite(amt) || amt <= 0) { setErr("Enter a valid offer amount."); return; }
    setBusy(true); setErr(null);
    try {
      await api.patch(`/offers/${offer.id}`, {
        amount: amt,
        status,
        expirationDate: expiration || null,
        conditions: conditions.trim() || null,
      });
      showToast("Offer updated.");
      onSaved();
    } catch { setErr("Could not save the offer."); setBusy(false); }
  }

  return (
    <Modal
      title={`Edit offer — ${offer.buyer.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </>
      }
    >
      {err && <div className="error-text">{err}</div>}
      <div className="dd-grid">
        <div className="field"><label>Offer amount</label><MoneyInput value={amount} onChange={setAmount} ariaLabel="Offer amount" /></div>
        <div className="field"><label>Status</label>
          {/* The accepted offer's status is managed by the accept flow. */}
          {accepted
            ? <input value="Accepted" disabled aria-label="Offer status" />
            : <Select value={status} onChange={setStatus} ariaLabel="Offer status" options={STATUS_OPTIONS} />}
        </div>
        <div className="field"><label>Expiration date</label><DateField value={expiration} onChange={setExpiration} /></div>
        <div className="field"><label>Conditions</label><input value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="e.g. subject to title review" /></div>
      </div>
      <p className="muted" style={{ marginBottom: 0, fontSize: 12.5 }}>
        Changes apply immediately to the deal's metrics, profit estimates and reporting.
      </p>
    </Modal>
  );
}
