import { useEffect, useMemo, useState } from "react";
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

type VisFilter = "all" | "public" | "link" | "draft";
const VIS_TABS: { key: VisFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "public", label: "Public" },
  { key: "link", label: "Link only" },
  { key: "draft", label: "Drafts" },
];

/**
 * Buyer Portal admin — the internal hub for the public marketplace: portal
 * status, headline KPIs, and every published/draft offering with quick links
 * to the deal (to manage publishing) and the live offering page. Visibility
 * tabs and search filter the already-loaded offerings client-side.
 */
export function PortalAdmin() {
  const { can } = useAuth();
  const [offerings, setOfferings] = useState<Offering[] | null>(null);
  const [settings, setSettings] = useState<PortalSettings | null>(null);
  const [vis, setVis] = useState<VisFilter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    api.get<Offering[]>("/deals/portal/offerings").then(setOfferings).catch(() => setOfferings([]));
    if (can("managePortal")) api.get<PortalSettings>("/org/portal-settings").then(setSettings).catch(() => {});
  }, [can]);

  const locOf = (o: Offering) => [o.counties.join(", "), o.states.join(", ")].filter(Boolean).join(" · ");

  const shown = useMemo(() => {
    if (!offerings) return [];
    const q = query.trim().toLowerCase();
    return offerings.filter((o) => {
      if (vis === "public" && !(o.publishedToPortal && o.portalVisibility === "PUBLIC")) return false;
      if (vis === "link" && !(o.publishedToPortal && o.portalVisibility === "LINK_ONLY")) return false;
      if (vis === "draft" && o.publishedToPortal) return false;
      if (q && !o.name.toLowerCase().includes(q) && !locOf(o).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [offerings, vis, query]);

  if (!offerings) return <Spinner label="Loading portal…" />;

  const published = offerings.filter((o) => o.publishedToPortal);
  const publicCount = published.filter((o) => o.portalVisibility === "PUBLIC").length;
  const featuredCount = published.filter((o) => o.portalFeatured).length;
  const draftCount = offerings.length - published.length;
  const marketplaceUrl = settings?.portalSlug ? `${window.location.origin}/portal/${settings.portalSlug}` : null;

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <div className="page-header">
        <div>
          <h1 style={{ marginBottom: 4 }}>Buyer Portal</h1>
          <span className="muted">Your public offering marketplace</span>
        </div>
        <div className="portal-actions">
          {marketplaceUrl && settings?.portalEnabled && (
            <a className="pbtn pbtn-primary" href={marketplaceUrl} target="_blank" rel="noreferrer">
              Open marketplace
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17L17 7" /><path d="M9 7h8v8" /></svg>
            </a>
          )}
          {can("managePortal") && <Link className="pbtn" to="/settings/portal">Portal settings</Link>}
        </div>
      </div>

      {settings && !settings.portalEnabled && (
        <Banner kind="info">
          The portal is currently <strong>disabled</strong>. Enable it and set a URL under{" "}
          <Link to="/settings/portal">Portal settings</Link> to make published offerings publicly visible.
        </Banner>
      )}

      <div className="kpi-grid g3">
        <div className="kpi-card">
          <div className="kpi-label">Published Offerings</div>
          <div className="kpi-value">{published.length}</div>
          <div className="kpi-sub">{draftCount} in draft</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Public in Marketplace</div>
          <div className="kpi-value" style={{ color: "var(--accent)" }}>{publicCount}</div>
          <div className="kpi-sub">Visible to buyers now</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Featured</div>
          <div className="kpi-value" style={{ color: "var(--gold)" }}>{featuredCount}</div>
          <div className="kpi-sub">Pinned to top of portal</div>
        </div>
      </div>

      <section className="listing">
        <div className="listing-head">
          <div className="listing-title">Offerings <span className="count">({shown.length})</span></div>
          <div className="listing-tools">
            <div className="seg-control subtle" role="tablist" aria-label="Filter offerings by visibility">
              {VIS_TABS.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={vis === t.key}
                  className={`seg ${vis === t.key ? "active" : ""}`}
                  onClick={() => setVis(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <input
              className="listing-search"
              placeholder="Search offerings…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search offerings"
            />
          </div>
        </div>

        <div className="listing-scroll">
          <div className="listing-grid" style={{ gridTemplateColumns: "1.6fr 1fr auto auto 1fr auto" }}>
            <div className="lg-head">Deal</div>
            <div className="lg-head">Location</div>
            <div className="lg-head lg-right">NRA</div>
            <div className="lg-head">Status</div>
            <div className="lg-head">Visibility</div>
            <div className="lg-head lg-right">Actions</div>

            {shown.map((o) => {
              const loc = locOf(o);
              return (
                <div key={o.id} style={{ display: "contents" }}>
                  <div className="lg-cell">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <Link className="lg-name ellip" to={`/deals/${o.id}`}>{o.name}</Link>
                      {o.portalFeatured && <span className="pill-featured">★ Featured</span>}
                    </span>
                  </div>
                  <div className="lg-cell lg-dim"><span className="ellip">{loc || "—"}</span></div>
                  <div className="lg-cell lg-right lg-num">{o.nra != null ? num(o.nra) : <span className="lg-faint">—</span>}</div>
                  <div className="lg-cell">
                    <span className={`pill-status ${o.publishedToPortal ? "is-published" : ""}`}>
                      <span className="dot" />{o.publishedToPortal ? "Published" : "Draft"}
                    </span>
                  </div>
                  <div className="lg-cell">
                    {o.publishedToPortal
                      ? (o.portalVisibility === "PUBLIC"
                          ? <span className="vis-public">● Public</span>
                          : <span className="vis-private">○ Link only</span>)
                      : <span className="vis-none">—</span>}
                  </div>
                  <div className="lg-cell lg-right">
                    {o.publishedToPortal && o.portalSlug && (
                      <a href={`${window.location.origin}/offer/${o.portalSlug}`} target="_blank" rel="noreferrer">
                        <button className="lg-action">View ↗</button>
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {shown.length === 0 && (
            <div className="listing-empty">
              {offerings.length === 0 ? (
                <>
                  <div className="listing-empty-title">No offerings yet</div>
                  <div className="listing-empty-body">Open any deal and use its <strong>Buyer Portal</strong> panel to publish it.</div>
                </>
              ) : (
                <>
                  <div className="listing-empty-title">No offerings match</div>
                  <div className="listing-empty-body">Try a different filter or search term.</div>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      <div className="portal-note">
        Draft offerings are only visible to you. Publish an offering to make it available in the marketplace, then set
        visibility to Public — Featured offerings appear at the top of the buyer list.
      </div>
    </div>
  );
}
