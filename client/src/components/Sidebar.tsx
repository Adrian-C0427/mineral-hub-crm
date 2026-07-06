import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard, Briefcase, Workflow, Users, Map as MapIcon, BarChart3, Telescope, TrendingDown,
  Layers, Receipt, Store, Settings as SettingsIcon, ChevronRight, ChevronDown, LogOut,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";

interface NavItem {
  label: string;
  icon: LucideIcon;
  to?: string;
  end?: boolean;
  perm?: string;
  /** One-line purpose, shown as a hover tooltip — several pages look like
   *  "analytics", so each spells out which question it answers. */
  desc?: string;
  children?: NavItem[];
}

// Config-driven so new modules are added here without touching layout code.
const NAV: NavItem[] = [
  { label: "Dashboard", icon: LayoutDashboard, to: "/", end: true, desc: "Today's acquisition snapshot — active deals, profit, follow-ups" },
  {
    label: "Deals", icon: Briefcase, perm: "viewDeals", desc: "Acquisition opportunities you're working",
    children: [
      { label: "Active Deals", icon: Briefcase, to: "/deals/active" },
      { label: "Closed Deals", icon: Briefcase, to: "/deals/closed" },
      { label: "Archived Deals", icon: Briefcase, to: "/deals/archived" },
    ],
  },
  { label: "Mineral Assets", icon: Layers, to: "/assets", perm: "viewDeals", desc: "Your owned mineral & royalty portfolio" },
  { label: "Pipeline", icon: Workflow, to: "/pipeline", perm: "viewDeals", desc: "Drag deals through the acquisition stages" },
  { label: "Buyers", icon: Users, to: "/buyers", perm: "viewBuyers", desc: "Buyer list, buy boxes, and relationships" },
  { label: "Map", icon: MapIcon, to: "/map", perm: "viewMap", desc: "Wells, abstracts, and deals on the Texas map" },
  { label: "Research", icon: Telescope, to: "/research", perm: "viewResearch", desc: "Market intelligence — county transactions, permits, operators" },
  { label: "Well Analysis", icon: TrendingDown, to: "/valuation", perm: "viewWellAnalysis", desc: "Value specific wells — decline curves, forecasts, offer prices" },
  { label: "Reports", icon: BarChart3, to: "/reports", perm: "viewReports", desc: "Your business performance — closed deals, profit, win rate" },
  { label: "Expenses", icon: Receipt, to: "/expenses", perm: "manageExpenses", desc: "Company spend and reimbursements" },
  // Buyer Portal is operational-only (the offerings marketplace); its
  // configuration lives under Settings → Buyer Portal, so viewing settings
  // never lights up this item.
  { label: "Buyer Portal", icon: Store, to: "/portal-admin", perm: "publishOfferings", desc: "Your public offering marketplace" },
  {
    label: "Settings", icon: SettingsIcon,
    children: [
      { label: "General", icon: SettingsIcon, to: "/settings/general" },
      // Organization now lives under Settings (company, members, roles, owner).
      { label: "Organization", icon: SettingsIcon, to: "/settings/organization", perm: "orgSection" },
      { label: "Buyer Portal", icon: Store, to: "/settings/portal", perm: "managePortal" },
      { label: "Integrations", icon: SettingsIcon, to: "/settings/integrations", perm: "manageApiIntegrations" },
    ],
  },
];

const ROLE_LABEL: Record<string, string> = { OWNER: "Owner", ADMIN: "Administrator", MANAGER: "Manager", MEMBER: "Standard User", VIEWER: "Read-Only Viewer" };

export function Sidebar() {
  const { user, logout, can } = useAuth();
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

  // "orgSection" is a virtual permission: visible to anyone who can manage
  // members or the org's settings (Roles & Permissions is owner-only within).
  const allowed = (item: NavItem): boolean => {
    if (item.perm === "orgSection") return can("manageMembers") || can("manageOrgSettings");
    return !item.perm || can(item.perm);
  };

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-brand">
        {(() => {
          const org = user?.organization;
          const logo = collapsed ? org?.compactLogo : org?.fullLogo;
          if (logo) return <img className={`sidebar-logo ${collapsed ? "compact" : ""}`} src={logo} alt={org?.name ?? "Company logo"} />;
          return <span className="brand">{collapsed ? "MH" : <>Mineral Hub<span className="dot">.</span></>}</span>;
        })()}
        <button className="icon-btn sidebar-toggle" onClick={toggleCollapsed} title={collapsed ? "Expand" : "Collapse"} aria-label="Toggle sidebar">
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} style={{ transform: "rotate(90deg)" }} />}
        </button>
      </div>

      <nav className="sidebar-nav">
        {NAV.filter(allowed).map((item) => (
          <SidebarItem key={item.label} item={item} collapsed={collapsed} allowed={allowed} pathname={location.pathname} />
        ))}
      </nav>

      <div className="sidebar-footer">
        {!collapsed && <div className="sidebar-user">{user?.name}<br /><span className="muted">{user?.orgRole ? ROLE_LABEL[user.orgRole] ?? user.orgRole : ""}</span></div>}
        <button className="small" onClick={() => logout()} title="Sign out">{collapsed ? <LogOut size={16} /> : "Sign out"}</button>
      </div>
    </aside>
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
    const r = groupRef.current?.getBoundingClientRect();
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
      <NavLink to={item.to!} end={item.end} className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`} title={collapsed ? item.label : item.desc}>
        <span className="sidebar-icon"><Icon size={18} /></span>
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
          <span className="sidebar-icon"><Icon size={18} /></span>
        </button>
        {flyout && (
          <div className="sidebar-flyout" style={{ top: flyout.top, left: flyout.left }}
            onMouseEnter={openFlyout} onMouseLeave={scheduleClose}>
            <div className="flyout-head">{item.label}</div>
            {children.map((c) => (
              <NavLink key={c.label} to={c.to!} onClick={() => setFlyout(null)}
                className={({ isActive }) => `sidebar-sublink ${isActive ? "active" : ""}`}>
                {c.label}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`sidebar-group ${within ? "within" : ""}`}>
      <div className="sidebar-link group-head" onClick={() => setOpen((o) => !o)} title={item.desc}>

        <span className="sidebar-icon"><Icon size={18} /></span>
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
