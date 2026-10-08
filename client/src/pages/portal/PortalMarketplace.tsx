import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { acres, money, num } from "../../lib/format";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS } from "../../lib/options";
import { SearchableMultiSelect } from "../../components/SearchableMultiSelect";
import { Select } from "../../components/Select";
import { GeoFields } from "../../components/GeoFields";
import { PortalMap } from "./PortalMap";
import { PortalShell, StarGlyph } from "./PortalOffering";
import { portalGet, portalPost, type FC, type PortalDeal, type PortalOrg } from "./portalApi";
import { MoneyInput } from "../../components/MoneyInput";
import { PhoneInput } from "../../components/PhoneInput";
import { Modal } from "../../components/ui";
import { Segmented } from "../../components/kit";

const EMPTY_FC: FC = { type: "FeatureCollection", features: [] };

const typeLabel = (t: string) => (ASSET_TYPE_LABELS as Record<string, string>)[t] ?? t;
const locOf = (d: PortalDeal) => [d.counties.join(", "), d.states.join(", ")].filter(Boolean).join(" · ");

/** Card type chip: a seller package shows "Package · n"; otherwise the asset-type
 *  codes, with the full names as the tooltip. */
function TypeChip({ d }: { d: PortalDeal }) {
  if (d.assetCount) return <span className="pp-chip">Package · {d.assetCount}</span>;
  if (!d.assetTypes.length) return null;
  return <span className="pp-chip type" title={d.assetTypes.map(typeLabel).join(" / ")}>{d.assetTypes.join(" / ")}</span>;
}

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
const DEFAULT_LAYOUT: LayoutPrefs = { view: "grid", side: "left", width: 520 };
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
  // Buy-box form ("Tell us what you're looking for") — opened from the header
  // CTA per the design; state lives here so the button can reach it.
  const [buyBoxOpen, setBuyBoxOpen] = useState(false);
  // Once sent, the buy box shows the thank-you instead of a second blank form.
  const [leadSent, setLeadSent] = useState(false);
  const openBuyBox = () => setBuyBoxOpen(true);
  // Map visibility (desktop "Hide map") and the phone list/map mode — view
  // state only, not persisted.
  const [mapOn, setMapOn] = useState(true);
  const [phoneMap, setPhoneMap] = useState(false);

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


  // One removable chip per active filter value (same state the dropdowns edit).
  const drop = (set: React.Dispatch<React.SetStateAction<string[]>>, v: string) => () => set((p) => p.filter((x) => x !== v));
  const chips: { key: string; k: string; v: string; remove: () => void }[] = [
    ...fStates.map((v) => ({ key: `st:${v}`, k: "State", v, remove: drop(setFStates, v) })),
    ...fCounties.map((v) => ({ key: `co:${v}`, k: "County", v, remove: drop(setFCounties, v) })),
    ...fBasins.map((v) => ({ key: `ba:${v}`, k: "Basin", v, remove: drop(setFBasins, v) })),
    ...fFormations.map((v) => ({ key: `fo:${v}`, k: "Formation", v, remove: drop(setFFormations, v) })),
    ...fAssetTypes.map((v) => ({ key: `ty:${v}`, k: "Type", v: typeLabel(v), remove: drop(setFAssetTypes, v) })),
    ...fOperators.map((v) => ({ key: `op:${v}`, k: "Operator", v, remove: drop(setFOperators, v) })),
    ...(nraMin ? [{ key: "nmin", k: "NRA min", v: nraMin, remove: () => setNraMin("") }] : []),
    ...(nraMax ? [{ key: "nmax", k: "NRA max", v: nraMax, remove: () => setNraMax("") }] : []),
  ];
  const open = (d: PortalDeal) => navigate(`/offer/${d.slug}`);
  const buyBoxBtn = (
    <button type="button" className="pp-btn" onClick={openBuyBox}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" /></svg>
      Submit your buy box
    </button>
  );

  if (error) {
    return (
      <PortalShell>
        <div className="pp-state">
          <span className="pp-state-tag">Unavailable</span>
          <h1>Portal unavailable</h1>
          <p>{error}</p>
        </div>
      </PortalShell>
    );
  }

  return (
    <PortalShell org={org ?? undefined} wide action={buyBoxBtn}>
      <div className="pp-titlerow">
        <div className="pp-titlerow-main">
          <h1 className="pp-h1">Marketplace</h1>
          <span className="pp-lede">Mineral &amp; royalty opportunities, sourced weekly</span>
        </div>
        {deals.length > 0 && (
          <span className="pp-live"><i aria-hidden="true" />{deals.length} live opportunit{deals.length === 1 ? "y" : "ies"}</span>
        )}
      </div>

      <section className="pp-controls">
        <div className="pp-toolbar">
          <label className="pp-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search opportunities — name, county, abstract, operator, basin, formation, RRC…"
              aria-label="Search opportunities"
            />
            {q && (
              <button type="button" className="pp-search-x" onClick={() => setQ("")} title="Clear search" aria-label="Clear search">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            )}
          </label>
          <button type="button" className={`pp-tbtn ${showFilters || activeFilterCount > 0 ? "on" : ""}`} onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
            Filters
            {activeFilterCount > 0 && <span className="pp-badge">{activeFilterCount}</span>}
          </button>
          <div className="pp-sort">
            <span className="pp-sort-l">Sort</span>
            <Select value={sort} onChange={(v) => setSort(v as SortKey)} width={160} ariaLabel="Sort listings"
              options={[
                { value: "featured", label: "Featured first" },
                { value: "newest", label: "Newest" },
                { value: "nra", label: "Largest NRA" },
                { value: "name", label: "Name A–Z" },
              ]} />
          </div>
          <Segmented<ListView>
            className="pp-seg"
            ariaLabel="Listing view"
            value={view}
            onChange={setView}
            options={[
              { value: "grid", label: <><GridIcon />Grid</> },
              { value: "table", label: <><TableIcon />Table</> },
            ]}
          />
          {mapOn && (
            <button type="button" className="pp-tbtn pp-desk" title={`Dock listings ${side === "left" ? "right" : "left"}`} onClick={() => setSide((s) => (s === "left" ? "right" : "left"))}>
              {side === "left" ? "Dock listings right →" : "← Dock listings left"}
            </button>
          )}
          <button type="button" className={`pp-tbtn pp-desk ${mapOn ? "" : "on"}`} onClick={() => setMapOn((m) => !m)} aria-pressed={!mapOn}>
            <MapIcon />{mapOn ? "Hide map" : "Show map"}
          </button>
          <button type="button" className={`pp-tbtn pp-phone ${phoneMap ? "on" : ""}`} onClick={() => setPhoneMap((m) => !m)} aria-pressed={phoneMap}>
            <MapIcon />{phoneMap ? "Show list" : "Show map"}
          </button>
        </div>

        {showFilters && (
          <div className="pp-filters">
            <div className="pp-filter-grid">
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
              <div className="field">
                <label>NRA range</label>
                <div className="pp-range">
                  <input type="number" min="0" value={nraMin} onChange={(e) => setNraMin(e.target.value)} placeholder="0" aria-label="NRA min" />
                  <span aria-hidden="true">–</span>
                  <input type="number" min="0" value={nraMax} onChange={(e) => setNraMax(e.target.value)} placeholder="No max" aria-label="NRA max" />
                </div>
              </div>
            </div>
            {/* Saved searches — reapply a named filter set, or save the current one. */}
            <div className="pp-filters-foot">
              <div className="pp-saved">
                <span className="pp-saved-l">Saved searches</span>
                {saved.length === 0 && <span className="pp-saved-none">None yet. Set filters, then save them here.</span>}
                {saved.map((s) => (
                  <span key={s.name} className="pp-saved-chip">
                    <button type="button" className="pp-saved-apply" onClick={() => applySnapshot(s.f)}>{s.name}</button>
                    <button type="button" className="pp-saved-del" title="Delete" aria-label={`Delete saved search ${s.name}`} onClick={() => deleteSaved(s.name)}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </span>
                ))}
              </div>
              <div className="pp-savebar">
                <input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveCurrent(); } }}
                  placeholder="Name this search"
                  aria-label="Name this search"
                />
                <button type="button" className="pp-btn" disabled={!presetName.trim() || !hasFilters} onClick={saveCurrent}>Save</button>
              </div>
            </div>
          </div>
        )}

        <div className="pp-results">
          <span className="pp-count"><b>{filtered.length}</b> of {deals.length} opportunities</span>
          {chips.map((c) => (
            <span key={c.key} className="pp-fchip">
              <span className="pp-fchip-k">{c.k}</span>{c.v}
              <button type="button" onClick={c.remove} aria-label={`Remove ${c.k} ${c.v}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </span>
          ))}
          {hasFilters && <button type="button" className="pp-clear" onClick={() => applySnapshot({})}>Clear all</button>}
        </div>
      </section>

      {/* Workspace: dockable, resizable listings panel + the map (hideable). */}
      <div
        ref={wsRef}
        className={`pp-ws side-${side} ${mapOn ? "with-map" : "no-map"} ${phoneMap ? "ph-map" : "ph-list"}`}
        style={{ "--panel-w": `${panelWidth}px` } as React.CSSProperties}
      >
        <div className="pp-panel">
          {filtered.length === 0 ? (
            <div className="pp-empty">
              <span className="pp-empty-t">No opportunities match these filters</span>
              <span className="pp-empty-s">Broaden them, or tell us what you're looking for.</span>
              <div className="pp-empty-btns">
                {hasFilters && <button type="button" className="pp-btn" onClick={() => applySnapshot({})}>Clear filters</button>}
                <button type="button" className="pp-btn primary" onClick={openBuyBox}>Submit your buy box</button>
              </div>
            </div>
          ) : view === "grid" ? (
            <div className="pp-cards">
              {filtered.map((d) => {
                const sub = [d.formations[0], d.operator].filter(Boolean).join(" · ");
                return (
                  <div key={d.slug} className="pp-lcard" role="link" tabIndex={0} onClick={() => open(d)}
                    onKeyDown={(e) => { if (e.key === "Enter") open(d); }}>
                    <div className="pp-lcard-top">
                      <div className="pp-chips">
                        {d.featured && <span className="pp-chip feat"><StarGlyph />Featured</span>}
                        <TypeChip d={d} />
                        {d.producingStatus && <span className={`pp-chip prod ${d.producingStatus === "Producing" ? "on" : ""}`}><i />{d.producingStatus}</span>}
                      </div>
                      <span className="pp-lcard-name">{d.name}</span>
                      <span className="pp-lcard-loc">{locOf(d)}{d.basins.length ? ` · ${d.basins[0]}` : ""}</span>
                    </div>
                    <div className="pp-lcard-stats">
                      <div><span>NRA</span><b>{d.nra != null ? acres(d.nra) : "—"}</b></div>
                      <div><span>Wells</span><b className={d.wells.length ? "" : "dim"}>{d.wells.length || "—"}</b></div>
                      <div><span>Asking</span><b className={d.askPrice != null ? "ask" : "offer"}>{d.askPrice != null ? money(d.askPrice) : "Make offer"}</b></div>
                    </div>
                    <div className="pp-lcard-foot">
                      <span className="pp-lcard-sub">{sub || "—"}</span>
                      <span className="pp-lcard-view">View
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="pp-tablecard">
              <table>
                <thead>
                  <tr><th>Opportunity</th><th>Location</th><th>Type</th><th className="right">NRA</th><th className="right">Wells</th><th className="right">Asking</th><th>Operator</th></tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.slug} onClick={() => open(d)}>
                      <td className="pp-td-name">
                        {d.featured && <span className="pp-td-star" title="Featured"><StarGlyph /></span>}
                        {d.name}
                        {d.assetCount ? <span className="pp-td-dim"> · {d.assetCount} tract{d.assetCount > 1 ? "s" : ""}</span> : null}
                      </td>
                      <td className="pp-td-dim">{locOf(d) || "—"}</td>
                      <td>{d.assetTypes.length ? <span className="pp-chip type" title={d.assetTypes.map(typeLabel).join(" / ")}>{d.assetTypes.join(" / ")}</span> : <span className="pp-td-dim">—</span>}</td>
                      <td className="right pp-td-strong">{d.nra != null ? acres(d.nra) : "—"}</td>
                      <td className="right">{d.wells.length || "—"}</td>
                      <td className="right pp-td-ask">{d.askPrice != null ? money(d.askPrice) : "—"}</td>
                      <td className="pp-td-dim">{d.operator ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {mapOn && <div className="pp-resize" onPointerDown={startResize} title="Drag to resize" role="separator" aria-orientation="vertical" />}

        <div className="pp-mapcell">
          <PortalMap features={features} height="100%" legendLabel="Opportunity" resetLabel="Fit to listings" onSelect={(slug) => navigate(`/offer/${slug}`)} />
        </div>
      </div>

      <section className="pp-cta">
        {leadSent ? (
          <div>
            <span className="pp-cta-t">Thank you — we've got it.</span>
            <span className="pp-cta-s">Your acquisition criteria are in front of our team. We'll reach out as soon as a matching opportunity surfaces.</span>
          </div>
        ) : (
          <>
            <div>
              <span className="pp-cta-t">Don't see an opportunity that fits your needs?</span>
              <span className="pp-cta-s">Tell us your buy box — when a matching deal surfaces, you'll be the first call.</span>
            </div>
            <button type="button" className="pp-btn primary lg" onClick={openBuyBox}>Submit your buy box</button>
          </>
        )}
      </section>

      {buyBoxOpen && <LeadCapture orgSlug={orgSlug} done={leadSent} onDone={() => setLeadSent(true)} onClose={() => setBuyBoxOpen(false)} />}
    </PortalShell>
  );
}

const GridIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></svg>;
const TableIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
const MapIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" /></svg>;

// ---------------------------------------------------------------------------
// "Don't see an opportunity that fits your needs?" — lead capture (buy box)
// ---------------------------------------------------------------------------

function LeadCapture({ orgSlug, done, onDone, onClose }: { orgSlug: string; done: boolean; onDone: () => void; onClose: () => void }) {
  const [f, setF] = useState({
    companyName: "", contactName: "", email: "", phone: "", preferredContact: "either" as "email" | "phone" | "either",
    states: [] as string[], counties: [] as string[], basins: [] as string[], formations: [] as string[], assetTypes: [] as string[],
    minAcreage: "", maxAcreage: "", minPrice: "", maxPrice: "", additionalCriteria: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  // Anything typed? Then a stray backdrop click / Escape won't discard it.
  const dirty = !done && Object.entries(f).some(([k, v]) => k !== "preferredContact" && (Array.isArray(v) ? v.length > 0 : v !== ""));

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
      onDone();
    } catch (e2) { setError(e2 instanceof Error ? e2.message : "Submission failed"); }
    finally { setBusy(false); }
  }

  if (done) {
    return (
      <Modal title="Tell us what you're looking for" onClose={onClose} wide footer={<button type="button" className="primary" onClick={onClose}>Back to marketplace</button>}>
        <div className="pp-lead-done">
          <span className="pp-offer-check" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          </span>
          <h2>Thank you — we've got it.</h2>
          <p>Your acquisition criteria are in front of our team. We'll reach out as soon as a matching opportunity surfaces.</p>
        </div>
      </Modal>
    );
  }

  const star = <span className="req-star" aria-hidden="true">*</span>;
  return (
    <Modal
      title="Tell us what you're looking for"
      subtitle="We source new mineral and royalty opportunities every week — when something matches your buy box, you'll be the first call."
      onClose={onClose}
      wide
      dirty={dirty}
      footer={
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" form="pp-lead-form" className="primary" disabled={busy}>{busy ? "Submitting…" : "Submit my criteria"}</button>
        </>
      }
    >
      <form id="pp-lead-form" className="pp-lead" onSubmit={submit}>
        <div className="pp-lead-sec">Contact information</div>
        <div className="pp-lead-grid">
          <div className="field"><label>Company name {star}</label><input value={f.companyName} onChange={(e) => set("companyName")(e.target.value)} /></div>
          <div className="field"><label>Contact name {star}</label><input value={f.contactName} onChange={(e) => set("contactName")(e.target.value)} /></div>
          <div className="field"><label>Email {star}</label><input type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} /></div>
          <div className="field"><label>Phone {star}</label><PhoneInput value={f.phone} onChange={set("phone")} /></div>
          <div className="field"><label>Preferred contact</label>
            <Select value={f.preferredContact} onChange={(v) => set("preferredContact")(v as typeof f.preferredContact)} ariaLabel="Preferred contact"
              options={[{ value: "either", label: "Either" }, { value: "email", label: "Email" }, { value: "phone", label: "Phone" }]} />
          </div>
        </div>
        <div className="pp-lead-sec">Your buy box</div>
        <div className="pp-lead-grid">
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
      </form>
    </Modal>
  );
}
