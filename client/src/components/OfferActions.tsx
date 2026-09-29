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
export function OfferRowActions({ offer, accepted, onChanged, dealNma, dealNra }: {
  offer: OfferRow; accepted: boolean; onChanged: () => void;
  /** The deal's acreage, for the per-NMA / per-NRA offer pricing fields. */
  dealNma?: number | null; dealNra?: number | null;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="icon-btn" title="Edit offer" aria-label={`Edit ${offer.buyer.name}'s offer`} onClick={() => setEditing(true)}><Pencil size={14} /></button>
      <button className="icon-btn" title="Delete offer" aria-label={`Delete ${offer.buyer.name}'s offer`} onClick={() => setDeleting(true)}><Trash2 size={14} /></button>
      {editing && <EditOfferModal offer={offer} accepted={accepted} dealNma={dealNma ?? null} dealNra={dealNra ?? null} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />}
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

/** Per-acre price for an amount over some acreage ("" when it can't apply). */
function perAcre(amount: string, acres: number | null): string {
  const a = Number(amount);
  if (acres == null || acres <= 0 || !isFinite(a) || a <= 0) return "";
  return String(Math.round((a / acres) * 100) / 100);
}
/** Amount from a per-acre price × acreage ("" when it can't apply). */
function amountFrom(price: string, acres: number | null): string {
  const p = Number(price);
  if (acres == null || !isFinite(p) || p <= 0) return "";
  return String(Math.round(p * acres * 100) / 100);
}

function EditOfferModal({ offer, accepted, dealNma, dealNra, onClose, onSaved }: {
  offer: OfferRow; accepted: boolean; dealNma: number | null; dealNra: number | null; onClose: () => void; onSaved: () => void;
}) {
  const [amount, setAmount] = useState(String(offer.amount));
  // Offer per NMA / per NRA mirror the amount: editing either price sets the
  // amount (price × the deal's acreage), and every field stays in sync.
  const [perNma, setPerNma] = useState(perAcre(String(offer.amount), dealNma));
  const [perNra, setPerNra] = useState(perAcre(String(offer.amount), dealNra));
  const setFromAmount = (v: string) => { setAmount(v); setPerNma(perAcre(v, dealNma)); setPerNra(perAcre(v, dealNra)); };
  const setFromNma = (v: string) => { setPerNma(v); const a = amountFrom(v, dealNma); setAmount(a); setPerNra(perAcre(a, dealNra)); };
  const setFromNra = (v: string) => { setPerNra(v); const a = amountFrom(v, dealNra); setAmount(a); setPerNma(perAcre(a, dealNma)); };
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
      title={`Edit offer · ${offer.buyer.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </>
      }
    >
      {err && <div className="error-text">{err}</div>}
      {/* Standard sectioned layout (same system as New Deal / New Buyer). */}
      <div className="modal-sec">Offer</div>
      <div className="nd-basics">
        <div className="field">
          <label>Offer per NMA</label>
          <MoneyInput decimals={2} value={perNma} onChange={setFromNma} ariaLabel="Offer per NMA" disabled={dealNma == null} placeholder="0.00" />
          <span className="muted" style={{ fontSize: 11.5 }}>{dealNma != null ? `× ${dealNma} NMA` : "Deal has no NMA set"}</span>
        </div>
        <div className="field">
          <label>Offer per NRA</label>
          <MoneyInput decimals={2} value={perNra} onChange={setFromNra} ariaLabel="Offer per NRA" disabled={dealNra == null} placeholder="0.00" />
          <span className="muted" style={{ fontSize: 11.5 }}>{dealNra != null ? `× ${dealNra} NRA` : "Deal has no NRA set"}</span>
        </div>
        <div className="field"><label>Offer amount</label><MoneyInput value={amount} onChange={setFromAmount} ariaLabel="Offer amount" /></div>
        <div className="field"><label>Status</label>
          {/* The accepted offer's status is managed by the accept flow. */}
          {accepted
            ? <input value="Accepted Offer" disabled aria-label="Offer status" />
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
