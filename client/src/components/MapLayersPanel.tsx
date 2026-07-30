/**
 * The single, shared map Layers control used everywhere a map appears (the main
 * Map page, the per-deal map, tract mapping, and the public Buyer Portal maps).
 *
 * It renders the exact pill-toggle design of the primary Map page so the Layers
 * experience — styling, spacing, typography, icons, toggles, animation — is
 * identical no matter which map you're looking at. Each map passes its own layer
 * definitions (key + label, in a consistent order); the component owns nothing
 * else, so there is one Layers UI to maintain.
 */

import { useEffect, useState } from "react";

export interface MapLayerDef { key: string; label: string }

/** Accent-tinted pill with a checkmark when on, dim with an empty box when off. */
export function PillToggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`dpp-sec ${on ? "on" : ""}`} onClick={onClick} aria-pressed={on}>
      {on
        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
        : <span className="mc-off-box" />}
      {label}
    </button>
  );
}

/**
 * Layer toggles as a row of pills, preceded by a "Map layers" label.
 * `variant`:
 *  - "inline"   → bare pill row (host wraps it in its own panel; the Map page).
 *  - "bar"      → a bordered toolbar above an embedded canvas (deal/tract maps).
 *  - "floating" → a compact panel that overlays the top-right of a map (portal).
 *
 * `collapsible` (floating maps): the panel starts collapsed to a compact "Layers"
 * button so the map has maximum room; one click expands the pill row (animated),
 * and the open/closed choice is remembered for the browser session.
 */
export function MapLayersPanel<K extends string>({
  defs, layers, onToggle, title = "Map layers", variant = "inline",
  collapsible = false, storageKey = "mh-maplayers-open",
}: {
  defs: MapLayerDef[];
  layers: Record<K, boolean>;
  onToggle: (key: K) => void;
  title?: string;
  variant?: "inline" | "bar" | "floating";
  collapsible?: boolean;
  storageKey?: string;
}) {
  const activeCount = defs.reduce((n, d) => n + (layers[d.key as K] ? 1 : 0), 0);
  // Collapsed by default; remember the buyer's choice for the current session.
  const [open, setOpen] = useState<boolean>(() => {
    if (!collapsible) return true;
    try { return sessionStorage.getItem(storageKey) === "1"; } catch { return false; }
  });
  useEffect(() => {
    if (!collapsible) return;
    try { sessionStorage.setItem(storageKey, open ? "1" : "0"); } catch { /* storage off */ }
  }, [collapsible, open, storageKey]);

  const pills = (
    <div className="mc-pills-row ml-pills">
      {defs.map((d) => (
        <PillToggle key={d.key} on={Boolean(layers[d.key as K])} label={d.label} onClick={() => onToggle(d.key as K)} />
      ))}
    </div>
  );

  // Floating overlay (portal maps): the reference card design — header row with
  // layers glyph, count badge and chevron; a vertical checkbox list when open.
  if (variant === "floating") {
    return (
      <div className={`ml2-panel ${open ? "open" : ""}`}>
        <button type="button" className="ml2-head" onClick={() => (collapsible ? setOpen((o) => !o) : undefined)} aria-expanded={open} title={open ? `Hide ${title.toLowerCase()}` : `Show ${title.toLowerCase()}`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml2-glyph" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>
          <span className="ml2-title">{title}</span>
          <span className="ml2-count">{activeCount}</span>
          <svg className="ml2-caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{open ? <path d="M18 15l-6-6-6 6" /> : <path d="M6 9l6 6 6-6" />}</svg>
        </button>
        {open && (
          <div className="ml2-list">
            {defs.map((d) => {
              const on = Boolean(layers[d.key as K]);
              return (
                <div key={d.key} className="ml2-row" role="checkbox" aria-checked={on} tabIndex={0}
                  onClick={() => onToggle(d.key as K)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(d.key as K); } }}>
                  <span className={`ml2-box ${on ? "on" : ""}`}>
                    {on && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>}
                  </span>
                  <span className={`ml2-label ${on ? "on" : ""}`}>{d.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (collapsible) {
    return (
      <div className={`ml-layers ml-${variant} ml-collapsible ${open ? "open" : "closed"}`}>
        <button type="button" className="ml-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? `Hide ${title.toLowerCase()}` : `Show ${title.toLowerCase()}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
          <span className="ml-toggle-label">{title}</span>
          <span className="ml-count">{activeCount}</span>
          <svg className={`ml-caret ${open ? "open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
        <div className="ml-collapse" aria-hidden={!open}><div className="ml-collapse-inner">{pills}</div></div>
      </div>
    );
  }

  return (
    <div className={`ml-layers ml-${variant}`}>
      <span className="ddx-label ml-title">{title}</span>
      {pills}
    </div>
  );
}
