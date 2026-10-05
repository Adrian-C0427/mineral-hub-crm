import { useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronRight, ChevronDown, X } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { loadBranding } from "../lib/branding";
import { layoutRect } from "../lib/viewport";
import { ThemedLogo } from "./ThemedLogo";
import { revealActiveStripItems, setMobileNavOpen, useHasTabBar, useIsPhone, useMobileNavOpen } from "../lib/mobile";
import { MobileTabBar } from "./MobileTabBar";

interface NavItem {
  label: string;
  icon: React.ElementType<{ size?: number | string }>;
  to?: string;
  end?: boolean;
  perm?: string;
  /** One-line purpose, shown as a hover tooltip — several pages look like
   *  "analytics", so each spells out which question it answers. */
  desc?: string;
  children?: NavItem[];
  /** Path prefix that keeps this entry highlighted beyond its exact target
   *  (e.g. Deals lands on /deals/active but stays lit for all /deals/*). */
  match?: string;
}

/** Line icon from a single SVG path (the redesign's navigation icon set). */
const pathIcon = (d: string) => function NavIcon({ size = 17 }: { size?: number | string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
};
const BUYERS_PATH = "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M21 20c0-2.6-1.6-4.9-4-5.7";

// Config-driven so new modules are added here without touching layout code.
// Groups render with a small label; a group whose items are all hidden by
// permissions disappears with them.
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: "", items: [
    { label: "Dashboard", icon: pathIcon("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"), to: "/", end: true, desc: "Today's acquisition snapshot — active deals, profit, follow-ups" },
    // Single entry landing on ACTIVE deals (the working set); All/Closed/
    // Archived remain reachable via the tabs on the Deals pages themselves.
    { label: "Deals", icon: pathIcon("M4 8h16v11H4zM9 8V5h6v3M4 13h16"), to: "/deals/active", match: "/deals", perm: "viewDeals", desc: "Acquisition opportunities you're working" },
    { label: "Pipeline", icon: pathIcon("M5 4v16M12 4v11M19 4v6"), to: "/pipeline", perm: "viewDeals", desc: "Drag deals through the acquisition stages" },
    { label: "Mineral Assets", icon: pathIcon("M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"), to: "/assets", perm: "viewDeals", desc: "Your owned mineral & royalty portfolio" },
  ] },
  { label: "Relationships", items: [
    { label: "Buyers", icon: pathIcon(BUYERS_PATH), to: "/buyers", perm: "viewBuyers", desc: "Buyer list, buy boxes, and relationships" },
    // Acquisitions module — sourcing side of the CRM.
    { label: "Contacts", icon: pathIcon("M5 4h13a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5zM9 4v16M13 10h3M13 14h3"), to: "/contacts", perm: "viewContacts", desc: "Acquisitions — sellers, prospects, and inbound leads" },
    // Buyer Portal is operational-only (the offerings marketplace); its
    // configuration lives under Settings → Buyer Portal.
    { label: "Buyer Portal", icon: pathIcon("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"), to: "/portal-admin", perm: "publishOfferings", desc: "Your public offering marketplace" },
  ] },
  { label: "Analysis", items: [
    { label: "Map", icon: pathIcon("M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"), to: "/map", perm: "viewMap", desc: "Wells, abstracts, and deals on the Texas map" },
    { label: "Research", icon: pathIcon("M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4"), to: "/research", perm: "viewResearch", desc: "Market intelligence — county transactions, permits, operators" },
    { label: "Well Analysis", icon: pathIcon("M12 3L7 21M12 3l5 18M8.6 15h6.8M10.2 9h3.6M5 21h14"), to: "/valuation", perm: "viewWellAnalysis", desc: "Value specific wells — decline curves, forecasts, offer prices" },
    { label: "Reports", icon: pathIcon("M4 20h16M7 16v-5M12 16V6M17 16v-8"), to: "/reports", perm: "viewReports", desc: "Your business performance — closed deals, profit, win rate" },
  ] },
  { label: "Finance", items: [
    { label: "Expenses", icon: pathIcon("M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3"), to: "/expenses", perm: "manageExpenses", desc: "Company spend and reimbursements" },
  ] },
];
// Pinned to the bottom of the sidebar. General/Organization/Portal/
// Integrations are sections inside the Settings pages.
const SETTINGS_ITEM: NavItem = { label: "Settings", icon: pathIcon("M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4"), to: "/settings", match: "/settings", desc: "Account, organization, portal, and integrations" };

