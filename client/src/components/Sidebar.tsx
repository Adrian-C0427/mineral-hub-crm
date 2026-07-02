import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

interface NavItem {
  label: string;
  icon: string;
  to?: string;
  end?: boolean;
  perm?: string;
  children?: NavItem[];
}

// Config-driven so new modules are added here without touching layout code.
const NAV: NavItem[] = [
  { label: "Dashboard", icon: "🏠", to: "/", end: true },
  {
    label: "Deals", icon: "📁", to: "/deals", perm: "viewDeals",
    children: [
      { label: "Pipeline", icon: "•", to: "/pipeline" },
      { label: "Active Deals", icon: "•", to: "/deals/active" },
      { label: "Closed Deals", icon: "•", to: "/deals/closed" },
      { label: "Archived Deals", icon: "•", to: "/deals/archived" },
    ],
  },
  { label: "Buyers", icon: "🤝", to: "/buyers", perm: "viewBuyers" },
  { label: "Map", icon: "🗺️", to: "/map", perm: "viewMap" },
  { label: "Reports", icon: "📊", to: "/reports", perm: "viewReports" },
  { label: "Expenses", icon: "💳", to: "/expenses", perm: "manageExpenses" },
  {
    label: "Organization", icon: "🏢", to: "/organization", perm: "orgSection",
    children: [
      { label: "Team Members", icon: "•", to: "/organization?tab=users", perm: "manageMembers" },
      { label: "Roles & Permissions", icon: "•", to: "/organization?tab=roles", perm: "manageRoles" },
    ],
  },
  { label: "Settings", icon: "⚙️", to: "/settings" },
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
          {collapsed ? "»" : "«"}
        </button>
      </div>

      <nav className="sidebar-nav">
        {NAV.filter(allowed).map((item) => (
          <SidebarItem key={item.label} item={item} collapsed={collapsed} allowed={allowed} pathname={location.pathname} search={location.search} />
        ))}
      </nav>

      <div className="sidebar-footer">
        {!collapsed && <div className="sidebar-user">{user?.name}<br /><span className="muted">{user?.orgRole ? ROLE_LABEL[user.orgRole] ?? user.orgRole : ""}</span></div>}
        <button className="small" onClick={() => logout()}>{collapsed ? "⎋" : "Sign out"}</button>
      </div>
    </aside>
  );
}

function SidebarItem({ item, collapsed, allowed, pathname, search }: { item: NavItem; collapsed: boolean; allowed: (i: NavItem) => boolean; pathname: string; search: string }) {
  const children = item.children?.filter(allowed) ?? [];
  const hasChildren = children.length > 0;
  // A section is "within" the current route when the path matches the parent
  // base or any child base (so e.g. /pipeline expands the Deals group).
  const base = item.to?.split("?")[0] ?? "";
  const within =
    (base !== "/" && pathname.startsWith(base)) ||
    children.some((c) => pathname.startsWith(c.to!.split("?")[0]));
  const [open, setOpen] = useState(within);
  useEffect(() => { if (within) setOpen(true); }, [within]);

  if (!hasChildren) {
    return (
      <NavLink to={item.to!} end={item.end} className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`} title={collapsed ? item.label : undefined}>
        <span className="sidebar-icon">{item.icon}</span>
        {!collapsed && <span className="sidebar-label">{item.label}</span>}
      </NavLink>
    );
  }

  return (
    <div className={`sidebar-group ${within ? "within" : ""}`}>
      <div className="sidebar-link group-head" onClick={() => setOpen((o) => !o)} title={collapsed ? item.label : undefined}>
        <span className="sidebar-icon">{item.icon}</span>
        {!collapsed && <><span className="sidebar-label">{item.label}</span><span className="group-caret">{open ? "▾" : "▸"}</span></>}
      </div>
      {!collapsed && open && (
        <div className="sidebar-sub">
          {children.map((c) => {
            const cBase = c.to!.split("?")[0];
            const cActive = pathname.startsWith(cBase) && (c.to!.includes("?") ? search.includes(c.to!.split("?")[1]) : true);
            return (
              <NavLink key={c.label} to={c.to!} className={`sidebar-sublink ${cActive ? "active" : ""}`}>
                {c.label}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}
