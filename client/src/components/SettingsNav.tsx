import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { PHONE_PORTRAIT_QUERY } from "../lib/mobile";

/**
 * Settings frame shared by every Settings route: page title, a left section
 * menu grouped Personal / Organization / Connections, and the section cards.
 * The menu maps onto the existing routes — General sections are anchors on
 * /settings/general, Organization sections are its ?tab= values — and mirrors
 * the permission gating of those routes. On phones it becomes a chip row.
 */

interface RailItem {
  label: string;
  path: string;
  /** Anchor on /settings/general. */
  hash?: string;
  /** ?tab= value on /settings/organization ("org" when absent). */
  tab?: string;
  show: boolean;
}

/** Anchors on the General page, in page order (scroll-spy reads this). */
const GENERAL_ANCHORS = ["profile", "notifications", "appearance", "branding"];

function useRail(): { label: string; items: RailItem[] }[] {
  const { can, isOrgOwner } = useAuth();
  const groups = [
    {
      label: "Personal",
      items: [
        { label: "Profile & security", path: "/settings/general", hash: "profile", show: true },
        { label: "Notifications", path: "/settings/general", hash: "notifications", show: true },
        { label: "Appearance", path: "/settings/general", hash: "appearance", show: true },
      ],
    },
    {
      label: "Organization",
      items: [
        { label: "Organization", path: "/settings/organization", tab: "org", show: true },
        { label: "Team members", path: "/settings/organization", tab: "users", show: can("manageMembers") || can("inviteRemoveUsers") },
        { label: "Roles & permissions", path: "/settings/organization", tab: "roles", show: isOrgOwner },
        { label: "Branding", path: "/settings/general", hash: "branding", show: true },
        { label: "Owner controls", path: "/settings/organization", tab: "owner", show: isOrgOwner },
      ],
    },
    {
      label: "Connections",
      items: [
        { label: "Portal", path: "/settings/portal", show: can("managePortal") },
        { label: "Integrations", path: "/settings/integrations", show: can("manageApiIntegrations") },
      ],
    },
  ];
  return groups.map((g) => ({ ...g, items: g.items.filter((i) => i.show) })).filter((g) => g.items.length > 0);
}

/** Which General-page section is in view (falls back to the URL hash). */
function useGeneralSection(enabled: boolean, hash: string): string {
  const [active, setActive] = useState(hash || GENERAL_ANCHORS[0]);
  useEffect(() => { if (hash) setActive(hash); }, [hash]);
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id); }
      const first = GENERAL_ANCHORS.find((id) => visible.has(id));
      if (first) setActive(first);
    }, { rootMargin: "-80px 0px -55% 0px" });
    // Sections mount asynchronously (notification types load from the API).
    const attach = () => GENERAL_ANCHORS.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
    attach();
    const t = window.setTimeout(attach, 600);
    return () => { window.clearTimeout(t); io.disconnect(); };
  }, [enabled]);
  return active;
}

export function SettingsNav() {
  const { pathname, search, hash } = useLocation();
  const groups = useRail();
  const onGeneral = pathname === "/settings/general";
  const generalSection = useGeneralSection(onGeneral, hash.replace(/^#/, ""));
  const orgTab = new URLSearchParams(search).get("tab") || "org";
  const railRef = useRef<HTMLElement>(null);

  const isActive = (i: RailItem) => {
    if (i.path !== pathname) return false;
    if (i.hash) return generalSection === i.hash;
    if (i.tab) return orgTab === i.tab;
    return true;
  };

  // Phones: the chip row scrolls sideways — keep the selected chip in view.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || !window.matchMedia(PHONE_PORTRAIT_QUERY).matches) return;
    const active = rail.querySelector<HTMLElement>(".settings-rail-item.active");
    if (!active || rail.scrollWidth <= rail.clientWidth + 1) return;
    const a = active.getBoundingClientRect(), r = rail.getBoundingClientRect();
    if (a.left < r.left || a.right > r.right) rail.scrollLeft += a.left - r.left - (r.width - a.width) / 2;
  }, [pathname, search, generalSection]);

  return (
    <nav className="settings-rail" aria-label="Settings sections" ref={railRef}>
      {groups.map((g) => (
        <div className="settings-rail-group" key={g.label}>
          <span className="settings-rail-label">{g.label}</span>
          <div className="settings-rail-items">
            {g.items.map((i) => {
              const to = i.hash
                ? { pathname: i.path, hash: `#${i.hash}` }
                : { pathname: i.path, search: i.tab && i.tab !== "org" ? `?tab=${i.tab}` : "" };
              const active = isActive(i);
              return (
                <Link
                  key={i.label} to={to} className={`settings-rail-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}
                  // Re-selecting the anchor already in the URL still scrolls to it.
                  onClick={() => { if (i.hash && pathname === i.path) document.getElementById(i.hash)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                >
                  {i.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

/** Page frame for every Settings route: title, section menu and content column. */
export function SettingsLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { pathname, search, hash } = useLocation();

  // Menu entries that share a route scroll to their anchor on the page.
  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (!id) { window.scrollTo({ top: 0 }); return; }
    const go = () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    go();
    const t = window.setTimeout(go, 350); // late-mounting sections (data loads)
    return () => window.clearTimeout(t);
  }, [pathname, search, hash]);

  const orgName = user?.organization?.name;
  return (
    <div className="page settings-page">
      <div className="settings-title">
        <h1>Settings</h1>
        <span>{orgName ? `Your account, your team and how ${orgName} looks.` : "Your account, your team and how Mineral Hub looks."}</span>
      </div>
      <div className="settings-frame">
        <SettingsNav />
        <div className="settings-content">{children}</div>
      </div>
    </div>
  );
}

/** Card heading used by every settings section: title, description, optional right slot. */
export function SettingsCardHead({ title, desc, aside, badge }: { title: ReactNode; desc?: ReactNode; aside?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="set-head">
      <div className="set-head-text">
        <div className="set-title-row"><h3 className="set-title">{title}</h3>{badge}</div>
        {desc && <p className="set-desc">{desc}</p>}
      </div>
      {aside && <div className="set-head-aside">{aside}</div>}
    </div>
  );
}