export function Sidebar() {
  const { user, can } = useAuth();
  // Last-known org branding, read once per mount (see lib/branding).
  const cachedBranding = useMemo(() => loadBranding(), []);
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      if (window.matchMedia("(max-width: 760px)").matches) return true; // small screens start as the icon rail
      return localStorage.getItem("mh_sidebar_collapsed") === "1";
    } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem("mh_sidebar_collapsed", n ? "1" : "0"); } catch { /* ignore */ } return n; });

  // Auto-collapse to the icon rail whenever the viewport shrinks below tablet
  // width (rotation, window resize). Expanding manually stays possible — this
  // only fires on the wide→narrow transition, it never fights the user.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setCollapsed(true); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const allowed = (item: NavItem): boolean => !item.perm || can(item.perm);

  // Phones: the navigation is an off-canvas drawer (full labels) opened from
  // the tab bar's Menu (upright) or the top bar's menu button (landscape), so
  // the page gets the whole screen width. It closes on navigation, backdrop
  // tap, Escape, or Menu again. Desktop is unaffected.
  const phone = useIsPhone();
  const tabBar = useHasTabBar();
  const drawerOpen = useMobileNavOpen();
  useEffect(() => { setMobileNavOpen(false); return revealActiveStripItems(); }, [location.pathname, location.search]);
  useEffect(() => { if (!phone) setMobileNavOpen(false); }, [phone]);
  useEffect(() => {
    if (!phone || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNavOpen(false); };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("mobile-nav-open");
    return () => { document.removeEventListener("keydown", onKey); document.body.classList.remove("mobile-nav-open"); };
  }, [phone, drawerOpen]);
  const railCollapsed = phone ? false : collapsed;

  // Publish the sidebar's live width so dialogs (portaled to <body>) center in
  // the content area beside it — expanded, collapsed, or mid-transition. On
  // phones the sidebar is an off-canvas drawer and takes no width.
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    const el = asideRef.current;
    const publish = () => root.style.setProperty("--app-sidebar-w", phone || !el ? "0px" : `${Math.round(layoutRect(el).width)}px`);
    publish();
    const ro = el && !phone && typeof ResizeObserver !== "undefined" ? new ResizeObserver(publish) : null;
    if (ro && el) ro.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty("--app-sidebar-w"); };
  }, [phone]);

  return (
    <>
    {phone && drawerOpen && <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />}
    {phone && tabBar && <MobileTabBar />}
    <aside ref={asideRef} className={`sidebar ${railCollapsed ? "collapsed" : ""} ${phone ? `mobile-drawer ${drawerOpen ? "open" : ""}` : ""}`}
      aria-label="Main navigation" aria-hidden={phone && !drawerOpen ? true : undefined}>
      {/* Collapse control: a tiny chevron riding the panel's edge — half in,
          half out — so the brand row belongs entirely to the logo. */}
      {!phone && (
        <button className="sidebar-edge-toggle" onClick={toggleCollapsed} title={collapsed ? "Expand navigation" : "Collapse navigation"} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!collapsed}>
          <ChevronRight size={13} strokeWidth={2.5} className={collapsed ? "" : "flipped"} />
        </button>
      )}
      {phone && (
        <button type="button" className="mobile-nav-close icon-btn" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation">
          <X size={18} />
        </button>
      )}
      <div className="sidebar-brand">
        {(() => {
          // While /auth/me is still in flight (fresh page load, slow or
          // briefly-failing API) render the last-known branding from the local
          // cache so the logo is present from the first paint — it never
          // "pops in" late or drops to the text fallback mid-session.
          const org = user ? user.organization : cachedBranding;
          // Each variant falls back to the other, so an org that uploaded only
          // ONE logo still shows it in BOTH sidebar states (previously an org
          // with just a compact mark rendered an empty brand row when expanded).
          const full = org?.fullLogo ?? org?.compactLogo ?? null;
          const compact = org?.compactLogo ?? org?.fullLogo ?? null;
          if (!full && !compact) return <span className="brand">{railCollapsed ? "MH" : <>Mineral Hub<span className="dot">.</span></>}</span>;
          // BOTH variants stay mounted at all times; collapse only toggles CSS
          // visibility. Nothing remounts, reloads, or reprocesses on expand/
          // collapse, navigation, or theme change — the logo is a persistent
          // element, never recreated (the recurring "logo disappears" bug).
          return (
            <>
              {full && <ThemedLogo variant="dark" className="sidebar-logo logo-full" src={full} alt={org?.name ?? "Company logo"} />}
              {compact && <ThemedLogo variant="dark" className="sidebar-logo compact logo-compact" src={compact} alt={org?.name ?? "Company logo"} />}
            </>
          );
        })()}
      </div>

      <nav className="sidebar-nav">
        {NAV_GROUPS.map((g) => {
          const items = g.items.filter(allowed);
          if (items.length === 0) return null;
          return (
            <div className="sidebar-section" key={g.label || "main"}>
              {g.label && !railCollapsed && <div className="sidebar-section-label">{g.label}</div>}
              {items.map((item) => (
                <SidebarItem key={item.label} item={item} collapsed={railCollapsed} allowed={allowed} pathname={location.pathname} />
              ))}
            </div>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <SidebarItem item={SETTINGS_ITEM} collapsed={railCollapsed} allowed={allowed} pathname={location.pathname} />
      </div>

      {/* Notifications, user identity, and Sign out live in the fixed top
          navigation bar (TopBar) — the sidebar is pure navigation. */}
    </aside>
    </>
  );
}

function SidebarItem({ item, collapsed, allowed, pathname }: { item: NavItem; collapsed: boolean; allowed: (i: NavItem) => boolean; pathname: string }) {
  const Icon = item.icon;
  const children = item.children?.filter(allowed) ?? [];
  const hasChildren = children.length > 0;
  // Auto-expand the section that contains the current route.
  const within = children.some((c) => pathname.startsWith(c.to!.split("?")[0]));
  const [open, setOpen] = useState(within);
  useEffect(() => { if (within) setOpen(true); }, [within]);

  // Collapsed flyout: positioned with fixed coords measured from the group, so
  // it escapes the nav's overflow:auto clipping (the bug that made collapsed
  // submenus unreachable). Opens on hover or click; closes on leave / outside
  // click / Escape / navigation.
  const groupRef = useRef<HTMLDivElement>(null);
  const [flyout, setFlyout] = useState<{ top: number; left: number } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const openFlyout = () => {
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    const r = groupRef.current ? layoutRect(groupRef.current) : null; // zoom-aware
    if (r) setFlyout({ top: r.top, left: r.right + 6 });
  };
  const scheduleClose = () => { closeTimer.current = window.setTimeout(() => setFlyout(null), 140); };
  useEffect(() => {
    if (!flyout) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFlyout(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [flyout]);

  if (!hasChildren) {
    return (
      <NavLink to={item.to!} end={item.end} className={({ isActive }) => `sidebar-link ${isActive || (item.match && pathname.startsWith(item.match)) ? "active" : ""}`} title={collapsed ? item.label : item.desc}>
        <span className="sidebar-icon"><Icon size={17} /></span>
        {!collapsed && <span className="sidebar-label">{item.label}</span>}
      </NavLink>
    );
  }

  if (collapsed) {
    return (
      <div className={`sidebar-group ${within ? "within" : ""}`} ref={groupRef}
        onMouseEnter={openFlyout} onMouseLeave={scheduleClose}>
        <button type="button" className={`sidebar-link group-head ${within ? "active" : ""}`} title={item.label}
          onClick={() => (flyout ? setFlyout(null) : openFlyout())}>
          <span className="sidebar-icon"><Icon size={17} /></span>
        </button>
        {/* Rendered into <body> so no ancestor stacking context (transforms on
            the app shell, a MapLibre canvas, sticky headers, etc.) can ever
            paint over the open navigation flyout. */}
        {flyout && createPortal(
          <div className="sidebar-flyout" style={{ top: flyout.top, left: flyout.left }}
            onMouseEnter={openFlyout} onMouseLeave={scheduleClose}>
            <div className="flyout-head">{item.label}</div>
            {children.map((c) => (
              <NavLink key={c.label} to={c.to!} onClick={() => setFlyout(null)}
                className={({ isActive }) => `sidebar-sublink ${isActive ? "active" : ""}`}>
                {c.label}
              </NavLink>
            ))}
          </div>,
          document.body,
        )}
      </div>
    );
  }

  return (
    <div className={`sidebar-group ${within ? "within" : ""}`}>
      <div className="sidebar-link group-head" onClick={() => setOpen((o) => !o)} title={item.desc}>

        <span className="sidebar-icon"><Icon size={17} /></span>
        <span className="sidebar-label">{item.label}</span><span className="group-caret">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      </div>
      <div className="sidebar-sub" style={!open ? { display: "none" } : undefined}>
        {children.map((c) => (
          <NavLink key={c.label} to={c.to!} className={({ isActive }) => `sidebar-sublink ${isActive ? "active" : ""}`}>
            {c.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
