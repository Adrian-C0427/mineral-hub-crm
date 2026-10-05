import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

/** Quick links, each shown only when the user can open that page. */
const LINKS: { label: string; to: string; perm: string }[] = [
  { label: "Deals", to: "/deals/active", perm: "viewDeals" },
  { label: "Pipeline", to: "/pipeline", perm: "viewDeals" },
  { label: "Map", to: "/map", perm: "viewMap" },
  { label: "Buyers", to: "/buyers", perm: "viewBuyers" },
];

/**
 * 404 for signed-in users on an unknown URL (rendered inside the app shell).
 * Signed-out unknown URLs keep landing on the sign-in form (see App.tsx).
 */
export function NotFound() {
  const { user, can } = useAuth();
  const links = LINKS.filter((l) => can(l.perm));
  const org = user?.organization?.name;
  return (
    <div className="nf-page">
      <div className="nf-grid" aria-hidden="true" />
      <div className="nf-main">
        <div className="nf-body">
          <div className="nf-tags">
            <span className="nf-code">404</span>
            <span className="nf-eyebrow">Abstract not found</span>
          </div>
          <h1>This tract isn't on the plat.</h1>
          <p>The page you asked for was moved, renamed, or never recorded. Check the link, or head back to the dashboard.</p>
          <div className="nf-actions">
            <Link to="/" className="nf-back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
              Back to dashboard
            </Link>
            {links.map((l) => <Link key={l.label} to={l.to} className="nf-link">{l.label}</Link>)}
          </div>
        </div>
      </div>
      {org && <footer className="nf-foot">© {new Date().getFullYear()} {org}</footer>}
    </div>
  );
}
