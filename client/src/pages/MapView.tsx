import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { Select } from "../components/Select";
import { COUNTIES, COUNTIES_WITH_WELLS, COUNTIES_WITH_PRODUCTION } from "../lib/counties";
import { addCadastralLayers, styleWithGlyphs } from "../lib/mapLayers";
import { MapLayersPanel, PillToggle } from "../components/MapLayersPanel";
import { Spinner, StageBadge, PriorityBadge } from "../components/ui";
import { money, num } from "../lib/format";
import {
  extractWells, wellsPerLease, buildPoints, latestMonth, periodWindow, metricGeojson,
  summarize, rankings, detectHotspots, boe,
  type HeatWell, type HeatPoint, type HeatPeriod, type AreaSummary, type Rankings, type Hotspot,
} from "../lib/heatmap";

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
type WellPermit = { statusNo: string; permitDate: string | null; operator: string | null; leaseName: string | null; wellNo: string | null };
type WellCompletion = { trackingNo: string; filingType: string | null; status: string | null; filedDate: string | null; completionDate: string | null; fieldName: string | null };
type WellProps = { fid: number; api: string; api8: string; wellNo: string | null; wellId: string; symbol: string; type: string; status: string; county: string; abstract: string | null; survey: string | null; operator: string | null; leaseName: string | null; leaseNo: string | null; field: string | null; oilGas: string | null; district: string | null; cumOil: number | null; cumGas: number | null; lastProd: string | null; formations: string | null; spudDate?: string | null; plugDate?: string | null; permits?: WellPermit[]; completions?: WellCompletion[] };
type SelWell = { kind: "well" } & WellProps;
type SelHotspot = { kind: "hotspot"; summary: AreaSummary; periodLabel: string };
type Selected = SelAbstract | SelWell | SelHotspot | null;

const LEON_CENTER: [number, number] = [-95.99, 31.29];

// --- Unified map search (server-ranked, /gis/suggest) ---
type BBox = [number, number, number, number];
interface Suggest {
  counties: { label: string; bbox: BBox }[];
  abstracts: { id: string; label: string; sub: string }[];
  wells: { fid: number; label: string; sub: string }[];
  operators: { name: string; sub: string; bbox: BBox | null }[];
  fields: { name: string; sub: string; bbox: BBox | null }[];
  formations: { name: string; sub: string; bbox: BBox | null }[];
  deals: { id: string; label: string; sub: string; abstractIds: string[] }[];
  assets: { id: string; label: string; sub: string; abstractIds: string[] }[];
}
/** A recent selection — enough payload to replay the action without re-searching. */
interface Recent { t: keyof Suggest; label: string; sub: string; p: Record<string, unknown> }
const RECENTS_KEY = "mh_map_recents";

// Map view personalization (Customize View): the user's default visible layers,
// last camera position, and named presets — all remembered locally per browser.
const MAP_LAYERS_KEY = "mh-map-layers:v1";
const MAP_VIEW_KEY = "mh-map-view:v1";
const MAP_PRESETS_KEY = "mh-map-presets:v1";
type MapLayers = { boundaries: boolean; absNums: boolean; surveyNames: boolean; deals: boolean; wells: boolean; wellbores: boolean };
const DEFAULT_MAP_LAYERS: MapLayers = { boundaries: true, absNums: true, surveyNames: true, deals: true, wells: true, wellbores: true };
interface MapCam { center: [number, number]; zoom: number }
interface MapPreset { name: string; layers: MapLayers; view: MapCam }
function loadJson<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function saveJson(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage off */ } }

const GROUP_LABELS: Record<keyof Suggest, string> = {
  counties: "Counties", abstracts: "Abstracts & surveys", wells: "Wells & leases",
  operators: "Operators", fields: "Fields", formations: "Formations",
  deals: "Deals", assets: "Mineral assets",
};

const EMPTY_FC = { type: "FeatureCollection", features: [] } as unknown as GeoJSON.FeatureCollection;
// Oil ramp runs warm (amber → red); gas ramp runs cool (indigo → violet) so the
// two heat layers stay distinguishable when both are on and overlapping.
const HEAT_OIL_COLOR = ["interpolate", ["linear"], ["heatmap-density"],
  0, "rgba(0,0,0,0)", 0.15, "#fde68a", 0.4, "#f59e0b", 0.65, "#ea580c", 0.85, "#dc2626", 1, "#7f1d1d"] as unknown as maplibregl.ExpressionSpecification;
const HEAT_GAS_COLOR = ["interpolate", ["linear"], ["heatmap-density"],
  0, "rgba(0,0,0,0)", 0.15, "#c7d2fe", 0.4, "#818cf8", 0.65, "#6d28d9", 0.85, "#4c1d95", 1, "#2e1065"] as unknown as maplibregl.ExpressionSpecification;
const HEAT_STOPS: [number, string][] = [[0, "#eef2ff"], [0.2, "#fde68a"], [0.45, "#f59e0b"], [0.7, "#ea580c"], [1, "#7f1d1d"]];

interface HeatState { oil: boolean; gas: boolean; intensity: number; radius: number; opacity: number; min: number; max: number; period: HeatPeriod; from: string; to: string; topProducers: boolean; hotspots: boolean }
const DEFAULT_HEAT: HeatState = { oil: false, gas: false, intensity: 1, radius: 32, opacity: 0.85, min: 0, max: 0, period: "12m", from: "", to: "", topProducers: false, hotspots: true };

const STATUS_OPTIONS = [
  ["ACTIVE", "Active deals"], ["ALL", "All linked deals"], ["UNDER_CONTRACT", "Under Contract"],
  ["PREPARING_PACKAGE", "Preparing Package"], ["SENT_TO_BUYERS", "Sent to Buyers"], ["NEGOTIATING", "Negotiating"],
  ["CLOSING", "Closing"], ["CLOSED", "Closed"], ["DEAD", "Dead"],
] as const;

