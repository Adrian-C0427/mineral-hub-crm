import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { num } from "../../lib/format";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS } from "../../lib/options";
import { SearchableMultiSelect } from "../../components/SearchableMultiSelect";
import { Select } from "../../components/Select";
import { GeoFields } from "../../components/GeoFields";
import { PortalMap } from "./PortalMap";
import { PortalShell } from "./PortalOffering";
import { portalGet, portalPost, type FC, type PortalDeal, type PortalOrg } from "./portalApi";
import { MoneyInput } from "../../components/MoneyInput";
import { PhoneInput } from "../../components/PhoneInput";

const EMPTY_FC: FC = { type: "FeatureCollection", features: [] };

type SortKey = "featured" | "newest" | "nra" | "name";
type ListView = "grid" | "table";
type DockSide = "left" | "right";

// A snapshot of every filter control — persisted locally so a buyer's last
// search restores on return, and named presets can be saved/reapplied. The
// portal is unauthenticated, so this lives in the browser (per org), not on the
// server.
interface FilterSnapshot {
  q: string;
  states: string[]; counties: string[]; basins: string[]; formations: string[];
  assetTypes: string[]; operators: string[]; nraMin: string; nraMax: string; sort: SortKey;
}
interface SavedSearch { name: string; f: FilterSnapshot }
// The buyer's remembered workspace layout — list view, which side the listings
// panel is docked on, and how wide it is.
interface LayoutPrefs { view: ListView; side: DockSide; width: number }
const DEFAULT_LAYOUT: LayoutPrefs = { view: "grid", side: "left", width: 400 };
const MIN_PANEL = 300;
const MAX_PANEL = 760;

const lastKey = (org: string) => `mh-portal-filters:${org}`;
const savedKey = (org: string) => `mh-portal-saved:${org}`;
const layoutKey = (org: string) => `mh-portal-layout:${org}`;
function loadJson<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function saveJson(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage off */ } }

/**
 * Public marketplace — a premium, map-first browsing experience (Zillow-style,
 * for mineral interests). The interactive map fills the workspace; a dockable,
 * resizable listings panel (grid or table) rides alongside it, filters collapse
 * out of the way, and the buyer's view/dock/size preferences persist per org.
 */
