import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { Briefcase, ChevronRight, Store, TrendingUp } from "lucide-react";
import { ResearchChoropleth, type CountyStat } from "../components/ResearchChoropleth";
import "../landing.css";

// MapLibre is heavy; the live map demos mount only when needed.
const LandingMap = lazy(() => import("./LandingMap"));

const CONTACT_EMAIL = "adrian@aamjsolutions.com";
const waitlistHref = (email: string) =>
  `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Mineral Hub — waitlist")}&body=${encodeURIComponent(
    `Please add me to the Mineral Hub waitlist.\n\nEmail: ${email || "(your email)"}\n`,
  )}`;

/* ---------------------------------------------------------------------------
 * Sample data — every interactive demo below runs on this, fully client-side.
 * The point is "use the real thing": these are the same stages, fields, and
 * math the production CRM uses, seeded with a believable Texas book.
 * ------------------------------------------------------------------------- */

type Stage = "UNDER_CONTRACT" | "PREPARING_PACKAGE" | "SENT_TO_BUYERS" | "NEGOTIATING" | "CLOSING";
const STAGES: { key: Stage; label: string }[] = [
  { key: "UNDER_CONTRACT", label: "Under Contract" },
  { key: "PREPARING_PACKAGE", label: "Preparing Package" },
  { key: "SENT_TO_BUYERS", label: "Sent to Buyers" },
  { key: "NEGOTIATING", label: "Negotiating" },
  { key: "CLOSING", label: "Closing" },
];
const STAGE_COLOR: Record<Stage, string> = {
  UNDER_CONTRACT: "#3b82f6", PREPARING_PACKAGE: "#6366f1", SENT_TO_BUYERS: "#8b5cf6",
  NEGOTIATING: "#f59e0b", CLOSING: "#22c55e",
};

interface DemoDeal { id: string; name: string; county: string; stage: Stage; nra: number; profit: number; buyer?: string; days: number }

const SEED_DEALS: DemoDeal[] = [
  { id: "d1", name: "Barnes A-537", county: "Leon", stage: "UNDER_CONTRACT", nra: 142, profit: 75000, days: 3 },
  { id: "d2", name: "Whitfield Minerals", county: "Freestone", stage: "UNDER_CONTRACT", nra: 88, profit: 41000, days: 6 },
  { id: "d3", name: "Caldwell Royalty", county: "Robertson", stage: "PREPARING_PACKAGE", nra: 210, profit: 118000, days: 4 },
  { id: "d4", name: "Hargrove NPRI", county: "Leon", stage: "SENT_TO_BUYERS", nra: 64, profit: 32000, days: 9 },
  { id: "d5", name: "Twin Oaks ORRI", county: "Midland", stage: "SENT_TO_BUYERS", nra: 175, profit: 96000, days: 11 },
  { id: "d6", name: "Prewitt Estate", county: "Freestone", stage: "NEGOTIATING", nra: 120, profit: 67000, buyer: "Basin Peak Minerals", days: 7 },
  { id: "d7", name: "Salt Creek RI", county: "Reeves", stage: "CLOSING", nra: 240, profit: 155000, buyer: "Stag Royalty Partners", days: 12 },
];

interface DemoBuyer { name: string; counties: string[]; types: string[]; minNra: number | null; closed: number }
const SAMPLE_BUYERS: DemoBuyer[] = [
  { name: "Stag Royalty Partners", counties: ["Leon", "Freestone", "Robertson"], types: ["RI", "NPRI", "MI"], minNra: 50, closed: 6 },
  { name: "Basin Peak Minerals", counties: ["Leon", "Midland", "Reeves"], types: ["RI", "ORRI"], minNra: 100, closed: 4 },
  { name: "Brazos Verde Capital", counties: ["Robertson", "Freestone"], types: ["NPRI", "MI"], minNra: null, closed: 2 },
  { name: "Llano Uplift Holdings", counties: ["Midland", "Reeves"], types: ["WI", "ORRI"], minNra: 150, closed: 3 },
  { name: "Pine Prairie Royalty", counties: ["Leon"], types: ["RI", "ORRI", "NPRI"], minNra: 25, closed: 1 },
];
const DEMO_COUNTIES = ["Leon", "Freestone", "Robertson", "Midland", "Reeves"];
const DEMO_TYPES = [
  { v: "RI", label: "Royalty Interest (RI)" },
  { v: "ORRI", label: "Overriding Royalty (ORRI)" },
  { v: "NPRI", label: "Non-Participating (NPRI)" },
  { v: "WI", label: "Working Interest (WI)" },
  { v: "MI", label: "Mineral Interest (MI)" },
];

