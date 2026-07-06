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

// Standard loss reasons for reporting/loss analysis; "Other" requires a note.
const DEAD_REASONS = [
  "Seller withdrew", "Buyer withdrew", "Price disagreement",
  "Title issues", "Competitive purchase", "Other",
] as const;

export function StageChangeModal({ deal, initialStage, hasUnresolvedActivity, onClose, onChanged }: Props) {
  const [toStage, setToStage] = useState<Stage>(initialStage ?? deal.stage);
  const [deadCategory, setDeadCategory] = useState<string>("");
  const [deadNotes, setDeadNotes] = useState("");
  // Reason saved to history = the category, plus notes when provided ("Other"
  // uses the note as the whole reason).
  const deadReason = deadCategory === "Other"
    ? deadNotes.trim()
    : [deadCategory, deadNotes.trim()].filter(Boolean).join(" — ");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Closed/Dead are transition points out of the active Pipeline — they get an
  // explicit second-step confirmation spelling out the consequence.
  const [confirming, setConfirming] = useState(false);
  const isTerminal = toStage === "CLOSED" || toStage === "DEAD";

  function requestMove() {
    if (toStage === "DEAD" && !deadCategory) { setError("Select a reason this opportunity was lost."); return; }
    if (toStage === "DEAD" && deadCategory === "Other" && !deadNotes.trim()) { setError("Add a note describing the reason."); return; }
    setError(null);
    if (isTerminal) { setConfirming(true); return; }
    void commit();
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<DealSummary>(`/deals/${deal.id}/stage`, {
        toStage,
        deadReason: toStage === "DEAD" ? deadReason.trim() : undefined,
      });
      onChanged(updated);
    } catch (err) {
      setConfirming(false);
      setError(err instanceof ApiError ? err.message : "Failed to change stage");
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    const closed = toStage === "CLOSED";
    return (
      <Modal
        title={closed ? "Move Deal to Closed?" : "Archive Deal?"}
        onClose={() => setConfirming(false)}
        footer={
          <>
            <button onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
            <button className={closed ? "primary" : "danger"} onClick={commit} disabled={busy}>
              {busy ? "Moving…" : closed ? "Move Deal" : "Archive Deal"}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          This action will remove the opportunity from the active Pipeline and move the
          associated deal to <strong>{closed ? "Closed Deals" : "Archived Deals"}</strong>.
        </p>
        {!closed && (
          <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
            <li>Loss reason <strong>{deadReason}</strong> is saved to the deal history with your name and the date.</li>
            {deal.publishedToPortal && <li>The offering will be <strong>unpublished from the Buyer Portal</strong>.</li>}
          </ul>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          Nothing is deleted — all deal information, documents, buyer activity, emails, notes,
          and history stay with the deal, and dashboards and reports update automatically.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Move Stage"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={requestMove} disabled={busy || toStage === deal.stage}>
            {busy ? "Saving…" : `Move to ${prettyStage(toStage)}${isTerminal ? "…" : ""}`}
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
        <>
          <div className="field">
            <label>Reason lost (required)</label>
            <select value={deadCategory} onChange={(e) => setDeadCategory(e.target.value)}>
              <option value="">Select a reason…</option>
              {DEAD_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {deadCategory && (
            <div className="field">
              <label>{deadCategory === "Other" ? "Details (required)" : "Additional notes (optional)"}</label>
              <textarea rows={2} value={deadNotes} onChange={(e) => setDeadNotes(e.target.value)} placeholder="Add context for future loss analysis…" />
            </div>
          )}
          {deal.publishedToPortal && (
            <div className="banner banner-warn">This offering is live on the Buyer Portal — marking it Dead will unpublish it.</div>
          )}
        </>
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
