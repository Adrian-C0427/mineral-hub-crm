/**
 * Shared segmented period control — the compact pill selector first introduced
 * on the Research page, reused on Reports, Expenses, and the Dashboard so every
 * reporting surface picks a date range the same way.
 *
 * Generic over the preset union so each page supplies its own presets; a preset
 * whose value is "CUSTOM" automatically shows a small calendar glyph.
 */
export function CalendarGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

export function PeriodSegmented<T extends string>({ options, value, onChange, compact }: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  /** Tighter padding for header placement (e.g. the Dashboard). */
  compact?: boolean;
}) {
  return (
    <div className={`seg-control${compact ? " seg-compact" : ""}`}>
      {options.map(([v, label]) => (
        <span key={v} className={`seg ${value === v ? "active" : ""}`} onClick={() => onChange(v)}>
          {v === "CUSTOM" && <CalendarGlyph />}
          {label}
        </span>
      ))}
    </div>
  );
}
