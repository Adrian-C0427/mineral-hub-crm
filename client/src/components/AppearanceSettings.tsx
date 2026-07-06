import { useTheme, type Theme } from "../theme";

// Appearance — light/dark theme picker. Applies instantly across the whole app
// and saves to the user's profile so the choice follows them across devices.
const OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: "light", label: "Light", hint: "Bright surfaces for well-lit rooms" },
  { value: "dark", label: "Dark", hint: "Low-glare, the app's original look" },
];

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="panel">
      <h3>Appearance</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Choose how Mineral Hub looks. The change applies immediately everywhere and is saved to your account, so it follows you across devices.
      </p>

      <div className="theme-picker" role="radiogroup" aria-label="Theme">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={theme === o.value}
            className={`theme-option ${theme === o.value ? "active" : ""}`}
            onClick={() => setTheme(o.value)}
          >
            <span className={`theme-swatch theme-swatch-${o.value}`} aria-hidden="true">
              <span className="tsw-bar" />
              <span className="tsw-body">
                <span className="tsw-line" />
                <span className="tsw-line short" />
              </span>
            </span>
            <span className="theme-option-label">
              {o.label}
              {theme === o.value && <span className="theme-check" aria-hidden="true"> ✓</span>}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
