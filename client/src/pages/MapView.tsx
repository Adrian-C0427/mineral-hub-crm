import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { Spinner, StageBadge, PriorityBadge } from "../components/ui";
import { money, num } from "../lib/format";

interface MapDeal {
  id: string; abstractIds: string[]; name: string; stage: string;
  priority: "HIGH" | "MEDIUM" | "LOW"; counties: string[]; state: string | null;
  operator: string | null; assetTypes: string[]; basins: string[]; formations: string[];
  acreageNma: number | null; nra: number | null; askPrice: number | null;
  profitEst: number | null; selectedBuyer: { id: string; name: string } | null;
}
type FC = { type: "FeatureCollection"; features: GeoFeature[] };
type GeoFeature = { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
type SelAbstract = { kind: "abstract"; id: string; abstract: string; survey: string; county: string };
type SelPipeline = { kind: "pipeline"; operator: string; system: string; commodity: string; diameter: unknown; status: string; interstate: boolean };
type Selected = SelAbstract | SelPipeline | null;

const ABSTRACTS_URL = "/data/leon-abstracts.geojson";
const PIPELINES_URL = "/data/leon-pipelines.geojson";
const LEON_CENTER: [number, number] = [-95.99, 31.29];
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};
const STATUS_OPTIONS = [
  ["ACTIVE", "Active deals"], ["ALL", "All linked deals"], ["UNDER_CONTRACT", "Under Contract"],
  ["PREPARING_PACKAGE", "Preparing Package"], ["SENT_TO_BUYERS", "Sent to Buyers"], ["NEGOTIATING", "Negotiating"],
  ["CLOSING", "Closing"], ["CLOSED", "Closed"], ["DEAD", "Dead"],
] as const;

