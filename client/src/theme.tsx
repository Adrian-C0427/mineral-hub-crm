import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api/client";
import { useAuth } from "./auth/AuthContext";

/**
 * App theme (light / dark). Three layers keep the choice consistent:
 *  - <html data-theme> drives every CSS token (set pre-render by the inline
 *    script in index.html, so there's no flash).
 *  - localStorage mirrors it for instant application on the next load.
 *  - the user profile (PATCH /auth/preferences) is the cross-device source of
 *    truth; on login we reconcile to whatever the server has.
 */
export type Theme = "dark" | "light";

const STORAGE_KEY = "mh-theme";
const ACCENT_KEY = "mh-accent";
const ACCENT2_KEY = "mh-accent2";

/**
 * Accent presets offered in Settings. The default (null accent) keeps the
 * stylesheet's built-in blue — including its deeper light-theme variant — so
 * users who never touch the setting see exactly the current design.
 */
export const ACCENT_PRESETS: { key: string; label: string; hex: string }[] = [
  { key: "blue", label: "Blue", hex: "#3b82f6" },
  { key: "indigo", label: "Indigo", hex: "#6366f1" },
  { key: "violet", label: "Violet", hex: "#8b5cf6" },
  { key: "teal", label: "Teal", hex: "#14b8a6" },
  { key: "emerald", label: "Emerald", hex: "#10b981" },
  { key: "amber", label: "Amber", hex: "#f59e0b" },
  { key: "rose", label: "Rose", hex: "#f43f5e" },
  { key: "slate", label: "Slate", hex: "#64748b" },
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Darken a #rrggbb color by a factor (hover shade for a custom accent). */
function darken(hex: string, factor = 0.85): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  const r = c((n >> 16) & 255), g = c((n >> 8) & 255), b = c(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function readStoredAccent(key: string = ACCENT_KEY): string | null {
  try {
    const v = localStorage.getItem(key);
    return v && HEX_COLOR.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Apply an accent to the DOM + persist locally. Setting the two tokens on the
 * root element overrides both theme blocks at once, so every accent-derived
 * style (buttons, links, focus rings, color-mix tints, chart fills that read
 * var(--accent)) updates instantly — no refresh. Null clears back to the
 * stylesheet default.
 */
function applyAccent(hex: string | null): void {
  const root = document.documentElement.style;
  if (hex && HEX_COLOR.test(hex)) {
    root.setProperty("--accent", hex);
    root.setProperty("--accent-hover", darken(hex));
  } else {
    root.removeProperty("--accent");
    root.removeProperty("--accent-hover");
  }
  try {
    if (hex) localStorage.setItem(ACCENT_KEY, hex);
    else localStorage.removeItem(ACCENT_KEY);
  } catch {
    /* private mode — DOM still updates */
  }
}

/** Secondary accent (--accent2): charts, status indicators, progress bars and
 *  other supporting visuals. Null falls back to the stylesheet default, which
 *  itself follows the primary accent. */
function applyAccent2(hex: string | null): void {
  const root = document.documentElement.style;
  if (hex && HEX_COLOR.test(hex)) root.setProperty("--accent2", hex);
  else root.removeProperty("--accent2");
  try {
    if (hex) localStorage.setItem(ACCENT2_KEY, hex);
    else localStorage.removeItem(ACCENT2_KEY);
  } catch {
    /* private mode — DOM still updates */
  }
}

function readStored(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    if (t === "light" || t === "dark") return t;
    // Fall back to whatever the boot script already applied.
    const attr = document.documentElement.dataset.theme;
    return attr === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Apply to the DOM + persist locally. Server persistence is handled separately. */
function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode / storage disabled — DOM still updates */
  }
}

interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  /** Custom accent hex, or null for the built-in blue. */
  accent: string | null;
  setAccent: (hex: string | null) => void;
  /** Secondary accent (charts/indicators), or null to follow the accent. */
  accent2: string | null;
  setAccent2: (hex: string | null) => void;
}

const ThemeContext = createContext<ThemeState | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [theme, setThemeState] = useState<Theme>(readStored);
  const [accent, setAccentState] = useState<string | null>(() => readStoredAccent());
  const [accent2, setAccent2State] = useState<string | null>(() => readStoredAccent(ACCENT2_KEY));

  // Re-apply the locally stored accents on mount (the theme boot script only
  // handles data-theme; accent tokens are inline style properties).
  useEffect(() => { applyAccent(readStoredAccent()); applyAccent2(readStoredAccent(ACCENT2_KEY)); }, []);

  // User-initiated change: apply immediately, then persist to the profile so it
  // follows them to other devices. Server write is best-effort (offline, or the
  // DB column not yet pushed) — the local application already succeeded.
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyTheme(t);
    api.patch("/auth/preferences", { theme: t }).catch(() => {});
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const setAccent = useCallback((hex: string | null) => {
    setAccentState(hex);
    applyAccent(hex);
    api.patch("/auth/preferences", { accentColor: hex }).catch(() => {});
  }, []);

  const setAccent2 = useCallback((hex: string | null) => {
    setAccent2State(hex);
    applyAccent2(hex);
    api.patch("/auth/preferences", { accentColor2: hex }).catch(() => {});
  }, []);

  // When the profile loads (login / refresh), the server is authoritative — adopt
  // its saved theme so a preference set on another device wins over this device's
  // stale local copy. Only applies when it actually differs, to avoid churn.
  useEffect(() => {
    const server = user?.themePreference;
    if ((server === "light" || server === "dark") && server !== theme) {
      setThemeState(server);
      applyTheme(server);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.themePreference]);

  // Same adoption for the saved accents (non-null only, mirroring the theme).
  useEffect(() => {
    const server = user?.accentColor;
    if (server && HEX_COLOR.test(server) && server !== accent) {
      setAccentState(server);
      applyAccent(server);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.accentColor]);

  useEffect(() => {
    const server = user?.accentColor2;
    if (server && HEX_COLOR.test(server) && server !== accent2) {
      setAccent2State(server);
      applyAccent2(server);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.accentColor2]);

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, accent, setAccent, accent2, setAccent2 }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
