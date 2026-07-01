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
type GeoFeature = { type: "Feature"; id?: number; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
type SelAbstract = { kind: "abstract"; id: string; abstract: string; survey: string; county: string };
type WellProps = { fid: number; api: string; api8: string; wellNo: string | null; wellId: string; symbol: string; type: string; status: string; county: string; abstract: string | null; survey: string | null; operator: string | null; leaseName: string | null; leaseNo: string | null; field: string | null; oilGas: string | null; cumOil: number | null; cumGas: number | null; lastProd: string | null; formations: string | null };
type SelWell = { kind: "well" } & WellProps;
type Selected = SelAbstract | SelWell | null;

const ABSTRACTS_URL = "/data/leon-abstracts.geojson";
const WELLS_URL = "/data/leon-wells.geojson";
const WELLBORES_URL = "/data/leon-wellbores.geojson";
const PRODUCTION_URL = "/data/leon-production.json";
const LEON_CENTER: [number, number] = [-95.99, 31.29];

// Wells are colored by RRC status.
const STATUS_COLOR = [
  "match", ["get", "status"],
  "Producing", "#22c55e", "Shut-In", "#f59e0b", "Plugged", "#6b7280", "Permitted", "#3b82f6",
  "Dry Hole", "#78350f", "Active", "#7c3aed", "Canceled/Abandoned", "#9ca3af", "Surface location", "#0ea5e9",
  "#64748b",
] as unknown as maplibregl.ExpressionSpecification;

const STATUS_OPTIONS = [
  ["ACTIVE", "Active deals"], ["ALL", "All linked deals"], ["UNDER_CONTRACT", "Under Contract"],
  ["PREPARING_PACKAGE", "Preparing Package"], ["SENT_TO_BUYERS", "Sent to Buyers"], ["NEGOTIATING", "Negotiating"],
  ["CLOSING", "Closing"], ["CLOSED", "Closed"], ["DEAD", "Dead"],
] as const;

function styleWithGlyphs(): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: `${window.location.origin}/fonts/{fontstack}/{range}.pbf`,
    sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  };
}
function bboxOf(geom: { type: string; coordinates: unknown }): [number, number, number, number] {
  let a = 180, b = 90, c = -180, d = -90;
  const w = (x: unknown) => { if (Array.isArray(x) && typeof x[0] === "number") { const [px, py] = x as number[]; if (px < a) a = px; if (py < b) b = py; if (px > c) c = px; if (py > d) d = py; } else if (Array.isArray(x)) x.forEach(w); };
  w(geom.coordinates); return [a, b, c, d];
}

