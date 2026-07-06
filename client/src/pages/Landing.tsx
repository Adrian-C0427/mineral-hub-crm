import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Map as MapIcon, Layers, Users, Briefcase, Workflow, Telescope, TrendingDown, BarChart3,
  Receipt, Building2, Store, FileText, Sparkles, Mail, Calendar, Cloud, ShieldCheck,
  CheckCircle2, ChevronDown, ArrowRight, Landmark, Target, Zap,
} from "lucide-react";
import "../landing.css";

// MapLibre is heavy — the live demo map loads only when its section approaches
// the viewport, so the landing page itself stays fast.
const LandingMap = lazy(() => import("./LandingMap"));

/* ============================================================================
 * Public marketing site. Everything here is static + hand-animated (CSS/SVG),
 * except the map showcase, which embeds the real platform map. Sign-up remains
 * invite-only; every CTA routes to /login or the contact email.
 * ========================================================================== */

const CONTACT_EMAIL = "adrian@aamjsolutions.com";
const DEMO_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Mineral Hub — demo request")}&body=${encodeURIComponent("Hi — I'd like to see a live demo of Mineral Hub.\n\nCompany:\nRole:\nCounties/regions of interest:")}`;

/**
 * Adds .in to .reveal elements as they enter the viewport (once).
 * IntersectionObserver is the primary path; a passive scroll fallback covers
 * throttled/background-tab contexts where IO callbacks are deferred, so
 * content can never stay stuck invisible.
 */
function useReveal() {
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>(".reveal")];
    const mark = () => {
      for (const el of els) {
        if (!el.classList.contains("in") && el.getBoundingClientRect().top < window.innerHeight - 40) el.classList.add("in");
      }
    };
    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) { en.target.classList.add("in"); io!.unobserve(en.target); }
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
      els.forEach((e) => io!.observe(e));
    } else els.forEach((e) => e.classList.add("in"));
    mark();
    window.addEventListener("scroll", mark, { passive: true });
    return () => { io?.disconnect(); window.removeEventListener("scroll", mark); };
  }, []);
}

export function Landing() {
  useReveal();
  // SEO for the SPA shell.
  useEffect(() => {
    document.title = "Mineral Hub — The CRM built for mineral acquisitions";
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement("meta"); meta.setAttribute("name", "description"); document.head.appendChild(meta); }
    meta.setAttribute("content", "Mineral Hub is the acquisition platform for mineral & royalty companies: GIS mapping with abstracts, surveys and wells, deal pipeline, buyer matching, research, well analysis, and a public buyer offering portal — in one system.");
    return () => { document.title = "Mineral Hub"; };
  }, []);

  return (
    <div className="lp">
      <a className="lp-skip" href="#main">Skip to content</a>
      <Nav />
      <main id="main">
        <Hero />
        <Different />
        <ModuleExplorer />
        <MapShowcase />
        <Research />
        <Portal />
        <Automation />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

/* --------------------------------- Nav ---------------------------------- */

function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on(); window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={`lp-nav ${scrolled ? "scrolled" : ""}`}>
      <div className="lp-shell lp-nav-row">
        <span className="lp-logo">Mineral Hub<span className="lp-dot">.</span></span>
        <nav className="lp-nav-links" aria-label="Page sections">
          <a href="#platform">Platform</a>
          <a href="#map">GIS Map</a>
          <a href="#research">Research</a>
          <a href="#portal">Buyer Portal</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <div className="lp-nav-cta">
          <Link className="lp-btn ghost" to="/login">Log in / Sign up</Link>
          <a className="lp-btn primary" href={DEMO_MAILTO}>Request a demo</a>
        </div>
      </div>
    </header>
  );
}

/* --------------------------------- Hero --------------------------------- */

