import { LogOut } from "lucide-react";
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
 * Fixed top navigation bar shown on every signed-in page: notifications,
 * the signed-in user (avatar + name + role), and Log out. These moved here
 * from the sidebar footer so the sidebar is pure navigation.
 */
export function TopBar() {
  const { user, logout } = useAuth();
  return (
    <header className="topbar">
      <NotificationsBell collapsed />
      <span className="topbar-div" aria-hidden="true" />
      <span className="topbar-user">
        <span className="topbar-avatar" aria-hidden="true">{initialsOf(user?.name)}</span>
        <span className="topbar-user-meta">
          <span className="topbar-user-name">{user?.name}</span>
          <span className="topbar-user-role">{user?.orgRole ? ROLE_LABEL[user.orgRole] ?? user.orgRole : ""}</span>
        </span>
      </span>
      <button type="button" className="topbar-logout" onClick={() => logout()} title="Sign out">
        <LogOut size={13} />
        Log out
      </button>
    </header>
  );
}
