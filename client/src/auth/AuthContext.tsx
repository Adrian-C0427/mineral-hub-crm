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
  organization: { id: string; name: string; teamId: string } | null;
}

export interface RegisterPayload {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  password: string;
  joinToken?: string;
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  isOwner: boolean;
  /** Org owner (RBAC authority), distinct from the legacy account `role`. */
  isOrgOwner: boolean;
  /** True if the current user holds the given permission (owner has all). */
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

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

  const login = async (email: string, password: string) => {
    const r = await api.post<{ token: string; user: CurrentUser }>("/auth/login", { email, password });
    setAuthToken(r.token);
    // Fetch the full profile (incl. organization) after authenticating.
    await refresh();
  };

  const register = async (payload: RegisterPayload) => {
    const r = await api.post<{ token: string; user: CurrentUser }>("/auth/register", payload);
    setAuthToken(r.token);
    await refresh();
  };

  const logout = async () => {
    await api.post("/auth/logout").catch(() => {});
    setAuthToken(null);
    setUser(null);
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
        user, loading, login, register, logout, refresh,
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