export function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReady = useRef(false);
  const activeIds = useRef<string[]>([]);
  const selAbstractRef = useRef<string | null>(null);
  const selWellRef = useRef<number | null>(null);
  const wellsFC = useRef<FC | null>(null);
  // County bboxes (from county-labels.geojson) power "go to county" framing.
  const countyBBox = useRef<Map<string, [number, number, number, number]>>(new Map());
  const heatWells = useRef<HeatWell[]>([]);
  const perLease = useRef<Map<string, number>>(new Map());
  const heatPointsRef = useRef<HeatPoint[]>([]);
  const periodLabelRef = useRef("");

  const [deals, setDeals] = useState<MapDeal[] | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [choices, setChoices] = useState<WellProps[] | null>(null); // overlap disambiguation
  const [layers, setLayers] = useState<MapLayers>(() => ({ ...DEFAULT_MAP_LAYERS, ...loadJson<Partial<MapLayers>>(MAP_LAYERS_KEY, {}) }));
  const layersRef = useRef(layers); layersRef.current = layers;
  useEffect(() => { saveJson(MAP_LAYERS_KEY, layers); }, [layers]);
  // Saved map presets (default layers + camera), remembered per browser.
  const [presets, setPresets] = useState<MapPreset[]>(() => loadJson<MapPreset[]>(MAP_PRESETS_KEY, []));
  const [presetName, setPresetName] = useState("");
  const [showLayers, setShowLayers] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [fCounties, setFCounties] = useState<string[]>([]);
  const [fSurveys, setFSurveys] = useState<string[]>([]);
  const [fAbstracts, setFAbstracts] = useState<string[]>([]);
  const [fWellTypes, setFWellTypes] = useState<string[]>([]);
  const [fWellStatuses, setFWellStatuses] = useState<string[]>([]);
  const [fOperators, setFOperators] = useState<string[]>([]);
  const [fFormations, setFFormations] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [prod, setProd] = useState<Record<string, [number, number, number][]>>({});
  const [meta, setMeta] = useState<{ counties: string[] }>({ counties: [] });
  // Survey/abstract filter options come from the GIS API (PostGIS), scoped to the
  // selected counties — no abstract data needs to be downloaded to filter it.
  const [gisOptions, setGisOptions] = useState<{ surveys: string[]; abstracts: string[]; wellTypes: string[]; wellStatuses: string[]; operators: string[]; wellCount: number }>({ surveys: [], abstracts: [], wellTypes: [], wellStatuses: [], operators: [], wellCount: 0 });
  const [sug, setSug] = useState<Suggest | null>(null);
  const [searchFocus, setSearchFocus] = useState(false);
  const [recents, setRecents] = useState<Recent[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(RECENTS_KEY) ?? "[]") as Recent[]; } catch { return []; }
  });

  // --- Production heat map ---
  const [showHeat, setShowHeat] = useState(false);
  const [heat, setHeat] = useState<HeatState>(DEFAULT_HEAT);
  const heatRef = useRef(heat); heatRef.current = heat;
  const [rank, setRank] = useState<Rankings | null>(null);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  // Numeric scale behind the legend gradient (max per-well value in view).
  const [heatScale, setHeatScale] = useState<{ oil: number; gas: number }>({ oil: 0, gas: 0 });
  // Hover summary of the production points near the cursor.
  const [heatHover, setHeatHover] = useState<{ x: number; y: number; wells: number; oil: number; gas: number } | null>(null);
  const [heatReady, setHeatReady] = useState(false);
  const setHeatK = <K extends keyof HeatState>(k: K, v: HeatState[K]) => setHeat((p) => ({ ...p, [k]: v }));
  const heatActive = heat.oil || heat.gas;

  const dealsByAbstract = useMemo(() => {
    const m = new Map<string, MapDeal[]>();
    for (const d of deals ?? []) for (const aid of d.abstractIds) { const a = m.get(aid) ?? []; a.push(d); m.set(aid, a); }
    return m;
  }, [deals]);

  // Formation options come from the heat-map wells (static Leon/Freestone
  // production data — the formation filter only affects the heat layer until
  // phase B5 moves production server-side). Everything else is API-driven.
  const scoped = useMemo(() => {
    const inC = (c: unknown) => fCounties.length === 0 || fCounties.includes(c as string);
    const wel = (wellsFC.current?.features ?? []).filter((f) => inC(f.properties.county));
    const forms = wel.flatMap((f) => Array.isArray(f.properties.formations) ? (f.properties.formations as string[]) : []);
    return { formations: [...new Set(forms.filter(Boolean))].sort() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fCounties, meta]);

  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;
    // Reopen where the user last left the map (their remembered default view).
    const savedCam = loadJson<MapCam | null>(MAP_VIEW_KEY, null);
    const map = new maplibregl.Map({ container: mapContainer.current, style: styleWithGlyphs(), center: savedCam?.center ?? LEON_CENTER, zoom: savedCam?.zoom ?? 10, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;

    map.on("load", async () => {
      // Cadastral geometry (counties + abstracts) streams as vector tiles; the
      // only statics are county label points (tiny, DB-derived) and the
      // heat-map wells for the two production counties (phase B5 removes).
      const [countyLabels, welParts, boreParts] = await Promise.all([
        fetch(`/data/county-labels.geojson`).then((r) => r.json()).catch(() => ({ features: [] })),
        Promise.all(COUNTIES_WITH_WELLS.map((k) => fetch(`/data/${k}-wells.geojson`).then((r) => r.json()).catch(() => ({ features: [] })))),
        Promise.all(COUNTIES_WITH_WELLS.map((k) => fetch(`/data/${k}-wellbores.geojson`).then((r) => r.json()).catch(() => ({ features: [] })))),
      ]);
      const welFC: FC = { type: "FeatureCollection", features: welParts.flatMap((p: FC) => p.features) } as FC;
      void boreParts; // laterals render from tiles; the static files feed nothing else
      wellsFC.current = welFC;
      heatWells.current = extractWells(welFC.features);
      perLease.current = wellsPerLease(heatWells.current);

      // County bboxes (from the DB-derived label file; fips = "48" + our
      // 3-digit code) for search → "go to county" framing.
      const bboxByFips = new Map<string, [number, number, number, number]>();
      for (const f of (countyLabels.features ?? []) as GeoFeature[]) bboxByFips.set(String(f.properties.fips), f.properties.bbox as [number, number, number, number]);
      for (const c of COUNTIES) { const bb = bboxByFips.get(`48${c.fips}`); if (bb) countyBBox.current.set(c.key, bb); }

      setMeta({ counties: COUNTIES.map((c) => c.name).sort() });

      // Shared cadastral source + layer stack (counties, abstracts, wells,
      // wellbores, labels) — identical to the deal map via lib/mapLayers.
      addCadastralLayers(map, countyLabels as unknown as GeoJSON.FeatureCollection);

      // Production heat map — inserted below the cadastral fill so parcels and
      // labels stay readable over it. Weight `w` is pre-normalized to [0,1] per
      // extent so the gradient rescales with zoom; oil/gas are separate sources.
      map.addSource("heat-oil", { type: "geojson", data: EMPTY_FC });
      map.addSource("heat-gas", { type: "geojson", data: EMPTY_FC });
      const heatLayer = (id: string, color: maplibregl.ExpressionSpecification): maplibregl.HeatmapLayerSpecification => ({
        id, type: "heatmap", source: id, layout: { visibility: "none" }, paint: {
          "heatmap-weight": ["get", "w"],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 8, 1, 15, 1.4],
          "heatmap-color": color,
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 16, 12, 32, 15, 58],
          "heatmap-opacity": 0.85,
        },
      });
      map.addLayer(heatLayer("heat-oil", HEAT_OIL_COLOR), "abstracts-fill");
      map.addLayer(heatLayer("heat-gas", HEAT_GAS_COLOR), "abstracts-fill");

      // Top-producer overlay (on top): the highest-BOE wells in view, sized by output.
      map.addSource("heat-top", { type: "geojson", data: EMPTY_FC });
      map.addLayer({ id: "heat-top", type: "circle", source: "heat-top", layout: { visibility: "none" }, paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "rank"], 0, 12, 14, 5],
        "circle-color": "#facc15", "circle-stroke-color": "#78350f", "circle-stroke-width": 2, "circle-opacity": 0.9 } });
      // Hotspot markers (on top): concentrated cells within the current extent.
      map.addSource("heat-hotspots", { type: "geojson", data: EMPTY_FC });
      map.addLayer({ id: "heat-hotspots-ring", type: "circle", source: "heat-hotspots", layout: { visibility: "none" }, paint: {
        "circle-radius": 16, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#dc2626", "circle-stroke-width": 2.5 } });
      map.addLayer({ id: "heat-hotspots-label", type: "symbol", source: "heat-hotspots", layout: { visibility: "none",
        "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, -1.6], "text-anchor": "bottom", "text-allow-overlap": true },
        paint: { "text-color": "#7f1d1d", "text-halo-color": "#ffffff", "text-halo-width": 1.6 } });

      map.on("click", (e) => {
        // Precise well selection: gather wells under a small tolerance box.
        const t = 6;
        const bx: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - t, e.point.y - t], [e.point.x + t, e.point.y + t]];
        const hits = layersRef.current.wells ? map.queryRenderedFeatures(bx, { layers: ["wells"] }) : [];
        // De-dupe by fid (a feature can appear once), keep distinct wells.
        const seen = new Map<number, WellProps>();
        for (const h of hits) { const p = h.properties as Record<string, unknown>; const fid = Number(p.fid); if (!seen.has(fid)) seen.set(fid, toWellProps(p)); }
        const wells = [...seen.values()];
        if (wells.length === 1) { void openWell(wells[0].fid); return; }
        if (wells.length > 1) { clearSelection(); setChoices(wells); return; }
        // When a heat layer is on, a click summarizes the production points under
        // the cursor (contributing wells, oil/gas totals, top operators/wells…).
        if (heatRef.current.oil || heatRef.current.gas) {
          const near = heatPointsRef.current.filter((p) => {
            const sp = map.project([p.lon, p.lat]);
            return Math.hypot(sp.x - e.point.x, sp.y - e.point.y) <= 48;
          });
          if (near.length) { clearSelection(); setSelected({ kind: "hotspot", summary: summarize(near), periodLabel: periodLabelRef.current }); return; }
        }
        // Otherwise an abstract (toggle).
        const feats = map.queryRenderedFeatures(e.point, { layers: ["abstracts-fill"] });
        if (feats.length === 0) { clearSelection(); return; }
        const id = feats[0].properties?.id as string;
        if (selAbstractRef.current === id) { clearSelection(); return; }
        selectAbstract(id, feats[0].properties as Record<string, unknown>);
      });
      map.on("mouseenter", "wells", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "wells", () => (map.getCanvas().style.cursor = ""));
      // Heat hover tooltip: summarize the production points under the cursor.
      // rAF-throttled so dense counties stay smooth while panning.
      let hoverPending = false;
      map.on("mousemove", (e) => {
        if (!(heatRef.current.oil || heatRef.current.gas) || hoverPending) return;
        hoverPending = true;
        requestAnimationFrame(() => {
          hoverPending = false;
          const pts = heatPointsRef.current;
          if (!pts.length) { setHeatHover(null); return; }
          let wells = 0, oil = 0, gas = 0;
          for (const p of pts) {
            const sp = map.project([p.lon, p.lat]);
            if (Math.hypot(sp.x - e.point.x, sp.y - e.point.y) <= 40) { wells++; oil += p.oil; gas += p.gas; }
          }
          setHeatHover(wells ? { x: e.point.x, y: e.point.y, wells, oil, gas } : null);
        });
      });
      map.getCanvas().addEventListener("mouseleave", () => setHeatHover(null));
      map.on("mouseenter", "abstracts-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "abstracts-fill", () => (map.getCanvas().style.cursor = ""));
      // On pan/zoom: re-scale the heat gradient to the current extent. (Abstract
      // tiles load themselves — MapLibre requests only what the viewport needs.)
      map.on("moveend", () => {
        if (heatRef.current.oil || heatRef.current.gas) pushHeat();
        // Remember the camera as the user's default view for next visit.
        const c = map.getCenter();
        saveJson(MAP_VIEW_KEY, { center: [c.lng, c.lat] as [number, number], zoom: map.getZoom() });
      });

      styleReady.current = true;
      applyLayerVisibility(); applyAbstractFilter(); applyWellFilter();
      setHeatReady(true); // lets the heat effect run its first compute with a fresh closure
    });
    return () => { map.remove(); mapRef.current = null; styleReady.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toWellProps(p: Record<string, unknown>): WellProps {
    return { fid: Number(p.fid), api: (p.api as string) || "", api8: (p.api8 as string) || "", wellNo: (p.wellNo as string) || null, wellId: (p.wellId as string) || "", symbol: (p.symbol as string) || "", type: (p.type as string) || "", status: (p.status as string) || "", county: (p.county as string) || "Leon", abstract: (p.abstract as string) || null, survey: (p.survey as string) || null, operator: (p.operator as string) || null, leaseName: (p.leaseName as string) || null, leaseNo: (p.leaseNo as string) || null, field: (p.field as string) || null, oilGas: (p.oilGas as string) || null, district: (p.district as string) || null, cumOil: p.cumOil != null ? Number(p.cumOil) : null, cumGas: p.cumGas != null ? Number(p.cumGas) : null, lastProd: (p.lastProd as string) || null, formations: Array.isArray(p.formations) ? (p.formations as string[]).join(", ") : ((p.formations as string) || null) };
  }
  function clearSelection() {
    const map = mapRef.current;
    if (map) {
      if (selAbstractRef.current) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id: selAbstractRef.current }, { selected: false });
      if (selWellRef.current != null) map.setFeatureState({ source: "abstracts", sourceLayer: "wells", id: selWellRef.current }, { selected: false });
      if (map.getLayer("wellbores-sel")) map.setFilter("wellbores-sel", ["==", ["get", "surfaceId"], -1]);
    }
    selAbstractRef.current = null; selWellRef.current = null;
    setSelected(null); setChoices(null);
  }
  function selectAbstract(id: string, props: Record<string, unknown>) {
    const map = mapRef.current; if (!map) return;
    clearSelection();
    selAbstractRef.current = id;
    map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { selected: true });
    setSelected({ kind: "abstract", id, abstract: (props.abstract as string) || id, survey: (props.survey as string) || "", county: (props.county as string) || "" });
  }
  function selectWell(w: WellProps) {
    const map = mapRef.current; if (!map) return;
    clearSelection();
    selWellRef.current = w.fid;
    map.setFeatureState({ source: "abstracts", sourceLayer: "wells", id: w.fid }, { selected: true });
    if (map.getLayer("wellbores-sel")) map.setFilter("wellbores-sel", ["==", ["get", "surfaceId"], w.fid]);
    setSelected({ kind: "well", ...w });
  }
  // Full panel detail (operator, lease, cums, spud/plug, permits, completions)
  // comes from the GIS API — tile features carry only render/filter props.
  async function openWell(fid: number, fly = false) {
    try {
      const d = await api.get<Record<string, unknown>>(`/gis/wells/${fid}`);
      selectWell({
        ...toWellProps(d),
        formations: Array.isArray(d.formations) ? (d.formations as string[]).join(", ") : null,
        spudDate: (d.spudDate as string | null)?.slice(0, 10) ?? null,
        plugDate: (d.plugDate as string | null)?.slice(0, 10) ?? null,
        permits: (d.permits as WellPermit[]) ?? [],
        completions: (d.completions as WellCompletion[]) ?? [],
      } as WellProps);
      const map = mapRef.current;
      if (fly && map && typeof d.lon === "number") map.flyTo({ center: [d.lon as number, d.lat as number], zoom: Math.max(map.getZoom(), 13), duration: 800 });
    } catch { /* well not in the database */ }
  }
  // (Wells are opened via openWell — search results carry the fid directly.)
  async function selectAbstractById(id: string) {
    // The abstract may not be in any loaded tile yet, so its attributes and
    // bbox come from the GIS API rather than the map.
    const map = mapRef.current; if (!map) return;
    try {
      const r = await api.get<{ id: string; abstract: string | null; survey: string | null; county: string; minx: number; miny: number; maxx: number; maxy: number }>(`/gis/abstracts/${encodeURIComponent(id)}`);
      selectAbstract(id, { abstract: r.abstract, survey: r.survey, county: r.county });
      map.fitBounds([[r.minx, r.miny], [r.maxx, r.maxy]], { padding: 80, maxZoom: 14, duration: 800 });
    } catch { /* stale search result — nothing to select */ }
  }

  // Frame a county from search (abstract tiles stream in on their own).
  function goToCounty(key: string): void {
    const map = mapRef.current; if (!map) return;
    const bb = countyBBox.current.get(key);
    if (bb) map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 40, maxZoom: 12, duration: 800 });
  }

  function applyHighlight() {
    const map = mapRef.current; if (!map || !styleReady.current) return;
    for (const id of activeIds.current) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { active: false });
    if (!layersRef.current.deals) { activeIds.current = []; return; }
    activeIds.current = [...dealsByAbstract.keys()];
    for (const id of activeIds.current) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { active: true });
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
    if (fCounties.length) cl.push(["in", ["get", "county"], ["literal", fCounties]]);
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
    if (fCounties.length) cl.push(["in", ["get", "county"], ["literal", fCounties]]);
    const filter = cl.length ? (["all", ...cl] as maplibregl.FilterSpecification) : null;
    map.setFilter("wells", filter);
    // Wellbore tile features carry their surface well's attributes (joined
    // server-side), so the SAME filter keeps wells and laterals in lockstep.
    if (map.getLayer("wellbores")) map.setFilter("wellbores", filter);
  }

  // Recompute the period-attributed production points from current filters, then
  // render. Called whenever the data, period, or filters change.
  function recomputeHeat() {
    const h = heatRef.current;
    const spec = periodWindow(h.period, latestMonth(prod), h.from, h.to);
    periodLabelRef.current = spec.label;
    heatPointsRef.current = buildPoints(heatWells.current, perLease.current, prod as never, spec,
      { counties: fCounties, operators: fOperators, wellTypes: fWellTypes, wellStatuses: fWellStatuses, formations: fFormations });
    setRank(heatPointsRef.current.length ? rankings(heatPointsRef.current) : null);
    pushHeat();
  }

  // Render current points into the heat sources + overlays, normalizing weights to
  // the max within the current viewport so the gradient is meaningful at any zoom.
  function pushHeat() {
    const map = mapRef.current; if (!map || !styleReady.current) return;
    const h = heatRef.current;
    const pts = heatPointsRef.current;
    const b = map.getBounds();
    const bounds: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const inView = pts.filter((p) => p.lon >= bounds[0] && p.lon <= bounds[2] && p.lat >= bounds[1] && p.lat <= bounds[3]);
    const basis = inView.length ? inView : pts;
    const normOil = Math.max(1, ...basis.map((p) => p.oil));
    const normGas = Math.max(1, ...basis.map((p) => p.gas));
    setHeatScale({ oil: normOil > 1 ? normOil : 0, gas: normGas > 1 ? normGas : 0 });
    (map.getSource("heat-oil") as maplibregl.GeoJSONSource | undefined)?.setData(metricGeojson(pts, "oil", h.min, h.max, normOil) as unknown as GeoJSON.FeatureCollection);
    (map.getSource("heat-gas") as maplibregl.GeoJSONSource | undefined)?.setData(metricGeojson(pts, "gas", h.min, h.max, normGas) as unknown as GeoJSON.FeatureCollection);

    // Top-producer overlay: highest-BOE wells in view.
    const top = [...inView].sort((a, b2) => boe(b2.oil, b2.gas) - boe(a.oil, a.gas)).slice(0, 15);
    (map.getSource("heat-top") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: top.map((p, i) => ({ type: "Feature", properties: { rank: i }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })),
    } as unknown as GeoJSON.FeatureCollection);

    // Hotspot detection within the current extent.
    const hs = h.hotspots ? detectHotspots(pts, bounds) : [];
    setHotspots(hs);
    (map.getSource("heat-hotspots") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: hs.map((s) => ({ type: "Feature", properties: { label: `${s.wells} wells · ${num(Math.round(boe(s.oil, s.gas)))} BOE` }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })),
    } as unknown as GeoJSON.FeatureCollection);

    applyHeatPaint();
  }

  function applyHeatPaint() {
    const map = mapRef.current; if (!map || !styleReady.current) return;
    const h = heatRef.current;
    const rad = (base: number): maplibregl.ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], 8, base * 0.5, 12, base, 15, base * 1.8] as unknown as maplibregl.ExpressionSpecification;
    for (const id of ["heat-oil", "heat-gas"]) {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "heatmap-radius", rad(h.radius));
      map.setPaintProperty(id, "heatmap-intensity", ["interpolate", ["linear"], ["zoom"], 8, h.intensity, 15, h.intensity * 1.4] as unknown as maplibregl.ExpressionSpecification);
      map.setPaintProperty(id, "heatmap-opacity", h.opacity);
    }
    applyHeatVisibility();
  }

  function applyHeatVisibility() {
    const map = mapRef.current; if (!map || !styleReady.current) return;
    const h = heatRef.current;
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("heat-oil", h.oil); vis("heat-gas", h.gas);
    const anyHeat = h.oil || h.gas;
    vis("heat-top", anyHeat && h.topProducers);
    vis("heat-hotspots-ring", anyHeat && h.hotspots);
    vis("heat-hotspots-label", anyHeat && h.hotspots);
  }

  function loadDeals() { const qs = new URLSearchParams(); qs.set("status", statusFilter); api.get<MapDeal[]>(`/map/deals?${qs.toString()}`).then(setDeals); }
  useEffect(loadDeals, [statusFilter]);
  useEffect(() => {
    // Merge every county's monthly production. Keys are og|district|leaseNo and
    // RRC lease numbers are unique within a district, so counties don't collide.
    // B5: counties imported into rrc.production come from the API (10-year
    // window); the rest still ship as static per-county JSON assets.
    const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
    Promise.all(
      COUNTIES_WITH_PRODUCTION.map(async (k) => {
        try {
          const fromApi = await api.get<Record<string, [number, number, number][]>>(
            `/gis/production?county=${encodeURIComponent(cap(k))}`,
          );
          if (Object.keys(fromApi).length) return fromApi;
        } catch { /* fall back to the static asset */ }
        return fetch(`/data/${k}-production.json`).then((r) => r.json()).catch(() => ({}));
      }),
    ).then((parts) => setProd(Object.assign({}, ...parts))).catch(() => {});
  }, []);
  useEffect(applyHighlight, [dealsByAbstract]);
  useEffect(applyLayerVisibility, [layers]);
  // Survey/abstract filter option lists from the GIS API, scoped to the selected
  // counties. Nothing needs to be on-screen (or downloaded) to be filterable.
  useEffect(() => {
    const qs = fCounties.length ? `?counties=${encodeURIComponent(fCounties.join(","))}` : "";
    api.get<typeof gisOptions>(`/gis/options${qs}`)
      .then(setGisOptions)
      .catch(() => setGisOptions({ surveys: [], abstracts: [], wellTypes: [], wellStatuses: [], operators: [], wellCount: 0 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fCounties]);
  // Debounced unified search — one round-trip covers every entity type.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setSug(null); return; }
    const t = setTimeout(() => {
      api.get<Suggest>(`/gis/suggest?q=${encodeURIComponent(q)}`).then(setSug).catch(() => setSug(null));
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(applyAbstractFilter, [fCounties, fSurveys, fAbstracts]);
  useEffect(applyWellFilter, [fCounties, fSurveys, fAbstracts, fWellTypes, fWellStatuses, fOperators]);
  // Rebuild heat points whenever the data, filters, period, or thresholds change.
  useEffect(() => { if (heatReady) recomputeHeat(); /* eslint-disable-next-line */ },
    [heatReady, prod, fCounties, fOperators, fWellTypes, fWellStatuses, fFormations, heat.period, heat.from, heat.to, heat.min, heat.max, heat.oil, heat.gas, heat.hotspots]);
  // Cheap paint/visibility tweaks don't need a recompute.
  useEffect(() => { applyHeatPaint(); /* eslint-disable-next-line */ }, [heat.intensity, heat.radius, heat.opacity]);
  useEffect(() => { applyHeatVisibility(); /* eslint-disable-next-line */ }, [heat.topProducers, heat.oil, heat.gas, heat.hotspots]);

  function fitBbox(bbox: BBox | null | undefined): void {
    const map = mapRef.current; if (!map || !bbox) return;
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 60, maxZoom: 13, duration: 800 });
  }
  // Frame a deal/asset by the union bbox of its abstracts' geometry.
  async function zoomToAbstracts(ids: string[]): Promise<void> {
    const map = mapRef.current; if (!map || !ids.length) return;
    try {
      const fc = await api.get<FC>(`/gis/features?ids=${encodeURIComponent(ids.join(","))}`);
      let minx = 180, miny = 90, maxx = -180, maxy = -90;
      const walk = (c: unknown): void => {
        if (Array.isArray(c) && typeof c[0] === "number") {
          const [x, y] = c as number[];
          if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        } else if (Array.isArray(c)) c.forEach(walk);
      };
      for (const f of fc.features) walk(f.geometry.coordinates);
      if (minx <= maxx) fitBbox([minx, miny, maxx, maxy]);
    } catch { /* footprint unavailable */ }
  }
  function pushRecent(r: Recent): void {
    setRecents((prev) => {
      const next = [r, ...prev.filter((x) => !(x.t === r.t && x.label === r.label))].slice(0, 8);
      try { sessionStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }
  /** One dispatcher for both live results and recents. */
  function runSearchAction(t: keyof Suggest, label: string, sub: string, p: Record<string, unknown>): void {
    switch (t) {
      case "counties": fitBbox(p.bbox as BBox); break;
      case "abstracts": void selectAbstractById(String(p.id)); break;
      case "wells": void openWell(Number(p.fid), true); break;
      case "operators": setFOperators((prev) => (prev.includes(String(p.name)) ? prev : [...prev, String(p.name)])); fitBbox(p.bbox as BBox | null); break;
      case "formations": setFFormations((prev) => (prev.includes(String(p.name)) ? prev : [...prev, String(p.name)])); fitBbox(p.bbox as BBox | null); break;
      case "fields": fitBbox(p.bbox as BBox | null); break;
      case "deals": case "assets": void zoomToAbstracts((p.abstractIds as string[]) ?? []); break;
    }
    pushRecent({ t, label, sub, p });
    setQuery(""); setSug(null); setSearchFocus(false);
  }
  // Grouped, server-ranked results flattened for rendering.
  const results = useMemo(() => {
    if (!sug) return [] as { t: keyof Suggest; label: string; sub: string; p: Record<string, unknown> }[];
    const out: { t: keyof Suggest; label: string; sub: string; p: Record<string, unknown> }[] = [];
    for (const c of sug.counties) out.push({ t: "counties", label: c.label, sub: "Go to county", p: { bbox: c.bbox } });
    for (const a of sug.abstracts) out.push({ t: "abstracts", label: a.label, sub: a.sub, p: { id: a.id } });
    for (const w of sug.wells) out.push({ t: "wells", label: w.label, sub: w.sub, p: { fid: w.fid } });
    for (const o of sug.operators) out.push({ t: "operators", label: o.name, sub: o.sub, p: { name: o.name, bbox: o.bbox } });
    for (const f of sug.fields) out.push({ t: "fields", label: f.name, sub: f.sub, p: { bbox: f.bbox } });
    for (const f of sug.formations) out.push({ t: "formations", label: f.name, sub: f.sub, p: { name: f.name, bbox: f.bbox } });
    for (const d of sug.deals) out.push({ t: "deals", label: d.label, sub: d.sub, p: { abstractIds: d.abstractIds } });
    for (const d of sug.assets) out.push({ t: "assets", label: d.label, sub: d.sub, p: { abstractIds: d.abstractIds } });
    return out;
  }, [sug]);

  const panelDeals = selected?.kind === "abstract" ? dealsByAbstract.get(selected.id) ?? [] : [];
  const abstractCount = dealsByAbstract.size;
  const toggle = (k: keyof typeof layers) => setLayers((p) => ({ ...p, [k]: !p[k] }));

  // Saved presets: capture the current layers + camera, reapply, or delete.
  function saveCurrentPreset() {
    const m = mapRef.current; const name = presetName.trim();
    if (!m || !name) return;
    const c = m.getCenter();
    const preset: MapPreset = { name, layers: layersRef.current, view: { center: [c.lng, c.lat], zoom: m.getZoom() } };
    const next = [...presets.filter((p) => p.name !== name), preset];
    setPresets(next); saveJson(MAP_PRESETS_KEY, next); setPresetName("");
  }
  function applyPreset(p: MapPreset) {
    setLayers({ ...DEFAULT_MAP_LAYERS, ...p.layers });
    mapRef.current?.jumpTo({ center: p.view.center, zoom: p.view.zoom });
  }
  function deletePreset(name: string) {
    const next = presets.filter((p) => p.name !== name);
    setPresets(next); saveJson(MAP_PRESETS_KEY, next);
  }
  function resetMapView() {
    setLayers(DEFAULT_MAP_LAYERS);
    mapRef.current?.jumpTo({ center: LEON_CENTER, zoom: 10 });
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header"><div className="row"><h1 style={{ marginBottom: 0 }}>Map</h1><span className="muted">Texas · {COUNTIES.length} counties · abstracts stream as you pan &amp; zoom</span></div></div>

      <div className="row" style={{ marginBottom: 12, gap: 10, position: "relative" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 480 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocus(true)}
            onClick={() => setSearchFocus(true)}
            onBlur={() => setTimeout(() => setSearchFocus(false), 150)}
            placeholder="Search wells, API #, abstracts, operators, fields, deals…"
            aria-label="Search the map"
          />
          {searchFocus && query.trim().length < 2 && recents.length > 0 && (
            <div className="msel-menu map-search-menu" style={{ top: "100%" }}>
              <div className="map-search-group">Recent searches</div>
              {recents.map((r, i) => (
                <div className="msel-opt" key={`${r.t}-${r.label}-${i}`} onMouseDown={() => runSearchAction(r.t, r.label, r.sub, r.p)}>
                  <strong>{r.label}</strong> {r.sub && <span className="muted">· {r.sub}</span>}
                  <span className="map-search-kind">{GROUP_LABELS[r.t]}</span>
                </div>
              ))}
            </div>
          )}
          {query.trim().length >= 2 && results.length > 0 && (
            <div className="msel-menu map-search-menu" style={{ top: "100%" }}>
              {results.map((r, i) => (
                <div key={`${r.t}-${r.label}-${i}`}>
                  {(i === 0 || results[i - 1].t !== r.t) && <div className="map-search-group">{GROUP_LABELS[r.t]}</div>}
                  <div className="msel-opt" onMouseDown={() => runSearchAction(r.t, r.label, r.sub, r.p)}>
                    <strong>{r.label}</strong> {r.sub && <span className="muted">· {r.sub}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {query.trim().length >= 2 && sug && results.length === 0 && (
            <div className="msel-menu map-search-menu" style={{ top: "100%" }}>
              <div className="msel-opt muted">No matches for “{query.trim()}”</div>
            </div>
          )}
        </div>
        <div className="spacer" />
        <button className={`mc-btn ${showFilters ? "active" : ""}`} onClick={() => { setShowFilters((s) => !s); setShowLayers(false); setShowHeat(false); }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
          Filters
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
        <button className={`mc-btn ${showLayers ? "active" : ""}`} onClick={() => { setShowLayers((s) => !s); setShowFilters(false); setShowHeat(false); }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
          Layers
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
        <button className={`mc-btn ${showHeat ? "active" : ""} ${heatActive ? "hot" : ""}`} onClick={() => { setShowHeat((s) => !s); setShowFilters(false); setShowLayers(false); }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2c3 4.5 6 7.5 6 11a6 6 0 01-12 0c0-1.5.5-3 1.5-4.5C8.5 10 10.5 7 12 2z" /></svg>
          Heat map
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
      </div>

      {showFilters && (
        <div className="panel mc-panel" style={{ marginBottom: 12 }}>
          <div className="mc-note">
            Filters apply to all GIS data on the map (wells, abstracts, surveys) — independent of whether a deal exists. <b>"Deal status"</b> only affects the deal highlight.
          </div>
          <div className="mc-grid">
            <div><div className="ddx-label mc-lbl">Deal status</div><Select value={statusFilter} onChange={setStatusFilter} ariaLabel="Deal status" options={STATUS_OPTIONS.map(([v, l]) => ({ value: v, label: l }))} /></div>
            <div><div className="ddx-label mc-lbl">County</div><SearchableMultiSelect options={meta.counties} value={fCounties} onChange={setFCounties} placeholder="Counties…" /></div>
            <div><div className="ddx-label mc-lbl">Survey</div><SearchableMultiSelect options={gisOptions.surveys} value={fSurveys} onChange={setFSurveys} placeholder="Surveys…" /></div>
            <div><div className="ddx-label mc-lbl">Abstract</div><SearchableMultiSelect options={gisOptions.abstracts} value={fAbstracts} onChange={setFAbstracts} placeholder="Abstracts…" /></div>
            <div><div className="ddx-label mc-lbl">Well type</div><SearchableMultiSelect options={gisOptions.wellTypes} value={fWellTypes} onChange={setFWellTypes} placeholder="Well types…" /></div>
            <div><div className="ddx-label mc-lbl">Well status</div><SearchableMultiSelect options={gisOptions.wellStatuses} value={fWellStatuses} onChange={setFWellStatuses} placeholder="Well statuses…" /></div>
            <div><div className="ddx-label mc-lbl">Operator <span className="mc-count">({gisOptions.operators.length})</span></div><SearchableMultiSelect options={gisOptions.operators} value={fOperators} onChange={setFOperators} placeholder="Operators…" /></div>
            <div><div className="ddx-label mc-lbl">Formation <span className="mc-count">({scoped.formations.length})</span></div><SearchableMultiSelect options={scoped.formations} value={fFormations} onChange={setFFormations} placeholder="Formations…" /></div>
          </div>
        </div>
      )}

      {showLayers && (
        <div className="panel mc-panel" style={{ marginBottom: 12 }}>
          <MapLayersPanel
            defs={[
              { key: "boundaries", label: "Abstract boundaries" }, { key: "absNums", label: "Abstract numbers" },
              { key: "surveyNames", label: "Survey names" }, { key: "deals", label: "Active deals" },
              { key: "wells", label: "Wells" }, { key: "wellbores", label: "Wellbores (laterals)" },
            ]}
            layers={layers}
            onToggle={(k) => toggle(k as keyof typeof layers)}
          />
          {/* Saved presets: layer visibility + camera are remembered as your
              default; save named presets to jump between setups. */}
          <div className="mc-presets">
            <span className="ddx-label">Saved views</span>
            <div className="mc-presets-row">
              {presets.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>Your layers &amp; last position are remembered. Save a named preset to switch quickly.</span>}
              {presets.map((p) => (
                <span key={p.name} className="mc-preset-chip">
                  <button type="button" className="mc-preset-apply" onClick={() => applyPreset(p)}>{p.name}</button>
                  <button type="button" className="mc-preset-del" title="Delete preset" onClick={() => deletePreset(p.name)}>×</button>
                </span>
              ))}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input value={presetName} onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveCurrentPreset(); } }}
                placeholder="Name this view" style={{ width: 170 }} />
              <button type="button" className="small" disabled={!presetName.trim()} onClick={saveCurrentPreset}>Save current view</button>
              <button type="button" className="small" onClick={resetMapView}>Restore default</button>
            </div>
          </div>
        </div>
      )}

      {showHeat && (
        <div className="panel mc-panel" style={{ marginBottom: 12 }}>
          <div className="mc-heat">
            <div>
              <div className="mc-dot-lbl"><span className="va-dot" style={{ background: "#f59e0b" }} /><span className="ddx-label">Layers</span></div>
              <div className="mc-pills-row" style={{ padding: 0 }}>
                <PillToggle on={heat.oil} label="Oil production" onClick={() => setHeatK("oil", !heat.oil)} />
                <PillToggle on={heat.gas} label="Gas production" onClick={() => setHeatK("gas", !heat.gas)} />
                <PillToggle on={heat.topProducers} label="Top producers" onClick={() => setHeatK("topProducers", !heat.topProducers)} />
                <PillToggle on={heat.hotspots} label="Hotspot labels" onClick={() => setHeatK("hotspots", !heat.hotspots)} />
              </div>
              <div className="ddx-label mc-lbl" style={{ marginTop: 16 }}>Production period</div>
              <Select value={heat.period} onChange={(v) => setHeatK("period", v as HeatPeriod)} ariaLabel="Heat map period"
                options={[
                  { value: "current", label: "Current month" },
                  { value: "3m", label: "Last 3 months" },
                  { value: "6m", label: "Last 6 months" },
                  { value: "12m", label: "Last 12 months" },
                  { value: "3y", label: "Last 3 years" },
                  { value: "ytd", label: "Year to date" },
                  { value: "all", label: "Cumulative (all history)" },
                  { value: "custom", label: "Custom range" },
                ]} />
              {heat.period === "custom" && (
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <div style={{ flex: 1 }}><div className="ddx-label mc-lbl">From</div><input type="month" value={heat.from} onChange={(e) => setHeatK("from", e.target.value)} /></div>
                  <div style={{ flex: 1 }}><div className="ddx-label mc-lbl">To</div><input type="month" value={heat.to} onChange={(e) => setHeatK("to", e.target.value)} /></div>
                </div>
              )}
            </div>
            <div className="mc-heat-mid">
              <div className="mc-dot-lbl"><span className="va-dot" style={{ background: "var(--accent)" }} /><span className="ddx-label">Appearance</span></div>
              <Slider label="Intensity" min={0.2} max={3} step={0.1} value={heat.intensity} onChange={(v) => setHeatK("intensity", v)} />
              <Slider label="Radius" min={8} max={80} step={1} value={heat.radius} onChange={(v) => setHeatK("radius", v)} suffix="px" />
              <Slider label="Opacity" min={0.1} max={1} step={0.05} value={heat.opacity} onChange={(v) => setHeatK("opacity", v)} />
            </div>
            <div>
              <div className="mc-dot-lbl"><span className="va-dot" style={{ background: "#22c55e" }} /><span className="ddx-label">Production thresholds</span><span className="muted" style={{ fontSize: 11.5 }}>(per well, period)</span></div>
              <div className="ddx-label mc-lbl">Minimum</div>
              <input type="number" value={heat.min || ""} onChange={(e) => setHeatK("min", Number(e.target.value) || 0)} placeholder="no minimum" />
              <div className="ddx-label mc-lbl" style={{ marginTop: 10 }}>Maximum</div>
              <input type="number" value={heat.max || ""} onChange={(e) => setHeatK("max", Number(e.target.value) || 0)} placeholder="no maximum" />
              <p className="muted" style={{ fontSize: 11.5, margin: "8px 0 0" }}>Oil in bbl, gas in mcf. Wells outside the range drop from the heat.</p>
            </div>
          </div>
          {rank && (heat.oil || heat.gas) && (
            <div className="mc-rank">
              <div className="ddx-label" style={{ marginBottom: 6 }}>Production ranking · {periodLabelRef.current}</div>
              <div className="dd-grid">
                <RankList title="Top counties" rows={rank.counties} />
                <RankList title="Top operators" rows={rank.operators} />
                <RankList title="Top formations" rows={rank.formations} />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted">{deals == null ? "…" : `${deals.length} deal${deals.length === 1 ? "" : "s"} · ${abstractCount} highlighted · ${num(gisOptions.wellCount)} wells`}</span>
      </div>

      {/* dvh tracks the real visible viewport on mobile (URL bar collapse). */}
      <div style={{ position: "relative", height: "calc(100dvh - 250px)", minHeight: 320, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
        <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />
        {!deals && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}><Spinner label="Loading map…" /></div>}

        <div style={{ position: "absolute", left: 12, bottom: 26, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
          {heatActive ? (
            <div style={{ minWidth: 160 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 4 }}>Production intensity · {periodLabelRef.current}</div>
              <div style={{ height: 10, borderRadius: 5, background: `linear-gradient(90deg, ${HEAT_STOPS.map(([s, c]) => `${c} ${s * 100}%`).join(", ")})` }} />
              <div className="row" style={{ justifyContent: "space-between", fontSize: 11 }}><span>0</span><span>Peak in view</span></div>
              {/* Numeric range represented by the ramp, per active metric. */}
              {heat.oil && heatScale.oil > 0 && <div className="muted" style={{ fontSize: 11 }}>Oil: 0 – {num(Math.round(heatScale.oil))} bbl / well</div>}
              {heat.gas && heatScale.gas > 0 && <div className="muted" style={{ fontSize: 11 }}>Gas: 0 – {num(Math.round(heatScale.gas))} MCF / well</div>}
              <div className="row" style={{ gap: 12, marginTop: 4 }}>
                {heat.oil && <span className="row" style={{ gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#dc2626" }} />Oil</span>}
                {heat.gas && <span className="row" style={{ gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#6d28d9" }} />Gas</span>}
                {heat.topProducers && <span className="row" style={{ gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#facc15", border: "1.5px solid #78350f" }} />Top well</span>}
              </div>
            </div>
          ) : (
            <>
              <Legend color="#22c55e" label="Producing" /><Legend color="#f59e0b" label="Shut-in" /><Legend color="#6b7280" label="Plugged" />
              <Legend color="#3b82f6" label="Permitted" /><Legend color="#78350f" label="Dry hole" /><Legend color="#7c3aed" label="Injection/Disposal" />
              {layers.wellbores && <Legend color="#0f766e" label="Wellbore (lateral)" line />}
            </>
          )}
        </div>

        {/* Heat hover tooltip — what the colors under the cursor represent. */}
        {heatActive && heatHover && (
          <div className="heat-tip" style={{ left: heatHover.x + 14, top: heatHover.y + 14 }}>
            <div><strong>{heatHover.wells}</strong> producing well{heatHover.wells === 1 ? "" : "s"} nearby</div>
            {heat.oil && <div>Oil: <strong>{num(Math.round(heatHover.oil))}</strong> bbl</div>}
            {heat.gas && <div>Gas: <strong>{num(Math.round(heatHover.gas))}</strong> MCF</div>}
            <div className="muted" style={{ fontSize: 10 }}>{periodLabelRef.current} · click for full breakdown</div>
          </div>
        )}

        {/* Overlap chooser */}
        {choices && (
          <div style={{ position: "absolute", top: 12, right: 12, width: 300, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow)", padding: 16 }}>
            <div className="section-head"><h3 style={{ margin: 0 }}>{choices.length} wells here</h3><button className="icon-btn" onClick={() => setChoices(null)}>×</button></div>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Pick the well you meant:</p>
            {choices.map((w) => (
              <div key={w.fid} className="msel-opt" style={{ borderTop: "1px solid var(--border)" }} onClick={() => void openWell(w.fid)}>
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
                  <KV k="Spud/permit" v={selected.spudDate} /><KV k="Plugged" v={selected.plugDate} />
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
                  const key = selected.leaseNo ? `${selected.oilGas === "Gas" ? "G" : "O"}|${selected.district ?? "05"}|${selected.leaseNo}` : null;
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
                {(selected.permits?.length ?? 0) > 0 && (
                  <>
                    <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 10 }}>Permit history (RRC W-1)</div>
                    {selected.permits!.slice(0, 5).map((p) => (
                      <div key={p.statusNo} className="row" style={{ justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.operator || "—"}{p.wellNo ? ` #${p.wellNo}` : ""}</span>
                        <span className="muted" style={{ whiteSpace: "nowrap" }}>{p.permitDate?.slice(0, 10) ?? "—"}</span>
                      </div>
                    ))}
                  </>
                )}
                {(selected.completions?.length ?? 0) > 0 && (
                  <>
                    <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 10 }}>Completion filings (W-2/G-1)</div>
                    {selected.completions!.slice(0, 5).map((c) => (
                      <div key={c.trackingNo} className="row" style={{ justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.fieldName || c.filingType || "Filing"}</span>
                        <span className="muted" style={{ whiteSpace: "nowrap" }}>{(c.completionDate ?? c.filedDate)?.slice(0, 10) ?? "—"}</span>
                      </div>
                    ))}
                  </>
                )}
                {/* fid resolves the exact rrc well (production is read live from
                    the centralized dataset); the API label is a readable fallback. */}
                <Link className="primary" to={`/valuation?fid=${selected.fid}&well=${encodeURIComponent(selected.api || selected.api8 || "")}`}
                  style={{ display: "flex", justifyContent: "center", marginTop: 12, padding: "8px 12px", borderRadius: 8 }}>
                  Open in Well Analysis →
                </Link>
                <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Operator, lease, field, dates, permits, and completions are from RRC records (lease-level; oil is reported per lease). Formation shows where a W-2 was filed.</p>
              </>
            ) : selected.kind === "hotspot" ? (
              <>
                <div className="section-head"><div><h3 style={{ margin: 0 }}>Production summary</h3><div className="muted" style={{ fontSize: 12 }}>{selected.summary.wells} contributing well{selected.summary.wells === 1 ? "" : "s"} · {selected.periodLabel}</div></div><button className="icon-btn" onClick={clearSelection}>×</button></div>
                <div className="dd-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <KV k="Total oil (bbl)" v={num(Math.round(selected.summary.oil))} /><KV k="Total gas (MCF)" v={num(Math.round(selected.summary.gas))} />
                  <KV k="Avg oil / well" v={num(Math.round(selected.summary.avgOil))} /><KV k="Avg gas / well" v={num(Math.round(selected.summary.avgGas))} />
                </div>
                {selected.summary.topOperators.length > 0 && (
                  <>
                    <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 10 }}>Top operators</div>
                    {selected.summary.topOperators.map((o) => (
                      <div key={o.name} className="row" style={{ justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.name}</span>
                        <span className="muted" style={{ whiteSpace: "nowrap" }}>{num(Math.round(boe(o.oil, o.gas)))} BOE · {o.wells}w</span>
                      </div>
                    ))}
                  </>
                )}
                {selected.summary.topWells.length > 0 && (
                  <>
                    <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 10 }}>Top-producing wells</div>
                    {selected.summary.topWells.map((w, i) => (
                      <div key={i} className="row" style={{ justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.leaseName || w.api || "Well"}{w.operator ? ` · ${w.operator}` : ""}</span>
                        <span className="muted" style={{ whiteSpace: "nowrap" }}>{num(Math.round(boe(w.oil, w.gas)))} BOE</span>
                      </div>
                    ))}
                  </>
                )}
                <div className="dd-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 10 }}>
                  <KV k="Counties" v={selected.summary.counties.join(", ")} />
                  <KV k="Abstracts" v={selected.summary.abstracts.slice(0, 8).join(", ")} />
                </div>
                {selected.summary.surveys.length > 0 && <div className="kv" style={{ marginTop: 6 }}><span className="k">Surveys</span><span className="v wrap">{selected.summary.surveys.slice(0, 8).join(", ")}</span></div>}
                <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Totals attribute each lease's production evenly across its wells. BOE = oil + gas/6. Click elsewhere to summarize another area.</p>
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

function Legend({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return <div className="row" style={{ gap: 8, marginTop: 4 }}><span style={{ width: 12, height: line ? 3 : 12, background: color, opacity: 0.9, borderRadius: line ? 0 : "50%", display: "inline-block" }} /> {label}</div>;
}
function Slider({ label, min, max, step, value, onChange, suffix }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div className="mc-slider">
      <div className="mc-slider-head"><span>{label}</span><span className="mc-slider-val">{value}{suffix ?? ""}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
function RankList({ title, rows }: { title: string; rows: { name: string; oil: number; gas: number; wells: number }[] }) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label>{title}</label>
      {rows.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>—</div> : rows.map((r) => (
        <div key={r.name} className="row" style={{ justifyContent: "space-between", fontSize: 13, padding: "2px 0" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name || "(unknown)"}</span>
          <span className="muted" style={{ whiteSpace: "nowrap" }}>{num(Math.round(boe(r.oil, r.gas)))}</span>
        </div>
      ))}
    </div>
  );
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
  const [copied, setCopied] = useState(false);
  const text = typeof v === "string" || typeof v === "number" ? String(v) : null;
  const canCopy = text != null && text !== "" && text !== "—";
  const doCopy = () => { if (!text) return; navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  return (
    <div className="kv kv-copy">
      <span className="k">{k}</span>
      <span className="v">{v || "—"}
        {canCopy && <button type="button" className="kv-copy-btn" title={copied ? "Copied" : "Copy"} onClick={doCopy}>{copied ? "✓" : "⧉"}</button>}
      </span>
    </div>
  );
}
