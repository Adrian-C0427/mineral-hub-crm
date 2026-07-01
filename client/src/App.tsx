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
import { Suspense, lazy, type ReactNode } from "react";
import { Settings } from "./pages/Settings";
// MapLibre is heavy (~300KB gzip); load it only when the Map route is visited.
const MapView = lazy(() => import("./pages/MapView").then((m) => ({ default: m.MapView })));
// recharts (+ jsPDF/html2canvas on Reports) is heavy; load analytics on demand.
const Expenses = lazy(() => import("./pages/Expenses").then((m) => ({ default: m.Expenses })));
const Reports = lazy(() => import("./pages/Reports").then((m) => ({ default: m.Reports })));

const ROLE_LABEL: Record<string, string> = { OWNER: "Owner", ADMIN: "Administrator", MANAGER: "Manager", MEMBER: "Standard User", VIEWER: "Read-Only Viewer" };

function TopNav() {
  const { user, logout, can } = useAuth();
  return (
    <nav className="topnav">
      <span className="brand">
        Mineral Hub<span className="dot">.</span>
      </span>
      <div className="nav-links">
        <NavLink to="/" end>Dashboard</NavLink>
        {can("viewDeals") && <NavLink to="/pipeline">Pipeline</NavLink>}
        {can("viewDeals") && <NavLink to="/deals">Deals</NavLink>}
        {can("viewBuyers") && <NavLink to="/buyers">Buyers</NavLink>}
        {can("viewReports") && <NavLink to="/reports">Reports</NavLink>}
        {can("manageExpenses") && <NavLink to="/expenses">Expenses</NavLink>}
        {can("viewMap") && <NavLink to="/map">Map</NavLink>}
      </div>
      <div className="nav-user">
        <span>{user?.name}{user?.orgRole ? ` · ${ROLE_LABEL[user.orgRole] ?? user.orgRole}` : ""}</span>
        <NavLink to="/settings" className="gear-link" title="Settings" aria-label="Settings">⚙</NavLink>
        <button className="small" onClick={() => logout()}>Sign out</button>
      </div>
    </nav>
  );
}

/** Redirect to Dashboard if the user lacks the required permission. */
function Guard({ perm, children }: { perm: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(perm) ? <>{children}</> : <Navigate to="/" replace />;
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
        <Route path="/pipeline" element={<Guard perm="viewDeals"><Pipeline /></Guard>} />
        <Route path="/deals" element={<Guard perm="viewDeals"><Deals /></Guard>} />
        <Route path="/deals/:id" element={<Guard perm="viewDeals"><DealDetail /></Guard>} />
        <Route path="/buyers" element={<Guard perm="viewBuyers"><Buyers /></Guard>} />
        <Route path="/buyers/:id" element={<Guard perm="viewBuyers"><BuyerProfile /></Guard>} />
        <Route path="/reports" element={<Guard perm="viewReports"><Suspense fallback={<Spinner label="Loading reports…" />}><Reports /></Suspense></Guard>} />
        <Route path="/expenses" element={<Guard perm="manageExpenses"><Suspense fallback={<Spinner label="Loading expenses…" />}><Expenses /></Suspense></Guard>} />
        <Route path="/map" element={<Guard perm="viewMap"><Suspense fallback={<Spinner label="Loading map…" />}><MapView /></Suspense></Guard>} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