const money = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;

/* --------------------------------- page --------------------------------- */

export function Landing() {
  const [deals, setDeals] = useState<DemoDeal[]>(SEED_DEALS);
  // Recent-activity feed for the hero dashboard; pipeline drags prepend to it.
  const [events, setEvents] = useState<{ text: string; when: string }[]>([
    { text: "Morgan emailed \"Twin Oaks ORRI\" to 4 buyers", when: "2h ago" },
    { text: "Offer received — Basin Peak Minerals · $310,000", when: "5h ago" },
    { text: "Portal lead: Riley Cole (Basin Peak Minerals)", when: "1d ago" },
  ]);
  const logMove = (deal: string, stage: string) =>
    setEvents((p) => [{ text: `You moved "${deal}" to ${stage}`, when: "just now" }, ...p].slice(0, 4));

  useEffect(() => {
    document.title = "Mineral Hub — the CRM built for mineral & royalty deals";
    const meta = document.querySelector('meta[name="description"]') ?? (() => {
      const m = document.createElement("meta"); m.setAttribute("name", "description"); document.head.appendChild(m); return m;
    })();
    meta.setAttribute("content",
      "Mineral Hub is the CRM for mineral and royalty buyers and flippers: deal pipeline, buyer matching, GIS mapping with shapefile tract import, well valuation, and a public buyer portal.");
  }, []);

  useReveal();

  return (
    <div className="lp">
      <Nav />
      <Hero deals={deals} events={events} />
      <Comparison />
      <PipelineDemo deals={deals} onChange={setDeals} onMoved={logMove} onReset={() => setDeals(SEED_DEALS)} />
      <MatchDemo />
      <MapSection />
      <ResearchDemo />
      <ValuationDemo />
      <FeatureTrio />
      <FinalCta />
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <span>© {new Date().getFullYear()} Mineral Hub</span>
          <span className="lp-footer-links">
            <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
            <Link to="/login">Sign in</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------ scaffolding ------------------------------ */

/** IO-based reveal with a scroll fallback (hidden-tab IO throttling burned us once). */
function useReveal() {
  useEffect(() => {
    const els = () => Array.from(document.querySelectorAll<HTMLElement>(".lp .rv:not(.in)"));
    const show = (el: HTMLElement) => el.classList.add("in");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { els().forEach(show); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { show(e.target as HTMLElement); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px" });
    els().forEach((el) => io.observe(el));
    const onScroll = () => els().forEach((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight - 40) show(el);
    });
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => { io.disconnect(); window.removeEventListener("scroll", onScroll); };
  }, []);
}

function WaitlistPill({ dark }: { dark?: boolean }) {
  const [email, setEmail] = useState("");
  return (
    <div className={`lp-pill ${dark ? "dark" : ""}`}>
      <input
        type="email" value={email} placeholder="you@company.com" aria-label="Work email"
        onChange={(e) => setEmail(e.target.value)}
      />
      <a className="lp-pill-btn" href={waitlistHref(email)}>Join the waitlist →</a>
    </div>
  );
}

function Nav() {
  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <nav className="lp-nav">
      <div className="lp-nav-inner">
        <a className="lp-brand" href="#top" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
          <span className="lp-mark">MH</span><span>Mineral Hub</span>
        </a>
        <div className="lp-nav-links">
          <a href="#pipeline" onClick={go("pipeline")}>Pipeline</a>
          <a href="#buyers" onClick={go("buyers")}>Buyers</a>
          <a href="#mapping" onClick={go("mapping")}>Mapping</a>
          <a href="#research" onClick={go("research")}>Research</a>
          <a href="#valuation" onClick={go("valuation")}>Valuation</a>
        </div>
        <div className="lp-nav-cta">
          <Link className="lp-signin" to="/login">Sign in</Link>
          <a className="lp-cta-pill" href={waitlistHref("")}>Join the waitlist</a>
        </div>
      </div>
    </nav>
  );
}

/* --------------------------------- hero --------------------------------- */

const TOP_BUYERS = [
  { name: "Stag Royalty Partners", volume: 468000 },
  { name: "Basin Peak Minerals", volume: 291000 },
  { name: "Llano Uplift Holdings", volume: 133000 },
];
const FOLLOW_UPS = [
  { buyer: "Basin Peak Minerals", deal: "Prewitt Estate", when: "Tomorrow" },
  { buyer: "Brazos Verde Capital", deal: "Hargrove NPRI", when: "Jul 10" },
  { buyer: "Pine Prairie Royalty", deal: "Barnes A-537", when: "Jul 14" },
];

// Navigation of the product shot — the app's real sections, neutral brand.
const SHOT_NAV: { label: string; d: string }[] = [
  { label: "Dashboard", d: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" },
  { label: "Deals", d: "M4 8h16v11H4zM9 8V5h6v3M4 13h16" },
  { label: "Pipeline", d: "M5 4v16M12 4v11M19 4v6" },
  { label: "Mineral Assets", d: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5" },
  { label: "Buyers", d: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M21 20c0-2.6-1.6-4.9-4-5.7" },
  { label: "Contacts", d: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-7 8-7s8 3 8 7" },
  { label: "Map", d: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" },
  { label: "Research", d: "M4 19h16M6 16l4-5 4 3 4-7" },
  { label: "Reports", d: "M5 20V9M12 20V4M19 20v-7" },
];

function Hero({ deals, events }: { deals: DemoDeal[]; events: { text: string; when: string }[] }) {
  const active = deals.length;
  const projected = deals.reduce((s, d) => s + d.profit, 0);
  const closing = deals.filter((d) => d.stage === "CLOSING").length;
  const byStage = STAGES.map((s) => deals.filter((d) => d.stage === s.key).length);
  const maxStage = Math.max(1, ...byStage);
  const bars = [36, 49, 41, 68, 55, 82]; // realized months (static)
  return (
    <header className="lp-hero" id="top">
      <h1 className="rv">A CRM that knows what a <em>net mineral acre</em> is</h1>
      <p className="lp-sub rv">
        The big platforms were built for software sales. Mineral Hub was built in the field —
        for buyers and flippers who live in counties, contracts, and closing timelines.
      </p>
      <div className="rv" style={{ display: "flex", justifyContent: "center", width: "100%" }}><WaitlistPill /></div>
      <div className="lp-fineprint rv">Free during beta · No card required · Founding pricing for waitlist members</div>

      {/* Dark product shot — LIVE: numbers below re-compute when you drag deals
          in the pipeline demo further down the page. */}
      <div className="lp-shot rv" aria-label="Mineral Hub dashboard preview">
        <aside className="lp-shot-side" aria-hidden="true">
          <div className="lp-shot-brand"><span className="lp-shot-mark">MH</span><span>Mineral Hub</span></div>
          <div className="lp-shot-nav">
            {SHOT_NAV.map((n, i) => (
              <div key={n.label} className={i === 0 ? "on" : ""}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={n.d} /></svg>
                <span>{n.label}</span>
              </div>
            ))}
          </div>
        </aside>
        <div className="lp-shot-main">
          <div className="lp-shot-bar">
            <span className="lp-shot-live"><span className="lp-dot" /> live demo — drag deals in the pipeline below</span>
          </div>
          <div className="lp-shot-body">
            <div className="lp-shot-title"><strong>Dashboard</strong><span>Acquisition snapshot</span></div>
            <div className="lp-shot-metrics">
              <ShotMetric label="Active Deals" value={String(active)} delta="▲14%" />
              <ShotMetric label="Projected Profit" value={money(projected)} delta="▲22%" />
              <ShotMetric label="Closed YTD" value="$892K" delta="▲9%" green />
              <ShotMetric label="In Closing" value={String(closing)} delta="▲40%" amber />
            </div>
            <div className="lp-shot-grid">
              <div className="lp-shot-card">
                <div className="lp-shot-h">
                  <span>Profit by month</span>
                  <span className="lp-shot-legend"><span><i className="g" />Realized</span><span><i className="b" />Projected</span></span>
                </div>
                <div className="lp-shot-bars">
                  {bars.map((h, i) => <div key={i} className="real" style={{ height: `${h}%` }} />)}
                  {[60, 90, 100].map((h, i) => <div key={`p${i}`} className="proj" style={{ height: `${h}%` }} />)}
                </div>
              </div>
              <div className="lp-shot-card">
                <div className="lp-shot-h"><span>Active deals by stage</span></div>
                <div className="lp-shot-stages">
                  {STAGES.map((s, i) => (
                    <div key={s.key} className="lp-shot-stagerow">
                      <span>{s.label}</span>
                      <div className="lp-shot-stage"><div style={{ width: `${(byStage[i] / maxStage) * 100}%`, background: STAGE_COLOR[s.key] }} /></div>
                      <b>{byStage[i]}</b>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {/* Second row — the rest of the real Dashboard: follow-ups, activity, top buyers */}
            <div className="lp-shot-grid three">
              <div className="lp-shot-card">
                <div className="lp-shot-h"><span>Upcoming follow-ups</span></div>
                {FOLLOW_UPS.map((f) => (
                  <div key={f.deal} className="lp-shot-row">
                    <span className="lp-shot-ell">{f.buyer} · <i>{f.deal}</i></span>
                    <span className="lp-shot-dim">{f.when}</span>
                  </div>
                ))}
              </div>
              <div className="lp-shot-card">
                <div className="lp-shot-h"><span>Recent activity</span></div>
                {events.slice(0, 3).map((e, i) => (
                  <div key={`${e.text}${i}`} className={`lp-shot-row ${e.when === "just now" ? "new" : ""}`}>
                    <span className="lp-shot-ell">{e.text}</span>
                    <span className="lp-shot-dim">{e.when}</span>
                  </div>
                ))}
              </div>
              <div className="lp-shot-card">
                <div className="lp-shot-h"><span>Top buyers YTD</span></div>
                {TOP_BUYERS.map((b, i) => (
                  <div key={b.name} className="lp-shot-row">
                    <span className="lp-shot-ell">{i + 1}. {b.name}</span>
                    <span className="lp-shot-green">{money(b.volume)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function ShotMetric({ label, value, delta, green, amber }: { label: string; value: string; delta: string; green?: boolean; amber?: boolean }) {
  return (
    <div className="lp-shot-card lp-shot-metric">
      <div className="lp-shot-label">{label}</div>
      <div className={`lp-shot-value ${green ? "green" : ""}`}>{value} <span className={amber ? "amber" : "green"}>{delta}</span></div>
    </div>
  );
}

/* ------------------------------ comparison ------------------------------ */

function Comparison() {
  return (
    <section className="lp-section">
      <div className="lp-section-head rv">
        <h2>You've been renaming CRM fields for years. Stop.</h2>
        <p>We work in oil &amp; gas. We know exactly where the big platforms break — because they broke on us first.</p>
      </div>
      <div className="lp-compare rv">
        <div className="lp-compare-col generic">
          <div className="lp-eyebrow gray">Generic CRM</div>
          <span><b className="x">✕</b>"Opportunity" pipelines you rebuild from scratch</span>
          <span><b className="x">✕</b>Your buyer list lives in someone's spreadsheet</span>
          <span><b className="x">✕</b>A deal's location is one address text box</span>
          <span><b className="x">✕</b>Valuation happens in a workbook nobody trusts</span>
        </div>
        <div className="lp-compare-col ours">
          <div className="lp-eyebrow blue">Mineral Hub</div>
          <span><b className="ck">✓</b>Mineral deal stages, ready on day one</span>
          <span><b className="ck">✓</b>Every buyer matched and ranked against every deal by their buy box</span>
          <span><b className="ck">✓</b>Every tract (imported from your shapefiles) on the live county survey map — abstracts, wells, and all</span>
          <span><b className="ck">✓</b>Decline curves, PV-10, and a defensible offer number built in</span>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------- pipeline (demo) ---------------------------- */

function PipelineDemo({ deals, onChange, onMoved, onReset }: { deals: DemoDeal[]; onChange: (d: DemoDeal[]) => void; onMoved: (deal: string, stage: string) => void; onReset: () => void }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<Stage | null>(null);

  const moveTo = (id: string, stage: Stage) => {
    const deal = deals.find((d) => d.id === id);
    if (!deal || deal.stage === stage) return;
    onChange(deals.map((d) => (d.id === id ? { ...d, stage, days: 0, buyer: stage === "CLOSING" && !d.buyer ? "Stag Royalty Partners" : d.buyer } : d)));
    onMoved(deal.name, STAGES.find((s) => s.key === stage)?.label ?? stage);
  };
  const advance = (d: DemoDeal) => {
    const i = STAGES.findIndex((s) => s.key === d.stage);
    if (i < STAGES.length - 1) moveTo(d.id, STAGES[i + 1].key);
  };

  return (
    <section className="lp-section" id="pipeline">
      <div className="lp-section-head rv">
        <div className="lp-try">TRY IT — this is the real board</div>
        <h2>Drag a deal. Watch the dashboard follow.</h2>
        <p>This is Mineral Hub's actual pipeline with sample deals. Drag cards between stages (or tap ▸) — the hero dashboard above recalculates live, exactly like the app.</p>
      </div>
      <div className="lp-panel rv">
        <div className="lp-panel-head">
          <span className="lp-panel-title">Pipeline</span>
          <button type="button" className="lp-ghost" onClick={onReset}>Reset demo</button>
        </div>
        <div className="lp-board">
          {STAGES.map((s) => (
            <div
              key={s.key}
              className={`lp-col ${over === s.key ? "over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(s.key); }}
              onDragLeave={() => setOver((o) => (o === s.key ? null : o))}
              onDrop={() => { if (dragId) moveTo(dragId, s.key); setDragId(null); setOver(null); }}
            >
              <div className="lp-col-head">
                <span className="lp-stage-dot" style={{ background: STAGE_COLOR[s.key] }} /> {s.label}
                <span className="lp-col-n">{deals.filter((d) => d.stage === s.key).length}</span>
              </div>
              {deals.filter((d) => d.stage === s.key).map((d) => (
                <div key={d.id} className="lp-card" draggable onDragStart={() => setDragId(d.id)}>
                  <div className="lp-card-top">
                    <strong>{d.name}</strong>
                    {s.key !== "CLOSING" && (
                      <button aria-label={`Advance ${d.name}`} title="Advance stage" onClick={() => advance(d)}><ChevronRight size={13} /></button>
                    )}
                  </div>
                  <div className="lp-card-meta">{d.county} Co. · {d.nra} NRA</div>
                  <div className="lp-card-meta lp-card-split"><span className="lp-profit">{money(d.profit)}</span><span>{d.days}d in stage</span></div>
                  {d.buyer && <div className="lp-card-buyer">→ {d.buyer}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------- buyer match (demo) --------------------------- */

function MatchDemo() {
  const [county, setCounty] = useState("Leon");
  const [type, setType] = useState("RI");
  const [nra, setNra] = useState(142);
  const [contacted, setContacted] = useState<Set<string>>(new Set());

  const ranked = useMemo(() => {
    return SAMPLE_BUYERS.map((b) => {
      const crit = [
        { label: "County", hit: b.counties.includes(county) },
        { label: "Asset type", hit: b.types.includes(type) },
        { label: "Min size", hit: b.minNra == null || nra >= b.minNra },
      ];
      const hits = crit.filter((c) => c.hit).length;
      return { b, crit, pct: Math.round((hits / crit.length) * 100) };
    }).sort((a, z) => z.pct - a.pct || z.b.closed - a.b.closed);
  }, [county, type, nra]);

  return (
    <section className="lp-section alt" id="buyers">
      <div className="lp-section-head rv">
        <div className="lp-try">TRY IT — real matching math</div>
        <h2>Describe the deal. Get your buyer list, ranked.</h2>
        <p>Every buyer carries a buy box — counties, asset types, minimum size. Change the deal below and the match scores re-rank instantly, exactly as they do on a live deal page.</p>
      </div>
      <div className="lp-panel lp-match rv">
        <div className="lp-match-form">
          <div className="lp-field">
            <span className="lp-field-l">Deal characteristics</span>
          </div>
          <div className="lp-field">
            <label>County</label>
            <div className="lp-chips">{DEMO_COUNTIES.map((c) => (
              <button key={c} className={c === county ? "on" : ""} onClick={() => setCounty(c)}>{c}</button>
            ))}</div>
          </div>
          <div className="lp-field">
            <label>Asset type</label>
            <div className="lp-chips">{DEMO_TYPES.map((t) => (
              <button key={t.v} className={t.v === type ? "on" : ""} title={t.label} onClick={() => setType(t.v)}>{t.v}</button>
            ))}</div>
          </div>
          <div className="lp-field">
            <label className="lp-field-row"><span>Size</span><b>{nra} NRA</b></label>
            <input type="range" min={10} max={300} value={nra} onChange={(e) => setNra(Number(e.target.value))} aria-label="Size in NRA" />
          </div>
        </div>
        <div className="lp-match-list">
          <div className="lp-panel-head">
            <span className="lp-panel-title">Buyer matches <span className="lp-dim">· {ranked.length} ranked</span></span>
            <span className="lp-panel-note">Sorted by match score</span>
          </div>
          {ranked.map(({ b, crit, pct }, i) => (
            <div key={b.name} className="lp-match-row">
              <span className="lp-rank">#{i + 1}</span>
              <span className={`lp-ring ${pct === 100 ? "full" : pct >= 60 ? "mid" : "low"}`} style={{ "--p": pct } as CSSProperties} aria-label={`${pct}% match`}>
                <span>{pct}</span>
              </span>
              <div className="lp-match-main">
                <div className="lp-match-name">{b.name} <span className="lp-closed">· {b.closed} closed together</span></div>
                <div className="lp-tags">{crit.map((c) => (
                  <span key={c.label} className={c.hit ? "hit" : "miss"}>{c.hit ? "✓" : "✕"} {c.label}</span>
                ))}</div>
              </div>
              <button
                className={`lp-log ${contacted.has(b.name) ? "done" : ""}`}
                onClick={() => setContacted((p) => new Set(p).add(b.name))}
              >
                {contacted.has(b.name) ? "✓ Contacted" : "Log contact"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------- research (demo) ----------------------------- */

interface CountyRow { county: string; tx: number; prev: number; hotspot?: boolean }
const RESEARCH_ROWS: CountyRow[] = [
  { county: "Leon", tx: 412, prev: 268, hotspot: true },
  { county: "Freestone", tx: 366, prev: 301 },
  { county: "Robertson", tx: 254, prev: 259 },
  { county: "Midland", tx: 838, prev: 790 },
  { county: "Reeves", tx: 761, prev: 502, hotspot: true },
  { county: "Martin", tx: 495, prev: 462 },
  { county: "Howard", tx: 441, prev: 517 },
  { county: "Loving", tx: 233, prev: 148 },
  { county: "Karnes", tx: 322, prev: 356 },
  { county: "Webb", tx: 289, prev: 244 },
  { county: "Panola", tx: 176, prev: 118 },
  { county: "Upton", tx: 208, prev: 0 },
];

function ResearchDemo() {
  const [metric, setMetric] = useState<"activity" | "change">("activity");
  const [selected, setSelected] = useState<string[]>(["Leon"]);

  const stats: CountyStat[] = useMemo(() => RESEARCH_ROWS.map((r) => ({
    county: r.county,
    total: r.tx,
    pctChange: r.prev === 0 ? null : (r.tx - r.prev) / r.prev,
    isHotspot: !!r.hotspot,
  })), []);

  const ranked = useMemo(() => [...RESEARCH_ROWS].sort((a, b) =>
    metric === "activity"
      ? b.tx - a.tx
      : ((b.prev ? (b.tx - b.prev) / b.prev : 9) - (a.prev ? (a.tx - a.prev) / a.prev : 9)),
  ).slice(0, 6), [metric]);

  const toggle = (county: string) =>
    setSelected((p) => (p.includes(county) ? p.filter((c) => c !== county) : [...p, county]));

  return (
    <section className="lp-section" id="research">
      <div className="lp-section-head rv">
        <div className="lp-try">TRY IT — the actual Research module</div>
        <h2>See where the market is moving before you drive there.</h2>
        <p>County recording indexes, lease assignments, and permits roll up into an activity map with hotspot detection. This is the real choropleth from the app, on sample data — switch metrics, hover any county, click to select.</p>
      </div>
      <div className="lp-panel rv">
        <div className="lp-panel-head">
          <span className="lp-panel-title">Research</span>
          <div className="lp-seg" role="tablist" aria-label="Metric">
            <button role="tab" aria-selected={metric === "activity"} className={metric === "activity" ? "on" : ""} onClick={() => setMetric("activity")}>Activity volume</button>
            <button role="tab" aria-selected={metric === "change"} className={metric === "change" ? "on" : ""} onClick={() => setMetric("change")}>Momentum vs prior period</button>
          </div>
        </div>
        <div className="lp-research">
          <div className="lp-research-map">
            <ResearchChoropleth stats={stats} metric={metric} selected={selected} onSelect={toggle} />
            <div className="lp-legend">
              <span><i className="sw blue" /> more activity</span>
              <span><i className="sw green" /> accelerating</span>
              <span><i className="sw red-o" /> hotspot</span>
              <span><i className="sw sel" /> selected</span>
            </div>
          </div>
          <div className="lp-research-rank">
            <div className="lp-rank-h">{metric === "activity" ? "Most active counties" : "Fastest-moving counties"}</div>
            <div className="lp-rank-cols" aria-hidden="true"><span>#</span><span>County</span><span>Records</span><span>vs prior</span></div>
            {ranked.map((r, i) => {
              const pct = r.prev ? Math.round(((r.tx - r.prev) / r.prev) * 100) : null;
              return (
                <button key={r.county} className={`lp-rank-row ${selected.includes(r.county) ? "sel" : ""}`} onClick={() => toggle(r.county)}>
                  <span className="lp-rank">#{i + 1}</span>
                  <span className="lp-rank-name">{r.county}{r.hotspot && <em> hotspot</em>}</span>
                  <span className="lp-rank-val">{r.tx.toLocaleString()} rec.</span>
                  <span className={`lp-rank-pct ${pct == null || pct >= 0 ? "up" : "down"}`}>
                    {pct == null ? "new" : `${pct >= 0 ? "+" : ""}${pct}%`}
                  </span>
                </button>
              );
            })}
            <p className="lp-rank-note">Clicked counties highlight on the map — in the app this filters records, top buyers, and opportunity scores to your selection.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------- GIS map -------------------------------- */

function MapSection() {
  const [on, setOn] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (on) return;
    const near = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r && r.top < window.innerHeight + 400) setOn(true);
    };
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) setOn(true); }, { rootMargin: "400px" });
    if (ref.current) io.observe(ref.current);
    window.addEventListener("scroll", near, { passive: true });
    near();
    return () => { io.disconnect(); window.removeEventListener("scroll", near); };
  }, [on]);
  return (
    <section className="lp-section" id="mapping">
      <div className="lp-section-head rv">
        <div className="lp-try">LIVE — real public cadastral data, not a screenshot</div>
        <h2>Your deals on the actual survey grid.</h2>
        <p>Abstracts, surveys, wells, and horizontal laterals — the same layer stack your team gets on day one. Zoom into Leon County and click anything.</p>
      </div>
      <div className="lp-panel lp-mapwrap rv" ref={ref}>
        {on ? (
          <Suspense fallback={<div className="lp-tract-empty">Loading map…</div>}>
            <LandingMap />
          </Suspense>
        ) : (
          <div className="lp-tract-empty">Map loads as you scroll…</div>
        )}
      </div>
    </section>
  );
}

/* ---------------------------- valuation (demo) ---------------------------- */

function ValuationDemo() {
  const [qi, setQi] = useState(3200);   // bbl/month at t0 (lease level)
  const [di, setDi] = useState(58);     // % annual initial decline
  const [b, setB] = useState(1.1);      // Arps b-factor
  const [price, setPrice] = useState(72); // $/bbl

  const { pts, pv10, offer } = useMemo(() => {
    const diM = -Math.log(1 - Math.min(di, 99) / 100) / 12; // nominal monthly
    const months = 120, nri = 0.2;
    const pts: number[] = [];
    let pv = 0;
    for (let t = 0; t < months; t++) {
      const q = b === 0 ? qi * Math.exp(-diM * t) : qi / Math.pow(1 + b * diM * t, 1 / b);
      pts.push(q);
      pv += (q * price * nri) / Math.pow(1.1, t / 12);
    }
    return { pts, pv10: pv, offer: pv * 0.7 };
  }, [qi, di, b, price]);

  const max = Math.max(...pts);
  const path = pts.map((q, i) => `${i === 0 ? "M" : "L"}${(i / (pts.length - 1)) * 100},${40 - (q / max) * 36}`).join(" ");

  return (
    <section className="lp-section" id="valuation">
      <div className="lp-section-head rv">
        <div className="lp-try">TRY IT — the same decline math as the app</div>
        <h2>Know your number before you make the call.</h2>
        <p>Fit a decline curve to real production, forecast to economic limit, and get a defensible offer range. Drag the sliders — this is the live Arps engine at a 20% royalty, PV-10.</p>
      </div>
      <div className="lp-panel lp-val rv">
        <div className="lp-val-controls">
          <div className="lp-field"><span className="lp-field-l">Well analysis</span></div>
          <label><span>Current rate</span><b>{qi.toLocaleString()} bbl/mo</b>
            <input type="range" min={500} max={8000} step={100} value={qi} onChange={(e) => setQi(Number(e.target.value))} /></label>
          <label><span>Initial decline</span><b>{di}%/yr</b>
            <input type="range" min={10} max={90} value={di} onChange={(e) => setDi(Number(e.target.value))} /></label>
          <label><span>b-factor</span><b>{b.toFixed(1)}</b>
            <input type="range" min={0} max={2} step={0.1} value={b} onChange={(e) => setB(Number(e.target.value))} /></label>
          <label><span>Oil price</span><b>${price}/bbl</b>
            <input type="range" min={40} max={110} value={price} onChange={(e) => setPrice(Number(e.target.value))} /></label>
        </div>
        <div className="lp-val-out">
          <div className="lp-val-head">
            <span className="lp-panel-title">Forecast · 120 months</span>
            <span className="lp-val-key"><i />Arps decline</span>
          </div>
          <svg viewBox="0 0 100 42" className="lp-val-curve" preserveAspectRatio="none" aria-label="Decline curve">
            <path className="area" d={`${path} L100,42 L0,42 Z`} />
            <path className="line" d={path} />
          </svg>
          <div className="lp-val-nums">
            <div><span>PV-10 (10-yr, 20% NRI)</span><strong>{money(pv10)}</strong></div>
            <div><span>Suggested offer (70% of PV)</span><strong className="blue">{money(offer)}</strong></div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ closing bits ------------------------------ */

function FeatureTrio() {
  return (
    <section className="lp-section lp-section-trio">
      <div className="lp-trio rv">
        <div><div className="lp-ico"><Briefcase size={22} strokeWidth={1.8} /></div><h3>Built for the deal flow</h3><p>From signed PSA to funded closing — every stage, document, seller, and dollar in one place. Offers, e-mail outreach, and follow-up alerts included.</p></div>
        <div><div className="lp-ico"><Store size={22} strokeWidth={1.8} /></div><h3>Your own buyer portal</h3><p>Publish offerings to a branded public marketplace. Buyers browse, filter the map, and submit their buy box — leads land in your CRM with a notification.</p></div>
        <div><div className="lp-ico"><TrendingUp size={22} strokeWidth={1.8} /></div><h3>Profit, not activity</h3><p>Realized vs. projected profit per deal and per month, win rate, county rankings, and CSV exports. The numbers that actually matter.</p></div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="lp-final" id="waitlist">
      <h2 className="rv">The waitlist is open. The spreadsheet era is closing.</h2>
      <div className="rv" style={{ display: "flex", justifyContent: "center" }}><WaitlistPill dark /></div>
      <div className="lp-fineprint dark rv">Onboarding in small batches · Founding pricing locked for life</div>
    </section>
  );
}

export default Landing;
