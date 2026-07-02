import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard, Briefcase, Workflow, Users, Map as MapIcon, BarChart3,
  Receipt, Building2, Settings as SettingsIcon, ChevronRight, ChevronDown, LogOut,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";

interface NavItem {
  label: string;
  icon: LucideIcon;
  to?: string;
  end?: boolean;
  perm?: string;
  children?: NavItem[];
}

// Config-driven so new modules are added here without touching layout code.
const NAV: NavItem[] = [
  { label: "Dashboard", icon: LayoutDashboard, to: "/", end: true },
  {
    label: "Deals", icon: Briefcase, perm: "viewDeals",
    children: [
      { label: "Active Deals", icon: Briefcase, to: "/deals/active" },
      { label: "Closed Deals", icon: Briefcase, to: "/deals/closed" },
      { label: "Archived Deals", icon: Briefcase, to: "/deals/archived" },
    ],
  },
  { label: "Pipeline", icon: Workflow, to: "/pipeline", perm: "viewDeals" },
  { label: "Buyers", icon: Users, to: "/buyers", perm: "viewBuyers" },
  { label: "Map", icon: MapIcon, to: "/map", perm: "viewMap" },
  { label: "Reports", icon: BarChart3, to: "/reports", perm: "viewReports" },
  { label: "Expenses", icon: Receipt, to: "/expenses", perm: "manageExpenses" },
  { label: "Organization", icon: Building2, to: "/organization", perm: "orgSection" },
  { label: "Settings", icon: SettingsIcon, to: "/settings" },
];

const ROLE_LABEL: Record<string, string> = { OWNER: "Owner", ADMIN: "Administrator", MANAGER: "Manager", MEMBER: "Standard User", VIEWER: "Read-Only Viewer" };

export function Sidebar() {
  const { user, logout, can } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("mh_sidebar_collapsed") === "1"; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem("mh_sidebar_collapsed", n ? "1" : "0"); } catch { /* ignore */ } return n; });

  // "orgSection" is a virtual permission: visible if the user can manage members OR roles.
  const allowed = (item: NavItem): boolean => {
    if (item.perm === "orgSection") return can("manageMembers") || can("manageRoles");
    return !item.perm || can(item.perm);
  };

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-brand">
        <span className="brand">{collapsed ? "MH" : <>Mineral Hub<span className="dot">.</span></>}</span>
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

  if (!hasChildren) {
    return (
      <NavLink to={item.to!} end={item.end} className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`} title={collapsed ? item.label : undefined}>
        <span className="sidebar-icon"><Icon size={18} /></span>
        {!collapsed && <span className="sidebar-label">{item.label}</span>}
      </NavLink>
    );
  }

  return (
    <div className={`sidebar-group ${within ? "within" : ""}`}>
      <div className="sidebar-link group-head" onClick={() => setOpen((o) => !o)} title={collapsed ? item.label : undefined}>
        <span className="sidebar-icon"><Icon size={18} /></span>
        {!collapsed && <><span className="sidebar-label">{item.label}</span><span className="group-caret">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span></>}
      </div>
      {/* Expanded: inline sub (shown when open). Collapsed: hover flyout (CSS). */}
      <div className={`sidebar-sub ${collapsed ? "flyout" : ""}`} style={!collapsed && !open ? { display: "none" } : undefined}>
        {collapsed && <div className="flyout-head">{item.label}</div>}
        {children.map((c) => (
          <NavLink key={c.label} to={c.to!} className={({ isActive }) => `sidebar-sublink ${isActive ? "active" : ""}`}>
            {c.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
