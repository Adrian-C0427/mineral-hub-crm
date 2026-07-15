import { useState, type ReactNode } from "react";

/**
 * A panel section that starts collapsed and expands on demand — the same
 * header interaction as the Buyer Portal panel (dpp-*), so collapsible
 * sections look and behave identically everywhere they appear.
 */
export function CollapsibleSection({ title, sub, right, defaultOpen = false, children }: {
  title: string;
  sub?: string;
  /** Extra header content (e.g. a count), shown beside the Expand/Collapse hint. */
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`panel dpp-panel ${open ? "open" : ""}`}>
      <div
        className="dpp-head"
        role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
      >
        <div className="dpp-title">
          <div>
            <h3 style={{ margin: 0 }}>{title}</h3>
            {sub && <div className="dpp-sub">{sub}</div>}
          </div>
        </div>
        <span className="dpp-right">
          {right}
          <span className="muted" style={{ fontSize: 12.5 }}>{open ? "Collapse" : "Expand"}</span>
          <span className={`va-chev ${open ? "" : "down"}`}>⌃</span>
        </span>
      </div>
      {open && <div className="cs-body">{children}</div>}
    </div>
  );
}
