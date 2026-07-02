import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { Spinner } from "./components/ui";
import { Sidebar } from "./components/Sidebar";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Pipeline } from "./pages/Pipeline";
import { Deals } from "./pages/Deals";
import { DealDetail } from "./pages/DealDetail";
import { Buyers } from "./pages/Buyers";
import { BuyerProfile } from "./pages/BuyerProfile";
import { Suspense, lazy, type ReactNode } from "react";
import { Settings } from "./pages/Settings";
import { Organization } from "./pages/Organization";
// MapLibre is heavy (~300KB gzip); load it only when the Map route is visited.
const MapView = lazy(() => import("./pages/MapView").then((m) => ({ default: m.MapView })));
// recharts (+ jsPDF/html2canvas on Reports) is heavy; load analytics on demand.
const Expenses = lazy(() => import("./pages/Expenses").then((m) => ({ default: m.Expenses })));
const Reports = lazy(() => import("./pages/Reports").then((m) => ({ default: m.Reports })));

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
    <div className="app-shell with-sidebar">
      <Sidebar />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pipeline" element={<Guard perm="viewDeals"><Pipeline /></Guard>} />
          <Route path="/deals" element={<Guard perm="viewDeals"><Deals scope="all" /></Guard>} />
          <Route path="/deals/active" element={<Guard perm="viewDeals"><Deals scope="active" /></Guard>} />
          <Route path="/deals/closed" element={<Guard perm="viewDeals"><Deals scope="closed" /></Guard>} />
          <Route path="/deals/archived" element={<Guard perm="viewDeals"><Deals scope="archived" /></Guard>} />
          <Route path="/deals/:id" element={<Guard perm="viewDeals"><DealDetail /></Guard>} />
          <Route path="/buyers" element={<Guard perm="viewBuyers"><Buyers /></Guard>} />
          <Route path="/buyers/:id" element={<Guard perm="viewBuyers"><BuyerProfile /></Guard>} />
          <Route path="/reports" element={<Guard perm="viewReports"><Suspense fallback={<Spinner label="Loading reports…" />}><Reports /></Suspense></Guard>} />
          <Route path="/expenses" element={<Guard perm="manageExpenses"><Suspense fallback={<Spinner label="Loading expenses…" />}><Expenses /></Suspense></Guard>} />
          <Route path="/map" element={<Guard perm="viewMap"><Suspense fallback={<Spinner label="Loading map…" />}><MapView /></Suspense></Guard>} />
          <Route path="/organization" element={<Organization />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