export function PortalMarketplace() {
  const { orgSlug = "" } = useParams();
  const navigate = useNavigate();
  const [org, setOrg] = useState<PortalOrg | null>(null);
  const [deals, setDeals] = useState<PortalDeal[]>([]);
  const [features, setFeatures] = useState<FC>(EMPTY_FC);
  const [error, setError] = useState<string | null>(null);

  // Workspace layout (remembered per org).
  const [view, setView] = useState<ListView>(DEFAULT_LAYOUT.view);
  const [side, setSide] = useState<DockSide>(DEFAULT_LAYOUT.side);
  const [panelWidth, setPanelWidth] = useState<number>(DEFAULT_LAYOUT.width);
  const [showFilters, setShowFilters] = useState(false);
  const wsRef = useRef<HTMLDivElement>(null);

  const [sort, setSort] = useState<SortKey>("featured");
  const [q, setQ] = useState("");
  const [fStates, setFStates] = useState<string[]>([]);
  const [fCounties, setFCounties] = useState<string[]>([]);
  const [fBasins, setFBasins] = useState<string[]>([]);
  const [fFormations, setFFormations] = useState<string[]>([]);
  const [fAssetTypes, setFAssetTypes] = useState<string[]>([]);
  const [fOperators, setFOperators] = useState<string[]>([]);
  const [nraMin, setNraMin] = useState("");
  const [nraMax, setNraMax] = useState("");
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [presetName, setPresetName] = useState("");

  const snapshot = useMemo<FilterSnapshot>(() => ({
    q, states: fStates, counties: fCounties, basins: fBasins, formations: fFormations,
    assetTypes: fAssetTypes, operators: fOperators, nraMin, nraMax, sort,
  }), [q, fStates, fCounties, fBasins, fFormations, fAssetTypes, fOperators, nraMin, nraMax, sort]);

  function applySnapshot(f: Partial<FilterSnapshot>) {
    setQ(f.q ?? "");
    setFStates(f.states ?? []); setFCounties(f.counties ?? []); setFBasins(f.basins ?? []);
    setFFormations(f.formations ?? []); setFAssetTypes(f.assetTypes ?? []); setFOperators(f.operators ?? []);
    setNraMin(f.nraMin ?? ""); setNraMax(f.nraMax ?? ""); setSort(f.sort ?? "featured");
  }
  const activeFilterCount =
    fStates.length + fCounties.length + fBasins.length + fFormations.length +
    fAssetTypes.length + fOperators.length + (nraMin ? 1 : 0) + (nraMax ? 1 : 0);
  const hasFilters = activeFilterCount > 0 || q.trim() !== "";

  useEffect(() => {
    portalGet<{ org: PortalOrg; deals: PortalDeal[] }>(`/${encodeURIComponent(orgSlug)}`)
      .then((d) => { setOrg(d.org); setDeals(d.deals); })
      .catch((e) => setError(e.message));
    portalGet<FC>(`/${encodeURIComponent(orgSlug)}/features`).then(setFeatures).catch(() => {});
    // Restore this buyer's saved searches, last-used filters, and workspace layout.
    setSaved(loadJson<SavedSearch[]>(savedKey(orgSlug), []));
    applySnapshot(loadJson<Partial<FilterSnapshot>>(lastKey(orgSlug), {}));
    const layout = loadJson<LayoutPrefs>(layoutKey(orgSlug), DEFAULT_LAYOUT);
    setView(layout.view ?? DEFAULT_LAYOUT.view);
    setSide(layout.side ?? DEFAULT_LAYOUT.side);
    setPanelWidth(Math.min(MAX_PANEL, Math.max(MIN_PANEL, layout.width ?? DEFAULT_LAYOUT.width)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug]);

  // Persist filters + layout so a return visit restores the whole workspace.
  useEffect(() => { if (orgSlug) saveJson(lastKey(orgSlug), snapshot); }, [orgSlug, snapshot]);
  useEffect(() => { if (orgSlug) saveJson(layoutKey(orgSlug), { view, side, width: panelWidth }); }, [orgSlug, view, side, panelWidth]);

  // Drag the divider to resize the listings panel (map takes the rest).
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const r = wsRef.current?.getBoundingClientRect();
      if (!r) return;
      const raw = side === "left" ? ev.clientX - r.left : r.right - ev.clientX;
      setPanelWidth(Math.min(MAX_PANEL, Math.max(MIN_PANEL, raw)));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function saveCurrent() {
    const name = presetName.trim();
    if (!name || !hasFilters) return;
    const next = [...saved.filter((s) => s.name !== name), { name, f: snapshot }];
    setSaved(next); saveJson(savedKey(orgSlug), next); setPresetName("");
  }
  function deleteSaved(name: string) {
    const next = saved.filter((s) => s.name !== name);
    setSaved(next); saveJson(savedKey(orgSlug), next);
  }

  // Filter option lists derive from the live listings so they never dangle.
  const options = useMemo(() => {
    const uniq = (xs: string[]) => [...new Set(xs)].sort();
    return {
      counties: uniq(deals.flatMap((d) => d.counties)),
      operators: uniq(deals.map((d) => d.operator ?? "").filter(Boolean)),
    };
  }, [deals]);

  const filtered = useMemo(() => {
    const min = Number(nraMin) || 0, max = Number(nraMax) || Infinity;
    // Global search: every whitespace-separated term must appear somewhere in the
    // listing's searchable text (name, geography, operator, RRC, asset details…).
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matchesQuery = (d: PortalDeal) => {
      if (!terms.length) return true;
      const hay = [
        d.name, d.summary ?? "", d.operator ?? "", d.rrc ?? "",
        ...d.counties, ...d.states, ...d.abstractIds, ...d.basins, ...d.formations, ...d.assetTypes,
      ].join("  ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    };
    const hit = (d: PortalDeal) =>
      matchesQuery(d) &&
      (!fStates.length || d.states.some((s) => fStates.includes(s))) &&
      (!fCounties.length || d.counties.some((c) => fCounties.includes(c))) &&
      (!fBasins.length || d.basins.some((b) => fBasins.includes(b))) &&
      (!fFormations.length || d.formations.some((f) => fFormations.includes(f))) &&
      (!fAssetTypes.length || d.assetTypes.some((t) => fAssetTypes.includes(t))) &&
      (!fOperators.length || (d.operator != null && fOperators.includes(d.operator))) &&
      (d.nra == null ? min === 0 : d.nra >= min && d.nra <= max);
    const rows = deals.filter(hit);
    const cmp: Record<SortKey, (a: PortalDeal, b: PortalDeal) => number> = {
      featured: (a, b) => Number(b.featured) - Number(a.featured) || +new Date(b.listedAt) - +new Date(a.listedAt),
      newest: (a, b) => +new Date(b.listedAt) - +new Date(a.listedAt),
      nra: (a, b) => (b.nra ?? 0) - (a.nra ?? 0),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return rows.sort(cmp[sort]);
  }, [deals, q, fStates, fCounties, fBasins, fFormations, fAssetTypes, fOperators, nraMin, nraMax, sort]);

  if (error) return <PortalShell><div className="panel" style={{ textAlign: "center", padding: 48 }}><h2>Portal unavailable</h2><p className="muted">{error}</p></div></PortalShell>;

  return (
    <PortalShell org={org ?? undefined}>
      <div className="portal-hero panel mkt-hero">
        <div>
          <h1 style={{ margin: "0 0 4px" }}>Available Mineral Opportunities</h1>
          <p className="muted" style={{ margin: 0 }}>{deals.length} active offering{deals.length === 1 ? "" : "s"} · Explore on the map, then reach out — we move fast.</p>
        </div>
      </div>

      {/* Collapsible filters + workspace controls (map-first: filters stay out of the way). */}
      <div className="panel mkt-controls">
        <div className="mkt-search-row">
          <svg className="mkt-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input
            className="mkt-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search opportunities — name, county, abstract, operator, basin, formation, RRC…"
            aria-label="Search opportunities"
          />
          {q && <button type="button" className="mkt-search-clear" onClick={() => setQ("")} title="Clear search" aria-label="Clear search">×</button>}
        </div>
        <div className="mkt-controls-bar">
          <button className="small" onClick={() => setShowFilters((s) => !s)}>
            {showFilters ? "▾" : "▸"} Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          <span className="muted" style={{ fontSize: 13 }}>{filtered.length} of {deals.length} opportunities</span>
          <span className="spacer" style={{ marginLeft: "auto" }} />
          <Select value={sort} onChange={(v) => setSort(v as SortKey)} width={170} ariaLabel="Sort listings"
            options={[
              { value: "featured", label: "Featured first" },
              { value: "newest", label: "Newest" },
              { value: "nra", label: "Largest NRA" },
              { value: "name", label: "Name A–Z" },
            ]} />
          <div className="seg-control mkt-seg">
            <span className={`seg ${view === "grid" ? "active" : ""}`} onClick={() => setView("grid")}>▦ Grid</span>
            <span className={`seg ${view === "table" ? "active" : ""}`} onClick={() => setView("table")}>☰ Table</span>
          </div>
          <button className="small" title={`Dock listings ${side === "left" ? "right" : "left"}`} onClick={() => setSide((s) => (s === "left" ? "right" : "left"))}>
            {side === "left" ? "Dock listings right →" : "← Dock listings left"}
          </button>
        </div>

        {showFilters && (
          <div className="mkt-filters-body">
            {/* Saved searches — reapply a named filter set, or save the current one. */}
            <div className="portal-saved">
              <span className="muted" style={{ fontSize: 13 }}>Saved searches:</span>
              {saved.length === 0 && <span className="muted" style={{ fontSize: 13 }}>none yet</span>}
              {saved.map((s) => (
                <span key={s.name} className="portal-saved-chip">
                  <button type="button" className="portal-saved-apply" onClick={() => applySnapshot(s.f)}>{s.name}</button>
                  <button type="button" className="portal-saved-del" title="Delete" onClick={() => deleteSaved(s.name)}>×</button>
                </span>
              ))}
              <span className="spacer" />
              <input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveCurrent(); } }}
                placeholder="Name this search"
                style={{ width: 160 }}
              />
              <button type="button" className="small" disabled={!presetName.trim() || !hasFilters} onClick={saveCurrent}>Save</button>
              {hasFilters ? <button type="button" className="small" onClick={() => applySnapshot({})}>Clear</button> : null}
            </div>
            <div className="filters-grid" style={{ marginTop: 10 }}>
              {/* Same cascading geographic selector as the CRM; options scope to
                  what's actually published so nothing dangles. */}
              <GeoFields
                states={fStates} onStatesChange={setFStates}
                counties={fCounties} onCountiesChange={setFCounties}
                countyOptions={options.counties.length ? options.counties : undefined}
                labels={{ state: "State", county: "County" }}
              />
              <div className="field"><label>Basin</label><SearchableMultiSelect options={[...TEXAS_BASIN_OPTIONS]} value={fBasins} onChange={setFBasins} placeholder="Any basin" /></div>
              <div className="field"><label>Formation</label><SearchableMultiSelect options={[...TEXAS_FORMATION_OPTIONS]} value={fFormations} onChange={setFFormations} placeholder="Any formation" /></div>
              <div className="field"><label>Asset type</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={fAssetTypes} onChange={setFAssetTypes} placeholder="Any type" /></div>
              <div className="field"><label>Operator</label><SearchableMultiSelect options={options.operators} value={fOperators} onChange={setFOperators} placeholder="Any operator" /></div>
              <div className="field"><label>NRA min</label><input type="number" min="0" value={nraMin} onChange={(e) => setNraMin(e.target.value)} placeholder="0" /></div>
              <div className="field"><label>NRA max</label><input type="number" min="0" value={nraMax} onChange={(e) => setNraMax(e.target.value)} placeholder="No max" /></div>
            </div>
          </div>
        )}
      </div>

      {/* Map-first workspace: dockable, resizable listings panel + big map. */}
      <div ref={wsRef} className={`mkt-workspace side-${side}`} style={{ "--panel-w": `${panelWidth}px` } as React.CSSProperties}>
        <div className="mkt-panel">
          {filtered.length === 0 ? (
            <div className="mkt-empty">
              <p className="muted" style={{ margin: 0 }}>No opportunities match those filters — broaden them, or tell us what you're looking for below.</p>
            </div>
          ) : view === "grid" ? (
            <div className="mkt-cards">
              {filtered.map((d) => (
                <div key={d.slug} className="panel portal-card clickable" onClick={() => navigate(`/offer/${d.slug}`)}>
                  {d.featured && <span className="badge resp-offer">Featured</span>}
                  <h3 style={{ margin: "6px 0 2px" }}>{d.name}</h3>
                  <div className="muted" style={{ fontSize: 13 }}>{d.counties.map((c) => `${c} County`).join(", ")}{d.states.length ? ` · ${d.states.join(", ")}` : ""}</div>
                  <div className="portal-card-facts">
                    {d.assetCount ? <span className="badge resp-pending">Package · {d.assetCount} tract{d.assetCount > 1 ? "s" : ""}</span> : null}
                    {d.nra != null && <span><strong>{num(d.nra)}</strong> NRA</span>}
                    {d.assetTypes.length > 0 && <span>{d.assetTypes.join("/")}</span>}
                    {d.basins.length > 0 && <span>{d.basins[0]}</span>}
                    {d.operator && <span>{d.operator}</span>}
                  </div>
                  {d.summary && <p className="muted portal-card-summary">{d.summary}</p>}
                  <span className="portal-card-cta">View offering →</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="table-scroll mkt-table">
              <table className="data-table">
                <thead><tr><th>Opportunity</th><th>County</th><th>State</th><th className="right">NRA</th><th>Asset</th><th>Operator</th></tr></thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.slug} className="clickable" onClick={() => navigate(`/offer/${d.slug}`)}>
                      <td><strong>{d.name}</strong>{d.featured ? " ★" : ""}{d.assetCount ? <span className="muted" style={{ fontSize: 12 }}> · {d.assetCount} tract{d.assetCount > 1 ? "s" : ""}</span> : null}</td>
                      <td>{d.counties.join(", ")}</td>
                      <td>{d.states.join(", ")}</td>
                      <td className="right">{d.nra != null ? num(d.nra) : "—"}</td>
                      <td>{d.assetTypes.join("/") || "—"}</td>
                      <td>{d.operator ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="mkt-resize" onPointerDown={startResize} title="Drag to resize" role="separator" aria-orientation="vertical" />

        <div className="mkt-map">
          <PortalMap features={features} height="100%" onSelect={(slug) => navigate(`/offer/${slug}`)} />
        </div>
      </div>

      <LeadCapture orgSlug={orgSlug} />
    </PortalShell>
  );
}

// ---------------------------------------------------------------------------
// "Don't see an opportunity that fits your needs?" — lead capture
// ---------------------------------------------------------------------------

function LeadCapture({ orgSlug }: { orgSlug: string }) {
  const [f, setF] = useState({
    companyName: "", contactName: "", email: "", phone: "", preferredContact: "either" as "email" | "phone" | "either",
    states: [] as string[], counties: [] as string[], basins: [] as string[], formations: [] as string[], assetTypes: [] as string[],
    minAcreage: "", maxAcreage: "", minPrice: "", maxPrice: "", additionalCriteria: "",
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Required: company, contact, email, phone, and at least one state + county.
    const need: string[] = [];
    if (!f.companyName.trim()) need.push("Company name");
    if (!f.contactName.trim()) need.push("Contact name");
    if (!f.email.trim()) need.push("Email");
    if (!f.phone.trim()) need.push("Phone");
    if (!f.states.length) need.push("State(s) of interest");
    if (!f.counties.length) need.push("County(ies) of interest");
    if (need.length) { setError(`Required: ${need.join(", ")}`); return; }
    setBusy(true);
    try {
      await portalPost(`/${encodeURIComponent(orgSlug)}/leads`, {
        companyName: f.companyName, contactName: f.contactName, email: f.email, phone: f.phone,
        preferredContact: f.preferredContact,
        buyBox: {
          states: f.states, counties: f.counties, basins: f.basins, formations: f.formations, assetTypes: f.assetTypes,
          minAcreage: f.minAcreage ? Number(f.minAcreage) : null, maxAcreage: f.maxAcreage ? Number(f.maxAcreage) : null,
          minPrice: f.minPrice ? Number(f.minPrice) : null, maxPrice: f.maxPrice ? Number(f.maxPrice) : null,
        },
        additionalCriteria: f.additionalCriteria,
      });
      setDone(true);
    } catch (e2) { setError(e2 instanceof Error ? e2.message : "Submission failed"); }
    finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="panel portal-lead" style={{ textAlign: "center", padding: 40 }}>
        <h2 style={{ marginTop: 0 }}>Thank you — we've got it.</h2>
        <p className="muted" style={{ marginBottom: 0 }}>Your acquisition criteria are in front of our team. We'll reach out as soon as a matching opportunity surfaces.</p>
      </div>
    );
  }

  // Compact by default: a CTA banner; the full form opens on click.
  if (!open) {
    return (
      <div className="panel portal-lead portal-lead-cta">
        <div>
          <h3 style={{ margin: "0 0 4px" }}>Don't see an opportunity that fits your needs?</h3>
          <p className="muted" style={{ margin: 0 }}>Tell us your buy box — when a matching deal surfaces, you'll be the first call.</p>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>Submit Your Buy Box</button>
      </div>
    );
  }

  const star = <span style={{ color: "var(--accent)" }}>*</span>;
  return (
    <div className="panel portal-lead">
      <div className="section-head">
        <h2 style={{ margin: 0 }}>Tell Us What You're Looking For</h2>
        <button className="small" onClick={() => setOpen(false)}>Close</button>
      </div>
      <p className="muted">We source new mineral and royalty opportunities every week — when something matches your buy box, you'll be the first call.</p>
      <form onSubmit={submit}>
        <div className="muted portal-lead-section">Contact information</div>
        <div className="dd-grid">
          <div className="field"><label>Company name {star}</label><input value={f.companyName} onChange={(e) => set("companyName")(e.target.value)} /></div>
          <div className="field"><label>Contact name {star}</label><input value={f.contactName} onChange={(e) => set("contactName")(e.target.value)} /></div>
          <div className="field"><label>Email {star}</label><input type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} /></div>
          <div className="field"><label>Phone {star}</label><PhoneInput value={f.phone} onChange={set("phone")} /></div>
          <div className="field"><label>Preferred contact</label>
            <Select value={f.preferredContact} onChange={(v) => set("preferredContact")(v as typeof f.preferredContact)} ariaLabel="Preferred contact"
              options={[{ value: "either", label: "Either" }, { value: "email", label: "Email" }, { value: "phone", label: "Phone" }]} />
          </div>
        </div>
        <div className="muted portal-lead-section">Your buy box</div>
        <div className="dd-grid">
          <GeoFields
            states={f.states} onStatesChange={set("states")}
            counties={f.counties} onCountiesChange={set("counties")}
            labels={{ state: "States *", county: "Counties *" }}
          />
          <div className="field"><label>Basins</label><SearchableMultiSelect options={[...TEXAS_BASIN_OPTIONS]} value={f.basins} onChange={set("basins")} placeholder="Any" /></div>
          <div className="field"><label>Formations</label><SearchableMultiSelect options={[...TEXAS_FORMATION_OPTIONS]} value={f.formations} onChange={set("formations")} placeholder="Any" /></div>
          <div className="field"><label>Asset types</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={f.assetTypes} onChange={set("assetTypes")} placeholder="Any" /></div>
          <div className="field"><label>Min acreage</label><input type="number" min="0" value={f.minAcreage} onChange={(e) => set("minAcreage")(e.target.value)} /></div>
          <div className="field"><label>Max acreage</label><input type="number" min="0" value={f.maxAcreage} onChange={(e) => set("maxAcreage")(e.target.value)} /></div>
          <div className="field"><label>Min deal size</label><MoneyInput value={f.minPrice} onChange={(v) => setF((p) => ({ ...p, minPrice: v }))} ariaLabel="Minimum deal size" /></div>
          <div className="field"><label>Max deal size</label><MoneyInput value={f.maxPrice} onChange={(v) => setF((p) => ({ ...p, maxPrice: v }))} ariaLabel="Maximum deal size" /></div>
        </div>
        <div className="field">
          <label>Anything else? (NRA range, abstracts, surveys, operator or well-status preferences, notes)</label>
          <textarea rows={3} value={f.additionalCriteria} onChange={(e) => set("additionalCriteria")(e.target.value)} />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="primary" disabled={busy} style={{ marginTop: 8 }}>{busy ? "Submitting…" : "Submit my criteria"}</button>
      </form>
    </div>
  );
}
