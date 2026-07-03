import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Link } from "react-router-dom";
import { api, API_BASE } from "../api/client";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { COUNTIES, COUNTIES_WITH_WELLS, COUNTIES_WITH_PRODUCTION } from "../lib/counties";
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
type WellProps = { fid: number; api: string; api8: string; wellNo: string | null; wellId: string; symbol: string; type: string; status: string; county: string; abstract: string | null; survey: string | null; operator: string | null; leaseName: string | null; leaseNo: string | null; field: string | null; oilGas: string | null; district: string | null; cumOil: number | null; cumGas: number | null; lastProd: string | null; formations: string | null };
type SelWell = { kind: "well" } & WellProps;
type SelHotspot = { kind: "hotspot"; summary: AreaSummary; periodLabel: string };
type Selected = SelAbstract | SelWell | SelHotspot | null;

const LEON_CENTER: [number, number] = [-95.99, 31.29];
// Below this zoom the whole state is in view; only county outlines show until
// the user zooms in. Abstract number labels start at zoom 9, so 7 gives a lead.
const MIN_ABSTRACT_ZOOM = 7;
// Cadastral abstracts stream as vector tiles from PostGIS (ST_AsMVT on the API);
// the client never downloads county GeoJSON — cost is per-viewport at any scale.
// MapLibre requires absolute tile URLs, so fall back to the page origin in dev
// (the Vite proxy forwards /api to the local API server).
const ABSTRACT_TILES = `${API_BASE || window.location.origin}/api/gis/tiles/{z}/{x}/{y}.pbf`;

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
    // Self-hosted SDF glyphs for the label layers (client/public/fonts). The
    // previous files were an empty fontstack (0 glyphs) — an HTML error page
    // saved as .pbf — so on-map labels never rendered. Replaced with real
    // "Noto Sans Regular" glyph ranges.
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
  const wellsFC = useRef<FC | null>(null);
  // County bboxes (from tx-counties.geojson) power "go to county" framing.
  const countyBBox = useRef<Map<string, [number, number, number, number]>>(new Map());
  const heatWells = useRef<HeatWell[]>([]);
  const perLease = useRef<Map<string, number>>(new Map());
  const heatPointsRef = useRef<HeatPoint[]>([]);
  const periodLabelRef = useRef("");

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
  const [fFormations, setFFormations] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [prod, setProd] = useState<Record<string, [number, number, number][]>>({});
  const [meta, setMeta] = useState<{ counties: string[]; wellTypes: string[]; wellStatuses: string[]; operators: string[] }>({ counties: [], wellTypes: [], wellStatuses: [], operators: [] });
  // Survey/abstract filter options come from the GIS API (PostGIS), scoped to the
  // selected counties — no abstract data needs to be downloaded to filter it.
  const [gisOptions, setGisOptions] = useState<{ surveys: string[]; abstracts: string[] }>({ surveys: [], abstracts: [] });
  const [absResults, setAbsResults] = useState<{ id: string; abstract: string | null; survey: string | null; county: string }[]>([]);

  // --- Production heat map ---
  const [showHeat, setShowHeat] = useState(false);
  const [heat, setHeat] = useState<HeatState>(DEFAULT_HEAT);
  const heatRef = useRef(heat); heatRef.current = heat;
  const [rank, setRank] = useState<Rankings | null>(null);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [heatReady, setHeatReady] = useState(false);
  const setHeatK = <K extends keyof HeatState>(k: K, v: HeatState[K]) => setHeat((p) => ({ ...p, [k]: v }));
  const heatActive = heat.oil || heat.gas;

  const dealsByAbstract = useMemo(() => {
    const m = new Map<string, MapDeal[]>();
    for (const d of deals ?? []) for (const aid of d.abstractIds) { const a = m.get(aid) ?? []; a.push(d); m.set(aid, a); }
    return m;
  }, [deals]);

  // Well-derived filter options scoped to the selected counties (wells are still
  // local GeoJSON for the two implemented counties — phase B moves them server-side
  // too). Survey/abstract options come from the GIS API (see the fCounties effect).
  const scoped = useMemo(() => {
    const inC = (c: unknown) => fCounties.length === 0 || fCounties.includes(c as string);
    const wel = (wellsFC.current?.features ?? []).filter((f) => inC(f.properties.county));
    const uniq = (arr: unknown[]) => [...new Set(arr.filter(Boolean) as string[])];
    const forms = wel.flatMap((f) => Array.isArray(f.properties.formations) ? (f.properties.formations as string[]) : []);
    return {
      operators: uniq(wel.map((f) => f.properties.operator)).sort(),
      wellTypes: uniq(wel.map((f) => f.properties.type)).sort(),
      wellStatuses: uniq(wel.map((f) => f.properties.status)).sort(),
      formations: uniq(forms).sort(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fCounties, meta]);

  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;
    const map = new maplibregl.Map({ container: mapContainer.current, style: styleWithGlyphs(), center: LEON_CENTER, zoom: 10, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;

    map.on("load", async () => {
      // Abstracts are vector tiles (see ABSTRACT_TILES) — nothing to download here.
      // Wells/wellbores are only implemented for a couple of counties (phase B moves
      // them to PostGIS too), so those stay as small eager GeoJSON for now.
      const [txCounties, welParts, boreParts] = await Promise.all([
        fetch(`/data/tx-counties.geojson`).then((r) => r.json()).catch(() => ({ features: [] })),
        Promise.all(COUNTIES_WITH_WELLS.map((k) => fetch(`/data/${k}-wells.geojson`).then((r) => r.json()).catch(() => ({ features: [] })))),
        Promise.all(COUNTIES_WITH_WELLS.map((k) => fetch(`/data/${k}-wellbores.geojson`).then((r) => r.json()).catch(() => ({ features: [] })))),
      ]);
      const welFC: FC = { type: "FeatureCollection", features: welParts.flatMap((p: FC) => p.features) } as FC;
      const boreFC: FC = { type: "FeatureCollection", features: boreParts.flatMap((p: FC) => p.features) } as FC;
      wellsFC.current = welFC;
      heatWells.current = extractWells(welFC.features);
      perLease.current = wellsPerLease(heatWells.current);

      // County bboxes from the statewide boundary file (tx-counties fips = "48" +
      // our 3-digit county fips) for search → "go to county" framing.
      const bboxByFips = new Map<string, [number, number, number, number]>();
      for (const f of (txCounties.features ?? []) as GeoFeature[]) bboxByFips.set(String(f.properties.fips), bboxOf(f.geometry));
      for (const c of COUNTIES) { const bb = bboxByFips.get(`48${c.fips}`); if (bb) countyBBox.current.set(c.key, bb); }

      const uniq = (arr: (string | null | undefined)[]) => [...new Set(arr.filter(Boolean) as string[])];
      setMeta({
        counties: COUNTIES.map((c) => c.name).sort(),
        wellTypes: uniq(welFC.features.map((f) => f.properties.type as string)).sort(),
        wellStatuses: uniq(welFC.features.map((f) => f.properties.status as string)).sort(),
        operators: uniq(welFC.features.map((f) => f.properties.operator as string)).sort(),
      });

      // Statewide county outlines (cheap, always on) — the cadastral frame that
      // stays visible at every zoom; abstract detail streams in per viewport.
      map.addSource("counties", { type: "geojson", data: txCounties as unknown as GeoJSON.FeatureCollection });
      map.addLayer({ id: "county-bounds", type: "line", source: "counties", paint: { "line-color": "#94a3b8", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.4, 9, 1.2], "line-opacity": 0.5 } });

      // Vector tiles from PostGIS. promoteId maps the feature's `id` property to
      // its feature id so feature-state (selection/deal highlight) works exactly
      // as it did on the GeoJSON source — and persists across tile loads.
      map.addSource("abstracts", { type: "vector", tiles: [ABSTRACT_TILES], minzoom: MIN_ABSTRACT_ZOOM, maxzoom: 14, promoteId: { abstracts: "id" } });
      map.addSource("wells", { type: "geojson", data: welFC as unknown as GeoJSON.FeatureCollection, promoteId: "fid" });
      map.addSource("wellbores", { type: "geojson", data: boreFC as unknown as GeoJSON.FeatureCollection, promoteId: "fid" });

      // Production heat map (bottom of the stack, above the basemap): weight `w` is
      // pre-normalized to [0,1] per current extent, so the gradient rescales as you
      // zoom. Two independent sources so oil and gas toggle and blend separately.
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
      map.addLayer(heatLayer("heat-oil", HEAT_OIL_COLOR));
      map.addLayer(heatLayer("heat-gas", HEAT_GAS_COLOR));

      map.addLayer({ id: "abstracts-fill", type: "fill", source: "abstracts", "source-layer": "abstracts", paint: {
        "fill-color": ["case", ["boolean", ["feature-state", "selected"], false], "#f59e0b", ["boolean", ["feature-state", "active"], false], "#ef4444", "#3b82f6"],
        "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.55, ["boolean", ["feature-state", "active"], false], 0.45, 0.05] } });
      map.addLayer({ id: "abstracts-line", type: "line", source: "abstracts", "source-layer": "abstracts", paint: {
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
      map.addLayer({ id: "abstracts-num", type: "symbol", source: "abstracts", "source-layer": "abstracts", minzoom: 9, layout: {
        "symbol-sort-key": ["*", -1, ["get", "area"]], "text-field": ["get", "abstract"], "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13], "text-padding": 2, "text-allow-overlap": false, "text-optional": true },
        paint: { "text-color": "#0f172a", "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });
      map.addLayer({ id: "abstracts-survey", type: "symbol", source: "abstracts", "source-layer": "abstracts", minzoom: 12.5, layout: {
        "symbol-sort-key": ["*", -1, ["get", "area"]], "text-field": ["get", "survey"], "text-font": ["Noto Sans Regular"],
        "text-size": 11, "text-offset": [0, 1.1], "text-max-width": 8, "text-padding": 2, "text-allow-overlap": false, "text-optional": true },
        paint: { "text-color": "#334155", "text-halo-color": "#ffffff", "text-halo-width": 1.3 } });

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
        if (wells.length === 1) { selectWell(wells[0]); return; }
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
      map.on("mouseenter", "abstracts-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "abstracts-fill", () => (map.getCanvas().style.cursor = ""));
      // On pan/zoom: re-scale the heat gradient to the current extent. (Abstract
      // tiles load themselves — MapLibre requests only what the viewport needs.)
      map.on("moveend", () => { if (heatRef.current.oil || heatRef.current.gas) pushHeat(); });

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
    map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { selected: true });
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
  function selectWellByFid(fid: number) {
    const map = mapRef.current; const fc = wellsFC.current; if (!map || !fc) return;
    const feat = fc.features.find((f) => Number(f.properties.fid) === fid); if (!feat) return;
    selectWell(toWellProps(feat.properties));
    const [lon, lat] = feat.geometry.coordinates as number[];
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 13), duration: 800 });
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
    map.setFilter("wells", cl.length ? (["all", ...cl] as maplibregl.FilterSpecification) : null);

    // A wellbore (lateral) is never an independent entity: it is shown only for
    // wells that survive the SAME filters. We resolve the set of visible well
    // ids and constrain the laterals to those (linked via surfaceId = well fid),
    // so wells and laterals always update together and no orphan can remain.
    if (map.getLayer("wellbores")) {
      if (!cl.length) {
        map.setFilter("wellbores", null); // no filters → every well visible → every lateral allowed
      } else {
        const pass = (p: Record<string, unknown>) =>
          (!fWellTypes.length || fWellTypes.includes(p.type as string)) &&
          (!fWellStatuses.length || fWellStatuses.includes(p.status as string)) &&
          (!fOperators.length || fOperators.includes(p.operator as string)) &&
          (!fAbstracts.length || fAbstracts.includes(p.abstract as string)) &&
          (!fSurveys.length || fSurveys.includes(p.survey as string)) &&
          (!fCounties.length || fCounties.includes(p.county as string));
        const visibleFids = (wellsFC.current?.features ?? [])
          .filter((f) => pass(f.properties as Record<string, unknown>))
          .map((f) => (f.properties as { fid: number }).fid);
        map.setFilter("wellbores", ["in", ["get", "surfaceId"], ["literal", visibleFids]] as maplibregl.FilterSpecification);

        // Also drop the selection highlight if its parent well was filtered out.
        if (map.getLayer("wellbores-sel")) {
          const selF = map.getFilter("wellbores-sel") as unknown[] | undefined;
          const selFid = Array.isArray(selF) ? (selF[2] as number) : -1;
          if (selFid !== -1 && !visibleFids.includes(selFid)) {
            map.setFilter("wellbores-sel", ["==", ["get", "surfaceId"], -1]);
          }
        }
      }
    }
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
    // Merge every county's monthly-production asset. Keys are og|district|leaseNo
    // and RRC lease numbers are unique within a district, so counties don't collide.
    Promise.all(
      COUNTIES_WITH_PRODUCTION.map((k) => fetch(`/data/${k}-production.json`).then((r) => r.json()).catch(() => ({}))),
    ).then((parts) => setProd(Object.assign({}, ...parts))).catch(() => {});
  }, []);
  useEffect(applyHighlight, [dealsByAbstract]);
  useEffect(applyLayerVisibility, [layers]);
  // Survey/abstract filter option lists from the GIS API, scoped to the selected
  // counties. Nothing needs to be on-screen (or downloaded) to be filterable.
  useEffect(() => {
    const qs = fCounties.length ? `?counties=${encodeURIComponent(fCounties.join(","))}` : "";
    api.get<{ surveys: string[]; abstracts: string[] }>(`/gis/options${qs}`)
      .then(setGisOptions)
      .catch(() => setGisOptions({ surveys: [], abstracts: [] }));
  }, [fCounties]);
  // Debounced abstract/survey search against the GIS API.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setAbsResults([]); return; }
    const t = setTimeout(() => {
      api.get<{ id: string; abstract: string | null; survey: string | null; county: string }[]>(`/gis/search?q=${encodeURIComponent(q)}`)
        .then(setAbsResults)
        .catch(() => setAbsResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(applyAbstractFilter, [fCounties, fSurveys, fAbstracts]);
  useEffect(applyWellFilter, [fCounties, fSurveys, fAbstracts, fWellTypes, fWellStatuses, fOperators]);
  // Rebuild heat points whenever the data, filters, period, or thresholds change.
  useEffect(() => { if (heatReady) recomputeHeat(); /* eslint-disable-next-line */ },
    [heatReady, prod, fCounties, fOperators, fWellTypes, fWellStatuses, fFormations, heat.period, heat.from, heat.to, heat.min, heat.max, heat.oil, heat.gas, heat.hotspots]);
  // Cheap paint/visibility tweaks don't need a recompute.
  useEffect(() => { applyHeatPaint(); /* eslint-disable-next-line */ }, [heat.intensity, heat.radius, heat.opacity]);
  useEffect(() => { applyHeatVisibility(); /* eslint-disable-next-line */ }, [heat.topProducers, heat.oil, heat.gas, heat.hotspots]);

  const results = useMemo(() => {
    type R = { kind: "abstract" | "well" | "county"; key: string; label: string; sub: string };
    const q = query.trim().toLowerCase(); if (!q) return [] as R[];
    const out: R[] = [];
    for (const c of COUNTIES) {
      if (c.name.toLowerCase().includes(q)) { out.push({ kind: "county", key: c.key, label: `${c.name} County`, sub: "Go to county" }); if (out.length >= 4) break; }
    }
    // Abstract/survey matches come from the GIS API (every imported county is
    // searchable regardless of what tiles are loaded).
    for (const a of absResults.slice(0, 6)) {
      out.push({ kind: "abstract", key: a.id, label: a.abstract ?? a.id, sub: [a.survey, a.county ? `${a.county} County` : null].filter(Boolean).join(" · ") });
    }
    for (const f of wellsFC.current?.features ?? []) {
      const p = f.properties; const api = String(p.api || ""); const api8 = String(p.api8 || ""); const wn = String(p.wellNo || "");
      const op = String(p.operator || ""); const ln = String(p.leaseName || "");
      if (api.toLowerCase().includes(q) || api8.toLowerCase().includes(q) || wn.toLowerCase().includes(q) || op.toLowerCase().includes(q) || ln.toLowerCase().includes(q)) {
        out.push({ kind: "well", key: String(p.fid), label: `Well ${api}${wn ? ` #${wn}` : ""}`, sub: [op || null, ln || null, p.type].filter(Boolean).join(" · ") }); if (out.length >= 16) break;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, absResults]);

  const panelDeals = selected?.kind === "abstract" ? dealsByAbstract.get(selected.id) ?? [] : [];
  const abstractCount = dealsByAbstract.size;
  const toggle = (k: keyof typeof layers) => setLayers((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header"><div className="row"><h1 style={{ marginBottom: 0 }}>Map</h1><span className="muted">Texas · {COUNTIES.length} counties · abstracts stream as you pan &amp; zoom</span></div></div>

      <div className="row" style={{ marginBottom: 12, gap: 10, position: "relative" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 440 }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search API #, well #, abstract #, survey…" />
          {results.length > 0 && (
            <div className="msel-menu" style={{ top: "100%" }}>
              {results.map((r) => (
                <div className="msel-opt" key={r.kind + r.key} onClick={() => { if (r.kind === "abstract") void selectAbstractById(r.key); else if (r.kind === "county") goToCounty(r.key); else selectWellByFid(Number(r.key)); setQuery(""); }}>
                  <strong>{r.label}</strong> <span className="muted">· {r.sub}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="spacer" />
        <button onClick={() => { setShowFilters((s) => !s); setShowLayers(false); setShowHeat(false); }}>Filters ▾</button>
        <button onClick={() => { setShowLayers((s) => !s); setShowFilters(false); setShowHeat(false); }}>Layers ▾</button>
        <button className={heatActive ? "primary" : ""} onClick={() => { setShowHeat((s) => !s); setShowFilters(false); setShowLayers(false); }}>Heat map ▾</button>
      </div>

      {showFilters && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Filters apply to all GIS data on the map (wells, abstracts, surveys) — independent of whether a deal exists. "Deal status" only affects the deal highlight.</p>
          <div className="dd-grid">
            <div className="field"><label>Deal status</label><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div className="field"><label>County</label><SearchableMultiSelect options={meta.counties} value={fCounties} onChange={setFCounties} placeholder="Counties…" /></div>
            <div className="field"><label>Survey</label><SearchableMultiSelect options={gisOptions.surveys} value={fSurveys} onChange={setFSurveys} placeholder="Surveys…" /></div>
            <div className="field"><label>Abstract</label><SearchableMultiSelect options={gisOptions.abstracts} value={fAbstracts} onChange={setFAbstracts} placeholder="Abstracts…" /></div>
            <div className="field"><label>Well type</label><SearchableMultiSelect options={scoped.wellTypes} value={fWellTypes} onChange={setFWellTypes} placeholder="Well types…" /></div>
            <div className="field"><label>Well status</label><SearchableMultiSelect options={scoped.wellStatuses} value={fWellStatuses} onChange={setFWellStatuses} placeholder="Well statuses…" /></div>
            <div className="field"><label>Operator ({scoped.operators.length})</label><SearchableMultiSelect options={scoped.operators} value={fOperators} onChange={setFOperators} placeholder="Operators…" /></div>
            <div className="field"><label>Formation ({scoped.formations.length})</label><SearchableMultiSelect options={scoped.formations} value={fFormations} onChange={setFFormations} placeholder="Formations…" /></div>
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
            <Chk label="Wells" on={layers.wells} onChange={() => toggle("wells")} />
            <Chk label="Wellbores (laterals)" on={layers.wellbores} onChange={() => toggle("wellbores")} />
          </div>
        </div>
      )}

      {showHeat && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="dd-grid" style={{ alignItems: "start" }}>
            <div>
              <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>Layers</div>
              <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                <Chk label="Oil production" on={heat.oil} onChange={() => setHeatK("oil", !heat.oil)} />
                <Chk label="Gas production" on={heat.gas} onChange={() => setHeatK("gas", !heat.gas)} />
              </div>
              <div className="row" style={{ gap: 16, flexWrap: "wrap", marginTop: 8 }}>
                <Chk label="Top producers" on={heat.topProducers} onChange={() => setHeatK("topProducers", !heat.topProducers)} />
                <Chk label="Hotspot labels" on={heat.hotspots} onChange={() => setHeatK("hotspots", !heat.hotspots)} />
              </div>
              <div className="field" style={{ marginTop: 10 }}>
                <label>Production period</label>
                <select value={heat.period} onChange={(e) => setHeatK("period", e.target.value as HeatPeriod)}>
                  <option value="current">Current month</option>
                  <option value="3m">Last 3 months</option>
                  <option value="6m">Last 6 months</option>
                  <option value="12m">Last 12 months</option>
                  <option value="3y">Last 3 years</option>
                  <option value="ytd">Year to date</option>
                  <option value="custom">Custom range</option>
                </select>
              </div>
              {heat.period === "custom" && (
                <div className="row" style={{ gap: 8 }}>
                  <div className="field" style={{ flex: 1 }}><label>From</label><input type="month" value={heat.from} onChange={(e) => setHeatK("from", e.target.value)} /></div>
                  <div className="field" style={{ flex: 1 }}><label>To</label><input type="month" value={heat.to} onChange={(e) => setHeatK("to", e.target.value)} /></div>
                </div>
              )}
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>Appearance</div>
              <Slider label="Intensity" min={0.2} max={3} step={0.1} value={heat.intensity} onChange={(v) => setHeatK("intensity", v)} />
              <Slider label="Radius" min={8} max={80} step={1} value={heat.radius} onChange={(v) => setHeatK("radius", v)} suffix="px" />
              <Slider label="Opacity" min={0.1} max={1} step={0.05} value={heat.opacity} onChange={(v) => setHeatK("opacity", v)} />
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>Production thresholds (per well, period)</div>
              <div className="field"><label>Minimum</label><input type="number" value={heat.min || ""} onChange={(e) => setHeatK("min", Number(e.target.value) || 0)} placeholder="0 (no minimum)" /></div>
              <div className="field"><label>Maximum</label><input type="number" value={heat.max || ""} onChange={(e) => setHeatK("max", Number(e.target.value) || 0)} placeholder="0 (no maximum)" /></div>
              <p className="muted" style={{ fontSize: 11, margin: 0 }}>Oil in bbl, gas in mcf. Wells outside the range drop from the heat.</p>
            </div>
          </div>
          {rank && (heat.oil || heat.gas) && (
            <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>Production ranking · {periodLabelRef.current}</div>
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
        <span className="muted">{deals == null ? "…" : `${deals.length} deal${deals.length === 1 ? "" : "s"} · ${abstractCount} highlighted · ${wellsFC.current?.features.length ?? 0} wells`}</span>
      </div>

      <div style={{ position: "relative", height: "calc(100vh - 250px)", minHeight: 460, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
        <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />
        {!deals && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}><Spinner label="Loading map…" /></div>}

        <div style={{ position: "absolute", left: 12, bottom: 26, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
          {heatActive ? (
            <div style={{ minWidth: 160 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 4 }}>Production intensity · {periodLabelRef.current}</div>
              <div style={{ height: 10, borderRadius: 5, background: `linear-gradient(90deg, ${HEAT_STOPS.map(([s, c]) => `${c} ${s * 100}%`).join(", ")})` }} />
              <div className="row" style={{ justifyContent: "space-between", fontSize: 11 }}><span>Low</span><span>High</span></div>
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
                <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Operator, lease, field, and lease production/trend are from RRC records (lease-level; oil is reported per lease). Formation shows where a recent W-2 was filed.</p>
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

function Chk({ label, on, onChange }: { label: string; on: boolean; onChange: () => void }) {
  return <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, margin: 0, cursor: "pointer" }}><input type="checkbox" checked={on} onChange={onChange} style={{ width: "auto" }} /> {label}</label>;
}
function Legend({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return <div className="row" style={{ gap: 8, marginTop: 4 }}><span style={{ width: 12, height: line ? 3 : 12, background: color, opacity: 0.9, borderRadius: line ? 0 : "50%", display: "inline-block" }} /> {label}</div>;
}
function Slider({ label, min, max, step, value, onChange, suffix }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div className="field" style={{ marginBottom: 10 }}>
      <label style={{ display: "flex", justifyContent: "space-between" }}><span>{label}</span><span className="muted" style={{ textTransform: "none" }}>{value}{suffix ?? ""}</span></label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%", padding: 0 }} />
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
  return <div className="kv"><span className="k">{k}</span><span className="v">{v || "—"}</span></div>;
}
