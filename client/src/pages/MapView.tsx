import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { US_STATE_OPTIONS, US_STATE_LABELS } from "../lib/options";
import { Select } from "../components/Select";
import { downloadCsv } from "../lib/csv";
import { COUNTIES, COUNTIES_WITH_WELLS, COUNTIES_WITH_PRODUCTION } from "../lib/counties";
import { addCadastralLayers, addTractLayers, tractInfo, TRACT_SOURCE, STATUS_COLOR, type TractInfo, styleWithGlyphs, watchGisHealth } from "../lib/mapLayers";
import { collectCoords, bboxOfPoints } from "../lib/geo";
import { FormSection } from "../components/kit";
import { MapLayersPanel } from "../components/MapLayersPanel";
import { MapShpImport } from "../components/MapShpImport";
import { useAbstractIndex } from "../components/AbstractPicker";
import { PHONE_QUERY } from "../lib/mobile";
import { abstractShortLabel, countyStateLabel, formatAbstract, rankAbstracts, surveyLabel } from "../lib/abstracts";
import { useAuth } from "../auth/AuthContext";
import { Spinner, StageBadge, PriorityBadge, ChipList } from "../components/ui";
import { money, num } from "../lib/format";
import {
  extractWells, wellsPerLease, buildPoints, latestMonth, periodWindow, metricGeojson,
  summarize, rankings, detectHotspots, boe,
  type HeatWell, type HeatPoint, type HeatPeriod, type AreaSummary, type Rankings, type Hotspot,
} from "../lib/heatmap";

