import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { Spinner } from "./components/ui";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Pipeline } from "./pages/Pipeline";
import { Deals } from "./pages/Deals";
import { DealDetail } from "./pages/DealDetail";
import { Buyers } from "./pages/Buyers";
import { BuyerProfile } from "./pages/BuyerProfile";
import { Reports } from "./pages/Reports";
import { Settings } from "./pages/Settings";

function TopNav() {
  const { user, logout } = useAuth();
  return (
    <nav className="topnav">
      <span className="brand">
        Mineral Hub<span className="dot">.</span>
      </span>
      <div className="nav-links">
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/pipeline">Pipeline</NavLink>
        <NavLink to="/deals">Deals</NavLink>
        <NavLink to="/buyers">Buyers</NavLink>
        <NavLink to="/reports">Reports</NavLink>
      </div>
      <div className="nav-user">
        <span>{user?.name} · {user?.role === "OWNER" ? "Owner" : "Associate"}</span>
        <NavLink to="/settings" className="gear-link" title="Settings" aria-label="Settings">⚙</NavLink>
        <button className="small" onClick={() => logout()}>Sign out</button>
      </div>
    </nav>
  );
}

export function App() {
  const { user, loading } = useAuth();

  if (loading) return <Spinner label="Loading Mineral Hub…" />;
  if (!user) return <Login />;

  return (
    <div className="app-shell">
      <TopNav />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/pipeline" element={<Pipeline />} />
        <Route path="/deals" element={<Deals />} />
        <Route path="/deals/:id" element={<DealDetail />} />
        <Route path="/buyers" element={<Buyers />} />
        <Route path="/buyers/:id" element={<BuyerProfile />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
