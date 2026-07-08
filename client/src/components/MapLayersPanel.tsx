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
 */
export function MapLayersPanel<K extends string>({
  defs, layers, onToggle, title = "Map layers", variant = "inline",
}: {
  defs: MapLayerDef[];
  layers: Record<K, boolean>;
  onToggle: (key: K) => void;
  title?: string;
  variant?: "inline" | "bar" | "floating";
}) {
  return (
    <div className={`ml-layers ml-${variant}`}>
      <span className="ddx-label ml-title">{title}</span>
      <div className="mc-pills-row ml-pills">
        {defs.map((d) => (
          <PillToggle key={d.key} on={Boolean(layers[d.key as K])} label={d.label} onClick={() => onToggle(d.key as K)} />
        ))}
      </div>
    </div>
  );
}