interface MapDeal {
  id: string; abstractIds: string[]; name: string; stage: string;
  /** OWNED_ASSET here is always an asset actively marketed for sale. */
  recordType?: "OPPORTUNITY" | "OWNED_ASSET";
  priority: "HIGH" | "MEDIUM" | "LOW"; counties: string[]; state: string | null;
  operator: string | null; assetTypes: string[]; basins: string[]; formations: string[];
  acreageNma: number | null; nra: number | null; askPrice: number | null;
  profitEst: number | null; selectedBuyer: { id: string; name: string } | null;
}
/** An owned mineral asset on HOLD — shown as a Mineral Asset, never a deal. */
interface MapAsset {
  id: string; abstractIds: string[]; name: string; operator: string | null; assetTypes: string[];
  acreageNma: number | null; nra: number | null; counties: string[]; state: string | null;
}
type FC = { type: "FeatureCollection"; features: GeoFeature[] };
type GeoFeature = { type: "Feature"; id?: number; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
type SelAbstract = { kind: "abstract"; id: string; abstract: string; survey: string; county: string };
type WellPermit = { statusNo: string; permitDate: string | null; operator: string | null; leaseName: string | null; wellNo: string | null; acres: number | null; survey: string | null; abstract: string | null };
type WellCompletion = { trackingNo: string; filingType: string | null; status: string | null; filedDate: string | null; completionDate: string | null; fieldName: string | null };
type WellProps = { fid: number; api: string; api8: string; wellNo: string | null; wellId: string; symbol: string; type: string; status: string; county: string; abstract: string | null; survey: string | null; operator: string | null; leaseName: string | null; leaseNo: string | null; field: string | null; oilGas: string | null; district: string | null; cumOil: number | null; cumGas: number | null; lastProd: string | null; formations: string | null; unitAcres?: number | null; spudDate?: string | null; plugDate?: string | null; permits?: WellPermit[]; completions?: WellCompletion[] };
type SelWell = { kind: "well" } & WellProps;
type SelHotspot = { kind: "hotspot"; summary: AreaSummary; periodLabel: string };
type SelTract = { kind: "tract" } & TractInfo;
type Selected = SelAbstract | SelWell | SelHotspot | SelTract | null;

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

// Map view personalization: the user's default visible layers, last camera
// position, and named filter presets — all remembered locally per browser.
const MAP_LAYERS_KEY = "mh-map-layers:v1";
// Which side the Filters / Heat panel docks on. Persisted so the choice
// survives closing the app.
const MAP_DOCK_KEY = "mh-map-dock:v1";
const MAP_VIEW_KEY = "mh-map-view:v1";
const MAP_FILTERS_KEY = "mh-map-filters:v1";
type MapLayers = { boundaries: boolean; absNums: boolean; surveyNames: boolean; deals: boolean; assets: boolean; wells: boolean; wellbores: boolean; tracts: boolean };
const DEFAULT_MAP_LAYERS: MapLayers = { boundaries: true, absNums: true, surveyNames: true, deals: true, assets: true, wells: true, wellbores: true, tracts: true };
interface MapCam { center: [number, number]; zoom: number }
/** A named, reusable combination of every filter on the Filters panel. */
interface MapFilterState {
  status: string; states?: string[]; counties: string[]; surveys: string[]; abstracts: string[];
  wellTypes: string[]; wellStatuses: string[]; operators: string[]; formations: string[];
}
interface FilterPreset { name: string; filters: MapFilterState }
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
const DEFAULT_HEAT: HeatState = { oil: false, gas: false, intensity: 1.6, radius: 48, opacity: 0.85, min: 0, max: 0, period: "12m", from: "", to: "", topProducers: false, hotspots: true };


const STATUS_OPTIONS = [
  ["ACTIVE", "Active deals"], ["ALL", "All linked deals"], ["UNDER_CONTRACT", "Under Contract"],
  ["PREPARING_PACKAGE", "Preparing Package"], ["SENT_TO_BUYERS", "Sent to Buyers"], ["NEGOTIATING", "Negotiating"],
  ["CLOSING", "Closing"], ["CLOSED", "Closed"], ["DEAD", "Dead"],
] as const;

export function MapView() {
  const { can } = useAuth();
  const mapContainer = useRef<HTMLDivElement>(null);
  // The map fills all vertical space from its top down to the footer — measured
  // (not a fixed offset) so there's never blank space below it.
  const mapWrap = useRef<HTMLDivElement>(null);
  const [mapH, setMapH] = useState<number>(0);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReady = useRef(false);
  const activeIds = useRef<string[]>([]);
  const ownedIds = useRef<string[]>([]);
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
  const [assets, setAssets] = useState<MapAsset[]>([]);
  const [selected, setSelected] = useState<Selected>(null);
  const [choices, setChoices] = useState<WellProps[] | null>(null); // overlap disambiguation
  const [layers, setLayers] = useState<MapLayers>(() => ({ ...DEFAULT_MAP_LAYERS, ...loadJson<Partial<MapLayers>>(MAP_LAYERS_KEY, {}) }));
  const [dock, setDock] = useState<"left" | "right">(() => (loadJson<string>(MAP_DOCK_KEY, "left") === "right" ? "right" : "left"));
  useEffect(() => { saveJson(MAP_DOCK_KEY, dock); }, [dock]);
  const layersRef = useRef(layers); layersRef.current = layers;
  useEffect(() => { saveJson(MAP_LAYERS_KEY, layers); }, [layers]);
  // Saved filter presets (named filter combinations), remembered per browser.
  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(() => loadJson<FilterPreset[]>(MAP_FILTERS_KEY, []));
  const [filterName, setFilterName] = useState("");
  // "Save current" expands into the name field + Save / Cancel.
  const [saveOpen, setSaveOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  // Full-screen viewing mode: the page becomes a fixed overlay filling the
  // viewport. Nothing remounts — search, filters, hotspots, layers, zoom,
  // position, and popups all carry across the toggle untouched.
  const [fullscreen, setFullscreen] = useState(false);
  // The legend card collapses to its header; on phones it starts collapsed so
  // it doesn't cover the map.
  const [legendOpen, setLegendOpen] = useState(() => !window.matchMedia(PHONE_QUERY).matches);
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [fStates, setFStates] = useState<string[]>([]);
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
  // Abstract filter values stay the bare GIS labels the extent API expects;
  // they DISPLAY with survey + county + state and rank by number as you type.
  const absIndex = useAbstractIndex();
  const abstractFilterLabels = useMemo(
    () => Object.fromEntries(gisOptions.abstracts.map((a) => [a, absIndex.labelAmong(a, fCounties)])),
    [gisOptions.abstracts, absIndex, fCounties],
  );
  const rankAbstractFilter = useCallback((opts: readonly string[], q: string) =>
    q.trim() ? rankAbstracts(opts, q, (a) => ({ abstract: a, text: abstractFilterLabels[a] ?? a })) : [...opts],
  [abstractFilterLabels]);
  const [sug, setSug] = useState<Suggest | null>(null);
  const [searchFocus, setSearchFocus] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  // Standard autocomplete behavior: clicking anywhere outside the search box
  // (map, panels, page) dismisses the results immediately — no need to pick a
  // result or clear the text. Refocusing the input brings the results back.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) setSearchFocus(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);
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
  // Bumped when the background heat-well fetch lands (data arrives after load).
  const [heatData, setHeatData] = useState(0);
  const setHeatK = <K extends keyof HeatState>(k: K, v: HeatState[K]) => setHeat((p) => ({ ...p, [k]: v }));
  const heatActive = heat.oil || heat.gas;

  const dealsByAbstract = useMemo(() => {
    const m = new Map<string, MapDeal[]>();
    for (const d of deals ?? []) for (const aid of d.abstractIds) { const a = m.get(aid) ?? []; a.push(d); m.set(aid, a); }
    return m;
  }, [deals]);
  const assetsByAbstract = useMemo(() => {
    const m = new Map<string, MapAsset[]>();
    for (const a of assets) for (const aid of a.abstractIds) { const l = m.get(aid) ?? []; l.push(a); m.set(aid, l); }
    return m;
  }, [assets]);

  // Formation options come from the heat-map wells (static Leon/Freestone
  // production data — the formation filter only affects the heat layer until
  // phase B5 moves production server-side). Everything else is API-driven.
  const scoped = useMemo(() => {
    const inC = (c: unknown) => fCounties.length === 0 || fCounties.includes(c as string);
    const wel = (wellsFC.current?.features ?? []).filter((f) => inC(f.properties.county));
    const forms = wel.flatMap((f) => Array.isArray(f.properties.formations) ? (f.properties.formations as string[]) : []);
    return { formations: [...new Set(forms.filter(Boolean))].sort() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fCounties, meta, heatData]);

  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;
    // Reopen where the user last left the map (their remembered default view).
    const savedCam = loadJson<MapCam | null>(MAP_VIEW_KEY, null);
    const map = new maplibregl.Map({ container: mapContainer.current, style: styleWithGlyphs(), center: savedCam?.center ?? LEON_CENTER, zoom: savedCam?.zoom ?? 10, attributionControl: { compact: true } });
    watchGisHealth(map);
    mapRef.current = map;

    map.on("load", async () => {
      // Cadastral geometry (counties + abstracts) streams as vector tiles; the
      // only blocking static is the tiny county label file. Heat-map well
      // points (static per-county assets, phase B5 removes) load in the
      // background AFTER the layer stack is up, so first paint never waits on
      // them — and the wellbore statics aren't fetched at all (laterals render
      // from tiles; those files feed nothing).
      const countyLabels = await fetch(`/data/county-labels.geojson`).then((r) => r.json()).catch(() => ({ features: [] }));

      // County bboxes (from the DB-derived label file; fips = "48" + our
      // 3-digit code) for search → "go to county" framing.
      const bboxByFips = new Map<string, [number, number, number, number]>();
      for (const f of (countyLabels.features ?? []) as GeoFeature[]) bboxByFips.set(String(f.properties.fips), f.properties.bbox as [number, number, number, number]);
      for (const c of COUNTIES) { const bb = bboxByFips.get(`48${c.fips}`); if (bb) countyBBox.current.set(c.key, bb); }

      setMeta({ counties: COUNTIES.map((c) => c.name).sort() });

      void Promise.all(
        COUNTIES_WITH_WELLS.map((k) => fetch(`/data/${k}-wells.geojson`).then((r) => r.json()).catch(() => ({ features: [] }))),
      ).then((welParts) => {
        const welFC: FC = { type: "FeatureCollection", features: welParts.flatMap((p: FC) => p.features) } as FC;
        wellsFC.current = welFC;
        heatWells.current = extractWells(welFC.features);
        perLease.current = wellsPerLease(heatWells.current);
        setHeatData((n) => n + 1); // formations options + heat recompute pick up the wells
      });

      // Shared cadastral source + layer stack (counties, abstracts, wells,
      // wellbores, labels) — identical to the deal map via lib/mapLayers.
      addCadastralLayers(map, countyLabels as unknown as GeoJSON.FeatureCollection);

      // Imported tract boundaries (user-uploaded shapefiles, org-scoped) —
      // the same overlay the deal maps draw (see addTractLayers).
      addTractLayers(map, "wells");
      void loadTracts();
      map.on("mouseenter", "tracts-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "tracts-fill", () => (map.getCanvas().style.cursor = ""));

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
        // An imported tract boundary (its name + shapefile attributes).
        if (layersRef.current.tracts && map.getLayer("tracts-fill")) {
          const tf = map.queryRenderedFeatures(e.point, { layers: ["tracts-fill"] });
          if (tf.length) {
            clearSelection();
            setSelected({ kind: "tract", ...tractInfo(tf[0].properties as Record<string, unknown>) });
            return;
          }
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
      applyLayerVisibility(); applyWellFilter();
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
        unitAcres: d.unitAcres != null ? Number(d.unitAcres) : null,
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
    for (const id of ownedIds.current) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { owned: false });
    activeIds.current = layersRef.current.deals ? [...dealsByAbstract.keys()] : [];
    ownedIds.current = layersRef.current.assets ? [...assetsByAbstract.keys()] : [];
    for (const id of activeIds.current) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { active: true });
    for (const id of ownedIds.current) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { owned: true });
  }
  function applyLayerVisibility() {
    const map = mapRef.current; if (!map || !styleReady.current) return;
    const L = layersRef.current;
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("abstracts-fill", L.boundaries); vis("abstracts-line", L.boundaries);
    vis("abstracts-num", L.absNums); vis("abstracts-survey", L.surveyNames);
    vis("wells", L.wells); vis("wellbores", L.wellbores); vis("wellbores-sel", L.wellbores);
    vis("tracts-fill", L.tracts); vis("tracts-line", L.tracts); vis("tracts-label", L.tracts);
    applyHighlight();
  }
  // Filter behavior: filters never restyle the map — instead the map zooms to
  // frame the matching results (see the extent effect below). The exceptions:
  // Well type / Well status / Operator show ONLY matching wells, hiding the
  // rest via a layer filter.
  function applyWellFilter() {
    const map = mapRef.current; if (!map || !styleReady.current || !map.getLayer("wells")) return;
    const cl: unknown[] = [];
    if (fWellTypes.length) cl.push(["in", ["get", "type"], ["literal", fWellTypes]]);
    if (fWellStatuses.length) cl.push(["in", ["get", "status"], ["literal", fWellStatuses]]);
    // Operator filters HIDE, exactly like type/status: only wells operated by
    // the selected operator(s) stay on the map (a null-operator well is not
    // "associated" with any selection, so it hides too).
    if (fOperators.length) cl.push(["in", ["get", "operator"], ["literal", fOperators]]);
    const expr = cl.length ? (["all", ...cl] as unknown as maplibregl.ExpressionSpecification) : null;
    map.setFilter("wells", expr);
    // Wellbore tile features carry their surface well's attributes (joined
    // server-side), so the same tests keep laterals in lockstep with their
    // parent well: a matching well always keeps ALL of its wellbores. Bores
    // whose parent attributes didn't resolve (orphaned surface_fid → NULL
    // type/status from the LEFT JOIN) stay visible rather than vanishing the
    // moment any filter is active — filtering only removes a lateral when its
    // parent well itself no longer matches.
    const boreExpr = cl.length
      ? (["any", ["!", ["has", "type"]], ["all", ...cl]] as unknown as maplibregl.ExpressionSpecification)
      : null;
    if (map.getLayer("wellbores")) map.setFilter("wellbores", boreExpr);
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
  // Owned (HOLD) mineral assets: not deals, so the deal-status filter doesn't apply.
  useEffect(() => { api.get<MapAsset[]>("/map/assets").then(setAssets).catch(() => setAssets([])); }, []);
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
  useEffect(applyHighlight, [dealsByAbstract, assetsByAbstract]);
  useEffect(applyLayerVisibility, [layers]);
  // Survey/abstract filter option lists from the GIS API, scoped to the selected
  // counties. Nothing needs to be on-screen (or downloaded) to be filterable.
  // Debounced (rapid county edits coalesce) and sequence-guarded so a slow
  // earlier response can never clobber a newer one.
  const optionsSeq = useRef(0);
  useEffect(() => {
    const seq = ++optionsSeq.current;
    const t = setTimeout(() => {
      const qs = fCounties.length ? `?counties=${encodeURIComponent(fCounties.join(","))}` : "";
      api.get<typeof gisOptions>(`/gis/options${qs}`)
        .then((o) => { if (optionsSeq.current === seq) setGisOptions(o); })
        .catch(() => { if (optionsSeq.current === seq) setGisOptions({ surveys: [], abstracts: [], wellTypes: [], wellStatuses: [], operators: [], wellCount: 0 }); });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fCounties]);
  // Debounced unified search — one round-trip covers every entity type.
  useEffect(() => {
    const q = query.trim();
    // Three characters is the server's floor too (/gis/suggest): below it the
    // search predicates can't probe the trigram indexes and seq-scan instead.
    if (q.length < 3) { setSug(null); return; }
    const t = setTimeout(() => {
      api.get<Suggest>(`/gis/suggest?q=${encodeURIComponent(q)}`).then(setSug).catch(() => setSug(null));
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(applyWellFilter, [fWellTypes, fWellStatuses, fOperators]);
  // Zoom to the filtered results: whenever filters change, ask the server for
  // the bounding box of everything matching and frame it. Debounced so rapid
  // edits coalesce; sequence-guarded so a slow response can't zoom late; the
  // initial mount is skipped so restoring the last camera position wins.
  const extentSeq = useRef(0);
  const filtersTouched = useRef(false);
  useEffect(() => {
    if (!filtersTouched.current) { filtersTouched.current = true; return; }
    // Auto-zoom is a GEOGRAPHIC affordance: only State / County / Survey /
    // Abstract participate. Attribute filters (well type/status, operator,
    // formation) narrow what's shown without moving the camera.
    const groups: [string, string[]][] = [
      ["states", fStates], ["counties", fCounties], ["surveys", fSurveys], ["abstracts", fAbstracts],
    ];
    if (!groups.some(([, v]) => v.length)) return;
    const seq = ++extentSeq.current;
    const t = setTimeout(() => {
      const qs = new URLSearchParams();
      for (const [k, vals] of groups) for (const v of vals) qs.append(k, v);
      api.get<{ bbox: BBox | null }>(`/gis/extent?${qs.toString()}`)
        .then((r) => { if (extentSeq.current === seq) fitBbox(r.bbox); })
        .catch(() => { /* framing is best-effort */ });
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fStates, fCounties, fSurveys, fAbstracts]);
  // Rebuild heat points whenever the data, filters, period, or thresholds change.
  useEffect(() => { if (heatReady) recomputeHeat(); /* eslint-disable-next-line */ },
    [heatReady, heatData, prod, fCounties, fOperators, fWellTypes, fWellStatuses, fFormations, heat.period, heat.from, heat.to, heat.min, heat.max, heat.oil, heat.gas, heat.hotspots]);
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
  const panelAssets = selected?.kind === "abstract" ? assetsByAbstract.get(selected.id) ?? [] : [];
  const abstractCount = dealsByAbstract.size;
  const toggle = (k: keyof typeof layers) => setLayers((p) => ({ ...p, [k]: !p[k] }));

  // Imported tract boundaries (shapefile uploads) — fetched on load and after
  // every import/delete so the overlay always mirrors the stored set.
  const tractsFC = useRef<GeoJSON.FeatureCollection | null>(null);
  async function loadTracts() {
    try {
      const fc = await api.get<GeoJSON.FeatureCollection>("/map/tracts");
      tractsFC.current = fc;
      (mapRef.current?.getSource(TRACT_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(fc);
    } catch { /* overlay is optional — the map works without it */ }
  }
  // "Show on map" for one upload: turn the tracts layer on and frame that
  // file's boundaries (from the overlay data already loaded).
  function showImport(importId: string) {
    setLayers((p) => ({ ...p, tracts: true }));
    const feats = (tractsFC.current?.features ?? []).filter((f) => f.properties?.__importId === importId);
    const pts = feats.flatMap((f) => collectCoords(f.geometry as unknown as { type: string; coordinates: unknown }));
    if (pts.length) fitBbox(bboxOfPoints(pts));
  }

  // Saved filters: name the current filter combination, reload it later,
  // overwrite it with the current filters, or delete it. Saving with an
  // existing name overwrites that preset.
  function currentFilters(): MapFilterState {
    return {
      status: statusFilter, states: fStates, counties: fCounties, surveys: fSurveys, abstracts: fAbstracts,
      wellTypes: fWellTypes, wellStatuses: fWellStatuses, operators: fOperators, formations: fFormations,
    };
  }
  function persistFilterPresets(next: FilterPreset[]) {
    setFilterPresets(next); saveJson(MAP_FILTERS_KEY, next);
  }
  function saveFilterPreset(name: string) {
    const n = name.trim(); if (!n) return;
    persistFilterPresets([...filterPresets.filter((p) => p.name !== n), { name: n, filters: currentFilters() }]);
    setFilterName("");
  }
  function applyFilterPreset(p: FilterPreset) {
    const f = p.filters;
    setStatusFilter(f.status ?? "ACTIVE");
    setFStates(f.states ?? []);
    setFCounties(f.counties ?? []); setFSurveys(f.surveys ?? []); setFAbstracts(f.abstracts ?? []);
    setFWellTypes(f.wellTypes ?? []); setFWellStatuses(f.wellStatuses ?? []);
    setFOperators(f.operators ?? []); setFFormations(f.formations ?? []);
  }
  function deleteFilterPreset(name: string) {
    persistFilterPresets(filterPresets.filter((p) => p.name !== name));
  }
  // A preset is "active" when it exactly matches the filters on screen.
  const activePresetName = useMemo(() => {
    const cur = JSON.stringify(currentFilters());
    return filterPresets.find((p) => JSON.stringify({ ...p.filters, status: p.filters.status ?? "ACTIVE" }) === cur)?.name ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterPresets, statusFilter, fStates, fCounties, fSurveys, fAbstracts, fWellTypes, fWellStatuses, fOperators, fFormations]);
  // Filters button badge: how many filter groups are set (deal status counts
  // once it is anything other than the default "Active deals").
  const filterCount = (statusFilter !== "ACTIVE" ? 1 : 0) +
    [fStates, fCounties, fSurveys, fAbstracts, fWellTypes, fWellStatuses, fOperators, fFormations].filter((v) => v.length > 0).length;
  const anyFilterSet = fStates.length > 0 || fCounties.length > 0 || fSurveys.length > 0 || fAbstracts.length > 0 ||
    fWellTypes.length > 0 || fWellStatuses.length > 0 || fOperators.length > 0 || fFormations.length > 0;
  // Size the map to fill from its top down to the viewport bottom (footer), with
  // a small gap — recomputed on resize and whenever the controls row changes
  // height (a panel opening/closing), so there is never blank space below it.
  useLayoutEffect(() => {
    const el = mapWrap.current;
    if (!el) return;
    // A bottom tab bar (phones), when the shell has one, is subtracted too.
    const measure = () => {
      const tabbar = parseFloat(getComputedStyle(document.body).getPropertyValue("--tabbar-h")) || 0;
      setMapH(Math.max(360, Math.round(window.innerHeight - el.getBoundingClientRect().top - 16 - tabbar)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [showFilters, showHeat, fullscreen]);
  useEffect(() => { mapRef.current?.resize(); }, [mapH]);

  // Visible-area padding. With the Filters / Heat map sheet open, searches and
  // selections centre within the map the sheet leaves uncovered: MapLibre keeps
  // the camera centre inside its padding and fitBounds adds each call's own
  // gutter on top of it, so one setPadding covers every flyTo/fitBounds here.
  // Measured from the sheet's real box relative to the canvas (never a fixed
  // offset) and redone whenever the sheet opens, closes, switches side or the
  // frame resizes. While something is selected the change is eased so the
  // selection stays centred in the new visible area. On phones the sheet spans
  // the width, so no side padding would leave any map — none is set.
  const sheetRef = useRef<HTMLElement>(null);
  const selectedRef = useRef<Selected>(null); selectedRef.current = selected;
  const syncPadding = useCallback(() => {
    const map = mapRef.current, host = mapContainer.current;
    if (!map || !host) return;
    const next = { top: 0, bottom: 0, left: 0, right: 0 };
    const sheet = sheetRef.current;
    if (sheet) {
      const m = host.getBoundingClientRect(), s = sheet.getBoundingClientRect();
      const gutter = 12; // breathing room between the sheet edge and a centred result
      const side = s.left - m.left <= m.right - s.right ? "left" : "right";
      const pad = Math.round(side === "left" ? s.right - m.left + gutter : m.right - s.left + gutter);
      // Only when a usable strip of map stays visible beside the sheet.
      if (pad > 0 && m.width - pad >= 160) next[side] = pad;
    }
    const cur = map.getPadding();
    if (cur.top === next.top && cur.bottom === next.bottom && cur.left === next.left && cur.right === next.right) return;
    if (selectedRef.current) map.easeTo({ padding: next, duration: 800 });
    else map.setPadding(next);
  }, []);
  useLayoutEffect(() => { syncPadding(); }, [showFilters, showHeat, dock, fullscreen, mapH, syncPadding]);
  // Keep the canvas matched to its frame however the frame changes size.
  useEffect(() => {
    const el = mapContainer.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { mapRef.current?.resize(); syncPadding(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncPadding]);

  // Full-screen is a pure CSS re-layout of the SAME mounted tree — the map,
  // its panels, search, filters, and every piece of user state persist across
  // the toggle; MapLibre only receives a resize(). Escape also exits.
  useEffect(() => {
    if (!fullscreen) return;
    // The container height changes without a window resize event — re-measure
    // and resize the canvas on both enter and exit.
    mapRef.current?.resize();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Let open menus/search consume their own Escape first.
      if (document.querySelector(".msel-menu, .ml2-pop, .modal-overlay")) return;
      setFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); mapRef.current?.resize(); };
  }, [fullscreen]);

  const panelOpen = showFilters || showHeat;
  const closePanel = () => { setShowFilters(false); setShowHeat(false); };
  const clearAllFilters = () => {
    setStatusFilter("ACTIVE");
    setFStates([]); setFCounties([]); setFSurveys([]); setFAbstracts([]);
    setFWellTypes([]); setFWellStatuses([]); setFOperators([]); setFFormations([]);
  };

  return (
    <div className={`page map-page ${fullscreen ? "mc-fullscreen" : ""}`}>
      {/* Title + actions. In full screen only the title folds away — the
          actions, search and panels stay usable over the map. */}
      <div className="mc-head">
        <div className="mc-title">
          <h1>Map</h1>
          <span className="mc-sub">Texas · {COUNTIES.length} counties · abstracts stream as you pan and zoom</span>
        </div>
        <div className="mc-actions">
          <button type="button" className={`mc-btn ${showFilters || filterCount > 0 ? "active" : ""}`} aria-pressed={showFilters} onClick={() => { setShowFilters((s) => !s); setShowHeat(false); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5z" /></svg>
            Filters
            {filterCount > 0 && <span className="mc-badge" aria-label={`${filterCount} active`}>{filterCount}</span>}
          </button>
          <button type="button" className={`mc-btn ${showHeat ? "active" : ""} ${heatActive ? "hot" : ""}`} aria-pressed={showHeat} onClick={() => { setShowHeat((s) => !s); setShowFilters(false); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3c3 4 6 6.5 6 10.5A6 6 0 0 1 6 13.5C6 9.5 9 7 12 3z" /></svg>
            Heat map
            {heatActive && <span className="mc-hot-dot" aria-label="Heat map on" />}
          </button>
          <button
            type="button"
            className="mc-btn"
            disabled={!deals?.length}
            title="Export the deals linked on the map to CSV"
            onClick={() => downloadCsv(
              `map-deals-${new Date().toISOString().slice(0, 10)}.csv`,
              ["Deal", "Stage", "Priority", "State", "Counties", "Operator", "Asset Types", "NRA", "NMA", "Ask Price", "Profit Est.", "Buyer"],
              (deals ?? []).map((d) => [
                d.name, d.stage, d.priority, d.state ?? "", d.counties.join("; "), d.operator ?? "",
                d.assetTypes.join("; "), d.nra ?? "", d.acreageNma ?? "", d.askPrice ?? "", d.profitEst ?? "", d.selectedBuyer?.name ?? "",
              ]),
            )}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            Export
          </button>
          <button
            type="button"
            className={`mc-btn ${fullscreen ? "active" : ""}`}
            title={fullscreen ? "Exit full screen (Esc)" : "View the map full screen"}
            aria-pressed={fullscreen}
            onClick={() => setFullscreen((f) => !f)}
          >
            {fullscreen
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>}
            Full screen
          </button>
        </div>
      </div>

      <div className="mc-toolbar">
        <div ref={searchBoxRef} className="mc-search">
          <div className="mc-search-box">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSearchFocus(true); }}
              onFocus={() => setSearchFocus(true)}
              onClick={() => setSearchFocus(true)}
              onKeyDown={(e) => { if (e.key === "Escape") setSearchFocus(false); }}
              placeholder="Search wells, abstracts, operators, deals"
              aria-label="Search the map"
            />
          </div>
          {searchFocus && query.trim().length < 2 && recents.length > 0 && (
            <div className="msel-menu map-search-menu">
              <div className="map-search-group">Recent searches</div>
              {recents.map((r, i) => (
                <div className="msel-opt" key={`${r.t}-${r.label}-${i}`} onMouseDown={() => runSearchAction(r.t, r.label, r.sub, r.p)}>
                  <span className="map-search-text"><strong>{r.label}</strong> {r.sub && <span className="muted">· {r.sub}</span>}</span>
                  <span className="map-search-kind">{GROUP_LABELS[r.t]}</span>
                </div>
              ))}
            </div>
          )}
          {searchFocus && query.trim().length >= 2 && results.length > 0 && (
            <div className="msel-menu map-search-menu">
              {results.map((r, i) => (
                <div key={`${r.t}-${r.label}-${i}`}>
                  {(i === 0 || results[i - 1].t !== r.t) && <div className="map-search-group">{GROUP_LABELS[r.t]}</div>}
                  <div className="msel-opt" onMouseDown={() => runSearchAction(r.t, r.label, r.sub, r.p)}>
                    <span className="map-search-text"><strong>{r.label}</strong> {r.sub && <span className="muted">· {r.sub}</span>}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {searchFocus && query.trim().length >= 2 && sug && results.length === 0 && (
            <div className="msel-menu map-search-menu">
              <div className="map-search-empty">No matches for “{query.trim()}”</div>
            </div>
          )}
        </div>
        <div className="mc-stats">
          {deals == null ? <span>…</span> : ([
            [num(deals.length), `deal${deals.length === 1 ? "" : "s"}`],
            [num(abstractCount), `deal tract${abstractCount === 1 ? "" : "s"}`],
            [num(assets.length), `mineral asset${assets.length === 1 ? "" : "s"}`],
            [num(gisOptions.wellCount), "wells"],
          ] as const).map(([v, l], i) => (
            <span key={l} className="mc-stat">{i > 0 && <i className="mc-stat-dot" aria-hidden="true" />}<b>{v}</b> {l}</span>
          ))}
        </div>
      </div>

      {/* The map fills the rest of the page. Filters / Heat map float INSIDE it,
          docked left or right (remembered); the overlay controls on that side
          step aside so nothing sits under the panel. */}
      <div ref={mapWrap} className={`mc-map ${panelOpen ? `mc-has-panel mc-dock-${dock}` : ""}`} style={{ height: mapH ? `${mapH}px` : "calc(100dvh - 250px)" }}>
        <div ref={mapContainer} className="mc-canvas" />
        <div className="mc-controls-left">
          <MapLayersPanel
            variant="floating"
            collapsible
            storageKey="mh-mainmap-layers-open"
            defs={[
              { key: "boundaries", label: "Abstract boundaries" }, { key: "absNums", label: "Abstract numbers" },
              { key: "surveyNames", label: "Survey names" }, { key: "deals", label: "Active deals" },
              { key: "assets", label: "Mineral assets (owned)" },
              { key: "wells", label: "Wells" }, { key: "wellbores", label: "Wellbores (laterals)" },
              { key: "tracts", label: "Imported tracts" },
            ]}
            layers={layers}
            onToggle={(k) => toggle(k as keyof typeof layers)}
          />
          {can("manageMapData") && (
            <MapShpImport
              onChanged={(bbox) => {
                void loadTracts();
                setLayers((p) => ({ ...p, tracts: true }));
                if (bbox) mapRef.current?.fitBounds(bbox as maplibregl.LngLatBoundsLike, { padding: 60, duration: 800, maxZoom: 14 });
              }}
              onShow={showImport}
            />
          )}
        </div>
        {!deals && <div className="mc-loading"><Spinner label="Loading map…" /></div>}

        {fullscreen && (
          <button type="button" className="mc-fs-exit" title="Exit full screen (Esc)" onClick={() => setFullscreen(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
            Exit full screen
          </button>
        )}

        {panelOpen && (
          <aside ref={sheetRef} className={`mc-sheet mc-sheet-${dock}`} aria-label={showFilters ? "Filters" : "Heat map"}>
            <div className="mc-sheet-head">
              <span className="mc-sheet-title">{showFilters ? "Filters" : "Heat map"}</span>
              <div className="mc-sheet-tools">
                {/* Dock-side preference — remembered across sessions. */}
                <div className="mc-dock-seg" title="Panel position" role="group" aria-label="Panel position">
                  {(["left", "right"] as const).map((side) => (
                    <button key={side} type="button" className={`mc-dock-btn ${dock === side ? "on" : ""}`} aria-pressed={dock === side}
                      aria-label={side === "left" ? "Dock left" : "Dock right"} title={side === "left" ? "Dock left" : "Dock right"} onClick={() => setDock(side)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d={side === "left" ? "M4 5h6v14H4z" : "M14 5h6v14h-6z"} fill="currentColor" stroke="none" /></svg>
                    </button>
                  ))}
                </div>
                <button type="button" className="mc-sheet-x" aria-label="Close panel" onClick={closePanel}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
            </div>

            {showFilters && (
              <>
                <div className="mc-sheet-body">
                  <MapField label="Deal status"><Select value={statusFilter} onChange={setStatusFilter} ariaLabel="Deal status" options={STATUS_OPTIONS.map(([v, l]) => ({ value: v, label: l }))} /></MapField>
                  {/* Cascading geography: State → County → Abstract → Survey, one per row. Map data
                      is Texas-only today, so counties empty out under a non-TX state. */}
                  <MapField label="State"><SearchableMultiSelect options={[...US_STATE_OPTIONS]} labels={US_STATE_LABELS} value={fStates} onChange={setFStates} placeholder="States…" /></MapField>
                  <MapField label="County"><SearchableMultiSelect options={fStates.length && !fStates.includes("TX") ? [] : meta.counties} value={fCounties} onChange={setFCounties} placeholder="Counties…" /></MapField>
                  <MapField label="Abstract"><SearchableMultiSelect options={gisOptions.abstracts} labels={abstractFilterLabels} filterOptions={rankAbstractFilter} value={fAbstracts} onChange={setFAbstracts} placeholder="Abstract # or survey…" /></MapField>
                  <MapField label="Survey"><SearchableMultiSelect options={gisOptions.surveys} value={fSurveys} onChange={setFSurveys} placeholder="Surveys…" /></MapField>
                  <div className="mc-divider" />
                  <MapField label="Well type"><SearchableMultiSelect options={gisOptions.wellTypes} value={fWellTypes} onChange={setFWellTypes} placeholder="Well types…" /></MapField>
                  <MapField label="Well status"><SearchableMultiSelect options={gisOptions.wellStatuses} value={fWellStatuses} onChange={setFWellStatuses} placeholder="Well statuses…" /></MapField>
                  <MapField label="Operator" count={gisOptions.operators.length}><SearchableMultiSelect options={gisOptions.operators} value={fOperators} onChange={setFOperators} placeholder="Operators…" /></MapField>
                  <MapField label="Formation" count={scoped.formations.length}><SearchableMultiSelect options={scoped.formations} value={fFormations} onChange={setFFormations} placeholder="Formations…" /></MapField>
                </div>
                {/* Saved filters: load (name), overwrite (↻) and delete (×) per chip;
                    "Save current" opens the name field. Saving an existing name
                    overwrites that preset. */}
                <div className="mc-saved">
                  <div className="mc-saved-head">
                    <span className="mc-label">Saved filters</span>
                    <button type="button" className="mc-link" disabled={!anyFilterSet && statusFilter === "ACTIVE"} onClick={clearAllFilters}>Clear all</button>
                  </div>
                  <div className="mc-saved-chips">
                    {filterPresets.map((p) => (
                      <span key={p.name} className={`mc-preset-chip ${activePresetName === p.name ? "active" : ""}`}>
                        <button type="button" className="mc-preset-apply" title="Load this saved filter" onClick={() => applyFilterPreset(p)}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z" /></svg>
                          {p.name}
                        </button>
                        <button type="button" className="mc-preset-upd" title="Overwrite with the current filters" aria-label={`Overwrite ${p.name} with the current filters`} onClick={() => saveFilterPreset(p.name)}>↻</button>
                        <button type="button" className="mc-preset-del" title="Delete saved filter" aria-label={`Delete ${p.name}`} onClick={() => deleteFilterPreset(p.name)}>×</button>
                      </span>
                    ))}
                    {!saveOpen && (
                      <button type="button" className="mc-save-current" title="Save this combination to reapply it in one click." onClick={() => setSaveOpen(true)}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                        Save current
                      </button>
                    )}
                  </div>
                  {saveOpen && (
                    <div className="mc-save-row">
                      <input value={filterName} onChange={(e) => setFilterName(e.target.value)} autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); if (filterName.trim() && anyFilterSet) { saveFilterPreset(filterName); setSaveOpen(false); } }
                          if (e.key === "Escape") { e.stopPropagation(); setSaveOpen(false); setFilterName(""); }
                        }}
                        placeholder="Name these filters" aria-label="Name these filters" />
                      <button type="button" className="small primary" disabled={!filterName.trim() || !anyFilterSet}
                        title={!filterName.trim() ? "Enabled once you name the filter set" : !anyFilterSet ? "Set a filter to save it" : undefined}
                        onClick={() => { saveFilterPreset(filterName); setSaveOpen(false); }}>Save</button>
                      <button type="button" className="small" onClick={() => { setSaveOpen(false); setFilterName(""); }}>Cancel</button>
                    </div>
                  )}
                </div>
              </>
            )}

            {showHeat && (
              <div className="mc-sheet-body mc-heat-body">
                <FormSection title="Layers">
                  {/* Full-width checkbox tiles — active rows tint blue. */}
                  <div className="mc-tiles">
                    <HeatTile on={heat.oil} label="Oil production" unit="bbl" onClick={() => setHeatK("oil", !heat.oil)} />
                    <HeatTile on={heat.gas} label="Gas production" unit="mcf" onClick={() => setHeatK("gas", !heat.gas)} />
                    <HeatTile on={heat.topProducers} label="Top producers" unit="Top 15" onClick={() => setHeatK("topProducers", !heat.topProducers)} />
                    <HeatTile on={heat.hotspots} label="Hotspot labels" onClick={() => setHeatK("hotspots", !heat.hotspots)} />
                  </div>
                  <MapField label="Production period">
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
                  </MapField>
                  {heat.period === "custom" && (
                    <div className="mc-two">
                      <MapField label="From"><input type="month" value={heat.from} onChange={(e) => setHeatK("from", e.target.value)} /></MapField>
                      <MapField label="To"><input type="month" value={heat.to} onChange={(e) => setHeatK("to", e.target.value)} /></MapField>
                    </div>
                  )}
                </FormSection>
                <FormSection title="Appearance">
                  <Slider label="Intensity" min={0.2} max={6} step={0.1} value={heat.intensity} onChange={(v) => setHeatK("intensity", v)} />
                  <Slider label="Radius" min={8} max={160} step={1} value={heat.radius} onChange={(v) => setHeatK("radius", v)} suffix="px" />
                  <Slider label="Opacity" min={0.1} max={1} step={0.05} value={heat.opacity} onChange={(v) => setHeatK("opacity", v)} />
                </FormSection>
                <FormSection title="Production thresholds">
                  <div className="mc-two">
                    <MapField label="Minimum"><input type="number" value={heat.min || ""} onChange={(e) => setHeatK("min", Number(e.target.value) || 0)} placeholder="No minimum" /></MapField>
                    <MapField label="Maximum"><input type="number" value={heat.max || ""} onChange={(e) => setHeatK("max", Number(e.target.value) || 0)} placeholder="No maximum" /></MapField>
                  </div>
                  <p className="mc-help">Per well, for the selected period. Oil in bbl, gas in mcf. Wells outside the range drop from the heat.</p>
                </FormSection>
                {!heatActive && <div className="mc-heat-idle">Turn on oil or gas production above to draw the heat map.</div>}
                {rank && heatActive && (
                  <FormSection title={`Production ranking · ${periodLabelRef.current}`}>
                    <div className="mc-rank">
                      <RankList title="Top counties" rows={rank.counties} />
                      <RankList title="Top operators" rows={rank.operators} />
                      <RankList title="Top formations" rows={rank.formations} />
                    </div>
                  </FormSection>
                )}
              </div>
            )}
          </aside>
        )}

        {/* Legend card — collapses to its header (closed by default on phones).
            While the heat map is on it explains the heat ramp instead. */}
        <div className={`mcx-legend ${legendOpen ? "open" : ""}`}>
          <button type="button" className="mcx-legend-head" onClick={() => setLegendOpen((o) => !o)} aria-expanded={legendOpen}>
            <span>{heatActive ? "Heat map" : "Well status"}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {legendOpen && (heatActive ? (
            <div className="mcx-heat-legend">
              <div className="mcx-legend-cap">Production intensity · {periodLabelRef.current}</div>
              <div className="mcx-ramp" style={{ background: `linear-gradient(90deg, ${HEAT_STOPS.map(([s, c]) => `${c} ${s * 100}%`).join(", ")})` }} />
              <div className="mcx-ramp-scale"><span>0</span><span>Peak in view</span></div>
              {/* Numeric range represented by the ramp, per active metric. */}
              {heat.oil && heatScale.oil > 0 && <div className="mcx-legend-cap">Oil: 0 – {num(Math.round(heatScale.oil))} bbl / well</div>}
              {heat.gas && heatScale.gas > 0 && <div className="mcx-legend-cap">Gas: 0 – {num(Math.round(heatScale.gas))} MCF / well</div>}
              <div className="mcx-heat-keys">
                {heat.oil && <span><i style={{ background: "#dc2626" }} />Oil</span>}
                {heat.gas && <span><i style={{ background: "#6d28d9" }} />Gas</span>}
                {heat.topProducers && <span><i style={{ background: "#facc15", boxShadow: "inset 0 0 0 1.5px #78350f" }} />Top well</span>}
              </div>
            </div>
          ) : (
            <div className="mcx-legend-rows">
              <Legend color="#22c55e" label="Producing" /><Legend color="#f59e0b" label="Shut-in" /><Legend color="#6b7280" label="Plugged" />
              <Legend color="#3b82f6" label="Permitted" /><Legend color="#78350f" label="Dry hole" /><Legend color="#7c3aed" label="Injection/Disposal" />
              {layers.wellbores && <Legend color="#0f766e" label="Wellbore (lateral)" line />}
            </div>
          ))}
        </div>

        {/* Zoom in / out and recenter (the first-visit Leon County view). */}
        <div className="mc-zoom" role="group" aria-label="Map zoom">
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
          </button>
          <button type="button" aria-label="Recenter" title="Recenter" onClick={() => mapRef.current?.flyTo({ center: LEON_CENTER, zoom: 10, duration: 800 })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
          </button>
        </div>

        {/* Heat hover tooltip — what the colors under the cursor represent. */}
        {heatActive && heatHover && (
          <div className="heat-tip" style={{ left: heatHover.x + 14, top: heatHover.y + 14 }}>
            <div><strong>{heatHover.wells}</strong> producing well{heatHover.wells === 1 ? "" : "s"} nearby</div>
            {heat.oil && <div>Oil: <strong>{num(Math.round(heatHover.oil))}</strong> bbl</div>}
            {heat.gas && <div>Gas: <strong>{num(Math.round(heatHover.gas))}</strong> MCF</div>}
            <div className="muted" style={{ fontSize: 10.5 }}>{periodLabelRef.current} · click for full breakdown</div>
          </div>
        )}

        {/* Overlap chooser */}
        {choices && (
          <div className="mc-float-panel mc-choices">
            <div className="section-head"><h3 style={{ margin: 0 }}>{choices.length} wells here</h3><button className="icon-btn" aria-label="Close" onClick={() => setChoices(null)}>×</button></div>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Pick the well you meant:</p>
            {choices.map((w) => (
              <div key={w.fid} className="msel-opt mc-choice" onClick={() => void openWell(w.fid)}>
                <strong>{w.api}{w.wellNo ? ` #${w.wellNo}` : ""}</strong><div className="muted" style={{ fontSize: 12 }}>{w.type} · {w.status}</div>
              </div>
            ))}
          </div>
        )}

        {selected && !choices && (
          <div className="mc-float-panel">
            {selected.kind === "well" ? (
              <>
                <div className="section-head"><div><h3 style={{ margin: 0 }}>{selected.leaseName || "Well"} {selected.wellNo ? `#${selected.wellNo}` : ""}</h3><div className="muted" style={{ fontSize: 12 }}>{selected.symbol}</div></div><button className="icon-btn" aria-label="Close" onClick={clearSelection}>×</button></div>
                <div className="dd-grid mc-kv">
                  <KV k="Operator" v={selected.operator} /><KV k="Oil / Gas" v={selected.oilGas} />
                  <KV k="Lease" v={selected.leaseName} /><KV k="RRC Lease #" v={selected.leaseNo} />
                  <KV k="Field" v={selected.field} /><KV k="API" v={selected.api} />
                  <KV k="Well No." v={selected.wellNo} /><KV k="Type" v={selected.type} />
                  <KV k="Status" v={selected.status} /><KV k="County" v={selected.county} />
                  <KV k="Abstract" v={selected.abstract ? abstractShortLabel({ abstract: selected.abstract }) : null} /><KV k="Survey" v={selected.survey} />
                  <KV k="Spud/permit" v={selected.spudDate} /><KV k="Plugged" v={selected.plugDate} />
                  <KV k="Unit size" v={selected.unitAcres != null ? `${num(selected.unitAcres)} ac` : null} />
                </div>
                {selected.formations && (
                  <div className="kv" style={{ marginTop: 8 }}><span className="k">Formations (RRC W-2)</span><span className="v wrap">{selected.formations}</span></div>
                )}
                {(selected.cumOil != null || selected.cumGas != null) && (
                  <>
                    <div className="mc-fp-sec">Lease production (RRC)</div>
                    <div className="dd-grid mc-kv">
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
                      <div className="mc-fp-sec" style={{ marginTop: 0 }}>Production trend · {kind === "gas" ? "gas (MCF)" : "oil (bbl)"} · last {Math.min(series.length, 36)} mo</div>
                      <ProductionChart series={series} kind={kind} />
                      <div className="muted" style={{ fontSize: 12 }}>Last 12 mo: {num(last12)} {kind === "gas" ? "MCF" : "bbl"}</div>
                    </div>
                  );
                })()}
                {(selected.permits?.length ?? 0) > 0 && (
                  <>
                    <div className="mc-fp-sec">Permit history (RRC W-1)</div>
                    {selected.permits!.slice(0, 5).map((p) => (
                      <div key={p.statusNo} className="mc-fp-row">
                        <span>{p.operator || "—"}{p.wellNo ? ` #${p.wellNo}` : ""}</span>
                        <span className="muted">{p.acres != null ? `${num(p.acres)} ac · ` : ""}{p.permitDate?.slice(0, 10) ?? "—"}</span>
                      </div>
                    ))}
                  </>
                )}
                {(selected.completions?.length ?? 0) > 0 && (
                  <>
                    <div className="mc-fp-sec">Completion filings (W-2/G-1)</div>
                    {selected.completions!.slice(0, 5).map((c) => (
                      <div key={c.trackingNo} className="mc-fp-row">
                        <span>{c.fieldName || c.filingType || "Filing"}</span>
                        <span className="muted">{(c.completionDate ?? c.filedDate)?.slice(0, 10) ?? "—"}</span>
                      </div>
                    ))}
                  </>
                )}
                {/* fid resolves the exact rrc well (production is read live from
                    the centralized dataset); the API label is a readable fallback. */}
                <Link className="primary mc-fp-cta" to={`/valuation?fid=${selected.fid}&well=${encodeURIComponent(selected.api || selected.api8 || "")}`}>
                  Open in Well Analysis →
                </Link>
                <p className="mc-fp-note">Operator, lease, field, dates, permits, and completions are from RRC records (lease-level; oil is reported per lease). Formation shows where a W-2 was filed.</p>
              </>
            ) : selected.kind === "hotspot" ? (
              <>
                <div className="section-head"><div><h3 style={{ margin: 0 }}>Production summary</h3><div className="muted" style={{ fontSize: 12 }}>{selected.summary.wells} contributing well{selected.summary.wells === 1 ? "" : "s"} · {selected.periodLabel}</div></div><button className="icon-btn" aria-label="Close" onClick={clearSelection}>×</button></div>
                <div className="dd-grid mc-kv">
                  <KV k="Total oil (bbl)" v={num(Math.round(selected.summary.oil))} /><KV k="Total gas (MCF)" v={num(Math.round(selected.summary.gas))} />
                  <KV k="Avg oil / well" v={num(Math.round(selected.summary.avgOil))} /><KV k="Avg gas / well" v={num(Math.round(selected.summary.avgGas))} />
                </div>
                {selected.summary.topOperators.length > 0 && (
                  <>
                    <div className="mc-fp-sec">Top operators</div>
                    {selected.summary.topOperators.map((o) => (
                      <div key={o.name} className="mc-fp-row">
                        <span>{o.name}</span>
                        <span className="muted">{num(Math.round(boe(o.oil, o.gas)))} BOE · {o.wells}w</span>
                      </div>
                    ))}
                  </>
                )}
                {selected.summary.topWells.length > 0 && (
                  <>
                    <div className="mc-fp-sec">Top-producing wells</div>
                    {selected.summary.topWells.map((w, i) => (
                      <div key={i} className="mc-fp-row">
                        <span>{w.leaseName || w.api || "Well"}{w.operator ? ` · ${w.operator}` : ""}</span>
                        <span className="muted">{num(Math.round(boe(w.oil, w.gas)))} BOE</span>
                      </div>
                    ))}
                  </>
                )}
                <div className="dd-grid mc-kv" style={{ marginTop: 10 }}>
                  <KV k="Counties" v={selected.summary.counties.join(", ")} />
                  <KV k="Abstracts" v={selected.summary.abstracts.slice(0, 8).map((a) => absIndex.labelAmong(a, fCounties)).join("; ")} />
                </div>
                {selected.summary.surveys.length > 0 && <div className="kv" style={{ marginTop: 6 }}><span className="k">Surveys</span><span className="v wrap">{selected.summary.surveys.slice(0, 8).join(", ")}</span></div>}
                <p className="mc-fp-note">Totals attribute each lease's production evenly across its wells. BOE = oil + gas/6. Click elsewhere to summarize another area.</p>
              </>
            ) : selected.kind === "tract" ? (
              <>
                <div className="section-head"><div><h3 style={{ margin: 0 }}>{selected.name}</h3><div className="muted" style={{ fontSize: 12 }}>Imported tract · {selected.sourceFile}</div>{selected.dealId && <div style={{ fontSize: 12, marginTop: 2 }}>From deal <Link to={`/deals/${selected.dealId}`}>{selected.dealName ?? "Open deal"}</Link></div>}</div><button className="icon-btn" aria-label="Close" onClick={clearSelection}>×</button></div>
                {selected.attrs.length > 0 ? (
                  <div className="dd-grid mc-kv" style={{ marginTop: 6 }}>
                    {selected.attrs.map(([k, v]) => <KV key={k} k={k} v={v} />)}
                  </div>
                ) : (
                  <p className="muted" style={{ fontSize: 12 }}>The shapefile carried no attributes for this boundary.</p>
                )}
                <p className="mc-fp-note">Boundary and attributes come from the uploaded shapefile. Manage uploads via “Import SHP”.</p>
              </>
            ) : (
              <>
                <div className="section-head"><div><h3 style={{ margin: 0 }}>{formatAbstract({ abstract: selected.abstract })}</h3><div className="muted" style={{ fontSize: 12 }}>{[surveyLabel(selected.survey), countyStateLabel(selected.county, "TX")].filter(Boolean).join(" · ")}</div></div><button className="icon-btn" aria-label="Close" onClick={clearSelection}>×</button></div>
                <div className="dd-grid mc-kv" style={{ marginTop: 6 }}><KV k="Abstract" v={abstractShortLabel({ abstract: selected.abstract })} /><KV k="Survey" v={selected.survey} /><KV k="County" v={selected.county} /></div>
                {/* Owned mineral assets (HOLD) are identified as Mineral Assets —
                    no stage, priority, buyer, or other deal workflow. */}
                {panelAssets.length > 0 && (
                  <>
                    <div className="mc-fp-sec">{panelAssets.length} mineral asset{panelAssets.length === 1 ? "" : "s"} (owned)</div>
                    {panelAssets.map((a) => (
                      <div key={a.id} className="mc-fp-card">
                        <div className="row" style={{ justifyContent: "space-between" }}><Link to={`/assets/${a.id}`} style={{ fontWeight: 600 }}>{a.name}</Link><span className="badge map-asset-badge">Mineral Asset</span></div>
                        <div className="dd-grid mc-kv" style={{ marginTop: 6 }}><KV k="Operator" v={a.operator} /><KV k="Asset Type" v={a.assetTypes.length ? <ChipList items={a.assetTypes} /> : null} /><KV k="NMA" v={num(a.acreageNma)} /><KV k="NRA" v={num(a.nra)} /></div>
                      </div>
                    ))}
                  </>
                )}
                {(panelDeals.length > 0 || panelAssets.length === 0) && (
                  <div className="mc-fp-sec">{panelDeals.length} active deal{panelDeals.length === 1 ? "" : "s"}</div>
                )}
                {panelDeals.length === 0 ? (panelAssets.length === 0 && <p className="muted">No active deals in this abstract.</p>) : panelDeals.map((d) => (
                  <div key={d.id} className="mc-fp-card">
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <Link to={d.recordType === "OWNED_ASSET" ? `/assets/${d.id}` : `/deals/${d.id}`} style={{ fontWeight: 600 }}>{d.name}</Link>
                        {d.recordType === "OWNED_ASSET" && <span className="badge resp-interested" title="An owned mineral asset actively marketed for sale">Mineral asset · For sale</span>}
                      </span>
                      <PriorityBadge priority={d.priority} />
                    </div>
                    <div className="row" style={{ gap: 6, margin: "6px 0" }}><StageBadge stage={d.stage} />{d.selectedBuyer && <span className="muted" style={{ fontSize: 12 }}>→ {d.selectedBuyer.name}</span>}</div>
                    <div className="dd-grid mc-kv"><KV k="Operator" v={d.operator} /><KV k="Asset Type" v={d.assetTypes.length ? <ChipList items={d.assetTypes} /> : null} /><KV k="NMA" v={num(d.acreageNma)} /><KV k="Profit est." v={money(d.profitEst)} /></div>
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

/** Field wrapper used throughout the map panels: sentence-case label with an
 *  optional muted count, control below. */
function MapField({ label, count, children }: { label: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="mc-field">
      <div className="mc-label">{label}{count != null && <span className="mc-count">{num(count)}</span>}</div>
      {children}
    </div>
  );
}

function Legend({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return <div className="mcx-legend-row"><span className={line ? "line" : "dot"} style={{ background: color }} />{label}</div>;
}
/** Full-width layer checkbox tile (Map Panels reference): 38px row with a
 *  filled blue checkbox when on and a blue-tinted row background. */
function HeatTile({ on, label, unit, onClick }: { on: boolean; label: string; unit?: string; onClick: () => void }) {
  return (
    <button type="button" className={`mc-tile ${on ? "on" : ""}`} onClick={onClick} aria-pressed={on}>
      <span className="mc-tile-box">
        {on && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
      </span>
      <span className="mc-tile-label">{label}</span>
      {unit && <span className="mc-tile-unit">{unit}</span>}
    </button>
  );
}

function Slider({ label, min, max, step, value, onChange, suffix }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; suffix?: string }) {
  // Filled-track effect (reference): accent up to the thumb, track beyond it.
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="mc-slider">
      <div className="mc-slider-head"><span>{label}</span><span className="mc-slider-val">{value}{suffix ?? ""}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        style={{ ["--pct" as never]: `${pct}%` }} />
    </div>
  );
}
function RankList({ title, rows }: { title: string; rows: { name: string; oil: number; gas: number; wells: number }[] }) {
  return (
    <div className="mc-rank-list">
      <div className="mc-label">{title}</div>
      {rows.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>—</div> : rows.map((r) => (
        <div key={r.name} className="mc-fp-row">
          <span>{r.name || "(unknown)"}</span>
          <span className="muted">{num(Math.round(boe(r.oil, r.gas)))}</span>
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
