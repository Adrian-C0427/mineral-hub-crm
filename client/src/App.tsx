import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { Spinner } from "./components/ui";
import { Sidebar } from "./components/Sidebar";
import { Login } from "./pages/Login";
import { ResetPassword } from "./pages/ResetPassword";
import { OAuthCallback } from "./pages/OAuthCallback";
import { ChangePasswordForm } from "./components/ChangePasswordForm";
import { Dashboard } from "./pages/Dashboard";
import { Pipeline } from "./pages/Pipeline";
import { Deals } from "./pages/Deals";
import { DealDetail } from "./pages/DealDetail";
import { Buyers } from "./pages/Buyers";
import { BuyerProfile } from "./pages/BuyerProfile";
import { Suspense, lazy, type ReactNode } from "react";
import { SettingsGeneral } from "./pages/SettingsGeneral";
import { Organization } from "./pages/Organization";
const Integrations = lazy(() => import("./pages/Integrations").then((m) => ({ default: m.Integrations })));
// MapLibre is heavy (~300KB gzip); load it only when the Map route is visited.
const MapView = lazy(() => import("./pages/MapView").then((m) => ({ default: m.MapView })));
// recharts (+ jsPDF/html2canvas on Reports) is heavy; load analytics on demand.
const Expenses = lazy(() => import("./pages/Expenses").then((m) => ({ default: m.Expenses })));
const Reports = lazy(() => import("./pages/Reports").then((m) => ({ default: m.Reports })));
const Research = lazy(() => import("./pages/Research").then((m) => ({ default: m.Research })));
// Well valuation shares the recharts/jsPDF bundle profile; load on demand too.
const Valuation = lazy(() => import("./pages/Valuation").then((m) => ({ default: m.Valuation })));
// Mineral Assets (portfolio) — the detail view pulls in recharts + MapLibre.
const MineralAssets = lazy(() => import("./pages/MineralAssets").then((m) => ({ default: m.MineralAssets })));
const MineralAssetDetail = lazy(() => import("./pages/MineralAssetDetail").then((m) => ({ default: m.MineralAssetDetail })));
// Buyer Offering Portal — public pages (no auth); pulls in MapLibre lazily.
const PortalMarketplace = lazy(() => import("./pages/portal/PortalMarketplace").then((m) => ({ default: m.PortalMarketplace })));
const PortalOffering = lazy(() => import("./pages/portal/PortalOffering").then((m) => ({ default: m.PortalOffering })));

/** Redirect to Dashboard if the user lacks the required permission. */
function Guard({ perm, children }: { perm: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(perm) ? <>{children}</> : <Navigate to="/" replace />;
}

/** Blocking screen shown when the account is flagged mustChangePassword. */
function ForcePasswordChange() {
  const { user, logout, refresh } = useAuth();
  return (
    <div className="login-wrap">
      <div className="login-card" style={{ width: 420 }}>
        <div className="brand" style={{ fontSize: 22, marginBottom: 4 }}>Mineral Hub<span className="dot">.</span></div>
        <p className="muted" style={{ marginTop: 0 }}>
          Your password was reset by an administrator. Please set a new password to continue.
        </p>
        <ChangePasswordForm compact onChanged={() => refresh()} />
        <p className="muted" style={{ textAlign: "center", marginTop: 14, marginBottom: 0 }}>
          Signed in as {user?.email} · <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>Sign out</a>
        </p>
      </div>
    </div>
  );
}

export function App() {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();

  // Buyer Offering Portal is public: reachable signed-in or out, no CRM chrome.
  if (pathname.startsWith("/portal/") || pathname.startsWith("/offer/")) {
    return (
      <Suspense fallback={<Spinner label="Loading…" />}>
        <Routes>
          <Route path="/portal/:orgSlug" element={<PortalMarketplace />} />
          <Route path="/offer/:slug" element={<PortalOffering />} />
        </Routes>
      </Suspense>
    );
  }

  if (loading) return <Spinner label="Loading Mineral Hub…" />;
  if (!user) {
    // Public routes reachable while signed out (emailed reset link, OAuth return).
    return (
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/auth/callback" element={<OAuthCallback />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  // After an owner-issued reset, the user must set a new password before using the app.
  if (user.mustChangePassword) return <ForcePasswordChange />;

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
          <Route path="/research" element={<Guard perm="viewResearch"><Suspense fallback={<Spinner label="Loading research…" />}><Research /></Suspense></Guard>} />
          <Route path="/valuation" element={<Guard perm="viewResearch"><Suspense fallback={<Spinner label="Loading well analysis…" />}><Valuation /></Suspense></Guard>} />
          <Route path="/assets" element={<Guard perm="viewDeals"><Suspense fallback={<Spinner label="Loading mineral assets…" />}><MineralAssets /></Suspense></Guard>} />
          <Route path="/assets/:id" element={<Guard perm="viewDeals"><Suspense fallback={<Spinner label="Loading asset…" />}><MineralAssetDetail /></Suspense></Guard>} />
          <Route path="/expenses" element={<Guard perm="manageExpenses"><Suspense fallback={<Spinner label="Loading expenses…" />}><Expenses /></Suspense></Guard>} />
          <Route path="/map" element={<Guard perm="viewMap"><Suspense fallback={<Spinner label="Loading map…" />}><MapView /></Suspense></Guard>} />
          <Route path="/organization" element={<Organization />} />
          <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
          <Route path="/settings/general" element={<SettingsGeneral />} />
          <Route path="/settings/integrations" element={<Guard perm="manageApiIntegrations"><Suspense fallback={<Spinner label="Loading integrations…" />}><Integrations /></Suspense></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
