/**
 * Dollar-amount input with live thousand separators and a $ prefix.
 * Callers keep storing the same raw numeric STRING they always did (e.g.
 * "450000" or "12.50") — this component only changes what the user sees
 * while typing ("450,000"), so "0450000" no longer reads like a typo.
 */
export function MoneyInput({ value, onChange, placeholder, decimals = 0, disabled, ariaLabel, style }: {
  value: string;
  onChange: (raw: string) => void;
  placeholder?: string;
  /** Allow cents (expenses) — 0 for whole-dollar deal/offer amounts. */
  decimals?: number;
  disabled?: boolean;
  ariaLabel?: string;
  style?: React.CSSProperties;
}) {
  const display = format(value, decimals);

  function handle(e: React.ChangeEvent<HTMLInputElement>) {
    let raw = e.target.value.replace(/[^0-9.]/g, "");
    // A single decimal point, capped to the allowed precision.
    const firstDot = raw.indexOf(".");
    if (firstDot >= 0) {
      if (decimals === 0) raw = raw.slice(0, firstDot);
      else raw = raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, "").slice(0, decimals);
    }
    // Trim a leading-zero prefix ("0450000" → "450000"), but keep "0." intact.
    raw = raw.replace(/^0+(?=\d)/, "");
    onChange(raw);
  }

  return (
    <span className="money-input" style={style}>
      <span className="mi-prefix" aria-hidden="true">$</span>
      <input
        inputMode="decimal"
        value={display}
        onChange={handle}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
      />
    </span>
  );
}

function format(raw: string, decimals: number): string {
  if (raw === "" || raw == null) return "";
  const [int, frac] = raw.split(".");
  const withSep = int === "" ? "" : Number(int).toLocaleString("en-US");
  if (raw.includes(".") && decimals > 0) return `${withSep}.${frac ?? ""}`;
  return withSep;
}