function Hero() {
  return (
    <section className="lp-hero">
      <div className="lp-hero-glow" aria-hidden />
      <div className="lp-shell lp-hero-grid">
        <div className="lp-hero-copy">
          <span className="lp-eyebrow"><Landmark size={14} aria-hidden /> Purpose-built for oil &amp; gas</span>
          <h1>The CRM built for <span className="lp-grad">mineral acquisitions</span>. Not adapted to them.</h1>
          <p className="lp-lede">
            Mineral Hub unifies the entire acquisition workflow — GIS mapping with abstracts, surveys and wells,
            deal pipeline, buyer matching, county research, well economics, and a public offering portal —
            in one platform your land team will actually live in.
          </p>
          <div className="lp-hero-ctas">
            <a className="lp-btn primary lg" href={DEMO_MAILTO}>Request a demo <ArrowRight size={16} aria-hidden /></a>
            <a className="lp-btn ghost lg" href="#platform">Explore the platform</a>
          </div>
          <ul className="lp-hero-points" aria-label="Highlights">
            <li><CheckCircle2 size={15} aria-hidden /> Abstract &amp; survey-level mapping</li>
            <li><CheckCircle2 size={15} aria-hidden /> RRC wells, permits &amp; production</li>
            <li><CheckCircle2 size={15} aria-hidden /> AI-assisted workflows</li>
          </ul>
        </div>
        <HeroMock />
      </div>
    </section>
  );
}

