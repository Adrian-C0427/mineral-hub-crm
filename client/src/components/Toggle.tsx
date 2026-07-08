/**
 * The app-standard toggle switch (a 38×22 pill with a sliding knob). Used
 * everywhere a boolean is flipped inline — Buyer Portal publish/featured, the
 * Buyer Portal enable switch, etc. — so on/off controls look identical app-wide.
 */
export function Toggle({ checked, disabled, onChange, ariaLabel }: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <span
      className={`tgl ${checked ? "on" : ""} ${disabled ? "dis" : ""}`}
      role="switch" aria-checked={checked} aria-label={ariaLabel} tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onChange(!checked)}
      onKeyDown={(e) => { if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onChange(!checked); } }}
    >
      <span className="tgl-knob" />
    </span>
  );
}
