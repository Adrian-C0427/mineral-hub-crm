import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { prettyEnum } from "../lib/format";
import { useStages } from "../stages";

/**
 * Shared dialog chrome. Every overlay dialog gets, for free:
 *  - Escape closes (only the top-most dialog when several are stacked)
 *  - background scroll locked while any dialog is open
 *  - a "dirty guard": when the caller marks the dialog dirty, backdrop clicks
 *    and Escape pulse the dialog instead of silently discarding the user's
 *    input — only the explicit × / Cancel buttons close it.
 */
const MODAL_STACK: symbol[] = [];

function useDialogChrome(onClose: () => void, dirty?: boolean) {
  const id = useRef(Symbol("dialog")).current;
  const [attn, setAttn] = useState(0);
  const latest = useRef({ onClose, dirty });
  latest.current = { onClose, dirty };

  // requestClose("x") always closes; backdrop/esc respect the dirty guard.
  const requestClose = (source: "backdrop" | "esc" | "x") => {
    if (source !== "x" && latest.current.dirty) { setAttn((n) => n + 1); return; }
    latest.current.onClose();
  };

  useEffect(() => {
    MODAL_STACK.push(id);
    document.body.classList.add("modal-open");
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (MODAL_STACK[MODAL_STACK.length - 1] !== id) return;
      e.stopPropagation();
      if (latest.current.dirty) { setAttn((n) => n + 1); return; }
      latest.current.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      const i = MODAL_STACK.indexOf(id);
      if (i >= 0) MODAL_STACK.splice(i, 1);
      if (MODAL_STACK.length === 0) document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { requestClose, attn };
}

/* ---------------------------------------------------------------- toasts --
 * Fixed-position success/error feedback that never reflows the page. Fire
 * from anywhere with showToast("Saved."); <ToastHost/> is mounted once in App.
 */
type ToastKind = "success" | "error" | "info";
interface ToastItem { id: number; kind: ToastKind; msg: ReactNode }

let toastListener: ((t: ToastItem) => void) | null = null;
let toastSeq = 0;

export function showToast(msg: ReactNode, kind: ToastKind = "success") {
  toastListener?.({ id: ++toastSeq, kind, msg });
}

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  useEffect(() => {
    toastListener = (t) => {
      setToasts((l) => [...l.slice(-3), t]);
      window.setTimeout(() => setToasts((l) => l.filter((x) => x.id !== t.id)), 4200);
    };
    return () => { toastListener = null; };
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span className="toast-dot" aria-hidden="true" />
          <span className="toast-msg">{t.msg}</span>
          <button className="toast-x" aria-label="Dismiss" onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}>×</button>
        </div>
      ))}
    </div>
  );
}

/**
 * Standard back-to-list navigation for detail pages. Prefers browser back (so
 * the parent list's filters/scroll survive) and falls back to `fallback` on a
 * deep link with no in-app history.
 */
export function BackLink({ label, fallback }: { label: string; fallback: string }) {
  const nav = useNavigate();
  const go = () => { if (window.history.length > 1) nav(-1); else nav(fallback); };
  return <button className="link-btn back-link" onClick={go} style={{ marginBottom: 10 }}>← {label}</button>;
}

export function PriorityBadge({ priority }: { priority: "HIGH" | "MEDIUM" | "LOW" }) {
  // Priority is computed, not user-set — the tooltip explains why it changes on its own.
  return (
    <span
      className={`badge priority-${priority.toLowerCase()}`}
      title="Priority is computed automatically from deadline proximity and deal stage — e.g. it relaxes once a buyer is selected and the deal moves to closing."
    >
      {prettyEnum(priority)}
    </span>
  );
}

export function StageBadge({ stage }: { stage: string }) {
  const { label } = useStages();
  return <span className={`badge stage-${stage.toLowerCase()}`}>{label(stage)}</span>;
}

