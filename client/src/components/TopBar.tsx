import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, LogOut, Settings } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { NotificationsBell } from "./NotificationsBell";
import { ROLE_LABEL } from "../lib/roles";

/** Initials for the avatar chip — first letters of the first two name words. */
const initialsOf = (name: string | undefined): string =>
  (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/**
 * Compact fixed top navigation shown on every signed-in page: notifications
 * and the user menu (avatar + name opens a dropdown holding Log out and, over
 * time, profile/preferences/help). Kept deliberately low so the workspace gets
 * the vertical room.
 */
export function TopBar() {
  const { user, logout } = useAuth();
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

  return (
    <header className="topbar">
      <NotificationsBell collapsed />
      <span className="topbar-div" aria-hidden="true" />
      <div className="topbar-userwrap" ref={wrapRef}>
        <button type="button" className={`topbar-user ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
          <span className="topbar-avatar" aria-hidden="true">{initialsOf(user?.name)}</span>
          <span className="topbar-user-meta">
            <span className="topbar-user-name">{user?.name}</span>
            <span className="topbar-user-role">{user?.orgRole ? ROLE_LABEL[user.orgRole] ?? user.orgRole : ""}</span>
          </span>
          <ChevronDown size={11} className={`topbar-caret ${open ? "up" : ""}`} />
        </button>
        {open && (
          <div className="topbar-menu" role="menu">
            <div className="topbar-menu-id">
              <span className="topbar-avatar" aria-hidden="true">{initialsOf(user?.name)}</span>
              <span className="topbar-user-meta">
                <span className="topbar-user-name">{user?.name}</span>
                <span className="topbar-user-role">{user?.email}</span>
              </span>
            </div>
            <Link to="/settings" role="menuitem" className="topbar-menu-item" onClick={() => setOpen(false)}>
              <Settings size={13} /> Settings
            </Link>
            <div className="topbar-menu-div" aria-hidden="true" />
            <button type="button" role="menuitem" className="topbar-menu-item danger" onClick={() => logout()}>
              <LogOut size={13} /> Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
