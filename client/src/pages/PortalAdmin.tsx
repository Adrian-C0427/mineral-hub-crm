import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner, Spinner } from "../components/ui";
import { num } from "../lib/format";

interface Offering {
  id: string; name: string; stage: string; counties: string[]; states: string[]; nra: number | null;
  publishedToPortal: boolean; portalSlug: string | null; portalVisibility: "PUBLIC" | "LINK_ONLY"; portalFeatured: boolean;
}
interface PortalSettings { portalSlug: string | null; portalEnabled: boolean }

/**
 * Buyer Portal admin — the internal hub for the public marketplace: portal
 * status, the public URL, and every published/draft offering with quick links
 * to the deal (to manage publishing) and the live offering page.
 */
export function PortalAdmin() {
  const { can } = useAuth();
  const [offerings, setOfferings] = useState<Offering[] | null>(null);
  const [settings, setSettings] = useState<PortalSettings | null>(null);

  useEffect(() => {
    api.get<Offering[]>("/deals/portal/offerings").then(setOfferings).catch(() => setOfferings([]));
    if (can("manageOrgSettings")) api.get<PortalSettings>("/org/portal-settings").then(setSettings).catch(() => {});
  }, [can]);

  if (!offerings) return <Spinner label="Loading portal…" />;
  const published = offerings.filter((o) => o.publishedToPortal);
  const marketplaceUrl = settings?.portalSlug ? `${window.location.origin}/portal/${settings.portalSlug}` : null;

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-header">
        <div><h1>Buyer Portal</h1><span className="muted">Your public offering marketplace</span></div>
        <div className="row" style={{ gap: 8 }}>
          {marketplaceUrl && settings?.portalEnabled && <a className="btn-primary-link" href={marketplaceUrl} target="_blank" rel="noreferrer">Open marketplace ↗</a>}
          {can("manageOrgSettings") && <Link to="/settings/portal"><button className="small">Portal settings</button></Link>}
        </div>
      </div>

      {settings && !settings.portalEnabled && (
        <Banner kind="info">
          The portal is currently <strong>disabled</strong>. Enable it and set a URL under{" "}
          <Link to="/settings/portal">Portal settings</Link> to make published offerings publicly visible.
        </Banner>
      )}

      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        <MetricLite label="Published offerings" value={String(published.length)} />
        <MetricLite label="Public in marketplace" value={String(published.filter((o) => o.portalVisibility === "PUBLIC").length)} />
        <MetricLite label="Featured" value={String(published.filter((o) => o.portalFeatured).length)} />
      </div>

      <div className="panel">
        <h3>Offerings</h3>
        {offerings.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            No offerings yet. Open any deal and use its <strong>Buyer Portal</strong> panel to publish it.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Deal</th><th>Location</th><th className="right">NRA</th><th>Status</th><th>Visibility</th><th></th></tr></thead>
              <tbody>
                {offerings.map((o) => (
                  <tr key={o.id}>
                    <td><Link to={`/deals/${o.id}`}>{o.name}</Link>{o.portalFeatured && <span className="badge resp-offer" style={{ marginLeft: 6 }}>Featured</span>}</td>
                    <td>{[o.counties.join(", "), o.states.join(", ")].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="right">{o.nra != null ? num(o.nra) : "—"}</td>
                    <td><span className={`badge ${o.publishedToPortal ? "resp-offer" : "resp-pending"}`}>{o.publishedToPortal ? "Published" : "Draft"}</span></td>
                    <td>{o.publishedToPortal ? (o.portalVisibility === "PUBLIC" ? "Public" : "Link only") : "—"}</td>
                    <td className="right">
                      {o.publishedToPortal && o.portalSlug && (
                        <a href={`${window.location.origin}/offer/${o.portalSlug}`} target="_blank" rel="noreferrer"><button className="small">View ↗</button></a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricLite({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}
