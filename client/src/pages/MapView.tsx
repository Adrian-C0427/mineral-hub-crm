import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Spinner, StageBadge, PriorityBadge } from "../components/ui";
import { money, num } from "../lib/format";

interface MapDeal {
  id: string;
  abstractIds: string[];
  name: string;
  stage: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  counties: string[];
  state: string | null;
  operator: string | null;
  assetTypes: string[];
  basins: string[];
  formations: string[];
  acreageNma: number | null;
  nra: number | null;
  askPrice: number | null;
  profitEst: number | null;
  selectedBuyer: { id: string; name: string } | null;
}
interface FilterOptions { counties: string[]; basins: string[]; formations: string[]; assetTypes: string[] }
interface Selected { id: string; abstract: string; survey: string; county: string }

const ABSTRACTS_URL = "/data/leon-abstracts.geojson";
const LEON_CENTER: [number, number] = [-95.99, 31.29];
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: {
    osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const STATUS_OPTIONS = [
  ["ACTIVE", "Active deals"], ["ALL", "All linked deals"],
  ["UNDER_CONTRACT", "Under Contract"], ["PREPARING_PACKAGE", "Preparing Package"],
  ["SENT_TO_BUYERS", "Sent to Buyers"], ["NEGOTIATING", "Negotiating"],
  ["CLOSING", "Closing"], ["CLOSED", "Closed"], ["DEAD", "Dead"],
] as const;

export function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReady = useRef(false);
  const activeIds = useRef<string[]>([]);
  const selectedIdRef = useRef<string | null>(null);

  const [deals, setDeals] = useState<MapDeal[] | null>(null);
  const [options, setOptions] = useState<FilterOptions>({ counties: [], basins: [], formations: [], assetTypes: [] });
  const [filters, setFilters] = useState({ status: "ACTIVE", county: "", basin: "", formation: "", assetType: "" });
  const [selected, setSelected] = useState<Selected | null>(null);

  // Deals grouped by abstract id — recomputed whenever the fetched data changes, so
  // the panel and highlights always reflect the current underlying data.
  const dealsByAbstract = useMemo(() => {
    const m = new Map<string, MapDeal[]>();
    for (const d of deals ?? []) for (const aid of d.abstractIds) {
      const arr = m.get(aid) ?? []; arr.push(d); m.set(aid, arr);
    }
    return m;
  }, [deals]);

  // Init map once.
  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current, style: OSM_STYLE, center: LEON_CENTER, zoom: 10,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("abstracts", { type: "geojson", data: ABSTRACTS_URL, promoteId: "id" });
      map.addLayer({
        id: "abstracts-fill", type: "fill", source: "abstracts",
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false], "#f59e0b",
            ["boolean", ["feature-state", "active"], false], "#ef4444",
            "#3b82f6",
          ],
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false], 0.6,
            ["boolean", ["feature-state", "active"], false], 0.5,
            0.05,
          ],
        },
      });
      map.addLayer({
        id: "abstracts-line", type: "line", source: "abstracts",
        paint: {
          "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#b45309", "#64748b"],
          "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, 0.5],
        },
      });
      // Zoom-progressive, collision-managed labels (larger abstracts win first).
      map.addLayer({
        id: "abstracts-labels", type: "symbol", source: "abstracts", minzoom: 9,
        layout: {
          "symbol-sort-key": ["*", -1, ["get", "area"]],
          "text-field": ["step", ["zoom"], ["get", "abstract"], 12.5, ["concat", ["get", "abstract"], "\n", ["get", "survey"]]],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 13, 12, 15, 14],
          "text-max-width": 8, "text-line-height": 1.1, "text-padding": 2,
          "text-allow-overlap": false, "text-optional": true,
        },
        paint: { "text-color": "#0f172a", "text-halo-color": "#ffffff", "text-halo-width": 1.4 },
      });

      // Single click handler: toggle selection, or deselect when clicking empty map.
      map.on("click", (e) => {
        const feats = map.queryRenderedFeatures(e.point, { layers: ["abstracts-fill"] });
        if (feats.length === 0) { deselect(); return; }
        const feat = feats[0];
        const id = feat.properties?.id as string;
        if (selectedIdRef.current === id) { deselect(); return; }
        deselect();
        selectedIdRef.current = id;
        map.setFeatureState({ source: "abstracts", id }, { selected: true });
        setSelected({
          id,
          abstract: (feat.properties?.abstract as string) || id,
          survey: (feat.properties?.survey as string) || "",
          county: (feat.properties?.county as string) || "",
        });
      });
      map.on("mouseenter", "abstracts-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "abstracts-fill", () => (map.getCanvas().style.cursor = ""));

      styleReady.current = true;
      applyHighlight();
    });

    return () => { map.remove(); mapRef.current = null; styleReady.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function deselect() {
    const map = mapRef.current;
    if (map && selectedIdRef.current) {
      map.setFeatureState({ source: "abstracts", id: selectedIdRef.current }, { selected: false });
    }
    selectedIdRef.current = null;
    setSelected(null);
  }

  function applyHighlight() {
    const map = mapRef.current;
    if (!map || !styleReady.current) return;
    for (const id of activeIds.current) map.setFeatureState({ source: "abstracts", id }, { active: false });
    activeIds.current = [...dealsByAbstract.keys()];
    for (const id of activeIds.current) map.setFeatureState({ source: "abstracts", id }, { active: true });
  }

  function loadDeals() {
    const qs = new URLSearchParams();
    qs.set("status", filters.status);
    if (filters.county) qs.set("county", filters.county);
    if (filters.basin) qs.set("basin", filters.basin);
    if (filters.formation) qs.set("formation", filters.formation);
    if (filters.assetType) qs.set("assetType", filters.assetType);
    api.get<MapDeal[]>(`/map/deals?${qs.toString()}`).then(setDeals);
  }
  useEffect(loadDeals, [filters]);
  useEffect(() => { api.get<FilterOptions>("/map/filters").then(setOptions); }, []);
  useEffect(applyHighlight, [dealsByAbstract]);

  const panelDeals = selected ? dealsByAbstract.get(selected.id) ?? [] : [];
  const activeCount = deals?.length ?? 0;
  const abstractCount = dealsByAbstract.size;

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div className="row">
          <h1 style={{ marginBottom: 0 }}>Map</h1>
          <span className="muted">Leon County, TX · proof of concept</span>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12, gap: 10 }}>
        <Sel label="Status" value={filters.status} onChange={(v) => setFilters((f) => ({ ...f, status: v }))} options={STATUS_OPTIONS.map(([v, l]) => ({ v, l }))} />
        <Sel label="County" value={filters.county} onChange={(v) => setFilters((f) => ({ ...f, county: v }))} options={[{ v: "", l: "All" }, ...options.counties.map((c) => ({ v: c, l: c }))]} />
        <Sel label="Basin" value={filters.basin} onChange={(v) => setFilters((f) => ({ ...f, basin: v }))} options={[{ v: "", l: "All" }, ...options.basins.map((c) => ({ v: c, l: c }))]} />
        <Sel label="Formation" value={filters.formation} onChange={(v) => setFilters((f) => ({ ...f, formation: v }))} options={[{ v: "", l: "All" }, ...options.formations.map((c) => ({ v: c, l: c }))]} />
        <Sel label="Asset Type" value={filters.assetType} onChange={(v) => setFilters((f) => ({ ...f, assetType: v }))} options={[{ v: "", l: "All" }, ...options.assetTypes.map((c) => ({ v: c, l: c }))]} />
        <div className="spacer" />
        <span className="muted">{deals == null ? "…" : `${activeCount} deal${activeCount === 1 ? "" : "s"} · ${abstractCount} abstract${abstractCount === 1 ? "" : "s"} highlighted`}</span>
      </div>

      <div style={{ position: "relative", height: "calc(100vh - 210px)", minHeight: 460, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
        <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />
        {!deals && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}><Spinner label="Loading deals…" /></div>}

        <div style={{ position: "absolute", left: 12, bottom: 26, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
          <div className="row" style={{ gap: 8 }}><span style={{ width: 12, height: 12, background: "#ef4444", opacity: 0.7, borderRadius: 2, display: "inline-block" }} /> Active deal</div>
          <div className="row" style={{ gap: 8, marginTop: 4 }}><span style={{ width: 12, height: 12, background: "#f59e0b", opacity: 0.8, borderRadius: 2, display: "inline-block" }} /> Selected</div>
          <div className="row" style={{ gap: 8, marginTop: 4 }}><span style={{ width: 12, height: 12, background: "#3b82f6", opacity: 0.4, borderRadius: 2, display: "inline-block" }} /> Abstract boundary</div>
        </div>

        {selected && (
          <div style={{ position: "absolute", top: 12, right: 12, width: 320, maxHeight: "calc(100% - 24px)", overflowY: "auto", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow)", padding: 16 }}>
            <div className="section-head">
              <div><h3 style={{ margin: 0 }}>{selected.abstract}</h3><div className="muted" style={{ fontSize: 12 }}>{[selected.survey, selected.county ? `${selected.county} County` : ""].filter(Boolean).join(" · ")}</div></div>
              <button className="icon-btn" onClick={deselect} aria-label="Close">×</button>
            </div>
            <div className="kv" style={{ margin: "8px 0" }}><span className="k">Abstract ID</span><span className="v"><code>{selected.id}</code></span></div>
            <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 8 }}>
              {panelDeals.length} active deal{panelDeals.length === 1 ? "" : "s"}
            </div>
            {panelDeals.length === 0 ? (
              <p className="muted">No active deals in this abstract.</p>
            ) : (
              panelDeals.map((d) => (
                <div key={d.id} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <Link to={`/deals/${d.id}`} style={{ fontWeight: 600 }}>{d.name}</Link>
                    <PriorityBadge priority={d.priority} />
                  </div>
                  <div className="row" style={{ gap: 6, margin: "6px 0" }}><StageBadge stage={d.stage} />{d.selectedBuyer && <span className="muted" style={{ fontSize: 12 }}>→ {d.selectedBuyer.name}</span>}</div>
                  <div className="dd-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <KV k="County" v={d.counties.join(", ")} /><KV k="Operator" v={d.operator} />
                    <KV k="Asset Type" v={d.assetTypes.join(", ")} /><KV k="Basin" v={d.basins.join(", ")} />
                    <KV k="NMA" v={num(d.acreageNma)} /><KV k="NRA" v={num(d.nra)} />
                    <KV k="Ask" v={money(d.askPrice)} /><KV k="Profit est." v={money(d.profitEst)} />
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Sel({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <div className="field" style={{ marginBottom: 0, minWidth: 150 }}>
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </div>
  );
}
function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v || "—"}</span></div>;
}
