import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { userAvatarColor, avatarColor } from "../lib/avatarColor";

/**
 * Shared building blocks of the redesign. Each is the single implementation of
 * a pattern that recurs across pages — use these rather than page-local copies.
 * Styles live in styles/kit.css.
 */

/** Connected stat strip: one bordered card whose cells are divided by hairlines. */
export interface StatCell {
  label: ReactNode;
  value: ReactNode;
  /** Small line under the value (context, formula, counts). */
  sub?: ReactNode;
  /** Value tone. */
  tone?: "default" | "success" | "warn" | "danger" | "accent";
  /** Tag shown beside the label (e.g. "Realized"). */
  tag?: ReactNode;
  title?: string;
  onClick?: () => void;
}
export function StatStrip({ cells, className = "", min = 180 }: { cells: StatCell[]; className?: string; min?: number }) {
  return (
    <div className={`stat-strip ${className}`} style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` }}>
      {cells.map((c, i) => {
        const body = (
          <>
            <span className="stat-label">{c.label}{c.tag && <span className="stat-tag">{c.tag}</span>}</span>
            <span className={`stat-value tone-${c.tone ?? "default"}`}>{c.value}</span>
            {c.sub != null && <span className="stat-sub">{c.sub}</span>}
          </>
        );
        return c.onClick
          ? <button type="button" key={i} className="stat-cell clickable" title={c.title} onClick={c.onClick}>{body}</button>
          : <div key={i} className="stat-cell" title={c.title}>{body}</div>;
      })}
    </div>
  );
}

/** Segmented control. `accent` fills the active option with the accent colour
 *  (period selectors); the default is the neutral tray used for filters. */
export interface SegOption<T extends string> { value: T; label: ReactNode; count?: number | string; dot?: string; title?: string }
export function Segmented<T extends string>({ options, value, onChange, accent = false, className = "", ariaLabel }: {
  options: SegOption<T>[]; value: T; onChange: (v: T) => void; accent?: boolean; className?: string; ariaLabel?: string;
}) {
  return (
    <div className={`seg ${accent ? "seg-accent" : ""} ${className}`} role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} title={o.title}
          className={`seg-item ${o.value === value ? "active" : ""}`} onClick={() => onChange(o.value)}>
          {o.dot && <span className="seg-dot" style={{ background: o.dot }} />}
          <span>{o.label}</span>
          {o.count != null && <span className="seg-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Right-hand side panel (slide-in editor). Portaled to <body>; Escape and the
 *  backdrop call onClose — callers keep their own unsaved-changes guards. */
export function SidePanel({ title, subtitle, onClose, children, footer, width = 480 }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="side-panel-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="side-panel" style={{ width }} role="dialog" aria-modal="true">
        <header className="side-panel-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="side-panel-x" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>
        <div className="side-panel-body">{children}</div>
        {footer && <footer className="side-panel-foot">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

const initialsOf = (name: string | null | undefined): string =>
  (name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/** Initials avatar in the person's saved (or name-derived) colour. */
export function Avatar({ user, name, size = 24, title }: {
  user?: { name?: string | null; avatarColor?: string | null } | null; name?: string | null; size?: number; title?: string;
}) {
  const n = user?.name ?? name ?? "";
  const bg = user ? userAvatarColor(user as Parameters<typeof userAvatarColor>[0]) : avatarColor(n);
  return (
    <span className="avatar" title={title ?? n} style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)), background: bg }}>
      {initialsOf(n)}
    </span>
  );
}

/** Tag with an optional leading dot (status / relationship / type). */
export function Tag({ tone = "neutral", dot = false, children, title }: {
  tone?: "neutral" | "accent" | "success" | "warn" | "danger" | "violet" | "cyan"; dot?: boolean; children: ReactNode; title?: string;
}) {
  return <span className={`tag tag-${tone}`} title={title}>{dot && <i />}{children}</span>;
}

/** Thin progress bar (0–1). */
export function ProgressBar({ value, tone = "accent" }: { value: number; tone?: "accent" | "success" | "warn" | "danger" }) {
  return <span className="pbar"><i className={`tone-${tone}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></span>;
}

/** Section header used inside forms: a short accent bar and an uppercase title. */
export function FormSection({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="form-sec">
      <div className="form-sec-head"><span className="form-sec-bar" /><span className="form-sec-title">{title}</span>{hint && <span className="form-sec-hint">{hint}</span>}</div>
      {children}
    </section>
  );
}
