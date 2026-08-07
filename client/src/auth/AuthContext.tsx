import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, setAuthToken, getAuthToken } from "../api/client";
import { saveBranding } from "../lib/branding";

export type OrgRole = "OWNER" | "ADMIN" | "MANAGER" | "MEMBER" | "VIEWER";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: "OWNER" | "ASSOCIATE";
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  orgRole: OrgRole | null;
  permissions: string[];
  organization: { id: string; name: string; teamId: string; fullLogo?: string | null; compactLogo?: string | null } | null;
  mustChangePassword?: boolean;
  /** Persisted UI theme, or null when the user hasn't explicitly chosen one.
   *  The client only adopts a non-null value, so it never clobbers the local
   *  theme with a default. */
  themePreference?: "dark" | "light" | null;
  accentColor?: string | null;
  accentColor2?: string | null;
  avatarColor?: string | null;
}

export interface RegisterPayload {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  password: string;
  joinToken?: string;
}

/** login() resolves to this: either signed in, or a 2FA challenge is required. */
export type LoginResult = { status: "ok" } | { status: "twoFactorRequired" };

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  /** Pass totpCode to complete a 2FA challenge. Returns whether 2FA is needed. */
  login: (email: string, password: string, totpCode?: string) => Promise<LoginResult>;
  register: (payload: RegisterPayload) => Promise<void>;
  /** Adopt a session token obtained out-of-band (OAuth redirect). */
  loginWithToken: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  isOwner: boolean;
  /** Org owner (RBAC authority), distinct from the legacy account `role`. */
  isOrgOwner: boolean;
  /** True if the current user holds the given permission (owner has all). */
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

/** Reset the URL to "/" across an auth boundary. The provider mounts above the
 *  router, so we go through the history API + popstate (which React Router
 *  listens for). Without this, signing out strands the login form on a stale
 *  deep link, and a fresh signup lands wherever the inviter last was. */
function resetLocation() {
  if (window.location.pathname !== "/") {
    window.history.replaceState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Only attempt to restore a session if we have a stored token.
    if (!getAuthToken()) { setLoading(false); return; }
    let alive = true;
    // Session restore must survive transient failures: only a real auth
    // rejection (401/403) invalidates the token. A network blip or a 5xx
    // (e.g. a serverless DB cold-start hiccup) gets a couple of quick
    // retries and otherwise leaves the session intact for the next load —
    // previously ANY error here silently logged the user out.
    const boot = async (attempt = 0): Promise<void> => {
      try {
        const r = await api.get<{ user: CurrentUser }>("/auth/me");
        if (alive) adopt(r.user);
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        if (status === 401 || status === 403) {
          setAuthToken(null);
          if (alive) setUser(null);
          return;
        }
        if (attempt < 2 && alive) {
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
          return boot(attempt + 1);
        }
      }
    };
    void boot().finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  /** Install the fresh profile + persist org branding for instant next-boot paint. */
  const adopt = (u: CurrentUser) => {
    setUser(u);
    saveBranding(u.organization
      ? { name: u.organization.name, fullLogo: u.organization.fullLogo ?? null, compactLogo: u.organization.compactLogo ?? null }
      : null);
  };

  const login = async (email: string, password: string, totpCode?: string): Promise<LoginResult> => {
    const r = await api.post<{ token?: string; twoFactorRequired?: boolean }>("/auth/login", { email, password, ...(totpCode ? { totpCode } : {}) });
    if (r.twoFactorRequired || !r.token) return { status: "twoFactorRequired" };
    setAuthToken(r.token);
    // Fetch the full profile (incl. organization) after authenticating.
    await refresh();
    return { status: "ok" };
  };

  const loginWithToken = async (token: string) => {
    setAuthToken(token);
    await refresh();
  };

  const register = async (payload: RegisterPayload) => {
    const r = await api.post<{ token: string; user: CurrentUser }>("/auth/register", payload);
    setAuthToken(r.token);
    await refresh();
    resetLocation(); // new members start on the Dashboard, not the inviter's last page
  };

  const logout = async () => {
    await api.post("/auth/logout").catch(() => {});
    setAuthToken(null);
    setUser(null);
    saveBranding(null); // another account must never inherit this org's mark
    resetLocation(); // back to the marketing site, not a stale in-app URL
  };

  const refresh = async () => {
    const r = await api.get<{ user: CurrentUser }>("/auth/me");
    adopt(r.user);
  };

  const can = (permission: string): boolean =>
    user?.orgRole === "OWNER" || (user?.permissions?.includes(permission) ?? false);

  return (
    <AuthContext.Provider
      value={{
        user, loading, login, register, loginWithToken, logout, refresh,
        isOwner: user?.role === "OWNER",
        isOrgOwner: user?.orgRole === "OWNER",
        can,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