export function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReady = useRef(false);
  const activeIds = useRef<string[]>([]);
  const selAbstractRef = useRef<string | null>(null);
  const selWellRef = useRef<number | null>(null);
  const abstractsFC = useRef<FC | null>(null);
  const wellsFC = useRef<FC | null>(null);

  const [deals, setDeals] = useState<MapDeal[] | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [choices, setChoices] = useState<WellProps[] | null>(null); // overlap disambiguation
  const [layers, setLayers] = useState({ boundaries: true, absNums: true, surveyNames: true, deals: true, wells: true, wellbores: true });
  const layersRef = useRef(layers); layersRef.current = layers;
  const [showLayers, setShowLayers] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [fCounties, setFCounties] = useState<string[]>([]);
  const [fSurveys, setFSurveys] = useState<string[]>([]);
  const [fAbstracts, setFAbstracts] = useState<string[]>([]);
  const [fWellTypes, setFWellTypes] = useState<string[]>([]);
  const [fWellStatuses, setFWellStatuses] = useState<string[]>([]);
  const [fOperators, setFOperators] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [prod, setProd] = useState<Record<string, [number, number, number][]>>({});
  const [meta, setMeta] = useState<{ counties: string[]; surveys: string[]; abstracts: string[]; wellTypes: string[]; wellStatuses: string[]; operators: string[] }>({ counties: [], surveys: [], abstracts: [], wellTypes: [], wellStatuses: [], operators: [] });

  const dealsByAbstract = useMemo(() => {
    const m = new Map<string, MapDeal[]>();
    for (const d of deals ?? []) for (const aid of d.abstractIds) { const a = m.get(aid) ?? []; a.push(d); m.set(aid, a); }
    return m;
  }, [deals]);

  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;
    const map = new maplibregl.Map({ container: mapContainer.current, style: styleWithGlyphs(), center: LEON_CENTER, zoom: 10, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;

    map.on("load", async () => {
      const [absFC, welFC, boreFC] = await Promise.all([
        fetch(ABSTRACTS_URL).then((r) => r.json()) as Promise<FC>,
        fetch(WELLS_URL).then((r) => r.json()) as Promise<FC>,
        fetch(WELLBORES_URL).then((r) => r.json()) as Promise<FC>,
      ]);
      abstractsFC.current = absFC; wellsFC.current = welFC;
      const uniq = (arr: (string | null | undefined)[]) => [...new Set(arr.filter(Boolean) as string[])];
      setMeta({
        counties: ["Leon"],
        surveys: uniq(absFC.features.map((f) => f.properties.survey as string)).sort(),
        abstracts: uniq(absFC.features.map((f) => f.properties.abstract as string)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        wellTypes: uniq(welFC.features.map((f) => f.properties.type as string)).sort(),
        wellStatuses: uniq(welFC.features.map((f) => f.properties.status as string)).sort(),
        operators: uniq(welFC.features.map((f) => f.properties.operator as string)).sort(),
      });

      map.addSource("abstracts", { type: "geojson", data: absFC as unknown as GeoJSON.FeatureCollection, promoteId: "id" });
      map.addSource("wells", { type: "geojson", data: welFC as unknown as GeoJSON.FeatureCollection, promoteId: "fid" });
      map.addSource("wellbores", { type: "geojson", data: boreFC as unknown as GeoJSON.FeatureCollection, promoteId: "fid" });

      map.addLayer({ id: "abstracts-fill", type: "fill", source: "abstracts", paint: {
        "fill-color": ["case", ["boolean", ["feature-state", "selected"], false], "#f59e0b", ["boolean", ["feature-state", "active"], false], "#ef4444", "#3b82f6"],
        "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.55, ["boolean", ["feature-state", "active"], false], 0.45, 0.05] } });
      map.addLayer({ id: "abstracts-line", type: "line", source: "abstracts", paint: {
        "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#b45309", "#64748b"], "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, 0.5] } });
      // Wellbore laterals (surface -> bottom hole)
      map.addLayer({ id: "wellbores", type: "line", source: "wellbores", layout: { "line-cap": "round" }, paint: {
        "line-color": ["match", ["get", "wellboreType"], "Horizontal", "#0f766e", "Directional", "#9333ea", "#0f766e"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 15, 2.5], "line-opacity": 0.8 } });
      map.addLayer({ id: "wellbores-sel", type: "line", source: "wellbores", filter: ["==", ["get", "surfaceId"], -1], paint: { "line-color": "#111827", "line-width": 3 } });
      // Surface wells — colored by RRC status; selection via feature-state (unique fid)
      map.addLayer({ id: "wells", type: "circle", source: "wells", paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2.3, 12, 3.6, 15, 6],
        "circle-color": STATUS_COLOR,
        "circle-stroke-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, 0.6],
        "circle-stroke-color": ["case", ["boolean", ["feature-state", "selected"], false], "#111827", "#ffffff"],
        "circle-opacity": 0.9 } });
      map.addLayer({ id: "abstracts-num", type: "symbol", source: "abstracts", minzoom: 9, layout: {
        "symbol-sort-key": ["*", -1, ["get", "area"]], "text-field": ["get", "abstract"], "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13], "text-padding": 2, "text-allow-overlap": false, "text-optional": true },
        paint: { "text-color": "#0f172a", "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });
      map.addLayer({ id: "abstracts-survey", type: "symbol", source: "abstracts", minzoom: 12.5, layout: {
        "symbol-sort-key": ["*", -1, ["get", "area"]], "text-field": ["get", "survey"], "text-font": ["Noto Sans Regular"],
        "text-size": 11, "text-offset": [0, 1.1], "text-max-width": 8, "text-padding": 2, "text-allow-overlap": false, "text-optional": true },
        paint: { "text-color": "#334155", "text-halo-color": "#ffffff", "text-halo-width": 1.3 } });

      map.on("click", (e) => {
        // Precise well selection: gather wells under a small tolerance box.
        const t = 6;
        const bx: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - t, e.point.y - t], [e.point.x + t, e.point.y + t]];
        const hits = layersRef.current.wells ? map.queryRenderedFeatures(bx, { layers: ["wells"] }) : [];
        // De-dupe by fid (a feature can appear once), keep distinct wells.
        const seen = new Map<number, WellProps>();
        for (const h of hits) { const p = h.properties as Record<string, unknown>; const fid = Number(p.fid); if (!seen.has(fid)) seen.set(fid, toWellProps(p)); }
        const wells = [...seen.values()];
        if (wells.length === 1) { selectWell(wells[0]); return; }
        if (wells.length > 1) { clearSelection(); setChoices(wells); return; }
        // Otherwise an abstract (toggle).
        const feats = map.queryRenderedFeatures(e.point, { layers: ["abstracts-fill"] });
        if (feats.length === 0) { clearSelection(); return; }
        const id = feats[0].properties?.id as string;
        if (selAbstractRef.current === id) { clearSelection(); return; }
        selectAbstract(id, feats[0].properties as Record<string, unknown>);
      });
      map.on("mouseenter", "wells", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "wells", () => (map.getCanvas().style.cursor = ""));
      map.on("mouseenter", "abstracts-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "abstracts-fill", () => (map.getCanvas().style.cursor = ""));

      styleReady.current = true;
      applyHighlight(); applyLayerVisibility(); applyAbstractFilter(); applyWellFilter();
    });
    return () => { map.remove(); mapRef.current = null; styleReady.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toWellProps(p: Record<string, unknown>): WellProps {
    return { fid: Number(p.fid), api: (p.api as string) || "", api8: (p.api8 as string) || "", wellNo: (p.wellNo as string) || null, wellId: (p.wellId as string) || "", symbol: (p.symbol as string) || "", type: (p.type as string) || "", status: (p.status as string) || "", county: (p.county as string) || "Leon", abstract: (p.abstract as string) || null, survey: (p.survey as string) || null, operator: (p.operator as string) || null, leaseName: (p.leaseName as string) || null, leaseNo: (p.leaseNo as string) || null, field: (p.field as string) || null, oilGas: (p.oilGas as string) || null, cumOil: p.cumOil != null ? Number(p.cumOil) : null, cumGas: p.cumGas != null ? Number(p.cumGas) : null, lastProd: (p.lastProd as string) || null, formations: Array.isArray(p.formations) ? (p.formations as string[]).join(", ") : ((p.formations as string) || null) };
  }
  function clearSelection() {
    const map = mapRef.current;
    if (map) {
      if (selAbstractRef.current) map.setFeatureState({ source: "abstracts", id: selAbstractRef.current }, { selected: false });
      if (selWellRef.current != null) map.setFeatureState({ source: "wells", id: selWellRef.current }, { selected: false });
      if (map.getLayer("wellbores-sel")) map.setFilter("wellbores-sel", ["==", ["get", "surfaceId"], -1]);
    }
    selAbstractRef.current = null; selWellRef.current = null;
    setSelected(null); setChoices(null);
  }
  function selectAbstract(id: string, props: Record<string, unknown>) {
    const map = mapRef.current; if (!map) return;
    clearSelection();
    selAbstractRef.current = id;
    map.setFeatureState({ source: "abstracts", id }, { selected: true });
    setSelected({ kind: "abstract", id, abstract: (props.abstract as string) || id, survey: (props.survey as string) || "", county: (props.county as string) || "" });
  }
  function selectWell(w: WellProps) {
    const map = mapRef.current; if (!map) return;
    clearSelection();
    selWellRef.current = w.fid;
    map.setFeatureState({ source: "wells", id: w.fid }, { selected: true });
    if (map.getLayer("wellbores-sel")) map.setFilter("wellbores-sel", ["==", ["get", "surfaceId"], w.fid]);
    setSelected({ kind: "well", ...w });
  }
  function selectAbstractById(id: string) {
    const map = mapRef.current; const fc = abstractsFC.current; if (!map || !fc) return;
    const feat = fc.features.find((f) => f.properties.id === id); if (!feat) return;
    selectAbstract(id, feat.properties);
    const [a, b, c, d] = bboxOf(feat.geometry);
    map.fitBounds([[a, b], [c, d]], { padding: 80, maxZoom: 14, duration: 800 });
  }
  function selectWellByFid(fid: number) {
    const map = mapRef.current; const fc = wellsFC.current; if (!map || !fc) return;
    const feat = fc.features.find((f) => Number(f.properties.fid) === fid); if (!feat) return;
    selectWell(toWellProps(feat.properties));
    const [lon, lat] = feat.geometry.coordinates as number[];
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 13), duration: 800 });
  }

  function applyHighlight() {
    const map = mapRef.current; if (!map || !styleReady.current) return;
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
    vis("abstracts-num", L.absNums); vis("abstracts-survey", L.surveyNames);
    vis("wells", L.wells); vis("wellbores", L.wellbores); vis("wellbores-sel", L.wellbores);
    applyHighlight();
  }
  function applyAbstractFilter() {
    const map = mapRef.current; if (!map || !styleReady.current) return;
    const cl: unknown[] = [];
    if (fAbstracts.length) cl.push(["in", ["get", "abstract"], ["literal", fAbstracts]]);
    if (fSurveys.length) cl.push(["in", ["get", "survey"], ["literal", fSurveys]]);
    if (fCounties.length && !fCounties.includes("Leon")) cl.push(["==", ["get", "id"], "__none__"]);
    const filter = cl.length ? (["all", ...cl] as maplibregl.FilterSpecification) : null;
    for (const id of ["abstracts-fill", "abstracts-line", "abstracts-num", "abstracts-survey"]) if (map.getLayer(id)) map.setFilter(id, filter);
  }
  function applyWellFilter() {
    const map = mapRef.current; if (!map || !styleReady.current || !map.getLayer("wells")) return;
    const cl: unknown[] = [];
    if (fWellTypes.length) cl.push(["in", ["get", "type"], ["literal", fWellTypes]]);
    if (fWellStatuses.length) cl.push(["in", ["get", "status"], ["literal", fWellStatuses]]);
    if (fOperators.length) cl.push(["in", ["get", "operator"], ["literal", fOperators]]);
    if (fAbstracts.length) cl.push(["in", ["get", "abstract"], ["literal", fAbstracts]]);
    if (fSurveys.length) cl.push(["in", ["get", "survey"], ["literal", fSurveys]]);
    map.setFilter("wells", cl.length ? (["all", ...cl] as maplibregl.FilterSpecification) : null);
  }

  function loadDeals() { const qs = new URLSearchParams(); qs.set("status", statusFilter); api.get<MapDeal[]>(`/map/deals?${qs.toString()}`).then(setDeals); }
  useEffect(loadDeals, [statusFilter]);
  useEffect(() => { fetch(PRODUCTION_URL).then((r) => r.json()).then(setProd).catch(() => {}); }, []);
  useEffect(applyHighlight, [dealsByAbstract]);
  useEffect(applyLayerVisibility, [layers]);
  useEffect(applyAbstractFilter, [fCounties, fSurveys, fAbstracts]);
  useEffect(applyWellFilter, [fCounties, fSurveys, fAbstracts, fWellTypes, fWellStatuses, fOperators]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase(); if (!q) return [] as { kind: "abstract" | "well"; key: string; label: string; sub: string }[];
    const out: { kind: "abstract" | "well"; key: string; label: string; sub: string }[] = [];
    for (const f of abstractsFC.current?.features ?? []) {
      const ab = (f.properties.abstract as string) || ""; const sv = (f.properties.survey as string) || "";
      if (ab.toLowerCase().includes(q) || sv.toLowerCase().includes(q)) { out.push({ kind: "abstract", key: f.properties.id as string, label: ab, sub: sv }); if (out.length >= 6) break; }
    }
    for (const f of wellsFC.current?.features ?? []) {
      const p = f.properties; const api = String(p.api || ""); const api8 = String(p.api8 || ""); const wn = String(p.wellNo || "");
      const op = String(p.operator || ""); const ln = String(p.leaseName || "");
      if (api.toLowerCase().includes(q) || api8.toLowerCase().includes(q) || wn.toLowerCase().includes(q) || op.toLowerCase().includes(q) || ln.toLowerCase().includes(q)) {
        out.push({ kind: "well", key: String(p.fid), label: `Well ${api}${wn ? ` #${wn}` : ""}`, sub: [op || null, ln || null, p.type].filter(Boolean).join(" · ") }); if (out.length >= 16) break;
      }
    }
    return out;
  }, [query]);

  const panelDeals = selected?.kind === "abstract" ? dealsByAbstract.get(selected.id) ?? [] : [];
  const abstractCount = dealsByAbstract.size;
  const toggle = (k: keyof typeof layers) => setLayers((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header"><div className="row"><h1 style={{ marginBottom: 0 }}>Map</h1><span className="muted">Leon County, TX · proof of concept</span></div></div>

      <div className="row" style={{ marginBottom: 12, gap: 10, position: "relative" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 440 }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search API #, well #, abstract #, survey…" />
          {results.length > 0 && (
            <div className="msel-menu" style={{ top: "100%" }}>
              {results.map((r) => (
                <div className="msel-opt" key={r.kind + r.key} onClick={() => { r.kind === "abstract" ? selectAbstractById(r.key) : selectWellByFid(Number(r.key)); setQuery(""); }}>
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
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Filters apply to all GIS data on the map (wells, abstracts, surveys) — independent of whether a deal exists. "Deal status" only affects the deal highlight.</p>
          <div className="dd-grid">
            <div className="field"><label>Deal status</label><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div className="field"><label>County</label><SearchableMultiSelect options={meta.counties} value={fCounties} onChange={setFCounties} placeholder="Counties…" /></div>
            <div className="field"><label>Survey</label><SearchableMultiSelect options={meta.surveys} value={fSurveys} onChange={setFSurveys} placeholder="Surveys…" /></div>
            <div className="field"><label>Abstract</label><SearchableMultiSelect options={meta.abstracts} value={fAbstracts} onChange={setFAbstracts} placeholder="Abstracts…" /></div>
            <div className="field"><label>Well type</label><SearchableMultiSelect options={meta.wellTypes} value={fWellTypes} onChange={setFWellTypes} placeholder="Well types…" /></div>
            <div className="field"><label>Well status</label><SearchableMultiSelect options={meta.wellStatuses} value={fWellStatuses} onChange={setFWellStatuses} placeholder="Well statuses…" /></div>
            <div className="field"><label>Operator ({meta.operators.length})</label><SearchableMultiSelect options={meta.operators} value={fOperators} onChange={setFOperators} placeholder="Operators…" /></div>
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
            <Chk label="Well status" on={layers.wells} onChange={() => toggle("wells")} />
            <Chk label="Wellbores (laterals)" on={layers.wellbores} onChange={() => toggle("wellbores")} />
          </div>
        </div>
      )}

      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted">{deals == null ? "…" : `${deals.length} deal${deals.length === 1 ? "" : "s"} · ${abstractCount} highlighted · ${wellsFC.current?.features.length ?? 0} wells`}</span>
      </div>

      <div style={{ position: "relative", height: "calc(100vh - 250px)", minHeight: 460, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
        <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />
        {!deals && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}><Spinner label="Loading map…" /></div>}

        <div style={{ position: "absolute", left: 12, bottom: 26, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
          <Legend color="#22c55e" label="Producing" /><Legend color="#f59e0b" label="Shut-in" /><Legend color="#6b7280" label="Plugged" />
          <Legend color="#3b82f6" label="Permitted" /><Legend color="#78350f" label="Dry hole" /><Legend color="#7c3aed" label="Injection/Disposal" />
          {layers.wellbores && <Legend color="#0f766e" label="Wellbore (lateral)" line />}
        </div>

        {/* Overlap chooser */}
        {choices && (
          <div style={{ position: "absolute", top: 12, right: 12, width: 300, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow)", padding: 16 }}>
            <div className="section-head"><h3 style={{ margin: 0 }}>{choices.length} wells here</h3><button className="icon-btn" onClick={() => setChoices(null)}>×</button></div>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Pick the well you meant:</p>
            {choices.map((w) => (
              <div key={w.fid} className="msel-opt" style={{ borderTop: "1px solid var(--border)" }} onClick={() => selectWell(w)}>
                <strong>{w.api}{w.wellNo ? ` #${w.wellNo}` : ""}</strong><div className="muted" style={{ fontSize: 12 }}>{w.type} · {w.status}</div>
              </div>
            ))}
          </div>
        )}

        {selected && !choices && (
          <div style={{ position: "absolute", top: 12, right: 12, width: 320, maxHeight: "calc(100% - 24px)", overflowY: "auto", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow)", padding: 16 }}>
            {selected.kind === "well" ? (
              <>
                <div className="section-head"><div><h3 style={{ margin: 0 }}>{selected.leaseName || "Well"} {selected.wellNo ? `#${selected.wellNo}` : ""}</h3><div className="muted" style={{ fontSize: 12 }}>{selected.symbol}</div></div><button className="icon-btn" onClick={clearSelection}>×</button></div>
                <div className="dd-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <KV k="Operator" v={selected.operator} /><KV k="Oil / Gas" v={selected.oilGas} />
                  <KV k="Lease" v={selected.leaseName} /><KV k="RRC Lease #" v={selected.leaseNo} />
                  <KV k="Field" v={selected.field} /><KV k="API" v={selected.api} />
                  <KV k="Well No." v={selected.wellNo} /><KV k="Type" v={selected.type} />
                  <KV k="Status" v={selected.status} /><KV k="County" v={selected.county} />
                  <KV k="Abstract" v={selected.abstract} /><KV k="Survey" v={selected.survey} />
                </div>
                {selected.formations && (
                  <div className="kv" style={{ marginTop: 8 }}><span className="k">Formations (RRC W-2)</span><span className="v wrap">{selected.formations}</span></div>
                )}
                {(selected.cumOil != null || selected.cumGas != null) && (
                  <>
                    <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 10 }}>Lease production (RRC)</div>
                    <div className="dd-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      <KV k="Cum. oil (bbl)" v={num(selected.cumOil)} /><KV k="Cum. gas (MCF)" v={num(selected.cumGas)} />
                      <KV k="Last produced" v={selected.lastProd} />
                    </div>
                  </>
                )}
                {(() => {
                  const key = selected.leaseNo ? `${selected.oilGas === "Gas" ? "G" : "O"}|05|${selected.leaseNo}` : null;
                  const series = key ? prod[key] : null;
                  if (!series || !series.length) return null;
                  const kind: "oil" | "gas" = selected.oilGas === "Gas" ? "gas" : "oil";
                  const last12 = series.slice(-12).reduce((s, p) => s + (kind === "gas" ? p[2] : p[1]), 0);
                  return (
                    <div style={{ marginTop: 10 }}>
                      <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em" }}>Production trend · {kind === "gas" ? "gas (MCF)" : "oil (bbl)"} · last {Math.min(series.length, 36)} mo</div>
                      <ProductionChart series={series} kind={kind} />
                      <div className="muted" style={{ fontSize: 12 }}>Last 12 mo: {num(last12)} {kind === "gas" ? "MCF" : "bbl"}</div>
                    </div>
                  );
                })()}
                <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Operator, lease, field, and lease production/trend are from RRC records (lease-level; oil is reported per lease). Formation shows where a recent W-2 was filed.</p>
              </>
            ) : (
              <>
                <div className="section-head"><div><h3 style={{ margin: 0 }}>{selected.abstract}</h3><div className="muted" style={{ fontSize: 12 }}>{[selected.survey, selected.county ? `${selected.county} County` : ""].filter(Boolean).join(" · ")}</div></div><button className="icon-btn" onClick={clearSelection}>×</button></div>
                <div className="dd-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}><KV k="Abstract" v={selected.abstract} /><KV k="Survey" v={selected.survey} /><KV k="County" v={selected.county} /></div>
                <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 10 }}>{panelDeals.length} active deal{panelDeals.length === 1 ? "" : "s"}</div>
                {panelDeals.length === 0 ? <p className="muted">No active deals in this abstract.</p> : panelDeals.map((d) => (
                  <div key={d.id} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
                    <div className="row" style={{ justifyContent: "space-between" }}><Link to={`/deals/${d.id}`} style={{ fontWeight: 600 }}>{d.name}</Link><PriorityBadge priority={d.priority} /></div>
                    <div className="row" style={{ gap: 6, margin: "6px 0" }}><StageBadge stage={d.stage} />{d.selectedBuyer && <span className="muted" style={{ fontSize: 12 }}>→ {d.selectedBuyer.name}</span>}</div>
                    <div className="dd-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 6 }}><KV k="Operator" v={d.operator} /><KV k="Asset Type" v={d.assetTypes.join(", ")} /><KV k="NMA" v={num(d.acreageNma)} /><KV k="Profit est." v={money(d.profitEst)} /></div>
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

function Chk({ label, on, onChange }: { label: string; on: boolean; onChange: () => void }) {
  return <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, margin: 0, cursor: "pointer" }}><input type="checkbox" checked={on} onChange={onChange} style={{ width: "auto" }} /> {label}</label>;
}
function Legend({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return <div className="row" style={{ gap: 8, marginTop: 4 }}><span style={{ width: 12, height: line ? 3 : 12, background: color, opacity: 0.9, borderRadius: line ? 0 : "50%", display: "inline-block" }} /> {label}</div>;
}
function ProductionChart({ series, kind }: { series: [number, number, number][]; kind: "oil" | "gas" }) {
  const pts = series.slice(-36);
  const idx = kind === "gas" ? 2 : 1;
  const max = Math.max(1, ...pts.map((p) => p[idx]));
  const W = 288, H = 56, bw = W / Math.max(pts.length, 1);
  const color = kind === "gas" ? "#7c3aed" : "#22c55e";
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", margin: "4px 0" }}>
      {pts.map((p, i) => {
        const h = (p[idx] / max) * (H - 2);
        return <rect key={i} x={i * bw} y={H - h} width={Math.max(bw - 0.6, 0.6)} height={h} fill={color} opacity={0.85} />;
      })}
    </svg>
  );
}
function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v || "—"}</span></div>;
}
