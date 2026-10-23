import * as maplibregl from "maplibre-gl";
import { API_BASE } from "../api/client";
import { LEGACY_STATUS, STATUS_COLORS } from "./wellStatus";

// Shared cadastral map layer stack used identically by the main map (MapView)
// and the per-deal map (DealMap), so the two can never visually drift. Callers
// add their own extras (heat, deal highlight) on top via addLayer beforeId.

/** Tile data version — BUMP THIS whenever the underlying map data changes
 * (county scope edits, well re-imports, deletions). Browsers cache tiles for
 * an hour keyed by full URL, so a new value makes every client abandon its
 * stale tiles immediately; the server ignores the query param (its own LRU
 * clears on the deploy that ships the bump). */
export const TILE_DATA_VERSION = "2026-10-18";

/** Cadastral vector tiles from PostGIS (/api/gis/tiles). Absolute URL required
 * by MapLibre; falls back to the page origin in dev (Vite proxies /api). */
export const ABSTRACT_TILES = `${API_BASE || window.location.origin}/api/gis/tiles/{z}/{x}/{y}.pbf?v=${TILE_DATA_VERSION}`;

/** Abstract fills/lines and their labels start here; below this only county
 * boundaries + names carry the view. */
export const MIN_ABSTRACT_ZOOM = 8;

/** A `match` on a status property → its color (normalized vocabulary, plus
 * the pre-2026-10 values so tiles cached before the refresh still color). */
export function statusColorExpr(prop: string): maplibregl.ExpressionSpecification {
  return [
    "match", ["get", prop],
    ...Object.entries(STATUS_COLORS).flat(),
    ...Object.entries(LEGACY_STATUS).flatMap(([legacy, s]) => [legacy, STATUS_COLORS[s]]),
    STATUS_COLORS["Other/Unknown"],
  ] as unknown as maplibregl.ExpressionSpecification;
}

// Wells colored by normalized status.
export const STATUS_COLOR = statusColorExpr("status");

type Expr = maplibregl.ExpressionSpecification;
const SEL = ["boolean", ["feature-state", "selected"], false] as unknown as Expr;
const ACT = ["boolean", ["feature-state", "active"], false] as unknown as Expr;
// Owned mineral assets on HOLD — highlighted distinctly from active deals.
const OWN = ["boolean", ["feature-state", "owned"], false] as unknown as Expr;

/**
 * Paint for the abstract fill/line/label layers. Emphasis is reserved for
 * click-selection ("selected") and deal-linked parcels ("active") via
 * feature-state — map filters no longer restyle features (they zoom to the
 * matching results instead; see MapView's extent effect).
 */
