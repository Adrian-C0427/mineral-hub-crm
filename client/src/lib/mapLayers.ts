import maplibregl from "maplibre-gl";
import { API_BASE } from "../api/client";

// Shared cadastral map layer stack used identically by the main map (MapView)
// and the per-deal map (DealMap), so the two can never visually drift. Callers
// add their own extras (heat, deal highlight) on top via addLayer beforeId.

/** Cadastral vector tiles from PostGIS (/api/gis/tiles). Absolute URL required
 * by MapLibre; falls back to the page origin in dev (Vite proxies /api). */
export const ABSTRACT_TILES = `${API_BASE || window.location.origin}/api/gis/tiles/{z}/{x}/{y}.pbf`;

/** Abstract fills/lines and their labels start here; below this only county
 * boundaries + names carry the view. */
export const MIN_ABSTRACT_ZOOM = 8;

// Wells colored by RRC status.
export const STATUS_COLOR = [
  "match", ["get", "status"],
  "Producing", "#22c55e", "Shut-In", "#f59e0b", "Plugged", "#6b7280", "Permitted", "#3b82f6",
  "Dry Hole", "#78350f", "Active", "#7c3aed", "Canceled/Abandoned", "#9ca3af", "Surface location", "#0ea5e9",
  "#64748b",
] as unknown as maplibregl.ExpressionSpecification;

type Expr = maplibregl.ExpressionSpecification;
const SEL = ["boolean", ["feature-state", "selected"], false] as unknown as Expr;
const ACT = ["boolean", ["feature-state", "active"], false] as unknown as Expr;

/**
 * Paint for the abstract fill/line/label layers. Emphasis is reserved for
 * click-selection ("selected") and deal-linked parcels ("active") via
 * feature-state — map filters no longer restyle features (they zoom to the
 * matching results instead; see MapView's extent effect).
 */
export function abstractsPaint() {
  return {
    fill: {
      "fill-color": ["case", SEL, "#f59e0b", ACT, "#ef4444", "#3b82f6"] as unknown as Expr,
      "fill-opacity": ["case", SEL, 0.55, ACT, 0.45, 0.05] as unknown as Expr,
    },
    line: {
      "line-color": ["case", SEL, "#b45309", "#6b7280"] as unknown as Expr,
      // Zoom expressions must be TOP-LEVEL (not nested in a case) or MapLibre
      // drops the whole layer — zoom outside, selection inside.
      "line-width": ["interpolate", ["linear"], ["zoom"],
        9, ["case", SEL, 3, 0.35],
        12, ["case", SEL, 3, 0.5],
        14, ["case", SEL, 3, 0.65]] as unknown as Expr,
      "line-opacity": ["case", SEL, 1, 0.6] as unknown as Expr,
    },
    num: { "text-color": "#0f172a" },
    survey: { "text-color": "#334155" },
  };
}

/** Paint for the wells circle layer (selection via feature-state). */
export function wellsPaint() {
  return {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2.3, 12, 3.6, 15, 6] as unknown as Expr,
    "circle-stroke-width": ["case", SEL, 3, 0.6] as unknown as Expr,
    "circle-stroke-color": ["case", SEL, "#111827", "#ffffff"] as unknown as Expr,
    "circle-opacity": 0.9,
  };
}

/** Paint for the wellbore laterals layer. */
export function wellboresPaint() {
  return {
    "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 15, 2.5] as unknown as Expr,
    "line-opacity": 0.8,
  };
}

/** Base style: OSM raster basemap + self-hosted SDF glyphs for the label layers. */
export function styleWithGlyphs(): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: `${window.location.origin}/fonts/{fontstack}/{range}.pbf`,
    sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  };
}

/**
 * Add the shared cadastral source + layer stack to a map:
 * counties + county names, abstract fill/lines, wells, wellbore laterals, and
 * abstract-number / survey-name labels. Identical for both maps. Feature-state
 * ("selected"/"active") on the abstracts + wells layers works via promoteId.
 */
