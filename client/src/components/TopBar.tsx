import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Menu } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme";
import { userAvatarColor } from "../lib/avatarColor";
import { NotificationsBell } from "./NotificationsBell";
import { ROLE_LABEL } from "../lib/roles";
import { setMobileNavOpen, useHasTabBar, useIsPhone } from "../lib/mobile";

/** Initials for the avatar chip — first letters of the first two name words. */
const initialsOf = (name: string | undefined): string =>
  (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

const MenuIcon = ({ d }: { d: string }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const THEME_LABEL: Record<string, string> = { light: "Light", dark: "Dark", dim: "Dim", slate: "Slate", dusk: "Dusk", neutral: "Neutral" };

/**
 * Top navigation shown on every signed-in page: notifications and the account
 * menu (avatar + name opens a dropdown with shortcuts into Settings and Log out).
 */
export function TopBar() {
  const { user, logout, can } = useAuth();
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the user menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Phones: the sidebar is a drawer. Upright phones open it from the tab bar's
  // Menu; landscape phones (no tab bar) open it from the menu button here.
  const phone = useIsPhone();
  const tabBar = useHasTabBar();
  const role = user?.orgRole ? ROLE_LABEL[user.orgRole] ?? user.orgRole : "";
  const close = () => setOpen(false);

  return (
    <header className="topbar">
      {phone && !tabBar && (
        <button type="button" className="topbar-nav-btn icon-btn" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
          <Menu size={20} />
        </button>
      )}
      <NotificationsBell />
      <span className="topbar-div" aria-hidden="true" />
      <div className="topbar-userwrap" ref={wrapRef}>
        <button type="button" className={`topbar-user ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
          <span className="topbar-avatar" aria-hidden="true" style={{ background: userAvatarColor(user) }}>{initialsOf(user?.name)}</span>
          <span className="topbar-user-meta">
            <span className="topbar-user-name">{user?.name}</span>
            <span className="topbar-user-role">{role}</span>
          </span>
          <svg className={`topbar-caret ${open ? "up" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        {open && (
          <div className="topbar-menu" role="menu">
            <div className="topbar-menu-id">
              <span className="topbar-avatar lg" aria-hidden="true" style={{ background: userAvatarColor(user) }}>{initialsOf(user?.name)}</span>
              <span className="topbar-menu-who">
                <span className="topbar-menu-name">{user?.name}</span>
                <span className="topbar-menu-email">{user?.email}</span>
              </span>
            </div>
            {(user?.organization?.name || role) && (
              <div className="topbar-menu-org">
                <span>{user?.organization?.name}</span>
                {role && <span className="topbar-role-pill">{role}</span>}
              </div>
            )}
            <div className="topbar-menu-group">
              <Link to="/settings/general" role="menuitem" className="topbar-menu-item" onClick={close}>
                <MenuIcon d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-7 8-7s8 3 8 7" /><span>Profile &amp; security</span>
              </Link>
              <Link to="/settings/general" role="menuitem" className="topbar-menu-item" onClick={close}>
                <MenuIcon d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0" /><span>Notifications</span>
              </Link>
              <Link to="/settings/general" role="menuitem" className="topbar-menu-item" onClick={close}>
                <MenuIcon d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z" /><span>Appearance</span><em>{THEME_LABEL[theme] ?? ""}</em>
              </Link>
            </div>
            <div className="topbar-menu-group">
              <Link to="/settings/organization" role="menuitem" className="topbar-menu-item" onClick={close}>
                <MenuIcon d="M4 21V7l8-4 8 4v14M9 21v-6h6v6" /><span>Organization</span>
              </Link>
              <Link to="/settings/organization" role="menuitem" className="topbar-menu-item" onClick={close}>
                <MenuIcon d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M21 20c0-2.6-1.6-4.9-4-5.7" /><span>Team members</span>
              </Link>
              {can("manageApiIntegrations") && (
                <Link to="/settings/integrations" role="menuitem" className="topbar-menu-item" onClick={close}>
                  <MenuIcon d="M9 7V3M15 7V3M6 7h12v4a6 6 0 0 1-12 0zM12 17v4" /><span>Integrations</span>
                </Link>
              )}
            </div>
            <div className="topbar-menu-group last">
              <button type="button" role="menuitem" className="topbar-menu-item danger" onClick={() => logout()}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" /></svg><span>Log out</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