export function abstractsPaint() {
  return {
    fill: {
      "fill-color": ["case", SEL, "#f59e0b", ACT, "#ef4444", OWN, "#8b5cf6", "#3b82f6"] as unknown as Expr,
      "fill-opacity": ["case", SEL, 0.55, ACT, 0.45, OWN, 0.4, 0.05] as unknown as Expr,
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

/** Paint for the wellbore paths layer (surface location → bottom hole). */
export function wellboresPaint() {
  return {
    "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 15, 2.5] as unknown as Expr,
    "line-opacity": 0.85,
  };
}

/** Paint for bottom-hole points: hollow, ringed in the wellbore's status color. */
export function bottomHolesPaint() {
  return {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.2, 13, 3.4, 16, 5.5] as unknown as Expr,
    "circle-color": "#ffffff",
    "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 15, 2] as unknown as Expr,
    "circle-stroke-color": statusColorExpr("boreStatus"),
    "circle-opacity": 0.95,
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
  map.addSource("abstracts", { type: "vector", tiles: [ABSTRACT_TILES], minzoom: 0, maxzoom: 14, promoteId: { abstracts: "id", wells: "fid", wellbores: "fid", bottomholes: "fid" } });
  // County name labels (DB-derived points, always inside their polygon).
  // Louisiana points carry a `label` ("Caddo Parish") so a parish never reads
  // as the same-named Texas county; Texas points print their name.
  map.addSource("county-labels", { type: "geojson", data: countyLabels });
  map.addLayer({ id: "county-names", type: "symbol", source: "county-labels", maxzoom: 10, layout: {
    "text-field": ["coalesce", ["get", "label"], ["get", "name"]] as unknown as Expr, "text-font": ["Noto Sans Regular"],
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
  // Bottom-hole locations of horizontal / directional wellbores (the far end
  // of each path). Selectable: they open their surface well.
  map.addLayer({ id: "bottomholes", type: "circle", source: "abstracts", "source-layer": "bottomholes", minzoom: 10, paint: bottomHolesPaint() });
  map.addLayer({ id: "bottomholes-sel", type: "circle", source: "abstracts", "source-layer": "bottomholes", minzoom: 10, filter: ["==", ["get", "surfaceId"], -1], paint: {
    "circle-radius": 6, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2.5, "circle-stroke-color": "#111827" } });
  // Surface wells — colored by RRC status; selection via feature-state.
  map.addLayer({ id: "wells", type: "circle", source: "abstracts", "source-layer": "wells", minzoom: 9, paint: {
    "circle-color": STATUS_COLOR,
    ...wellsPaint() } });
  // East Texas Basin salt domes (approximate extent, BEG RI-140): a subtle
  // warm wash with a dashed ring so they read as a geologic overlay, never as
  // cadastral or well data. Rendered under wells so well dots stay clickable.
  map.addLayer({ id: "salt-domes-fill", type: "fill", source: "abstracts", "source-layer": "saltdomes", paint: {
    "fill-color": "#d97706", "fill-opacity": 0.10 } }, "wells");
  map.addLayer({ id: "salt-domes-line", type: "line", source: "abstracts", "source-layer": "saltdomes", paint: {
    "line-color": "#b45309", "line-dasharray": [3, 2],
    "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1, 11, 2, 14, 2.5] as unknown as Expr,
    "line-opacity": 0.85 } }, "wells");
  map.addLayer({ id: "salt-domes-label", type: "symbol", source: "abstracts", "source-layer": "saltdomes", minzoom: 8, layout: {
    "text-field": ["concat", ["get", "name"], " Salt Dome"] as unknown as Expr, "text-font": ["Noto Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 12, 14] as unknown as Expr,
    "text-letter-spacing": 0.05, "text-allow-overlap": false, "text-optional": true },
    paint: { "text-color": "#92400e", "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });

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

/** Source id of the imported-tract (shapefile) overlay. */
export const TRACT_SOURCE = "org-tracts";
export const TRACT_LAYERS = ["tracts-fill", "tracts-line", "tracts-label"] as const;

/**
 * Imported tract boundaries (user-uploaded shapefiles, org-scoped), drawn the
 * same way on the main map and every deal map. Served as an authed GeoJSON
 * overlay — org data never rides the public cached tile pipeline — and
 * inserted under `beforeId` (wells) so well dots stay clickable.
 */
export function addTractLayers(map: maplibregl.Map, beforeId?: string): void {
  map.addSource(TRACT_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // Tracts whose DBF carries a STATUS attribute (title-work exports use
  // LEASED / UNLEASED / SOLD …) are color-coded and fill more opaquely;
  // untagged imports keep the original faint teal. UNLEASED is tested
  // before LEASED because "in" is a substring match.
  const tractStatus = ["to-string", ["coalesce", ["get", "STATUS"], ["get", "Status"], ["get", "status"], ""]];
  const hasStatus = (needle: string) => ["any", ["in", needle, tractStatus], ["in", needle.toLowerCase(), tractStatus], ["in", needle[0] + needle.slice(1).toLowerCase(), tractStatus]];
  const byStatus = (unleased: string, leased: string, sold: string, fallback: string) => [
    "case",
    hasStatus("UNLEASED"), unleased,
    hasStatus("LEASED"), leased,
    hasStatus("SOLD"), sold,
    fallback,
  ] as unknown as maplibregl.ExpressionSpecification;
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer({ id: "tracts-fill", type: "fill", source: TRACT_SOURCE, paint: {
    "fill-color": byStatus("#d21f1f", "#2e8b57", "#8c8c8c", "#0d9488"),
    "fill-opacity": ["case", ["!=", tractStatus, ""], 0.45, 0.16] as unknown as maplibregl.ExpressionSpecification } }, before);
  map.addLayer({ id: "tracts-line", type: "line", source: TRACT_SOURCE, paint: {
    "line-color": byStatus("#a01818", "#1e6b41", "#6e6e6e", "#0f766e"),
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 13, 2.4] as unknown as maplibregl.ExpressionSpecification,
    "line-opacity": 0.9 } }, before);
  map.addLayer({ id: "tracts-label", type: "symbol", source: TRACT_SOURCE, minzoom: 9, layout: {
    "text-field": ["get", "__name"] as unknown as maplibregl.ExpressionSpecification, "text-font": ["Noto Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 13, 13] as unknown as maplibregl.ExpressionSpecification,
    "text-allow-overlap": false, "text-optional": true },
    paint: { "text-color": "#115e59", "text-halo-color": "#ffffff", "text-halo-width": 1.4 } }, before);
}

/** Source id of the pooled-unit overlay (operators' RRC permit plats; server domain/pooledUnits). */
export const UNIT_SOURCE = "pooled-units";
export const UNIT_LAYERS = ["units-fill", "units-line", "units-label"] as const;
/**
 * One color per unit, so neighbouring units stand apart: the bundle gives each unit an index into
 * this palette, chosen so no two touching or overlapping units share a color (tools/rrc/units
 * stage4_bundle.py keeps the same list in the same order). Deep, saturated tones that read as areas
 * next to the brighter well-status dots.
 */
export const UNIT_PALETTE = ["#c2410c", "#a16207", "#4d7c0f", "#15803d", "#0e7490", "#1d4ed8", "#6d28d9", "#be185d"] as const;
/** Fallback for a bundle without color indexes: one hue per operator. */
const UNIT_OPERATOR_COLORS: Record<string, string> = { Comstock: "#b45309", Mitsui: "#be185d" };
const UNIT_FALLBACK_COLOR = "#57534e";

/** The color a unit is drawn in (same rule as the map layers). */
export function unitColor(u: { colorIndex: number | null; operator: string }): string {
  if (u.colorIndex != null && Number.isInteger(u.colorIndex) && u.colorIndex >= 0 && u.colorIndex < UNIT_PALETTE.length) return UNIT_PALETTE[u.colorIndex];
  return UNIT_OPERATOR_COLORS[u.operator] ?? UNIT_FALLBACK_COLOR;
}

/**
 * Pooled-unit outlines as drawn on the operators' permit plats, placed from
 * each plat's surveyed points (see server domain/pooledUnits for the checks a
 * unit passed to be included). Each unit in its own color: outline, light
 * fill, and name + called acres from zoom 11; inserted under `beforeId` so
 * wells and tracts stay on top.
 */
export function addUnitLayers(map: maplibregl.Map, beforeId?: string): void {
  map.addSource(UNIT_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const byOperator = ["match", ["get", "operator"], ...Object.entries(UNIT_OPERATOR_COLORS).flat(), UNIT_FALLBACK_COLOR];
  // index -> palette color; a bundle without indexes falls back to the operator's color. (A
  // ["literal", [...colors]] array fails style validation, "array<color>" vs "array<string>",
  // which silently drops the layer, hence the match.)
  const color = ["match", ["get", "colorIndex"], ...UNIT_PALETTE.flatMap((c, i) => [i, c]), byOperator] as unknown as maplibregl.ExpressionSpecification;
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer({ id: "units-fill", type: "fill", source: UNIT_SOURCE, paint: { "fill-color": color, "fill-opacity": 0.14 } }, before);
  map.addLayer({ id: "units-line", type: "line", source: UNIT_SOURCE, paint: {
    "line-color": color,
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 2, 15, 3] as unknown as maplibregl.ExpressionSpecification,
    "line-opacity": 0.9 } }, before);
  map.addLayer({ id: "units-label", type: "symbol", source: UNIT_SOURCE, minzoom: 11, layout: {
    "text-field": ["get", "label"] as unknown as maplibregl.ExpressionSpecification, "text-font": ["Noto Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 14, 13] as unknown as maplibregl.ExpressionSpecification,
    "text-allow-overlap": false, "text-optional": true, "symbol-placement": "point" },
    paint: { "text-color": color, "text-halo-color": "#ffffff", "text-halo-width": 1.4 } }, before);
}

/** A clicked pooled unit, as the map panel shows it. */
export interface UnitInfo {
  id: string; name: string; operator: string; county: string;
  calledAcres: number; mappedAcres: number;
  /** Index into UNIT_PALETTE (null for an older bundle: the operator's color is used). */
  colorIndex: number | null;
  /** % the plat's drawing differs from its called acres, when more than 2.5% (null otherwise). */
  drawnVsCalledPct: number | null;
  wells: { api: string; lease: string | null; wellNo: string | null; permit: string }[];
  plat: { permit: string; rrcId: string; url: string; file: string } | null;
  placement: { method: "unit-plat" | "well-plat"; basis?: "well-points" | "survey-lines"; controlResidualFt: number; within10ftPct: number | null; note?: string } | null;
}
export function unitInfo(p: Record<string, unknown>): UnitInfo {
  const json = <T,>(v: unknown, fallback: T): T => {
    if (typeof v !== "string") return (v as T) ?? fallback;
    try { return JSON.parse(v) as T; } catch { return fallback; }
  };
  return {
    id: String(p.id ?? ""), name: String(p.name ?? "Pooled unit"), operator: String(p.operator ?? ""), county: String(p.county ?? ""),
    calledAcres: Number(p.calledAcres), mappedAcres: Number(p.mappedAcres),
    colorIndex: p.colorIndex == null || p.colorIndex === "" || !Number.isInteger(Number(p.colorIndex)) ? null : Number(p.colorIndex),
    drawnVsCalledPct: p.drawnVsCalledPct == null || p.drawnVsCalledPct === "" || !Number.isFinite(Number(p.drawnVsCalledPct)) ? null : Number(p.drawnVsCalledPct),
    wells: json(p.wells, []), plat: json(p.plat, null), placement: json(p.placement, null),
  };
}

/** A clicked imported tract: its name, source file, owning deal, and attributes. */
export interface TractInfo {
  id: string; name: string; sourceFile: string;
  dealId: string | null; dealName: string | null;
  attrs: [string, string][];
}
export function tractInfo(p: Record<string, unknown>): TractInfo {
  const attrs = Object.entries(p)
    .filter(([k, v]) => !k.startsWith("__") && v != null && String(v).trim() !== "")
    .slice(0, 14)
    .map(([k, v]) => [k, String(v)] as [string, string]);
  return {
    id: String(p.__id ?? ""), name: String(p.__name ?? "Tract"), sourceFile: String(p.__source ?? ""),
    dealId: p.__dealId ? String(p.__dealId) : null, dealName: p.__dealName ? String(p.__dealName) : null,
    attrs,
  };
}

// ---------------------------------------------------------------------------
// W-1 laterals and lease tracts — two more overlays read off the same permit
// plats as the pooled units (server domain/platOverlays).
// ---------------------------------------------------------------------------

/** Source / layer ids of the W-1 laterals overlay: each permit's own plat points and lateral lines. */
export const LATERAL_SOURCE = "w1-laterals";
export const LATERAL_LAYERS = ["laterals-line", "laterals-point"] as const;
export const LATERAL_COLOR = "#be123c";
/** Source / layer ids of the lease-tract overlay (tracts a lateral crosses that were not pooled). */
export const LEASE_SOURCE = "lease-tracts";
export const LEASE_LAYERS = ["leases-fill", "leases-line", "leases-label"] as const;
export const LEASE_COLOR = "#7c2d12";

/**
 * W-1 laterals: the lateral as the permit plat prints it (surface → penetration
 * / first take → bottom hole), independent of RRC's well layers. A solid line
 * in one colour; surface and bottom-hole points as rings, take points as dots.
 */
export function addLateralLayers(map: maplibregl.Map, beforeId?: string): void {
  map.addSource(LATERAL_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer({ id: "laterals-line", type: "line", source: LATERAL_SOURCE, filter: ["==", ["get", "feature"], "line"], paint: {
    "line-color": LATERAL_COLOR,
    "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 13, 2.4] as unknown as maplibregl.ExpressionSpecification,
    "line-opacity": 0.9 } }, before);
  map.addLayer({ id: "laterals-point", type: "circle", source: LATERAL_SOURCE, filter: ["==", ["get", "feature"], "point"], minzoom: 10, paint: {
    "circle-radius": ["match", ["get", "role"], "take", 3, 4.5] as unknown as maplibregl.ExpressionSpecification,
    "circle-color": ["match", ["get", "role"], "take", LATERAL_COLOR, "#ffffff"] as unknown as maplibregl.ExpressionSpecification,
    "circle-stroke-color": LATERAL_COLOR, "circle-stroke-width": 1.6 } }, before);
}

/**
 * Lease tracts crossed by a lateral but not pooled: a faint fill, a dashed
 * outline (so they read differently from pooled units) and a label from zoom 11.
 */
export function addLeaseTractLayers(map: maplibregl.Map, beforeId?: string): void {
  map.addSource(LEASE_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer({ id: "leases-fill", type: "fill", source: LEASE_SOURCE, paint: { "fill-color": LEASE_COLOR, "fill-opacity": 0.08 } }, before);
  map.addLayer({ id: "leases-line", type: "line", source: LEASE_SOURCE, paint: {
    "line-color": LEASE_COLOR, "line-dasharray": [3, 2],
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 1.8, 15, 2.6] as unknown as maplibregl.ExpressionSpecification,
    "line-opacity": 0.9 } }, before);
  map.addLayer({ id: "leases-label", type: "symbol", source: LEASE_SOURCE, minzoom: 11, layout: {
    "text-field": ["get", "label"] as unknown as maplibregl.ExpressionSpecification, "text-font": ["Noto Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 14, 12] as unknown as maplibregl.ExpressionSpecification,
    "text-allow-overlap": false, "text-optional": true, "symbol-placement": "point" },
    paint: { "text-color": LEASE_COLOR, "text-halo-color": "#ffffff", "text-halo-width": 1.4 } }, before);
}

/** A clicked W-1 lateral point or line, as the map panel shows it. */
export interface LateralInfo { api: string; apiLabel: string; well: string; operator: string; county: string; platKind: string; feature: "point" | "line"; pointCount: number; source: string }
export function lateralInfo(p: Record<string, unknown>): LateralInfo {
  return {
    api: String(p.api ?? ""), apiLabel: String(p.apiLabel ?? ""), well: String(p.well ?? "Well"), operator: String(p.operator ?? ""), county: String(p.county ?? ""),
    platKind: String(p.kind ?? ""), feature: p.feature === "line" ? "line" : "point", pointCount: Number(p.pointCount ?? 0), source: String(p.source ?? ""),
  };
}
/** A clicked lease tract, as the map panel shows it. */
export interface LeaseInfo { id: string; lease: string; operator: string; county: string; calledAcres: number; mappedAcres: number; well: string; plat: string }
export function leaseInfo(p: Record<string, unknown>): LeaseInfo {
  return {
    id: String(p.id ?? ""), lease: String(p.lease ?? "Lease tract"), operator: String(p.operator ?? ""), county: String(p.county ?? ""),
    calledAcres: Number(p.calledAcres), mappedAcres: Number(p.mappedAcres), well: String(p.well ?? ""), plat: String(p.plat ?? ""),
  };
}
