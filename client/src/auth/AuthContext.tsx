import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: "OWNER" | "ASSOCIATE";
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  orgRole: "OWNER" | "MEMBER" | null;
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
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ user: CurrentUser }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    await api.post<{ user: CurrentUser }>("/auth/login", { email, password });
    // Fetch the full profile (incl. organization) after authenticating.
    await refresh();
  };

  const register = async (payload: RegisterPayload) => {
    await api.post<{ user: CurrentUser }>("/auth/register", payload);
    await refresh();
  };

  const logout = async () => {
    await api.post("/auth/logout");
    setUser(null);
  };

  const refresh = async () => {
    const r = await api.get<{ user: CurrentUser }>("/auth/me");
    setUser(r.user);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refresh, isOwner: user?.role === "OWNER" }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
