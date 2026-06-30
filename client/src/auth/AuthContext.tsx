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
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
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
    const r = await api.post<{ user: CurrentUser }>("/auth/login", { email, password });
    setUser(r.user);
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
    <AuthContext.Provider value={{ user, loading, login, logout, refresh, isOwner: user?.role === "OWNER" }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