function bboxOf(geom: { type: string; coordinates: unknown }): [number, number, number, number] {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      const [x, y] = c as number[];
      if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

export function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReady = useRef(false);
  const activeIds = useRef<string[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const abstractsFC = useRef<FC | null>(null);

  const [deals, setDeals] = useState<MapDeal[] | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [layers, setLayers] = useState({ boundaries: true, absNums: true, surveyNames: true, deals: true, pipelines: false, wells: false });
  const layersRef = useRef(layers); layersRef.current = layers;
  const [showLayers, setShowLayers] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [fCounties, setFCounties] = useState<string[]>([]);
  const [fSurveys, setFSurveys] = useState<string[]>([]);
  const [fAbstracts, setFAbstracts] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [meta, setMeta] = useState<{ counties: string[]; surveys: string[]; abstracts: string[] }>({ counties: [], surveys: [], abstracts: [] });

  const dealsByAbstract = useMemo(() => {
    const m = new Map<string, MapDeal[]>();
    for (const d of deals ?? []) for (const aid of d.abstractIds) { const a = m.get(aid) ?? []; a.push(d); m.set(aid, a); }
    return m;
  }, [deals]);

  // Init map + load static layers once.
  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;
    const map = new maplibregl.Map({ container: mapContainer.current, style: OSM_STYLE, center: LEON_CENTER, zoom: 10, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    map.on("load", async () => {
      const [absFC, pipeFC] = await Promise.all([
        fetch(ABSTRACTS_URL).then((r) => r.json()) as Promise<FC>,
        fetch(PIPELINES_URL).then((r) => r.json()) as Promise<FC>,
      ]);
      abstractsFC.current = absFC;

      // Build filter option lists from the abstracts data.
      const surveys = [...new Set(absFC.features.map((f) => (f.properties.survey as string) || "").filter(Boolean))].sort();
      const abstracts = [...new Set(absFC.features.map((f) => (f.properties.abstract as string) || "").filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      setMeta({ counties: ["Leon"], surveys, abstracts });

      map.addSource("abstracts", { type: "geojson", data: absFC as unknown as GeoJSON.FeatureCollection, promoteId: "id" });
      map.addSource("pipelines", { type: "geojson", data: pipeFC as unknown as GeoJSON.FeatureCollection });

      map.addLayer({
        id: "abstracts-fill", type: "fill", source: "abstracts",
        paint: {
          "fill-color": ["case", ["boolean", ["feature-state", "selected"], false], "#f59e0b", ["boolean", ["feature-state", "active"], false], "#ef4444", "#3b82f6"],
          "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.6, ["boolean", ["feature-state", "active"], false], 0.5, 0.05],
        },
      });
      map.addLayer({
        id: "abstracts-line", type: "line", source: "abstracts",
        paint: { "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#b45309", "#64748b"], "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, 0.5] },
      });
      map.addLayer({
        id: "pipelines", type: "line", source: "pipelines", layout: { visibility: "none", "line-cap": "round" },
        paint: { "line-color": "#7c3aed", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 14, 2.2], "line-opacity": 0.85 },
      });
      // Two independent label layers so numbers and survey names toggle separately.
      map.addLayer({
        id: "abstracts-num", type: "symbol", source: "abstracts", minzoom: 9,
        layout: {
          "symbol-sort-key": ["*", -1, ["get", "area"]], "text-field": ["get", "abstract"],
          "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13],
          "text-padding": 2, "text-allow-overlap": false, "text-optional": true,
        },
        paint: { "text-color": "#0f172a", "text-halo-color": "#ffffff", "text-halo-width": 1.4 },
      });
      map.addLayer({
        id: "abstracts-survey", type: "symbol", source: "abstracts", minzoom: 12.5,
        layout: {
          "symbol-sort-key": ["*", -1, ["get", "area"]], "text-field": ["get", "survey"],
          "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.1],
          "text-max-width": 8, "text-padding": 2, "text-allow-overlap": false, "text-optional": true,
        },
        paint: { "text-color": "#334155", "text-halo-color": "#ffffff", "text-halo-width": 1.3 },
      });

      map.on("click", (e) => {
        // Pipelines first (thin lines): small tolerance box.
        const b = 4;
        const pipes = map.getLayoutProperty("pipelines", "visibility") === "visible"
          ? map.queryRenderedFeatures([[e.point.x - b, e.point.y - b], [e.point.x + b, e.point.y + b]], { layers: ["pipelines"] })
          : [];
        if (pipes.length) {
          const p = pipes[0].properties as Record<string, unknown>;
          deselectAbstract();
          setSelected({ kind: "pipeline", operator: (p.operator as string) || "Unknown operator", system: (p.system as string) || "", commodity: (p.commodity as string) || "", diameter: p.diameter, status: (p.status as string) || "", interstate: !!p.interstate });
          return;
        }
        const feats = map.queryRenderedFeatures(e.point, { layers: ["abstracts-fill"] });
        if (feats.length === 0) { deselectAbstract(); setSelected(null); return; }
        const feat = feats[0]; const id = feat.properties?.id as string;
        if (selectedIdRef.current === id) { deselectAbstract(); setSelected(null); return; }
        deselectAbstract();
        selectedIdRef.current = id;
        map.setFeatureState({ source: "abstracts", id }, { selected: true });
        setSelected({ kind: "abstract", id, abstract: (feat.properties?.abstract as string) || id, survey: (feat.properties?.survey as string) || "", county: (feat.properties?.county as string) || "" });
      });
      map.on("mouseenter", "abstracts-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "abstracts-fill", () => (map.getCanvas().style.cursor = ""));

      styleReady.current = true;
      applyHighlight(); applyLayerVisibility(); applyAbstractFilter();
    });

    return () => { map.remove(); mapRef.current = null; styleReady.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function deselectAbstract() {
    const map = mapRef.current;
    if (map && selectedIdRef.current) map.setFeatureState({ source: "abstracts", id: selectedIdRef.current }, { selected: false });
    selectedIdRef.current = null;
  }

  function selectAbstractById(id: string) {
    const map = mapRef.current; const fc = abstractsFC.current;
    if (!map || !fc) return;
    const feat = fc.features.find((f) => f.properties.id === id);
    if (!feat) return;
    deselectAbstract();
    selectedIdRef.current = id;
    map.setFeatureState({ source: "abstracts", id }, { selected: true });
    setSelected({ kind: "abstract", id, abstract: (feat.properties.abstract as string) || id, survey: (feat.properties.survey as string) || "", county: (feat.properties.county as string) || "" });
    const [minX, minY, maxX, maxY] = bboxOf(feat.geometry);
    map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 80, maxZoom: 14, duration: 800 });
  }

  function applyHighlight() {
    const map = mapRef.current;
    if (!map || !styleReady.current) return;
    for (const id of activeIds.current) map.setFeatureState({ source: "abstracts", id }, { active: false });
    if (!layersRef.current.deals) { activeIds.current = []; return; }
    activeIds.current = [...dealsByAbstract.keys()];
    for (const id of activeIds.current) map.setFeatureState({ source: "abstracts", id }, { active: true });
  }

  function applyLayerVisibility() {
    const map = mapRef.current; if (!map || !styleReady.current) return;
    const L = layersRef.current;
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("abstracts-fill", L.boundaries); vis("abstracts-line", L.boundaries);
    vis("abstracts-num", L.absNums); vis("abstracts-survey", L.surveyNames); vis("pipelines", L.pipelines);
    applyHighlight();
  }

  function applyAbstractFilter() {
    const map = mapRef.current; if (!map || !styleReady.current) return;
    const clauses: unknown[] = [];
    if (fAbstracts.length) clauses.push(["in", ["get", "abstract"], ["literal", fAbstracts]]);
    if (fSurveys.length) clauses.push(["in", ["get", "survey"], ["literal", fSurveys]]);
    if (fCounties.length && !fCounties.includes("Leon")) clauses.push(["==", ["get", "id"], "__none__"]);
    const filter = clauses.length ? (["all", ...clauses] as maplibregl.FilterSpecification) : null;
    for (const id of ["abstracts-fill", "abstracts-line", "abstracts-num", "abstracts-survey"]) {
      if (map.getLayer(id)) map.setFilter(id, filter);
    }
  }

  // Data + reactive effects
  function loadDeals() {
    const qs = new URLSearchParams(); qs.set("status", statusFilter);
    api.get<MapDeal[]>(`/map/deals?${qs.toString()}`).then(setDeals);
  }
  useEffect(loadDeals, [statusFilter]);
  useEffect(applyHighlight, [dealsByAbstract]);
  useEffect(applyLayerVisibility, [layers]);
  useEffect(applyAbstractFilter, [fCounties, fSurveys, fAbstracts]);

  // Global search over abstracts (number / survey / county). Wells to come.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !abstractsFC.current) return [];
    const out: { id: string; label: string; sub: string }[] = [];
    for (const f of abstractsFC.current.features) {
      const ab = (f.properties.abstract as string) || ""; const sv = (f.properties.survey as string) || "";
      if (ab.toLowerCase().includes(q) || sv.toLowerCase().includes(q)) {
        out.push({ id: f.properties.id as string, label: ab, sub: sv });
        if (out.length >= 8) break;
      }
    }
    return out;
  }, [query]);

  const panelDeals = selected?.kind === "abstract" ? dealsByAbstract.get(selected.id) ?? [] : [];
  const abstractCount = dealsByAbstract.size;

  const toggle = (k: keyof typeof layers) => setLayers((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div className="row"><h1 style={{ marginBottom: 0 }}>Map</h1><span className="muted">Leon County, TX · proof of concept</span></div>
      </div>

      {/* Toolbar */}
      <div className="row" style={{ marginBottom: 12, gap: 10, position: "relative" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 380 }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search abstract #, survey name…" />
          {results.length > 0 && (
            <div className="msel-menu" style={{ top: "100%" }}>
              {results.map((r) => (
                <div className="msel-opt" key={r.id} onClick={() => { selectAbstractById(r.id); setQuery(""); }}>
                  <strong>{r.label}</strong> <span className="muted">· {r.sub}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="spacer" />
        <button onClick={() => { setShowFilters((s) => !s); setShowLayers(false); }}>Filters ▾</button>
        <button onClick={() => { setShowLayers((s) => !s); setShowFilters(false); }}>Layers ▾</button>
      </div>

      {showFilters && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="dd-grid">
            <div className="field"><label>Deal status</label>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </div>
            <div className="field"><label>County</label><SearchableMultiSelect options={meta.counties} value={fCounties} onChange={setFCounties} placeholder="Counties…" /></div>
            <div className="field"><label>Survey</label><SearchableMultiSelect options={meta.surveys} value={fSurveys} onChange={setFSurveys} placeholder="Surveys…" /></div>
            <div className="field"><label>Abstract</label><SearchableMultiSelect options={meta.abstracts} value={fAbstracts} onChange={setFAbstracts} placeholder="Abstracts…" /></div>
            <div className="field"><label>Operator <span className="muted">(needs wells data)</span></label><SearchableMultiSelect options={[]} value={[]} onChange={() => {}} placeholder="Requires wells layer" /></div>
            <div className="field"><label>Well status <span className="muted">(needs wells data)</span></label><SearchableMultiSelect options={[]} value={[]} onChange={() => {}} placeholder="Requires wells layer" /></div>
            <div className="field"><label>Well type <span className="muted">(needs wells data)</span></label><SearchableMultiSelect options={[]} value={[]} onChange={() => {}} placeholder="Requires wells layer" /></div>
          </div>
        </div>
      )}

      {showLayers && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="row" style={{ gap: 18, flexWrap: "wrap" }}>
            <Chk label="Abstract boundaries" on={layers.boundaries} onChange={() => toggle("boundaries")} />
            <Chk label="Abstract numbers" on={layers.absNums} onChange={() => toggle("absNums")} />
            <Chk label="Survey names" on={layers.surveyNames} onChange={() => toggle("surveyNames")} />
            <Chk label="Active deals" on={layers.deals} onChange={() => toggle("deals")} />
            <Chk label="Pipelines" on={layers.pipelines} onChange={() => toggle("pipelines")} />
            <Chk label="Wells (coming soon)" on={false} onChange={() => {}} disabled />
          </div>
        </div>
      )}

      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted">{deals == null ? "…" : `${deals.length} deal${deals.length === 1 ? "" : "s"} · ${abstractCount} abstract${abstractCount === 1 ? "" : "s"} highlighted`}</span>
      </div>

      <div style={{ position: "relative", height: "calc(100vh - 250px)", minHeight: 460, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
        <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />
        {!deals && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}><Spinner label="Loading map…" /></div>}

        <div style={{ position: "absolute", left: 12, bottom: 26, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
          <Legend color="#ef4444" op={0.7} label="Active deal" />
          <Legend color="#f59e0b" op={0.8} label="Selected" />
          <Legend color="#3b82f6" op={0.4} label="Abstract boundary" />
          {layers.pipelines && <Legend color="#7c3aed" op={0.9} label="Pipeline" />}
        </div>

        {selected && (
          <div style={{ position: "absolute", top: 12, right: 12, width: 320, maxHeight: "calc(100% - 24px)", overflowY: "auto", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow)", padding: 16 }}>
            {selected.kind === "pipeline" ? (
              <>
                <div className="section-head"><div><h3 style={{ margin: 0 }}>Pipeline</h3><div className="muted" style={{ fontSize: 12 }}>{selected.system}</div></div><button className="icon-btn" onClick={() => setSelected(null)}>×</button></div>
                <div className="dd-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <KV k="Operator" v={selected.operator} /><KV k="Commodity" v={selected.commodity} />
                  <KV k="Diameter" v={selected.diameter ? `${selected.diameter}"` : "—"} /><KV k="Status" v={selected.status} />
                  <KV k="Interstate" v={selected.interstate ? "Yes" : "No"} />
                </div>
              </>
            ) : (
              <>
                <div className="section-head"><div><h3 style={{ margin: 0 }}>{selected.abstract}</h3><div className="muted" style={{ fontSize: 12 }}>{[selected.survey, selected.county ? `${selected.county} County` : ""].filter(Boolean).join(" · ")}</div></div><button className="icon-btn" onClick={() => { deselectAbstract(); setSelected(null); }}>×</button></div>
                <div className="kv" style={{ margin: "8px 0" }}><span className="k">Abstract ID</span><span className="v"><code>{selected.id}</code></span></div>
                <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 8 }}>{panelDeals.length} active deal{panelDeals.length === 1 ? "" : "s"}</div>
                {panelDeals.length === 0 ? <p className="muted">No active deals in this abstract.</p> : panelDeals.map((d) => (
                  <div key={d.id} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
                    <div className="row" style={{ justifyContent: "space-between" }}><Link to={`/deals/${d.id}`} style={{ fontWeight: 600 }}>{d.name}</Link><PriorityBadge priority={d.priority} /></div>
                    <div className="row" style={{ gap: 6, margin: "6px 0" }}><StageBadge stage={d.stage} />{d.selectedBuyer && <span className="muted" style={{ fontSize: 12 }}>→ {d.selectedBuyer.name}</span>}</div>
                    <div className="dd-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      <KV k="County" v={d.counties.join(", ")} /><KV k="Operator" v={d.operator} />
                      <KV k="Asset Type" v={d.assetTypes.join(", ")} /><KV k="NMA" v={num(d.acreageNma)} />
                      <KV k="NRA" v={num(d.nra)} /><KV k="Profit est." v={money(d.profitEst)} />
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Chk({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, margin: 0, opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer" }}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={onChange} style={{ width: "auto" }} /> {label}
    </label>
  );
}
function Legend({ color, op, label }: { color: string; op: number; label: string }) {
  return <div className="row" style={{ gap: 8, marginTop: 4 }}><span style={{ width: 12, height: 12, background: color, opacity: op, borderRadius: 2, display: "inline-block" }} /> {label}</div>;
}
function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v || "—"}</span></div>;
}
