import { useEffect, useState } from "react";
import { useTheme, ACCENT_PRESETS, type Theme } from "../theme";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { AVATAR_COLORS, avatarColor } from "../lib/avatarColor";

// Appearance — theme picker. Applies instantly across the whole app and saves
// to the user's profile so the choice follows them across devices. Preview
// colours are fixed per card (they depict that theme, not the active one).
const OPTIONS: { value: Theme; label: string; hint: string; side: string; bg: string; line: string; card: string; frame: string }[] = [
  { value: "light", label: "Light", hint: "Bright surfaces for well-lit rooms", side: "#0A0A0A", bg: "#FFFFFF", line: "#D4D4D8", card: "#EDEDED", frame: "#E4E4E7" },
  { value: "dark", label: "Dark", hint: "Low glare, the original look", side: "#0A0A0A", bg: "#000000", line: "#2A2A2A", card: "#161616", frame: "#1E1E1E" },
  { value: "dim", label: "Dim", hint: "Soft charcoal with a cool blue cast", side: "#16181D", bg: "#111318", line: "#2C3038", card: "#1A1D23", frame: "#262A31" },
  { value: "slate", label: "Slate", hint: "Modern professional gray, built for dashboards", side: "#1E293B", bg: "#0F172A", line: "#475569", card: "#1E293B", frame: "#334155" },
  { value: "dusk", label: "Dusk", hint: "Darker gray that stops short of black", side: "#2C2D32", bg: "#26272B", line: "#4C4D54", card: "#35363C", frame: "#3D3E44" },
  { value: "neutral", label: "Neutral", hint: "Warm taupe and sage, no stark whites or deep blacks", side: "#3F3C36", bg: "#4A4740", line: "#8E9580", card: "#57544C", frame: "#625F57" },
];

export function AppearanceSettings() {
  const { theme, setTheme, accent, setAccent, accent2, setAccent2 } = useTheme();
  const { user, refresh } = useAuth();

  // Colors already claimed by teammates — shown as taken so avatar colors stay
  // unique within the org where feasible (you can still pick one if you insist).
  const [taken, setTaken] = useState<string[]>([]);
  useEffect(() => {
    api.get<{ taken: string[] }>("/auth/avatar-colors").then((r) => setTaken(r.taken)).catch(() => {});
  }, []);

  const myAvatar = user?.avatarColor ?? null;
  const autoColor = avatarColor(user?.name);

  async function pickAvatarColor(hex: string | null) {
    try {
      await api.patch("/auth/preferences", { avatarColor: hex });
      await refresh(); // avatar in the header updates immediately
    } catch { /* offline — leave as-is */ }
  }

  return (
    <div className="panel">
      <h3>Appearance</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Choose how Mineral Hub looks. Changes apply immediately everywhere and are saved to your account, so they follow you across devices.
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
            <span className="theme-preview" style={{ borderColor: o.frame }} aria-hidden="true">
              <span className="tpv-side" style={{ background: o.side }}>
                <i style={{ background: o.value === "light" ? "#2A2A2A" : o.line }} />
                <i style={{ background: o.value === "light" ? "#2A2A2A" : o.line, width: "70%" }} />
                <i style={{ background: "var(--accent)" }} />
              </span>
              <span className="tpv-main" style={{ background: o.bg }}>
                <i style={{ background: o.line, width: "60%" }} />
                <b style={{ background: o.card }} />
                <i style={{ background: "var(--accent)", width: "40%" }} />
              </span>
            </span>
            <span className="theme-option-foot">
              <span className="theme-radio" />
              <span className="theme-option-text">
                <span className="theme-option-label">{o.label}</span>
                <span className="theme-option-hint">{o.hint}</span>
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="pref-row">
        <div className="pref-desc">
          <div className="pref-title">Primary accent color</div>
          <div className="muted" style={{ fontSize: 12 }}>
            Controls primary interactive elements — buttons, active navigation items, links, primary highlights, and selected states. Blue is the default.
          </div>
        </div>
        <div className="swatch-row" role="radiogroup" aria-label="Primary accent color">
          {ACCENT_PRESETS.map((p) => {
            const active = p.hex === "#3b82f6" ? accent == null || accent === p.hex : accent === p.hex;
            return (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={active}
                title={p.label}
                className={`color-swatch ${active ? "active" : ""}`}
                style={{ background: p.hex }}
                onClick={() => setAccent(p.hex === "#3b82f6" ? null : p.hex)}
              >
                {active && <span className="swatch-check" aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-desc">
          <div className="pref-title">Secondary accent color</div>
          <div className="muted" style={{ fontSize: 12 }}>
            Controls secondary interface elements — charts and graphs, status indicators, progress bars, and supporting visual accents. By default it follows the primary accent.
          </div>
        </div>
        <div className="swatch-row" role="radiogroup" aria-label="Secondary accent color">
          <button
            type="button"
            role="radio"
            aria-checked={accent2 == null}
            title="Follow the primary accent"
            className={`color-swatch ${accent2 == null ? "active" : ""}`}
            style={{ background: accent ?? "#3b82f6" }}
            onClick={() => setAccent2(null)}
          >
            <span className="swatch-auto" aria-hidden="true">A</span>
            {accent2 == null && <span className="swatch-check" aria-hidden="true">✓</span>}
          </button>
          {ACCENT_PRESETS.map((p) => {
            const active = accent2 === p.hex;
            return (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={active}
                title={p.label}
                className={`color-swatch ${active ? "active" : ""}`}
                style={{ background: p.hex }}
                onClick={() => setAccent2(p.hex)}
              >
                {active && <span className="swatch-check" aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="pref-row">
        <div>
          <div className="pref-title">Avatar color</div>
          <div className="muted" style={{ fontSize: 12 }}>
            The color behind your initials, everywhere your avatar appears. Colors already used by teammates are marked so each member stays distinct.
          </div>
        </div>
        <div className="swatch-row" role="radiogroup" aria-label="Avatar color">
          <button
            type="button"
            role="radio"
            aria-checked={myAvatar == null}
            title="Auto (assigned from your name)"
            className={`color-swatch ${myAvatar == null ? "active" : ""}`}
            style={{ background: autoColor }}
            onClick={() => void pickAvatarColor(null)}
          >
            <span className="swatch-auto" aria-hidden="true">A</span>
            {myAvatar == null && <span className="swatch-check" aria-hidden="true">✓</span>}
          </button>
          {AVATAR_COLORS.map((hex) => {
            const active = myAvatar === hex;
            const isTaken = taken.includes(hex) && !active;
            return (
              <button
                key={hex}
                type="button"
                role="radio"
                aria-checked={active}
                title={isTaken ? "Already used by a teammate" : hex}
                className={`color-swatch ${active ? "active" : ""} ${isTaken ? "taken" : ""}`}
                style={{ background: hex }}
                onClick={() => void pickAvatarColor(hex)}
              >
                {active && <span className="swatch-check" aria-hidden="true">✓</span>}
                {isTaken && <span className="swatch-taken" aria-hidden="true">/</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
