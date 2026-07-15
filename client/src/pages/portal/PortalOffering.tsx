import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { API_BASE } from "../../api/client";
import { num } from "../../lib/format";
import { PortalMap } from "./PortalMap";
import { portalGet, portalPost, type FC, type PortalAbstract, type PortalDeal, type PortalDocument, type PortalImage, type PortalOrg, type PortalPackageAsset, type PortalProduction } from "./portalApi";
import { formatPhone } from "../../lib/phone";
import { MoneyInput } from "../../components/MoneyInput";
import { PhoneInput } from "../../components/PhoneInput";
import { DateField } from "../../components/DateField";

const EMPTY_FC: FC = { type: "FeatureCollection", features: [] };

/**
 * Public offering page — the buyer-facing view of one published deal, reached
 * via its share link (/offer/:slug). Shows only whitelisted fields, the
 * property map, approved documents, and the org's contact section.
 */
export function PortalOffering() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<{ org: PortalOrg; deal: PortalDeal; abstracts: PortalAbstract[]; documents: PortalDocument[]; images: PortalImage[]; production: PortalProduction | null; assets: PortalPackageAsset[] } | null>(null);
  const [features, setFeatures] = useState<FC>(EMPTY_FC);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    portalGet<typeof data>(`/offering/${encodeURIComponent(slug)}`).then(setData).catch((e) => setError(e.message));
    portalGet<FC>(`/offering/${encodeURIComponent(slug)}/features`).then(setFeatures).catch(() => {});
  }, [slug]);

  if (error) return <PortalShell><div className="panel" style={{ textAlign: "center", padding: 48 }}><h2>Offering unavailable</h2><p className="muted">{error}</p></div></PortalShell>;
  if (!data) return <PortalShell><p className="muted" style={{ textAlign: "center", padding: 48 }}>Loading offering…</p></PortalShell>;
  const { org, deal, abstracts, documents, images, production, assets } = data;

  const mailSubject = encodeURIComponent(`Inquiry: ${deal.name}`);
  const mailto = org.contactEmail ? `mailto:${org.contactEmail}?subject=${mailSubject}` : null;
  // No section configuration: every block renders only when it has data.
  const hasMap = features.features.length > 0;

  return (
    <PortalShell org={org}>
      {/* Hero */}
      <div className="portal-hero panel">
        <div>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            {deal.featured && <span className="badge resp-offer">Featured opportunity</span>}
            {assets.length > 0 && <span className="badge resp-pending">Package · {assets.length} tract{assets.length > 1 ? "s" : ""}</span>}
          </div>
          <h1 style={{ margin: "4px 0 6px" }}>{deal.name}</h1>
          <div className="muted">{[deal.counties.map((c) => `${c} County`).join(", "), deal.states.join(", ")].filter(Boolean).join(" · ")}</div>
          {deal.summary && <p style={{ marginTop: 12, maxWidth: 720, lineHeight: 1.55 }}>{deal.summary}</p>}
        </div>
        <div className="portal-hero-facts">
          {deal.askPrice != null && <Fact label="Asking Price" value={`$${num(deal.askPrice)}`} />}
          {deal.nra != null && <Fact label="Net Royalty Acres" value={num(deal.nra)} />}
          {deal.acreageNma != null && <Fact label="Net Mineral Acres" value={num(deal.acreageNma)} />}
          {deal.assetTypes.length > 0 && <Fact label="Asset Type" value={deal.assetTypes.join(", ")} />}
          {deal.operator && <Fact label="Operator" value={deal.operator} />}
        </div>
      </div>

      {/* Bundle contents: the individual tracts included in this package. */}
      {assets.length > 0 && (
        <div className="panel">
          <div className="section-head">
            <h3 style={{ margin: 0 }}>Assets in this package</h3>
            <span className="muted">{assets.length} tract{assets.length > 1 ? "s" : ""} offered together — inquire for any or all</span>
          </div>
          <div className="portal-assets">
            {assets.map((a) => (
              <div key={a.id} className="portal-asset">
                <div className="portal-asset-name">{a.name}</div>
                <div className="portal-asset-facts">
                  {a.counties.length > 0 && <span>{a.counties.join(", ")}{a.states.length ? ` · ${a.states.join(", ")}` : ""}</span>}
                  {a.nra != null && <span><strong>{num(a.nra)}</strong> NRA</span>}
                  {a.assetTypes.length > 0 && <span>{a.assetTypes.join("/")}</span>}
                  {a.operator && <span>{a.operator}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Photos */}
      {images.length > 0 && (
        <div className="panel">
          <div className="section-head"><h3 style={{ margin: 0 }}>Photos</h3><span className="muted">Click to open full size</span></div>
          <div className="portal-gallery">
            {images.map((img) => (
              <a key={img.id} href={img.url} target="_blank" rel="noreferrer" title={img.filename}>
                <img src={img.url} alt={img.filename} loading="lazy" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Production summary */}
      {production && (
        <div className="panel">
          <div className="section-head">
            <h3 style={{ margin: 0 }}>Production Summary</h3>
            <span className="muted">Reported volumes across {production.wellsMatched} well{production.wellsMatched === 1 ? "" : "s"} · {production.firstMonth ?? "?"} → {production.lastMonth}</span>
          </div>
          <div className="portal-prod">
            <ProdStat v={`${num(production.cumOilBbl)}`} l="Cumulative oil (bbl)" />
            <ProdStat v={`${num(production.cumGasMcf)}`} l="Cumulative gas (mcf)" />
            <ProdStat v={`${num(production.cumBoe)}`} l="Cumulative BOE" />
            <ProdStat v={`${num(production.last12OilBbl)}`} l="Last 12mo oil (bbl)" />
            <ProdStat v={`${num(production.last12GasMcf)}`} l="Last 12mo gas (mcf)" />
            <ProdStat v={`${production.months}`} l="Months of history" />
          </div>
        </div>
      )}

      {/* Map — shown only when the offering has mappable geometry */}
      {hasMap && (
        <div className="panel">
          <div className="section-head"><h3 style={{ margin: 0 }}>Property Map</h3><span className="muted">Interactive — zoom, pan, and toggle layers</span></div>
          <PortalMap features={features} height={460} />
        </div>
      )}

      {/* Details */}
      <div className="portal-grid">
        <div className="panel">
          <h3>Property Details</h3>
          <div className="portal-kv">
            <KV k={deal.states.length > 1 ? "States" : "State"} v={deal.states.join(", ")} />
            <KV k={deal.counties.length > 1 ? "Counties" : "County"} v={deal.counties.join(", ")} />
            <KV k={deal.basins.length > 1 ? "Basins" : "Basin"} v={deal.basins.join(", ")} />
            <KV k={deal.formations.length > 1 ? "Formations" : "Formation"} v={deal.formations.join(", ")} />
            {/* NRA / NMA / asset type / operator already headline the hero
                stat chips — repeating them here diluted both. */}
            <KV k="Producing Status" v={deal.producingStatus ?? ""} />
            <KV k={deal.surveys.length > 1 ? "Surveys" : "Survey"} v={(deal.surveys.length ? deal.surveys : [...new Set(abstracts.map((a) => a.survey).filter(Boolean))] as string[]).join(", ")} />
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
          {/* Documents — shown only when the offering has approved documents */}
          {documents.length > 0 && (
          <div className="panel">
            <h3>Documents</h3>
            {(
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
          )}

          {/* Contact — shown when the listing has any point of contact */}
          {(org.contacts.length > 0 || mailto || org.contactPhone || org.officeLocation) && (
          <div className="panel portal-contact">
            <h3>Contact</h3>
            {org.name && <div className="portal-contact-line" style={{ marginBottom: 10 }}>{org.name}</div>}
            {org.contacts.length > 0 ? (
              <div className="portal-contact-cards">
                {org.contacts.map((c) => {
                  const cMail = c.email ? `mailto:${c.email}?subject=${mailSubject}` : null;
                  return (
                    <div key={c.id} className="portal-contact-card">
                      <div className="pcc-avatar">
                        {c.photo ? <img src={c.photo} alt={c.name} /> : <span>{c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>}
                      </div>
                      <div className="pcc-body">
                        <div><strong>{c.name}</strong>{c.isPrimary && org.contacts.length > 1 && <span className="badge" style={{ marginLeft: 6 }}>Primary</span>}</div>
                        {(c.title || c.department) && <div className="muted" style={{ fontSize: 13 }}>{[c.title, c.department].filter(Boolean).join(" · ")}</div>}
                        {c.phone && <div className="portal-contact-line"><a href={`tel:${c.phone}`}>{formatPhone(c.phone)}</a></div>}
                        {c.email && <div className="portal-contact-line"><a href={cMail ?? "#"}>{c.email}</a></div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                {org.contactPhone && <div className="portal-contact-line"><a href={`tel:${org.contactPhone}`}>{formatPhone(org.contactPhone)}</a></div>}
                {org.officeLocation && <div className="portal-contact-line muted">{org.officeLocation}</div>}
              </>
            )}
            <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: "wrap" }}>
              {mailto && <a className="btn-primary-link" href={mailto}>Contact Us</a>}
            </div>
          </div>
          )}
        </div>
      </div>

      {/* Submit an offer — a buyer can make an offer directly on this offering. */}
      <SubmitOffer slug={slug} dealName={deal.name} />

      {org.slug && (
        <p className="muted" style={{ textAlign: "center" }}>
          <Link to={`/portal/${org.slug}`}>← Browse all available opportunities</Link>
        </p>
      )}
    </PortalShell>
  );
}

// ---------------------------------------------------------------------------
// Submit an offer
// ---------------------------------------------------------------------------

function SubmitOffer({ slug, dealName }: { slug: string; dealName: string }) {
  const [f, setF] = useState({ companyName: "", contactName: "", email: "", phone: "", amount: "", conditions: "", expiresOn: "", message: "" });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const need: string[] = [];
    if (!f.companyName.trim()) need.push("Company name");
    if (!f.contactName.trim()) need.push("Contact name");
    if (!f.email.trim()) need.push("Email");
    const amount = Number(f.amount);
    if (!f.amount.trim() || !isFinite(amount) || amount <= 0) need.push("Offer amount");
    if (need.length) { setErr(`Required: ${need.join(", ")}`); return; }
    setBusy(true);
    try {
      await portalPost(`/offering/${encodeURIComponent(slug)}/offers`, {
        companyName: f.companyName, contactName: f.contactName, email: f.email, phone: f.phone,
        amount, conditions: f.conditions, expiresOn: f.expiresOn || null, message: f.message,
      });
      setDone(true);
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : "Submission failed"); }
    finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="panel portal-lead" style={{ textAlign: "center", padding: 40 }}>
        <h2 style={{ marginTop: 0 }}>Offer received — thank you.</h2>
        <p className="muted" style={{ marginBottom: 0 }}>Our team has been notified and will follow up shortly to discuss terms on <strong>{dealName}</strong>.</p>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="panel portal-lead portal-lead-cta">
        <div>
          <h3 style={{ margin: "0 0 4px" }}>Ready to make an offer on {dealName}?</h3>
          <p className="muted" style={{ margin: 0 }}>Submit your number and terms — it goes straight to our acquisition team.</p>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>Submit an Offer</button>
      </div>
    );
  }

  const star = <span style={{ color: "var(--accent)" }}>*</span>;
  return (
    <div className="panel portal-lead">
      <div className="section-head">
        <h2 style={{ margin: 0 }}>Submit an Offer</h2>
        <button className="small" onClick={() => setOpen(false)}>Close</button>
      </div>
      <p className="muted">An offer is non-binding and simply opens the conversation. Our team reviews every submission and responds promptly.</p>
      <form onSubmit={submit}>
        <div className="muted portal-lead-section">Your offer</div>
        <div className="dd-grid">
          <div className="field"><label>Offer amount {star}</label><MoneyInput value={f.amount} onChange={(v) => setF((p) => ({ ...p, amount: v }))} placeholder="e.g. 250,000" ariaLabel="Offer amount" /></div>
          <div className="field"><label>Offer expires (optional)</label><DateField value={f.expiresOn} onChange={set("expiresOn")} /></div>
          <div className="field" style={{ gridColumn: "1 / -1" }}><label>Terms / conditions (optional)</label><input value={f.conditions} onChange={(e) => set("conditions")(e.target.value)} placeholder="e.g. subject to title review; 30-day close" /></div>
        </div>
        <div className="muted portal-lead-section">Contact information</div>
        <div className="dd-grid">
          <div className="field"><label>Company name {star}</label><input value={f.companyName} onChange={(e) => set("companyName")(e.target.value)} /></div>
          <div className="field"><label>Contact name {star}</label><input value={f.contactName} onChange={(e) => set("contactName")(e.target.value)} /></div>
          <div className="field"><label>Email {star}</label><input type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} /></div>
          <div className="field"><label>Phone</label><PhoneInput value={f.phone} onChange={set("phone")} /></div>
        </div>
        <div className="field"><label>Message (optional)</label><textarea rows={3} value={f.message} onChange={(e) => set("message")(e.target.value)} placeholder="Anything our team should know about your offer" /></div>
        {err && <div className="error-text">{err}</div>}
        <button className="primary" disabled={busy} style={{ marginTop: 8 }}>{busy ? "Submitting…" : "Submit offer"}</button>
      </form>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="portal-fact"><div className="portal-fact-v">{value}</div><div className="portal-fact-l">{label}</div></div>;
}
function ProdStat({ v, l }: { v: string; l: string }) {
  return <div className="portal-prod-stat"><div className="portal-prod-v">{v}</div><div className="portal-prod-l">{l}</div></div>;
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