export function addCadastralLayers(map: maplibregl.Map, countyLabels: GeoJSON.FeatureCollection): void {
  // One multi-layer vector source: counties (every zoom), abstracts, wells,
  // wellbores. promoteId maps each layer's key to its feature id.
  map.addSource("abstracts", { type: "vector", tiles: [ABSTRACT_TILES], minzoom: 0, maxzoom: 14, promoteId: { abstracts: "id", wells: "fid", wellbores: "fid" } });
  // County name labels (DB-derived points, always inside their polygon).
  map.addSource("county-labels", { type: "geojson", data: countyLabels });
  map.addLayer({ id: "county-names", type: "symbol", source: "county-labels", maxzoom: 10, layout: {
    "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 4, 9, 6, 12, 9, 16],
    "text-transform": "uppercase", "text-letter-spacing": 0.08,
    "text-padding": 4, "text-allow-overlap": false, "text-optional": true },
    paint: { "text-color": "#475569", "text-halo-color": "#ffffff", "text-halo-width": 1.5,
      "text-opacity": ["interpolate", ["linear"], ["zoom"], 8.5, 0.9, 10, 0.4] } });

  const base = abstractsPaint();
  map.addLayer({ id: "abstracts-fill", type: "fill", source: "abstracts", "source-layer": "abstracts", minzoom: MIN_ABSTRACT_ZOOM, paint: base.fill });
  // Abstract boundaries: thin gray lines, in sync with wells + numbers (z9),
  // lighter than the county lines so the two read as different hierarchy levels.
  map.addLayer({ id: "abstracts-line", type: "line", source: "abstracts", "source-layer": "abstracts", minzoom: 9, paint: base.line });
  // County boundaries — drawn above the abstract mesh, slightly heavier so the
  // administrative level stays distinct and always visible.
  map.addLayer({ id: "county-bounds", type: "line", source: "abstracts", "source-layer": "counties", paint: {
    "line-color": "#64748b",
    "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.45, 9, 1.05, 13, 1.5],
    "line-opacity": 0.6 } });
  // Wellbore laterals (surface -> bottom hole).
  const borePaint = wellboresPaint();
  map.addLayer({ id: "wellbores", type: "line", source: "abstracts", "source-layer": "wellbores", minzoom: 10, layout: { "line-cap": "round" }, paint: {
    "line-color": ["match", ["get", "wellboreType"], "Horizontal", "#0f766e", "Directional", "#9333ea", "#0f766e"],
    ...borePaint } });
  map.addLayer({ id: "wellbores-sel", type: "line", source: "abstracts", "source-layer": "wellbores", minzoom: 10, filter: ["==", ["get", "surfaceId"], -1], paint: { "line-color": "#111827", "line-width": 3 } });
  // Surface wells — colored by RRC status; selection via feature-state.
  map.addLayer({ id: "wells", type: "circle", source: "abstracts", "source-layer": "wells", minzoom: 9, paint: {
    "circle-color": STATUS_COLOR,
    ...wellsPaint() } });
  map.addLayer({ id: "abstracts-num", type: "symbol", source: "abstracts", "source-layer": "abstracts", minzoom: 9, layout: {
    "symbol-sort-key": ["*", -1, ["get", "area"]], "text-field": ["get", "abstract"], "text-font": ["Noto Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13], "text-padding": 2, "text-allow-overlap": false, "text-optional": true },
    paint: { ...base.num, "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });
  map.addLayer({ id: "abstracts-survey", type: "symbol", source: "abstracts", "source-layer": "abstracts", minzoom: 12.5, layout: {
    "symbol-sort-key": ["*", -1, ["get", "area"]], "text-field": ["get", "survey"], "text-font": ["Noto Sans Regular"],
    "text-size": 11, "text-offset": [0, 1.1], "text-max-width": 8, "text-padding": 2, "text-allow-overlap": false, "text-optional": true },
    paint: { ...base.survey, "text-halo-color": "#ffffff", "text-halo-width": 1.3 } });
}

/**
 * Surface GIS outages instead of a silently empty canvas: the first failing
 * request from the shared "abstracts" vector source drops a small notice
 * onto the map. The base map keeps working; users learn why layers are gone.
 */
export function watchGisHealth(map: maplibregl.Map): void {
  let shown = false;
  map.on("error", (e) => {
    if (shown) return;
    const err = e as unknown as { sourceId?: string };
    if (err.sourceId !== "abstracts") return;
    shown = true;
    const el = document.createElement("div");
    el.className = "map-notice";
    el.setAttribute("role", "status");
    el.textContent = "Map data layers are unavailable right now — showing the base map only.";
    map.getContainer().appendChild(el);
  });
}
