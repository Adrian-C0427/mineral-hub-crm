import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { API_BASE } from "../../api/client";
import { num } from "../../lib/format";
import { PortalMap } from "./PortalMap";
import { portalGet, type FC, type PortalAbstract, type PortalDeal, type PortalDocument, type PortalOrg } from "./portalApi";

const EMPTY_FC: FC = { type: "FeatureCollection", features: [] };

/**
 * Public offering page — the buyer-facing view of one published deal, reached
 * via its share link (/offer/:slug). Shows only whitelisted fields, the
 * property map, approved documents, and the org's contact section.
 */
export function PortalOffering() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<{ org: PortalOrg; deal: PortalDeal; abstracts: PortalAbstract[]; documents: PortalDocument[] } | null>(null);
  const [features, setFeatures] = useState<FC>(EMPTY_FC);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    portalGet<typeof data>(`/offering/${encodeURIComponent(slug)}`).then(setData).catch((e) => setError(e.message));
    portalGet<FC>(`/offering/${encodeURIComponent(slug)}/features`).then(setFeatures).catch(() => {});
  }, [slug]);

  if (error) return <PortalShell><div className="panel" style={{ textAlign: "center", padding: 48 }}><h2>Offering unavailable</h2><p className="muted">{error}</p></div></PortalShell>;
  if (!data) return <PortalShell><p className="muted" style={{ textAlign: "center", padding: 48 }}>Loading offering…</p></PortalShell>;
  const { org, deal, abstracts, documents } = data;

  const mailSubject = encodeURIComponent(`Inquiry: ${deal.name}`);
  const mailto = org.contactEmail ? `mailto:${org.contactEmail}?subject=${mailSubject}` : null;

  return (
    <PortalShell org={org}>
      {/* Hero */}
      <div className="portal-hero panel">
        <div>
          {deal.featured && <span className="badge resp-offer" style={{ marginBottom: 8 }}>Featured opportunity</span>}
          <h1 style={{ margin: "4px 0 6px" }}>{deal.name}</h1>
          <div className="muted">{[deal.counties.map((c) => `${c} County`).join(", "), deal.states.join(", ")].filter(Boolean).join(" · ")}</div>
          {deal.summary && <p style={{ marginTop: 12, maxWidth: 720, lineHeight: 1.55 }}>{deal.summary}</p>}
        </div>
        <div className="portal-hero-facts">
          {deal.nra != null && <Fact label="Net Royalty Acres" value={num(deal.nra)} />}
          {deal.acreageNma != null && <Fact label="Net Mineral Acres" value={num(deal.acreageNma)} />}
          {deal.assetTypes.length > 0 && <Fact label="Asset Type" value={deal.assetTypes.join(", ")} />}
          {deal.operator && <Fact label="Operator" value={deal.operator} />}
        </div>
      </div>

      {/* Map */}
      <div className="panel">
        <div className="section-head"><h3 style={{ margin: 0 }}>Property Map</h3><span className="muted">Interactive — zoom, pan, and toggle layers</span></div>
        <PortalMap features={features} height={460} />
      </div>

      {/* Details */}
      <div className="portal-grid">
        <div className="panel">
          <h3>Property Details</h3>
          <div className="portal-kv">
            <KV k="State(s)" v={deal.states.join(", ")} />
            <KV k="County(ies)" v={deal.counties.join(", ")} />
            <KV k="Basin(s)" v={deal.basins.join(", ")} />
            <KV k="Formation(s)" v={deal.formations.join(", ")} />
            <KV k="Asset Type(s)" v={deal.assetTypes.join(", ")} />
            <KV k="NRA" v={deal.nra != null ? num(deal.nra) : ""} />
            <KV k="Net Mineral Acres" v={deal.acreageNma != null ? num(deal.acreageNma) : ""} />
            <KV k="Operator(s)" v={deal.operator ?? ""} />
            <KV k="Producing Status" v={deal.producingStatus ?? ""} />
            <KV k="Survey(s)" v={(deal.surveys.length ? deal.surveys : [...new Set(abstracts.map((a) => a.survey).filter(Boolean))] as string[]).join(", ")} />
          </div>
          {abstracts.length > 0 && (
            <>
              <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", margin: "14px 0 6px" }}>Abstracts</div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {abstracts.map((a) => <span key={a.id} className="badge resp-pending">{a.abstract ?? a.id}{a.survey ? ` · ${a.survey}` : ""} · {a.county}</span>)}
              </div>
            </>
          )}
          {deal.wells.length > 0 && (
            <>
              <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", margin: "14px 0 6px" }}>Wells</div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {deal.wells.map((w) => <span key={w} className="badge resp-pending">{w}</span>)}
              </div>
            </>
          )}
        </div>

        <div>
          {/* Documents */}
          <div className="panel">
            <h3>Documents</h3>
            {documents.length === 0 ? <p className="muted" style={{ marginBottom: 0 }}>No public documents for this offering.</p> : (
              documents.map((d) => (
                <a
                  key={d.id}
                  className="portal-doc"
                  href={`${API_BASE}/api/portal/offering/${encodeURIComponent(slug)}/files/${d.id}/download`}
                  onClick={async (e) => {
                    e.preventDefault();
                    try {
                      const r = await fetch(`${API_BASE}/api/portal/offering/${encodeURIComponent(slug)}/files/${d.id}/download`);
                      const j = (await r.json()) as { url?: string; error?: string };
                      if (j.url) window.open(j.url, "_blank");
                      else alert(j.error ?? "Download unavailable");
                    } catch { alert("Download unavailable"); }
                  }}
                >
                  <span>📄 {d.filename}</span>
                  <span className="muted">{(d.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                </a>
              ))
            )}
          </div>

          {/* Contact */}
          <div className="panel portal-contact">
            <h3>Interested in this opportunity?</h3>
            {org.contactName && <div className="portal-contact-line"><strong>{org.contactName}</strong></div>}
            <div className="portal-contact-line">{org.name}</div>
            {org.contactPhone && <div className="portal-contact-line"><a href={`tel:${org.contactPhone}`}>{org.contactPhone}</a></div>}
            {org.contactEmail && <div className="portal-contact-line"><a href={mailto ?? "#"}>{org.contactEmail}</a></div>}
            {org.officeLocation && <div className="portal-contact-line muted">{org.officeLocation}</div>}
            <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: "wrap" }}>
              {mailto && <a className="btn-primary-link" href={mailto}>Contact Us</a>}
              {mailto && <a className="btn-ghost-link" href={`${mailto}&body=${encodeURIComponent("Please send additional information about this opportunity.")}`}>Request More Info</a>}
              {org.contactPhone && <a className="btn-ghost-link" href={`tel:${org.contactPhone}`}>Schedule a Call</a>}
            </div>
          </div>
        </div>
      </div>

      {org.slug && (
        <p className="muted" style={{ textAlign: "center" }}>
          <Link to={`/portal/${org.slug}`}>← Browse all available opportunities</Link>
        </p>
      )}
    </PortalShell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="portal-fact"><div className="portal-fact-v">{value}</div><div className="portal-fact-l">{label}</div></div>;
}
function KV({ k, v }: { k: string; v: string }) {
  if (!v) return null;
  return <div className="portal-kv-row"><span className="muted">{k}</span><span>{v}</span></div>;
}

/** Shared public chrome: branded header + footer, no CRM sidebar/auth. */
export function PortalShell({ org, children }: { org?: PortalOrg; children: React.ReactNode }) {
  return (
    <div className="portal-shell">
      <header className="portal-header">
        {org?.fullLogo
          ? <img src={org.fullLogo} alt={org.name} style={{ height: 34 }} />
          : <span className="brand" style={{ fontSize: 18 }}>{org?.name ?? <>Mineral Hub<span className="dot">.</span></>}</span>}
        <span className="muted" style={{ fontSize: 13 }}>Mineral Opportunities</span>
      </header>
      <main className="portal-main">{children}</main>
      <footer className="portal-footer muted">
        © {new Date().getFullYear()} {org?.name ?? "Mineral Hub"} · All information subject to verification. Nothing herein constitutes an offer to sell securities.
      </footer>
    </div>
  );
}
