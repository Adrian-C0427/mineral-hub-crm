import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { API_BASE } from "../../api/client";
import { acres, fmtDate, fmtDateLocal, money, num } from "../../lib/format";
import { PortalMap, type PortalMapApi } from "./PortalMap";
import { portalGet, portalPost, visitorId, type FC, type PortalAbstract, type PortalDeal, type PortalDocument, type PortalImage, type PortalOrg, type PortalPackageAsset, type PortalProduction } from "./portalApi";
import { formatPhone } from "../../lib/phone";
import { MoneyInput } from "../../components/MoneyInput";
import { PhoneInput } from "../../components/PhoneInput";
import { DateField } from "../../components/DateField";
import { StatStrip, type StatCell } from "../../components/kit";
import { countyStateLabel, formatAbstract } from "../../lib/abstracts";
import { ASSET_TYPE_LABELS } from "../../lib/options";

const EMPTY_FC: FC = { type: "FeatureCollection", features: [] };

const typeLabel = (t: string) => (ASSET_TYPE_LABELS as Record<string, string>)[t] ?? t;
/** "Leon County, Freestone County · TX" — the location line used across the page. */
const locationOf = (d: Pick<PortalDeal, "counties" | "states">) =>
  [d.counties.map((c) => `${c} County`).join(", "), d.states.join(", ")].filter(Boolean).join(" · ");

/**
 * Public offering page — the buyer-facing view of one published deal, reached
 * via its share link (/offer/:slug). Shows only whitelisted fields, the
 * property map, approved documents, and the listing's contacts.
 */