/** Animated product impression — pure CSS/SVG, no screenshots. */
function HeroMock() {
  return (
    <div className="lp-mock reveal" aria-hidden>
      <div className="lp-mock-chrome"><span /><span /><span /><em>app.mineralhub — Dashboard</em></div>
      <div className="lp-mock-body">
        <div className="lp-mock-side">
          {["Dashboard", "Deals", "Pipeline", "Buyers", "Map", "Research"].map((x, i) => (
            <div key={x} className={`lp-mock-nav ${i === 0 ? "on" : ""}`}>{x}</div>
          ))}
        </div>
        <div className="lp-mock-main">
          <div className="lp-mock-kpis">
            <div className="lp-kpi a1"><small>Active deals</small><strong>24</strong><i>▲ 4 this week</i></div>
            <div className="lp-kpi a2"><small>Pipeline value</small><strong>$8.4M</strong><i>3 closing</i></div>
            <div className="lp-kpi a3"><small>Buyer matches</small><strong>61</strong><i>12 engaged</i></div>
          </div>
          <div className="lp-mock-row">
            <div className="lp-mock-map">
              <svg viewBox="0 0 220 140" role="presentation">
                <rect x="0" y="0" width="220" height="140" rx="6" fill="#16202b" />
                <g stroke="#31445a" strokeWidth="1" fill="rgba(59,130,246,.10)">
                  <path d="M14 22 L86 14 L98 58 L44 74 Z" />
                  <path d="M98 58 L160 40 L196 92 L124 108 Z" className="lp-parcel" />
                  <path d="M44 74 L124 108 L96 128 L20 112 Z" />
                  <path d="M86 14 L150 8 L160 40 L98 58 Z" />
                </g>
                <path d="M124 66 C140 78, 156 82, 178 84" stroke="#0f766e" strokeWidth="2" fill="none" className="lp-lateral" />
                <g fill="#22c55e"><circle cx="124" cy="66" r="3.4" className="lp-well w1" /><circle cx="70" cy="44" r="3" className="lp-well w2" /><circle cx="150" cy="98" r="3" className="lp-well w3" /></g>
                <circle cx="60" cy="96" r="3" fill="#f59e0b" className="lp-well w2" />
                <text x="112" y="86" fontSize="7" fill="#8b98a5">A-537 · I&amp;GN RR CO</text>
              </svg>
            </div>
            <div className="lp-mock-pipe">
              {[["Under contract", 78, "#3b82f6"], ["Sent to buyers", 56, "#8b5cf6"], ["Negotiating", 34, "#f59e0b"], ["Closing", 22, "#22c55e"]].map(([label, w, c]) => (
                <div key={label as string} className="lp-pipe-row">
                  <small>{label}</small>
                  <div className="lp-pipe-bar"><span style={{ width: `${w}%`, background: c as string }} /></div>
                </div>
              ))}
              <div className="lp-mock-match"><Sparkles size={12} aria-hidden /> 94% buyer match — Permian royalty buyer</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Differentiators -------------------------- */

const DIFFS = [
  { icon: MapIcon, title: "GIS is the foundation, not a plug-in", body: "County boundaries, abstract polygons, survey names, wells and horizontal laterals stream as vector tiles from our own PostGIS cadastre. Your deals live on the land they describe." },
  { icon: Target, title: "Buyer matching that closes deals", body: "Every buyer carries a structured Buy Box — states, counties, basins, formations, asset types, price bands. New deals rank your entire buyer list by fit, instantly." },
  { icon: Telescope, title: "Research from public records", body: "Import county deed and lease indexes, layer RRC permits automatically, and see who's actually buying — then pull the most active buyers straight into your CRM." },
  { icon: TrendingDown, title: "Well economics built in", body: "Decline-curve analysis, production forecasts and offer guidance from live RRC production data — valuation happens next to the deal, not in a spreadsheet." },
  { icon: Workflow, title: "A pipeline shaped like your business", body: "Under contract → package → buyers → negotiation → closing. Stage guards, contract timelines, buyer activity logs and closing-date math match how mineral deals really move." },
  { icon: Sparkles, title: "AI where it earns its keep", body: "Claude reads legal descriptions into mapped tract polygons, drafts buyer outreach, and summarizes deals — with deterministic geometry and your data never used for training." },
] as const;

function Different() {
  return (
    <section className="lp-section" id="platform">
      <div className="lp-shell">
        <div className="lp-head reveal">
          <span className="lp-eyebrow"><Zap size={14} aria-hidden /> Why Mineral Hub</span>
          <h2>Generic CRMs track contacts.<br />Mineral Hub understands minerals.</h2>
          <p>Spreadsheets, map viewers, county websites and a contact CRM — the typical acquisition stack is five tools taped together. We built the whole workflow into one system.</p>
        </div>
        <div className="lp-grid3">
          {DIFFS.map((d, i) => (
            <article key={d.title} className="lp-card reveal" style={{ transitionDelay: `${(i % 3) * 70}ms` }}>
              <d.icon className="lp-card-icon" size={22} aria-hidden />
              <h3>{d.title}</h3>
              <p>{d.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Module explorer -------------------------- */

interface Mod {
  key: string; label: string; icon: typeof MapIcon; blurb: string;
  benefits: string[]; useCase: string; mock: ReactNode;
}

function MiniTable({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="lp-mini-table" aria-hidden>
      {rows.map((r, i) => (
        <div key={i} className="lp-mini-tr" style={{ animationDelay: `${i * 120}ms` }}>
          <span>{r[0]}</span><span>{r[1]}</span><em>{r[2]}</em>
        </div>
      ))}
    </div>
  );
}

const MODULES: Mod[] = [
  {
    key: "deals", label: "Deals & Pipeline", icon: Briefcase,
    blurb: "Every opportunity carries its geography — counties, abstracts, formations, operators — plus contract dates with automatic find-buyer-by and closing math.",
    benefits: ["Stage-aware pipeline with guards", "Contract timeline that computes deadlines", "Folder-based documents with versioning", "Buyer activity & offer history per deal"],
    useCase: "A wholesaler puts a 160-acre Leon County royalty package under contract; the deal inherits its abstracts onto the map, deadlines are derived automatically, and the team sees exactly which buyers to call first.",
    mock: <MiniTable rows={[["Hargrove Minerals", "Leon · A-537", "Closing"], ["Bell County RI", "Bell · A-112", "Negotiating"], ["Permian NRA pkg", "Midland · 4 tracts", "Sent to buyers"], ["Freestone WI", "Freestone · A-88", "Under contract"]]} />,
  },
  {
    key: "buyers", label: "Buyer Management", icon: Users,
    blurb: "A buyer database that knows what each buyer actually buys. Buy Boxes turn into ranked match recommendations on every deal.",
    benefits: ["Structured Buy Box per buyer", "Ranked match % on every deal", "Relationship status & contact cadence", "Bulk outreach with per-deal email log"],
    useCase: "A new Robertson County listing instantly surfaces the six buyers whose Buy Box covers the county and formation — two have closed with you before, and outreach goes out in one step.",
    mock: <MiniTable rows={[["Stag Royalty", "TX · Austin Chalk", "94%"], ["Basin Partners", "Permian · NRA", "88%"], ["Legacy Minerals", "East TX · WI", "81%"], ["Crown Land Co", "Statewide", "77%"]]} />,
  },
  {
    key: "assets", label: "Mineral Assets", icon: Layers,
    blurb: "Owned minerals get their own lifecycle — acquisition cost, revenue history, hold/sell mode — separate from opportunities but on the same map.",
    benefits: ["Portfolio view of owned interests", "Royalty & bonus revenue tracking", "Hold / sell workflow into the pipeline", "Same GIS footprint as deals"],
    useCase: "An investor tracks 40 owned tracts, logs monthly royalty checks, and flips an underperforming asset to SELL — it enters the marketing pipeline with its map and documents already attached.",
    mock: <MiniTable rows={[["Home Place 160", "Owned · HOLD", "$2.4k/mo"], ["Dawson NRA", "Owned · SELL", "$910/mo"], ["Grimes RI", "Owned · HOLD", "$1.1k/mo"], ["Karnes WI", "Owned · HOLD", "$3.8k/mo"]]} />,
  },
  {
    key: "research", label: "Research", icon: Telescope,
    blurb: "County recording indexes and RRC permits become market intelligence: who's buying, where activity is concentrating, and which buyers you're missing.",
    benefits: ["Deed & lease import from any county", "Permits layered in automatically", "Most-active-buyer rankings", "One-click: add buyers to your CRM"],
    useCase: "After importing six months of Leon County deeds, the team sees an out-of-state fund quietly assembling acreage — and adds them as a buyer with their county history pre-filled.",
    mock: <MiniTable rows={[["ABC Minerals LLC", "38 acquisitions", "Add ➜"], ["Lone Star Royalty", "24 acquisitions", "Add ➜"], ["Fund IV Holdings", "17 acquisitions", "Added ✓"], ["Private buyer grp", "11 acquisitions", "Add ➜"]]} />,
  },
  {
    key: "wells", label: "Well Analysis", icon: TrendingDown,
    blurb: "Live RRC production drives decline curves, EUR forecasts and offer guidance — so every bid is grounded in the rock, not a rule of thumb.",
    benefits: ["Decline-curve fits from real production", "Forecast & PV at your discount rate", "Offer price guidance per interest", "Saved analyses attached to deals"],
    useCase: "Before raising an offer, an analyst pulls the subject wells, fits the decline, and confirms the seller's 'flat forever' story is really an 18% annual decline — the bid stays disciplined.",
    mock: <DeclineMock />,
  },
  {
    key: "reports", label: "Reports & Expenses", icon: BarChart3,
    blurb: "Closed-deal economics, win rates, cycle times and company spend — exportable, branded, and always current.",
    benefits: ["Profit & win-rate reporting", "Branded PDF exports", "Expense tracking with approvals", "Org-wide audit history"],
    useCase: "Month-end takes minutes: export the closed-deal report with your logo, reconcile expenses, and show investors exactly where the margin came from.",
    mock: <BarsMock />,
  },
];

function ModuleExplorer() {
  const [active, setActive] = useState(0);
  const mod = MODULES[active];
  return (
    <section className="lp-section alt">
      <div className="lp-shell">
        <div className="lp-head reveal">
          <span className="lp-eyebrow"><Layers size={14} aria-hidden /> Inside the platform</span>
          <h2>One login. The whole acquisition desk.</h2>
        </div>
        <div className="lp-tabs reveal" role="tablist" aria-label="Platform modules">
          {MODULES.map((m, i) => (
            <button key={m.key} role="tab" aria-selected={i === active} className={`lp-tab ${i === active ? "on" : ""}`} onClick={() => setActive(i)}>
              <m.icon size={15} aria-hidden /> {m.label}
            </button>
          ))}
        </div>
        <div className="lp-explorer reveal" role="tabpanel" aria-label={mod.label}>
          <div className="lp-explorer-copy" key={mod.key}>
            <h3>{mod.label}</h3>
            <p>{mod.blurb}</p>
            <ul>{mod.benefits.map((b) => <li key={b}><CheckCircle2 size={14} aria-hidden /> {b}</li>)}</ul>
            <div className="lp-usecase"><strong>In the field:</strong> {mod.useCase}</div>
          </div>
          <div className="lp-explorer-mock" key={`${mod.key}-mock`}>{mod.mock}</div>
        </div>
      </div>
    </section>
  );
}

/** Hand-drawn decline curve (no chart lib on the landing bundle). */
function DeclineMock() {
  return (
    <svg viewBox="0 0 300 170" className="lp-chart" role="presentation">
      <g stroke="#2d3742" strokeWidth="1">{[35, 70, 105, 140].map((y) => <line key={y} x1="34" x2="290" y1={y} y2={y} />)}</g>
      <text x="8" y="38" fontSize="9" fill="#8b98a5">bbl/d</text>
      {[["'21", 50], ["'22", 110], ["'23", 170], ["'24", 230]].map(([t, x]) => <text key={t as string} x={x as number} y={162} fontSize="9" fill="#8b98a5">{t}</text>)}
      <path d="M40 40 C 90 60, 130 95, 180 112 S 260 138, 288 141" fill="none" stroke="#3b82f6" strokeWidth="2.5" className="lp-decline" />
      <path d="M180 112 S 260 138, 288 141" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeDasharray="5 4" />
      <circle cx="180" cy="112" r="4" fill="#f59e0b" />
      <text x="150" y="100" fontSize="9" fill="#f59e0b">fit: 18%/yr</text>
      <text x="222" y="126" fontSize="9" fill="#22c55e">forecast</text>
    </svg>
  );
}

function BarsMock() {
  const bars = [42, 68, 55, 88, 74, 104];
  return (
    <svg viewBox="0 0 300 170" className="lp-chart" role="presentation">
      {bars.map((h, i) => (
        <rect key={i} x={30 + i * 44} y={150 - h} width="26" height={h} rx="4" fill={i === bars.length - 1 ? "#22c55e" : "#3b82f6"} className="lp-bar" style={{ animationDelay: `${i * 90}ms` }} />
      ))}
      <line x1="20" x2="290" y1="150" y2="150" stroke="#2d3742" />
      <text x="212" y="36" fontSize="10" fill="#22c55e">▲ profit / quarter</text>
    </svg>
  );
}

/* ------------------------------ Map showcase ----------------------------- */

const MAP_CAPS = [
  "Statewide architecture", "County boundaries", "Abstract polygons", "Survey names",
  "Wells by status", "Horizontal wellbores", "Production heat maps", "Deal footprints",
  "AI tract mapping", "Search & filters",
];

function MapShowcase() {
  const holder = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  // Load the heavy map chunk as the section approaches. IO primary + scroll
  // fallback (same rationale as useReveal).
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const near = () => { if (el.getBoundingClientRect().top < window.innerHeight + 500) setShow(true); };
    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver((e) => { if (e[0].isIntersecting) { setShow(true); io!.disconnect(); } }, { rootMargin: "500px" });
      io.observe(el);
    } else setShow(true);
    near();
    window.addEventListener("scroll", near, { passive: true });
    return () => { io?.disconnect(); window.removeEventListener("scroll", near); };
  }, []);
  return (
    <section className="lp-section" id="map">
      <div className="lp-shell">
        <div className="lp-head reveal">
          <span className="lp-eyebrow"><MapIcon size={14} aria-hidden /> Enterprise GIS</span>
          <h2>Try the map. Right now, right here.</h2>
          <p>Most CRMs show you a pin on Google Maps. Mineral Hub renders the actual cadastre — abstracts, surveys, wells and laterals — as fast vector tiles from PostGIS. Below is the real thing, live.</p>
        </div>
        <div className="lp-map-caps reveal" aria-label="Mapping capabilities">
          {MAP_CAPS.map((c) => <span key={c} className="lp-chip">{c}</span>)}
        </div>
        <div ref={holder} className="lp-map-holder reveal">
          {show ? (
            <Suspense fallback={<div className="lp-map-loading">Loading live map…</div>}>
              <LandingMap />
            </Suspense>
          ) : <div className="lp-map-loading">Scroll to load the live map…</div>}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Research --------------------------------- */

function Research() {
  return (
    <section className="lp-section alt" id="research">
      <div className="lp-shell">
        <div className="lp-head reveal">
          <span className="lp-eyebrow"><Telescope size={14} aria-hidden /> Research &amp; analytics</span>
          <h2>See the market before you bid into it.</h2>
          <p>Deed and lease indexes, drilling permits, production histories and buyer activity — normalized, charted, and connected to your pipeline.</p>
        </div>
        <div className="lp-grid3">
          <div className="lp-card reveal">
            <h3>Transaction trends</h3>
            <BarsMini vals={[22, 31, 27, 44, 39, 58, 61]} color="#3b82f6" />
            <p>County-level deed &amp; lease volume over time — spot heat before it's priced in.</p>
          </div>
          <div className="lp-card reveal" style={{ transitionDelay: "70ms" }}>
            <h3>Most active buyers</h3>
            <MiniTable rows={[["ABC Minerals", "Leon + 3 co.", "38"], ["Fund IV", "Freestone", "17"], ["Lone Star", "Robertson", "12"]]} />
            <p>Grantee analysis across public records — one click adds them to your buyer list.</p>
          </div>
          <div className="lp-card reveal" style={{ transitionDelay: "140ms" }}>
            <h3>Decline &amp; ROI</h3>
            <BarsMini vals={[64, 52, 44, 39, 34, 31, 28]} color="#f59e0b" />
            <p>Production-backed decline fits, forecasts, and offer-price guidance per interest.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function BarsMini({ vals, color }: { vals: number[]; color: string }) {
  const max = Math.max(...vals);
  return (
    <svg viewBox={`0 0 ${vals.length * 30} 80`} className="lp-chart sm" role="presentation">
      {vals.map((v, i) => (
        <rect key={i} x={i * 30 + 6} y={76 - (v / max) * 68} width="16" height={(v / max) * 68} rx="3" fill={color} className="lp-bar" style={{ animationDelay: `${i * 70}ms` }} />
      ))}
    </svg>
  );
}

/* ------------------------------ Portal ----------------------------------- */

const PORTAL_STEPS = [
  { n: 1, t: "Publish", d: "Flip a deal to the portal — buyer-safe fields only, public or unlisted link." },
  { n: 2, t: "Share", d: "A branded offering page with interactive property map and approved documents." },
  { n: 3, t: "Capture", d: "Buyers submit interest and their Buy Box — acreage, counties, price bands." },
  { n: 4, t: "Convert", d: "Leads become Buyer Profiles in your CRM automatically, deduped and merged." },
];

function Portal() {
  return (
    <section className="lp-section" id="portal">
      <div className="lp-shell lp-portal-grid">
        <div className="reveal">
          <span className="lp-eyebrow"><Store size={14} aria-hidden /> Buyer Offering Portal</span>
          <h2>Your own deal marketplace, on your own URL.</h2>
          <p className="lp-lede">Stop emailing PDFs. Publish opportunities to a branded public portal where buyers browse, explore the map, download approved documents, and tell you exactly what they buy — growing your buyer network while you sleep.</p>
          <ol className="lp-steps">
            {PORTAL_STEPS.map((s) => (
              <li key={s.n} className="reveal" style={{ transitionDelay: `${s.n * 60}ms` }}>
                <span className="lp-step-n">{s.n}</span>
                <div><strong>{s.t}</strong><p>{s.d}</p></div>
              </li>
            ))}
          </ol>
        </div>
        <div className="lp-portal-mock reveal" aria-hidden>
          <div className="lp-mock-chrome"><span /><span /><span /><em>yourcompany.com/portal</em></div>
          <div className="lp-portal-hero">
            <strong>Leon County Royalty Package</strong>
            <span className="lp-badge-feat">Featured opportunity</span>
            <div className="lp-portal-facts"><span>142 NRA</span><span>Austin Chalk</span><span>Producing</span></div>
          </div>
          <svg viewBox="0 0 260 90" role="presentation" className="lp-portal-map">
            <rect width="260" height="90" rx="6" fill="#16202b" />
            <path d="M30 20 L120 12 L150 50 L70 66 Z" fill="rgba(34,197,94,.25)" stroke="#22c55e" strokeWidth="1.5" className="lp-parcel" />
            <path d="M150 50 L220 34 L240 70 L170 82 Z" fill="rgba(59,130,246,.12)" stroke="#31445a" />
            <circle cx="96" cy="38" r="3" fill="#22c55e" className="lp-well w1" />
          </svg>
          <div className="lp-portal-form">
            <div className="lp-portal-input">Tell us what you buy…</div>
            <div className="lp-btn primary sm">Submit interest</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Automation ------------------------------- */

const AUTOS = [
  { icon: Sparkles, t: "Claude AI", d: "Legal-description tract mapping, deal summaries, outreach drafts — with your own API key." },
  { icon: Mail, t: "Email", d: "Send buyer outreach from the CRM with templates and per-deal history." },
  { icon: Calendar, t: "Deadlines", d: "Contract dates compute find-buyer-by and closing timelines automatically." },
  { icon: FileText, t: "Documents", d: "Folders, versioning, buyer-visible approvals, secure cloud storage." },
  { icon: Cloud, t: "Cloud native", d: "Vector tiles, presigned downloads, and a fully hosted stack." },
  { icon: ShieldCheck, t: "Enterprise controls", d: "Role-based permissions, 2FA, audit history, owner-only administration." },
];

function Automation() {
  return (
    <section className="lp-section alt">
      <div className="lp-shell">
        <div className="lp-head reveal">
          <span className="lp-eyebrow"><Zap size={14} aria-hidden /> Automation &amp; integrations</span>
          <h2>The busywork, handled.</h2>
        </div>
        <div className="lp-grid3">
          {AUTOS.map((a, i) => (
            <article key={a.t} className="lp-card slim reveal" style={{ transitionDelay: `${(i % 3) * 70}ms` }}>
              <a.icon className="lp-card-icon" size={20} aria-hidden />
              <h3>{a.t}</h3>
              <p>{a.d}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Pricing ---------------------------------- */

// Placeholder plans — edit here; the layout adapts to any number of tiers.
const PLANS = [
  { name: "Starter", mo: 99, blurb: "For solo landmen and small shops getting organized.", cta: "Request access", feats: ["Deals, pipeline & buyers", "Interactive GIS map", "Documents & templates", "Email support"] },
  { name: "Professional", mo: 199, best: true, blurb: "For acquisition teams running serious volume.", cta: "Request a demo", feats: ["Everything in Starter", "Research & public records", "Well analysis & forecasting", "Buyer Offering Portal", "AI-assisted workflows", "Roles & permissions"] },
  { name: "Enterprise", mo: null, blurb: "For funds and operators with custom needs.", cta: "Talk to us", feats: ["Everything in Professional", "Custom data onboarding", "Priority support & training", "Security review & SSO roadmap"] },
] as const;

function Pricing() {
  const [annual, setAnnual] = useState(true);
  const price = (mo: number) => (annual ? Math.round(mo * 0.8) : mo);
  return (
    <section className="lp-section" id="pricing">
      <div className="lp-shell">
        <div className="lp-head reveal">
          <span className="lp-eyebrow"><Receipt size={14} aria-hidden /> Pricing</span>
          <h2>Simple plans. Serious tooling.</h2>
          <div className="lp-toggle" role="group" aria-label="Billing period">
            <button className={!annual ? "on" : ""} onClick={() => setAnnual(false)}>Monthly</button>
            <button className={annual ? "on" : ""} onClick={() => setAnnual(true)}>Annual <em>save 20%</em></button>
          </div>
        </div>
        <div className="lp-plans">
          {PLANS.map((p, i) => (
            <article key={p.name} className={`lp-plan reveal ${"best" in p && p.best ? "best" : ""}`} style={{ transitionDelay: `${i * 80}ms` }}>
              {"best" in p && p.best && <span className="lp-plan-flag">Most popular</span>}
              <h3>{p.name}</h3>
              <div className="lp-price">
                {p.mo == null ? <strong>Custom</strong> : <><strong>${price(p.mo)}</strong><span>/user/mo{annual ? ", billed annually" : ""}</span></>}
              </div>
              <p className="lp-plan-blurb">{p.blurb}</p>
              <ul>{p.feats.map((f) => <li key={f}><CheckCircle2 size={14} aria-hidden /> {f}</li>)}</ul>
              <a className={`lp-btn ${"best" in p && p.best ? "primary" : "ghost"} block`} href={DEMO_MAILTO}>{p.cta}</a>
            </article>
          ))}
        </div>
        <p className="lp-invite-note reveal"><ShieldCheck size={14} aria-hidden /> Mineral Hub is currently onboarding by invitation. Account creation requires an invite code from our team — <a href={DEMO_MAILTO}>request access</a>.</p>
      </div>
    </section>
  );
}

/* -------------------------------- FAQ ------------------------------------ */

const FAQS = [
  { q: "Is this just another CRM with an oil & gas skin?", a: "No. The data model is mineral-native: deals carry abstracts, surveys, counties, basins and formations; buyers carry Buy Boxes; the map is a first-class PostGIS cadastre, not an embedded widget. Generic CRMs can't rank buyers by formation or draw a tract from a deed's legal description." },
  { q: "Where does the map data come from?", a: "Public-record sources: county cadastral surveys (abstract polygons and survey names) and Texas RRC data for wells, wellbores, permits, completions and production. It's served from our own PostGIS database as fast vector tiles." },
  { q: "How does the AI work, and is my data safe?", a: "AI features run on Anthropic's Claude using your organization's own API key, stored encrypted. The model extracts and drafts; all geometry and math are computed deterministically by the platform. Your CRM data is never used to train models." },
  { q: "Can buyers see my internal numbers on the portal?", a: "No. The public portal uses a whitelist serializer — only fields you explicitly publish (and documents you individually approve) ever leave the CRM. Pricing, notes, sellers and internal activity are structurally excluded." },
  { q: "How do we get started?", a: "Request a demo and we'll provision your organization. Sign-up is invite-only right now: your team creates accounts with the invite code we issue, so access stays tightly controlled." },
] as const;

function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="lp-section alt">
      <div className="lp-shell lp-faq-shell">
        <div className="lp-head reveal"><h2>Questions, answered.</h2></div>
        {FAQS.map((f, i) => (
          <div key={f.q} className={`lp-faq reveal ${open === i ? "open" : ""}`}>
            <button className="lp-faq-q" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
              {f.q} <ChevronDown size={16} aria-hidden />
            </button>
            <div className="lp-faq-a" role="region"><p>{f.a}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------ Final CTA -------------------------------- */

function FinalCta() {
  return (
    <section className="lp-final">
      <div className="lp-shell reveal">
        <h2>Run your next acquisition on Mineral Hub.</h2>
        <p>See the platform live on your counties, your buyers, your deals — a 30-minute walkthrough is all it takes.</p>
        <div className="lp-hero-ctas center">
          <a className="lp-btn primary lg" href={DEMO_MAILTO}>Schedule a live demo <ArrowRight size={16} aria-hidden /></a>
          <Link className="lp-btn ghost lg" to="/login">Log in / Sign up</Link>
        </div>
        <p className="lp-final-note">Invite-only onboarding · No credit card required for demos</p>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="lp-footer">
      <div className="lp-shell lp-footer-row">
        <div>
          <span className="lp-logo">Mineral Hub<span className="lp-dot">.</span></span>
          <p className="lp-footer-tag">The acquisition platform for mineral &amp; royalty professionals.</p>
        </div>
        <nav aria-label="Footer">
          <a href="#platform">Platform</a>
          <a href="#map">GIS Map</a>
          <a href="#research">Research</a>
          <a href="#portal">Buyer Portal</a>
          <a href="#pricing">Pricing</a>
          <Link to="/login">Log in</Link>
          <a href={DEMO_MAILTO}>Contact</a>
        </nav>
      </div>
      <div className="lp-shell lp-footer-bottom">
        <span>© {new Date().getFullYear()} Mineral Hub. All rights reserved.</span>
        <span><Building2 size={13} aria-hidden /> Built for the oil &amp; gas industry</span>
      </div>
    </footer>
  );
}
