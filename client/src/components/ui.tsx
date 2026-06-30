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
