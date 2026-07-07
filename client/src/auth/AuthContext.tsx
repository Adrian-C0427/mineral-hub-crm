import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setAuthToken, getAuthToken } from "../api/client";

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
    api
      .get<{ user: CurrentUser }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => { setAuthToken(null); setUser(null); })
      .finally(() => setLoading(false));
  }, []);

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
    resetLocation(); // back to the marketing site, not a stale in-app URL
  };

  const refresh = async () => {
    const r = await api.get<{ user: CurrentUser }>("/auth/me");
    setUser(r.user);
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
