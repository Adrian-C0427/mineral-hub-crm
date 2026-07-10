import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

/**
 * Persistent sub-navigation shared by every Settings page. Before this, moving
 * between General / Organization / Portal / Integrations meant reopening the
 * sidebar's Settings group each time — settings pages had no visible siblings.
 * Mirrors the sidebar's permission gating.
 */
const TABS: { label: string; to: string; perm?: string }[] = [
  { label: "General", to: "/settings/general" },
  { label: "Organization", to: "/settings/organization" },
  { label: "Portal", to: "/settings/portal", perm: "managePortal" },
  { label: "Integrations", to: "/settings/integrations", perm: "manageApiIntegrations" },
];

export function SettingsNav() {
  const { can } = useAuth();
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {TABS.filter((t) => !t.perm || can(t.perm)).map((t) => (
        <NavLink key={t.to} to={t.to} className={({ isActive }) => `settings-nav-link ${isActive ? "active" : ""}`}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
