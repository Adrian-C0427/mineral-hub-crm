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
}

const ThemeContext = createContext<ThemeState | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [theme, setThemeState] = useState<Theme>(readStored);

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

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
