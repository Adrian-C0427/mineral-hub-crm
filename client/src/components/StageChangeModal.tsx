import { useState } from "react";
import { Modal } from "./ui";
import { api, ApiError } from "../api/client";
import { prettyStage } from "../lib/format";
import type { DealSummary, Stage } from "../types";

const STAGES: Stage[] = [
  "UNDER_CONTRACT", "PREPARING_PACKAGE", "SENT_TO_BUYERS",
  "NEGOTIATING", "CLOSING", "CLOSED", "DEAD",
];

interface Props {
  deal: DealSummary;
  /** Pre-selected destination (e.g. from a drag-drop). */
  initialStage?: Stage;
  /** Soft-warning flag: are there unresolved (pending) buyer activities? */
  hasUnresolvedActivity?: boolean;
  onClose: () => void;
  onChanged: (d: DealSummary) => void;
}

export function StageChangeModal({ deal, initialStage, hasUnresolvedActivity, onClose, onChanged }: Props) {
  const [toStage, setToStage] = useState<Stage>(initialStage ?? deal.stage);
  const [deadReason, setDeadReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (toStage === "DEAD" && !deadReason.trim()) { setError("A reason is required to mark a deal Dead."); return; }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<DealSummary>(`/deals/${deal.id}/stage`, {
        toStage,
        deadReason: toStage === "DEAD" ? deadReason.trim() : undefined,
      });
      onChanged(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to change stage");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Move Stage"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={confirm} disabled={busy || toStage === deal.stage}>
            {busy ? "Saving…" : `Move to ${prettyStage(toStage)}`}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Currently in <strong>{prettyStage(deal.stage)}</strong>.
      </p>
      <div className="field">
        <label>Destination stage</label>
        <select value={toStage} onChange={(e) => setToStage(e.target.value as Stage)}>
          {STAGES.map((s) => <option key={s} value={s}>{prettyStage(s)}</option>)}
        </select>
      </div>

      {/* Destination-specific pre-flight checklist */}
      {toStage === "CLOSING" && (
        <div className="banner banner-info">
          Confirm before closing:
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            <li>Selected buyer: {deal.selectedBuyer ? <strong>{deal.selectedBuyer.name}</strong> : <span style={{ color: "var(--red)" }}>none selected</span>}</li>
            <li>Ask price: {deal.askPrice != null ? `$${deal.askPrice.toLocaleString()}` : <span style={{ color: "var(--red)" }}>not set</span>}</li>
          </ul>
        </div>
      )}
      {toStage === "DEAD" && (
        <div className="field">
          <label>Reason (required)</label>
          <textarea rows={3} value={deadReason} onChange={(e) => setDeadReason(e.target.value)} placeholder="Why is this deal dead?" />
        </div>
      )}
      {hasUnresolvedActivity && toStage !== deal.stage && (
        <div className="banner banner-warn">
          Heads up: this deal has buyer outreach still awaiting a response. You can still proceed.
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
