import type { ReactNode } from "react";
import { prettyStage, prettyEnum } from "../lib/format";

export function PriorityBadge({ priority }: { priority: "HIGH" | "MEDIUM" | "LOW" }) {
  return <span className={`badge priority-${priority.toLowerCase()}`}>{prettyEnum(priority)}</span>;
}

export function StageBadge({ stage }: { stage: string }) {
  return <span className={`badge stage-${stage.toLowerCase()}`}>{prettyStage(stage)}</span>;
}

export function RelationshipDot({ status }: { status: "HOT" | "WARM" | "COLD" }) {
  return (
    <span className="rel">
      <span className={`rel-dot rel-${status.toLowerCase()}`} /> {prettyEnum(status)}
    </span>
  );
}

const RESPONSE_CLASS: Record<string, string> = {
  OFFER_MADE: "resp-offer",
  INTERESTED: "resp-interested",
  PENDING: "resp-pending",
  NOT_INTERESTED: "resp-no",
  PASSED: "resp-passed",
};

export function ResponseBadge({ status }: { status: string }) {
  const label = status === "PENDING" ? "Awaiting reply" : prettyEnum(status);
  return <span className={`badge ${RESPONSE_CLASS[status] ?? ""}`}>{label}</span>;
}

// New buyer pipeline statuses (BuyerStatus).
const STATUS_CLASS: Record<string, string> = {
  CLOSED: "resp-offer",
  OFFER_RECEIVED: "resp-offer",
  NEGOTIATING: "resp-interested",
  REVIEWING: "resp-interested",
  INTERESTED: "resp-interested",
  CONTACTED: "resp-pending",
  PASSED: "resp-passed",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? ""}`}>{prettyEnum(status)}</span>;
}

export function MetricCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {hint && <div className="metric-hint">{hint}</div>}
    </div>
  );
}

export function Banner({ kind = "warn", children }: { kind?: "warn" | "info" | "error"; children: ReactNode }) {
  return <div className={`banner banner-${kind}`}>{children}</div>;
}

export function Modal({
  title,
  children,
  onClose,
  footer,
  wide,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <div className="spinner">{label}</div>;
}

/**
 * Blocking confirmation dialog for significant actions. Renders above any
 * open modal (later in the DOM), so it can layer on top of settings modals.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onCancel} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{message}</div>
        <div className="modal-footer">
          <button onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button className={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {busy ? "Saving…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Standard settings-save confirmation used across every settings page. */
export function ConfirmChanges({ busy, onCancel, onConfirm }: { busy?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog
      title="Confirm Changes"
      message={<p style={{ margin: 0 }}>You have modified your settings. Are you sure you want to save these changes?</p>}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function MatchPercentBadge({ value }: { value: number }) {
  const cls = value >= 80 ? "match-green" : value >= 55 ? "match-amber" : "match-gray";
  return <span className={`match-pct ${cls}`}>{value}%</span>;
}

export function MatchBar({ value }: { value: number }) {
  const cls = value >= 80 ? "match-green-bg" : value >= 55 ? "match-amber-bg" : "match-gray-bg";
  return (
    <div className="match-bar">
      <div className={`match-bar-fill ${cls}`} style={{ width: `${value}%` }} />
    </div>
  );
}
