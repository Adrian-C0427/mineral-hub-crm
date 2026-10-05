import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner, Spinner, showToast } from "../components/ui";
import { Segmented, StatStrip } from "../components/kit";
import { num } from "../lib/format";

interface Offering {
  id: string; name: string; stage: string; counties: string[]; states: string[]; nra: number | null;
  publishedToPortal: boolean; portalSlug: string | null; portalVisibility: "PUBLIC" | "LINK_ONLY"; portalFeatured: boolean;
}
interface PortalSettings { portalSlug: string | null; portalEnabled: boolean }
/** The publish fields `PATCH /deals/:id/portal` returns (same call DealPortalPanel makes). */
type PortalPatchResult = Pick<Offering, "publishedToPortal" | "portalSlug" | "portalVisibility" | "portalFeatured">;

type VisFilter = "all" | "public" | "link" | "draft";

const EMPTY_COPY: Record<VisFilter, { title: string; body: string }> = {
  all: { title: "No offerings match", body: "Try a different filter or search term." },
  public: { title: "No public offerings", body: "Publish an offering and set its visibility to Public." },
  link: { title: "No link-only offerings", body: "Link-only offerings are shared by URL and hidden from listings." },
  draft: { title: "No drafts", body: "Everything is published." },
};

const IconCopy = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>
);
const IconLink = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
);
const IconEye = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></svg>
);
const IconStar = ({ filled }: { filled: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" /></svg>
);

/**
 * Buyer Portal admin — the internal hub for the public marketplace: portal
 * status, headline counts, and every published/draft offering with the same
 * publish / visibility / featured controls as the deal's Buyer Portal panel
 * (same endpoint, same rules), a link to the deal, and the live offering page.
 * Visibility tabs and search filter the already-loaded offerings client-side.
 */
export function PortalAdmin() {
  const { can } = useAuth();
  const [offerings, setOfferings] = useState<Offering[] | null>(null);
  const [settings, setSettings] = useState<PortalSettings | null>(null);
  const [vis, setVis] = useState<VisFilter>("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const canEdit = can("publishOfferings");

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

  // Same call + payloads as the deal page's Buyer Portal panel; the row picks
  // up whatever the server returns (the first publish mints the share slug).
  async function patch(o: Offering, body: { published?: boolean; visibility?: Offering["portalVisibility"]; featured?: boolean }) {
    setBusyId(o.id);
    try {
      const d = await api.patch<PortalPatchResult>(`/deals/${o.id}/portal`, body);
      setOfferings((prev) => prev?.map((x) => (x.id === o.id ? {
        ...x, publishedToPortal: d.publishedToPortal, portalSlug: d.portalSlug, portalVisibility: d.portalVisibility, portalFeatured: d.portalFeatured,
      } : x)) ?? prev);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed to update portal settings", "error");
    } finally {
      setBusyId(null);
    }
  }

  function copy(url: string, msg: string) {
    void navigator.clipboard.writeText(url).then(() => showToast(msg), () => showToast("Couldn't copy the link", "error"));
  }

  if (!offerings) return <Spinner label="Loading portal…" />;

  const published = offerings.filter((o) => o.publishedToPortal);
  const publicCount = published.filter((o) => o.portalVisibility === "PUBLIC").length;
  const linkCount = published.length - publicCount;
  const featuredCount = published.filter((o) => o.portalFeatured).length;
  const draftCount = offerings.length - published.length;
  const marketplaceUrl = settings?.portalSlug ? `${window.location.origin}/portal/${settings.portalSlug}` : null;
  const offerUrl = (slug: string) => `${window.location.origin}/offer/${slug}`;
  const live = Boolean(settings?.portalEnabled) && publicCount > 0;

  return (
    <div className="page pa-page">
      <div className="page-header">
        <div className="pa-title">
          <h1>Buyer Portal</h1>
          <span className="muted">Your public offering marketplace</span>
        </div>
        <div className="pa-actions">
          {marketplaceUrl && (
            <button type="button" className="pa-url" onClick={() => copy(marketplaceUrl, "Portal link copied")} title="Copy portal link">
              <span className={`pa-url-dot ${live ? "live" : ""}`} aria-hidden="true" />
              <span className="pa-url-text">{marketplaceUrl.replace(/^https?:\/\//, "")}</span>
              <IconCopy />
            </button>
          )}
          {can("managePortal") && (
            <Link className="pa-btn" to="/settings/portal">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" /></svg>
              Portal settings
            </Link>
          )}
          {marketplaceUrl && settings?.portalEnabled && (
            <a className="pa-btn primary" href={marketplaceUrl} target="_blank" rel="noreferrer">
              Open marketplace
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8" /></svg>
            </a>
          )}
        </div>
      </div>

      {settings && !settings.portalEnabled && (
        <Banner kind="info">
          The portal is currently <strong>disabled</strong>. Enable it and set a URL under{" "}
          <Link to="/settings/portal">Portal settings</Link> to make published offerings publicly visible.
        </Banner>
      )}

      <StatStrip
        min={220}
        cells={[
          { label: "Published offerings", value: published.length, sub: `${draftCount} in draft` },
          { label: "Public in marketplace", value: publicCount, tone: publicCount > 0 ? "accent" : "default", sub: "Visible to buyers now" },
          { label: "Link only", value: linkCount, sub: "Shared by direct URL" },
          { label: "Featured", value: featuredCount, tone: featuredCount > 0 ? "warn" : "default", sub: "Pinned to top of portal" },
        ]}
      />

      <section className="pa-card">
        <div className="pa-card-head">
          <div className="pa-card-title">
            <span>Offerings</span>
            <span className="pa-card-count">{shown.length === offerings.length ? `${offerings.length} offerings` : `${shown.length} of ${offerings.length}`}</span>
          </div>
          <div className="pa-tools">
            <Segmented<VisFilter>
              ariaLabel="Filter offerings by visibility"
              value={vis}
              onChange={setVis}
              options={[
                { value: "all", label: "All", count: offerings.length },
                { value: "public", label: "Public", count: publicCount },
                { value: "link", label: "Link only", count: linkCount },
                { value: "draft", label: "Drafts", count: draftCount },
              ]}
            />
            <label className="pa-search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input placeholder="Search offerings" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search offerings" />
            </label>
          </div>
        </div>

        <div className="pa-scroll">
          <div className="pa-table" role="table">
            <div className="pa-row pa-head" role="row">
              <span role="columnheader">Deal</span>
              <span role="columnheader">Location</span>
              <span role="columnheader" className="pa-right">NRA</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Visibility</span>
              <span role="columnheader" className="pa-center">Featured</span>
              <span role="columnheader" className="pa-right">Actions</span>
            </div>

            {shown.map((o) => {
              const loc = locOf(o);
              const isPublic = o.publishedToPortal && o.portalVisibility === "PUBLIC";
              const busy = busyId === o.id;
              const locked = !canEdit || busy;
              return (
                <div key={o.id} className="pa-row" role="row">
                  <div className="pa-deal" role="cell">
                    <Link className="pa-deal-name" to={`/deals/${o.id}`}>{o.name}</Link>
                    <span className="pa-deal-sub">{!o.publishedToPortal ? "Not published" : isPublic ? "Listed in marketplace" : "Hidden from listings"}</span>
                  </div>
                  <span className="pa-dim pa-ellip" role="cell">{loc || "—"}</span>
                  <span className="pa-right pa-num" role="cell">{o.nra != null ? num(o.nra) : <span className="pa-faint">—</span>}</span>
                  <span role="cell">
                    <span className={`pa-status ${o.publishedToPortal ? "on" : ""}`}><i />{o.publishedToPortal ? "Published" : "Draft"}</span>
                  </span>
                  <span role="cell">
                    {o.publishedToPortal ? (
                      <span className="pa-vis" role="group" aria-label="Visibility">
                        <button type="button" className={o.portalVisibility === "PUBLIC" ? "on" : ""} disabled={locked}
                          aria-pressed={o.portalVisibility === "PUBLIC"}
                          onClick={() => o.portalVisibility !== "PUBLIC" && void patch(o, { visibility: "PUBLIC" })}>Public</button>
                        <button type="button" className={o.portalVisibility === "LINK_ONLY" ? "on" : ""} disabled={locked}
                          aria-pressed={o.portalVisibility === "LINK_ONLY"}
                          onClick={() => o.portalVisibility !== "LINK_ONLY" && void patch(o, { visibility: "LINK_ONLY" })}>Link only</button>
                      </span>
                    ) : <span className="pa-faint">Only you</span>}
                  </span>
                  <span className="pa-center" role="cell">
                    <button type="button" className={`pa-star ${o.portalFeatured ? "on" : ""}`}
                      disabled={locked || !o.publishedToPortal}
                      aria-pressed={o.portalFeatured} aria-label={o.portalFeatured ? "Unfeature offering" : "Feature offering"}
                      title={!o.publishedToPortal ? "Publish to feature" : o.portalFeatured ? "Featured" : "Feature"}
                      onClick={() => void patch(o, { featured: !o.portalFeatured })}>
                      <IconStar filled={o.portalFeatured} />
                    </button>
                  </span>
                  <span className="pa-row-actions" role="cell">
                    {!o.publishedToPortal && (
                      <button type="button" className="pa-mini primary" disabled={locked} onClick={() => void patch(o, { published: true })}>Publish</button>
                    )}
                    {o.publishedToPortal && o.portalSlug && (
                      <>
                        <button type="button" className="pa-icon" title="Copy link" aria-label="Copy link" onClick={() => copy(offerUrl(o.portalSlug!), "Link copied")}><IconLink /></button>
                        <a className="pa-icon" href={offerUrl(o.portalSlug)} target="_blank" rel="noreferrer" title="Preview as buyer" aria-label="Preview as buyer"><IconEye /></a>
                      </>
                    )}
                    {o.publishedToPortal && (
                      <button type="button" className="pa-mini" disabled={locked} onClick={() => void patch(o, { published: false })}>Unpublish</button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {shown.length === 0 && (
          <div className="pa-empty">
            {offerings.length === 0 ? (
              <>
                <span className="pa-empty-title">No offerings yet</span>
                <span className="pa-empty-body">Open any deal and use its <strong>Buyer Portal</strong> panel to publish it.</span>
              </>
            ) : query.trim() ? (
              <>
                <span className="pa-empty-title">No matches</span>
                <span className="pa-empty-body">Nothing matches “{query.trim()}”.</span>
              </>
            ) : (
              <>
                <span className="pa-empty-title">{EMPTY_COPY[vis].title}</span>
                <span className="pa-empty-body">{EMPTY_COPY[vis].body}</span>
              </>
            )}
          </div>
        )}

        <div className="pa-guide">
          <div className="pa-step"><span className="pa-step-n">1</span><div><strong>Draft</strong><span>Only visible to you.</span></div></div>
          <div className="pa-step"><span className="pa-step-n">2</span><div><strong>Publish</strong><span>Link only shares by URL. Public lists it in the marketplace.</span></div></div>
          <div className="pa-step"><span className="pa-step-n">3</span><div><strong>Feature</strong><span>Featured offerings are pinned to the top of the buyer list.</span></div></div>
        </div>
      </section>
    </div>
  );
}