export function RelationshipDot({ status }: { status: "HOT" | "WARM" | "COLD" }) {
  return (
    <span className="rel">
      <span className={`rel-dot rel-${status.toLowerCase()}`} /> {prettyEnum(status)}
    </span>
  );
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

export function MetricCard({ label, value, hint, valueColor }: { label: string; value: ReactNode; hint?: string; valueColor?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={valueColor ? { color: valueColor } : undefined}>{value}</div>
      {hint && <div className="metric-hint">{hint}</div>}
    </div>
  );
}

export function Banner({ kind = "warn", children }: { kind?: "warn" | "info" | "error"; children: ReactNode }) {
  return <div className={`banner banner-${kind}`}>{children}</div>;
}

/**
 * The application's standard "no data yet" empty state: generous padding on all
 * sides, a comfortable line height, and a constrained, centered column so the
 * message wraps naturally and stays visually balanced at any width. Use this for
 * zero-data panels/sections everywhere so empty states read consistently.
 */
export function EmptyState({ title, icon, children }: { title?: ReactNode; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon" aria-hidden="true">{icon}</div>}
      {title && <div className="empty-state-title">{title}</div>}
      {children && <div className="empty-state-body">{children}</div>}
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
  footer,
  wide,
  dirty,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  /** When true, backdrop clicks and Escape pulse the dialog instead of
   *  discarding the user's in-progress input; × and Cancel still close. */
  dirty?: boolean;
}) {
  const { requestClose, attn } = useDialogChrome(onClose, dirty);
  return (
    <div className="modal-overlay" onClick={() => requestClose("backdrop")}>
      <div
        key={attn} /* re-triggers the pulse animation on each blocked close */
        className={`modal ${wide ? "modal-wide" : ""} ${attn ? "modal-attn" : ""}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={() => requestClose("x")} aria-label="Close">
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
  const { requestClose } = useDialogChrome(onCancel);
  return (
    <div className="modal-overlay" onClick={() => requestClose("backdrop")}>
      <div className="modal" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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

/**
 * Standard destructive-delete confirmation used everywhere records can be
 * permanently deleted. States how many records will be removed and requires the
 * user to type DELETE before the button enables. `count` drives the pluralized
 * message; pass `itemLabel` (e.g. "deal", "buyer") for clearer copy.
 */
export function ConfirmDelete({
  count = 1,
  itemLabel = "record",
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  count?: number;
  itemLabel?: string;
  /** Optional single-record name to show in the prompt. */
  name?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const plural = count === 1 ? itemLabel : `${itemLabel}s`;
  const armed = typed.trim().toUpperCase() === "DELETE";
  // Typed text counts as dirty — a stray backdrop click shouldn't eat it.
  const { requestClose, attn } = useDialogChrome(onCancel, typed.length > 0);
  return (
    <div className="modal-overlay" onClick={() => requestClose("backdrop")}>
      <div key={attn} className={`modal ${attn ? "modal-attn" : ""}`} role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Confirm deletion</h3>
          <button className="icon-btn" onClick={onCancel} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <p style={{ marginTop: 0 }}>
            This will permanently delete{" "}
            {count === 1 && name ? <strong>{name}</strong> : <strong>{count.toLocaleString()} {plural}</strong>}
            . This action cannot be undone.
          </p>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Type <strong>DELETE</strong> to confirm</label>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="DELETE"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && armed && !busy) onConfirm(); }}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="danger" onClick={onConfirm} disabled={!armed || busy}>
            {busy ? "Deleting…" : `Delete ${count === 1 ? itemLabel : `${count} ${plural}`}`}
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

/**
 * Header overflow menu (⋯) for secondary and destructive page actions.
 * Destructive actions never sit as primary header buttons — they live here,
 * one deliberate click away, styled red inside the menu.
 */
export function OverflowMenu({ items, ariaLabel = "More actions" }: {
  items: { label: ReactNode; danger?: boolean; onClick: () => void }[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  return (
    <div className="ovf" ref={ref}>
      <button className="icon-btn ovf-btn" aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} title={ariaLabel} onClick={() => setOpen((o) => !o)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
      {open && (
        <div className="ovf-menu" role="menu">
          {items.map((it, i) => (
            <button key={i} role="menuitem" className={`ovf-item ${it.danger ? "danger" : ""}`} onClick={() => { setOpen(false); it.onClick(); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
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