export function PortalOffering() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<{ org: PortalOrg; deal: PortalDeal; abstracts: PortalAbstract[]; documents: PortalDocument[]; images: PortalImage[]; production: PortalProduction | null; assets: PortalPackageAsset[] } | null>(null);
  const [features, setFeatures] = useState<FC>(EMPTY_FC);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const offerRef = useRef<HTMLDivElement>(null);
  const mapApi = useRef<PortalMapApi | null>(null);

  useEffect(() => {
    portalGet<typeof data>(`/offering/${encodeURIComponent(slug)}`).then(setData).catch((e) => setError(e.message));
    portalGet<FC>(`/offering/${encodeURIComponent(slug)}/features`).then(setFeatures).catch(() => {});
  }, [slug]);

  if (error) {
    return (
      <PortalShell>
        <div className="pp-state">
          <span className="pp-state-tag">Unavailable</span>
          <h1>Offering unavailable</h1>
          <p>{error}</p>
        </div>
      </PortalShell>
    );
  }
  if (!data) return <PortalShell><p className="pp-state-loading">Loading offering…</p></PortalShell>;
  const { org, deal, abstracts, documents, images, production, assets } = data;

  const mailSubject = encodeURIComponent(`Inquiry: ${deal.name}`);
  const mailto = org.contactEmail ? `mailto:${org.contactEmail}?subject=${mailSubject}` : null;
  // No section configuration: every block renders only when it has data.
  const hasMap = features.features.length > 0;
  const location = locationOf(deal);
  const producing = deal.producingStatus === "Producing";
  const surveys = (deal.surveys.length ? deal.surveys : [...new Set(abstracts.map((a) => a.survey).filter(Boolean))] as string[]);
  const absLabel = (a: PortalAbstract) => formatAbstract({ abstract: (a.abstract ?? a.id).replace(/\?/g, ""), survey: a.survey, county: a.county, state: "TX" });
  const firstAbs = abstracts[0];
  const firstAbsNo = (firstAbs?.abstract ?? "").replace(/\?/g, "");
  const hasContact = org.contacts.length > 0 || mailto || org.contactPhone || org.officeLocation;

  function copyLink() {
    void navigator.clipboard.writeText(window.location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); });
  }
  function goOffer() {
    const el = offerRef.current; if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 90;
    window.scrollTo({ top, behavior: "smooth" });
    setHighlight(true);
    setTimeout(() => setHighlight(false), 1600);
  }

  const stats: StatCell[] = [
    ...(deal.nra != null ? [{ label: "Net royalty acres", value: acres(deal.nra) }] : []),
    ...(deal.acreageNma != null ? [{ label: "Net mineral acres", value: acres(deal.acreageNma) }] : []),
    { label: "Asking", value: deal.askPrice != null ? money(deal.askPrice) : "Make offer", tone: deal.askPrice != null ? "success" : "accent" },
    { label: "Wells", value: deal.wells.length || "—" },
    { label: "Listed", value: fmtDateLocal(deal.listedAt) },
  ];

  const facts: { k: string; v: string }[] = [
    { k: deal.states.length > 1 ? "States" : "State", v: deal.states.join(", ") },
    { k: deal.counties.length > 1 ? "Counties" : "County", v: deal.counties.join(", ") },
    { k: deal.basins.length > 1 ? "Basins" : "Basin", v: deal.basins.join(", ") },
    { k: deal.formations.length > 1 ? "Formations" : "Formation", v: deal.formations.join(", ") },
    { k: "Producing status", v: deal.producingStatus ?? "" },
    { k: surveys.length > 1 ? "Surveys" : "Survey", v: surveys.join(", ") },
    { k: "Operator", v: deal.operator ?? "" },
    { k: deal.assetTypes.length > 1 ? "Asset types" : "Asset type", v: deal.assetTypes.map(typeLabel).join(", ") },
  ].filter((f) => f.v);

  return (
    <PortalShell
      org={org}
      action={org.slug ? <Link className="pp-hdr-link" to={`/portal/${org.slug}`}>← All opportunities</Link> : undefined}
    >
      <nav className="pp-crumbs" aria-label="Breadcrumb">
        {org.slug ? <Link to={`/portal/${org.slug}`}>Marketplace</Link> : <span>Marketplace</span>}
        {location && <><span>/</span><span>{location}</span></>}
        <span>/</span><span className="pp-crumb-cur">{deal.name}</span>
      </nav>

      {/* Title block */}
      <section className="pp-titleblock">
        <div className="pp-titleblock-main">
          <div className="pp-chips">
            {deal.featured && <span className="pp-chip feat lg"><StarGlyph />Featured</span>}
            {deal.assetTypes.length > 0 && <span className="pp-chip lg">{deal.assetTypes.map(typeLabel).join(" / ")}</span>}
            {assets.length > 0 && <span className="pp-chip lg">Package · {assets.length} tract{assets.length > 1 ? "s" : ""}</span>}
            {deal.producingStatus && <span className={`pp-chip lg prod ${producing ? "on" : ""}`}><i />{deal.producingStatus}</span>}
          </div>
          <h1 className="pp-h1 xl">{deal.name}</h1>
          {location && <span className="pp-lede">{location}</span>}
        </div>
        <div className="pp-titleblock-actions">
          <button type="button" className="pp-btn lg" onClick={copyLink}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
            {copied ? "Copied ✓" : "Copy link"}
          </button>
          <button type="button" className="pp-btn lg primary" onClick={goOffer}>Make an offer</button>
        </div>
      </section>

      <StatStrip className="pp-stats" min={150} cells={stats} />

      <section className="pp-body">
        <div className="pp-body-main">
          {/* Map — shown only when the offering has mappable geometry */}
          {hasMap && (
            <div className="pp-card pp-mapcard">
              <PortalMap features={features} height={440} legendLabel="This tract" resetLabel="Recenter on tract" apiRef={mapApi} />
              {firstAbs && (
                <div className="pp-absstrip">
                  <div className="pp-absstrip-main">
                    <span className="pp-abs-badge">{firstAbsNo ? `A-${firstAbsNo}` : "A"}</span>
                    <div className="pp-absstrip-text">
                      <span className="pp-absstrip-name">{formatAbstract({ abstract: firstAbsNo || firstAbs.id, survey: firstAbs.survey })}{abstracts.length > 1 ? ` +${abstracts.length - 1} more` : ""}</span>
                      <span className="pp-absstrip-sub">{[countyStateLabel(firstAbs.county, "TX"), deal.basins.join(", ")].filter(Boolean).join(" · ")}</span>
                    </div>
                  </div>
                  <button type="button" className="pp-btn sm" onClick={() => mapApi.current?.recenter()}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
                    Locate tract
                  </button>
                </div>
              )}
            </div>
          )}

          {deal.summary && (
            <div className="pp-card pp-pad">
              <h2 className="pp-card-title">About this opportunity</h2>
              <p className="pp-about">{deal.summary}</p>
            </div>
          )}

          {/* Property details */}
          <div className="pp-card">
            <div className="pp-card-head"><h2 className="pp-card-title">Property details</h2></div>
            {facts.length > 0 && (
              <div className="pp-facts">
                {facts.map((f) => <div key={f.k} className="pp-fact"><span className="pp-fact-k">{f.k}</span><span className="pp-fact-v">{f.v}</span></div>)}
              </div>
            )}
            {abstracts.length > 0 && (
              <div className="pp-chipgroup">
                <span className="pp-chipgroup-l">Abstracts</span>
                <div className="pp-chiplist">{abstracts.map((a) => <span key={a.id} className="pp-tag">{absLabel(a)}</span>)}</div>
              </div>
            )}
            {deal.wells.length > 0 && (
              <div className="pp-chipgroup">
                <span className="pp-chipgroup-l">Wells</span>
                <div className="pp-chiplist">{deal.wells.map((w) => <span key={w} className="pp-tag">{w}</span>)}</div>
              </div>
            )}
          </div>

          {/* Bundle contents: the individual tracts included in this package. */}
          {assets.length > 0 && (
            <div className="pp-card">
              <div className="pp-card-head">
                <h2 className="pp-card-title">Assets in this package</h2>
                <span className="pp-card-note">{assets.length} tract{assets.length > 1 ? "s" : ""} offered together — inquire for any or all</span>
              </div>
              <div className="pp-assets">
                {assets.map((a) => (
                  <div key={a.id} className="pp-asset">
                    <div className="pp-asset-name">{a.name}</div>
                    <div className="pp-asset-facts">
                      {a.counties.length > 0 && <span>{a.counties.join(", ")}{a.states.length ? ` · ${a.states.join(", ")}` : ""}</span>}
                      {a.nra != null && <span><strong>{acres(a.nra)}</strong> NRA</span>}
                      {a.assetTypes.length > 0 && <span>{a.assetTypes.join("/")}</span>}
                      {a.operator && <span>{a.operator}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Production summary */}
          {production && (
            <div className="pp-card">
              <div className="pp-card-head">
                <h2 className="pp-card-title">Production summary</h2>
                <span className="pp-card-note">Reported volumes across {production.wellsMatched} well{production.wellsMatched === 1 ? "" : "s"} · {production.firstMonth ?? "?"} → {production.lastMonth}</span>
              </div>
              <div className="pp-pad-x">
                <StatStrip className="pp-prod" min={150} cells={[
                  { label: "Cumulative oil (bbl)", value: num(production.cumOilBbl) },
                  { label: "Cumulative gas (mcf)", value: num(production.cumGasMcf) },
                  { label: "Cumulative BOE", value: num(production.cumBoe) },
                  { label: "Last 12mo oil (bbl)", value: num(production.last12OilBbl) },
                  { label: "Last 12mo gas (mcf)", value: num(production.last12GasMcf) },
                  { label: "Months of history", value: production.months },
                ]} />
              </div>
            </div>
          )}

          {/* Photos */}
          {images.length > 0 && (
            <div className="pp-card">
              <div className="pp-card-head"><h2 className="pp-card-title">Photos</h2><span className="pp-card-note">Click to open full size</span></div>
              <div className="pp-gallery">
                {images.map((img) => (
                  <a key={img.id} href={img.url} target="_blank" rel="noreferrer" title={img.filename}>
                    <img src={img.url} alt={img.filename} loading="lazy" />
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="pp-card">
            <div className="pp-card-head col">
              <h2 className="pp-card-title">How offers work</h2>
              <span className="pp-card-note">An offer is non-binding and simply opens the conversation.</span>
            </div>
            <div className="pp-steps">
              <Step n={1} title="Make an offer">Send your number and any terms using the offer form.</Step>
              <Step n={2} title="We review it">Our team reviews every submission and follows up to discuss terms.</Step>
              <Step n={3} title="Agree on terms">Pricing and conditions are worked out directly with our team.</Step>
            </div>
          </div>
        </div>

        <aside className="pp-aside">
          <div ref={offerRef} className={`pp-card pp-offer ${highlight ? "hl" : ""}`}>
            <SubmitOffer slug={slug} dealName={deal.name} />
          </div>

          {/* Contact — shown when the listing has any point of contact */}
          {hasContact && (
            <div className="pp-card pp-contact">
              <span className="pp-contact-l">Contact</span>
              {org.name && <span className="pp-contact-org">{org.name}</span>}
              {org.contacts.length > 0 ? (
                org.contacts.map((c) => {
                  const cMail = c.email ? `mailto:${c.email}?subject=${mailSubject}` : null;
                  return (
                    <div key={c.id} className="pp-agent">
                      <div className="pp-agent-row">
                        <span className="pp-agent-av">
                          {c.photo ? <img src={c.photo} alt={c.name} /> : c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
                        </span>
                        <div className="pp-agent-text">
                          <span className="pp-agent-name">{c.name}{c.isPrimary && org.contacts.length > 1 && <span className="pp-chip sm">Primary</span>}</span>
                          {(c.title || c.department) && <span className="pp-agent-sub">{[c.title, c.department].filter(Boolean).join(" · ")}</span>}
                        </div>
                      </div>
                      {(c.phone || c.email) && (
                        <div className="pp-agent-btns">
                          {c.phone && (
                            <a className="pp-btn" href={`tel:${c.phone}`}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></svg>
                              {formatPhone(c.phone)}
                            </a>
                          )}
                          {c.email && (
                            <a className="pp-btn" href={cMail ?? "#"} title={c.email}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18v12H3zM3 7l9 6 9-6" /></svg>
                              Email
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <>
                  {org.contactPhone && <a className="pp-contact-line" href={`tel:${org.contactPhone}`}>{formatPhone(org.contactPhone)}</a>}
                  {org.officeLocation && <span className="pp-contact-line dim">{org.officeLocation}</span>}
                </>
              )}
              {mailto && <a className="pp-btn primary block" href={mailto}>Contact Us</a>}
            </div>
          )}

          {/* Documents — shown only when the offering has approved documents */}
          {documents.length > 0 && (
            <div className="pp-card pp-docs">
              <div className="pp-card-head"><h2 className="pp-card-title">Documents</h2></div>
              <div className="pp-doclist">
                {documents.map((d) => (
                  <a
                    key={d.id}
                    className="pp-doc"
                    href={`${API_BASE}/api/portal/offering/${encodeURIComponent(slug)}/files/${d.id}/download`}
                    onClick={async (e) => {
                      e.preventDefault();
                      try {
                        const r = await fetch(`${API_BASE}/api/portal/offering/${encodeURIComponent(slug)}/files/${d.id}/download`, { headers: { "x-mh-visitor": visitorId() } });
                        const j = (await r.json()) as { url?: string; error?: string };
                        if (j.url) window.open(j.url, "_blank");
                        else alert(j.error ?? "Download unavailable");
                      } catch { alert("Download unavailable"); }
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                    <span className="pp-doc-name">{d.filename}</span>
                    <span className="pp-doc-size">{(d.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </aside>
      </section>

      {org.slug && (
        <Link className="pp-backlink" to={`/portal/${org.slug}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
          Browse all available opportunities
        </Link>
      )}
    </PortalShell>
  );
}

// ---------------------------------------------------------------------------
// Submit an offer (always open in the sticky aside)
// ---------------------------------------------------------------------------

function SubmitOffer({ slug, dealName }: { slug: string; dealName: string }) {
  const [f, setF] = useState({ companyName: "", contactName: "", email: "", phone: "", amount: "", conditions: "", expiresOn: "", message: "" });
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
    // Summary rows echo what the buyer just entered — nothing derived.
    const rows = [
      { k: "Offer", v: `$${num(Number(f.amount))}` },
      { k: "Expires", v: f.expiresOn ? fmtDate(f.expiresOn) : "No expiry" },
      { k: "Terms", v: f.conditions.trim() || "None stated" },
    ];
    return (
      <div className="pp-offer-done">
        <span className="pp-offer-check" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        </span>
        <span className="pp-offer-done-t">Offer received — thank you.</span>
        <span className="pp-offer-done-s">Our team has been notified and will follow up shortly to discuss terms on <strong>{dealName}</strong>.</span>
        <div className="pp-offer-rows">
          {rows.map((r) => <div key={r.k}><span>{r.k}</span><span>{r.v}</span></div>)}
        </div>
      </div>
    );
  }

  const star = <span className="req-star" aria-hidden="true">*</span>;
  const opt = <span className="pp-opt">(optional)</span>;
  return (
    <form onSubmit={submit}>
      <div className="pp-offer-head">
        <h2 className="pp-offer-title">Make an offer</h2>
        <p>An offer is non-binding and simply opens the conversation. Our team reviews every submission and responds promptly.</p>
      </div>
      <div className="pp-offer-body">
        <div className="field pp-amount"><label>Offer amount {star}</label><MoneyInput value={f.amount} onChange={(v) => setF((p) => ({ ...p, amount: v }))} placeholder="e.g. 250,000" ariaLabel="Offer amount" /></div>
        <div className="field"><label>Offer expires {opt}</label><DateField value={f.expiresOn} onChange={set("expiresOn")} /></div>
        <div className="field"><label>Terms / conditions {opt}</label><input value={f.conditions} onChange={(e) => set("conditions")(e.target.value)} placeholder="e.g. subject to title review; 30-day close" /></div>
        <div className="pp-offer-div" />
        <div className="pp-offer-grid">
          <div className="field"><label>Company name {star}</label><input value={f.companyName} onChange={(e) => set("companyName")(e.target.value)} /></div>
          <div className="field"><label>Contact name {star}</label><input value={f.contactName} onChange={(e) => set("contactName")(e.target.value)} /></div>
          <div className="field"><label>Email {star}</label><input type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} /></div>
          <div className="field"><label>Phone</label><PhoneInput value={f.phone} onChange={set("phone")} /></div>
        </div>
        <div className="field"><label>Message {opt}</label><textarea rows={3} value={f.message} onChange={(e) => set("message")(e.target.value)} placeholder="Anything our team should know about your offer" /></div>
      </div>
      <div className="pp-offer-foot">
        {err && <div className="error-text">{err}</div>}
        <button className="primary pp-offer-submit" disabled={busy}>{busy ? "Submitting…" : "Submit offer"}</button>
      </div>
    </form>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="pp-step">
      <span className="pp-step-n">{n}</span>
      <div><strong>{title}</strong><span>{children}</span></div>
    </div>
  );
}

export function StarGlyph() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /></svg>;
}

/** Shared public chrome: branded sticky header + footer, no CRM sidebar/auth. */
export function PortalShell({ org, wide, action, children }: { org?: PortalOrg; wide?: boolean; action?: ReactNode; children: React.ReactNode }) {
  const brand = org?.fullLogo
    ? <img className="pp-brand-logo" src={org.fullLogo} alt={org.name} />
    : (
      <>
        {org?.compactLogo && <img className="pp-brand-mark" src={org.compactLogo} alt="" />}
        <span className="brand pp-brand-name">{org?.name ?? <>Mineral Hub<span className="dot">.</span></>}</span>
      </>
    );
  return (
    <div className="portal-shell pp-shell">
      <header className="portal-header pp-header">
        <div className="pp-brand">
          {org?.slug ? <Link className="pp-brand-link" to={`/portal/${org.slug}`}>{brand}</Link> : <span className="pp-brand-link">{brand}</span>}
          <span className="pp-brand-div" aria-hidden="true" />
          <span className="pp-brand-sub">Mineral Opportunities</span>
        </div>
        {action}
      </header>
      <main className={`portal-main pp-main ${wide ? "pp-wide" : ""}`}>{children}</main>
      <footer className="portal-footer pp-footer">
        © {new Date().getFullYear()} {org?.name ?? "Mineral Hub"} · All information subject to verification. Nothing herein constitutes an offer to sell securities.
      </footer>
    </div>
  );
}
