import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { setMobileNavOpen, useMobileNavOpen } from "../lib/mobile";

interface Tab {
  label: string;
  to: string;
  icon: string;
  perm?: string;
  /** Lit when the current path matches (detail pages light their list's tab). */
  isActive: (pathname: string) => boolean;
}

// Same destinations, permissions, and active matching as the sidebar entries.
const TABS: Tab[] = [
  { label: "Home", to: "/", icon: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z", isActive: (p) => p === "/" },
  { label: "Deals", to: "/deals/active", icon: "M4 8h16v11H4zM9 8V5h6v3M4 13h16", perm: "viewDeals", isActive: (p) => p.startsWith("/deals") },
  { label: "Pipeline", to: "/pipeline", icon: "M5 4v16M12 4v11M19 4v6", perm: "viewDeals", isActive: (p) => p.startsWith("/pipeline") },
  { label: "Buyers", to: "/buyers", icon: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M21 20c0-2.6-1.6-4.9-4-5.7", perm: "viewBuyers", isActive: (p) => p.startsWith("/buyers") },
];

const TabIcon = ({ d }: { d: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/**
 * Upright phones: the bottom tab bar (Home · Deals · Pipeline · Buyers · Menu).
 * Menu toggles the navigation drawer, which holds every other section. Rendered
 * into <body> so no ancestor can clip it; `body.has-tabbar` switches on the
 * `--tabbar-h` clearance that keeps page content, toasts, and the drawer clear
 * of it (styles/mobile-shell.css).
 */
export function MobileTabBar() {
  const { can } = useAuth();
  const { pathname } = useLocation();
  const drawerOpen = useMobileNavOpen();

  useLayoutEffect(() => {
    document.body.classList.add("has-tabbar");
    return () => document.body.classList.remove("has-tabbar");
  }, []);

  const tabs = TABS.filter((t) => !t.perm || can(t.perm));

  return createPortal(
    <nav className="mobile-tabbar" aria-label="Primary">
      {tabs.map((t) => {
        const active = t.isActive(pathname);
        return (
          // Tapping the current tab while the drawer is open has no route
          // change to close it, so close it here as well.
          <Link key={t.to} to={t.to} className={`mobile-tab ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}
            onClick={() => setMobileNavOpen(false)}>
            <TabIcon d={t.icon} />
            <span>{t.label}</span>
          </Link>
        );
      })}
      <button type="button" className={`mobile-tab ${drawerOpen ? "active" : ""}`} onClick={() => setMobileNavOpen(!drawerOpen)}
        aria-expanded={drawerOpen} aria-haspopup="dialog">
        <TabIcon d="M4 7h16M4 12h16M4 17h16" />
        <span>Menu</span>
      </button>
    </nav>,
    document.body,
  );
}
