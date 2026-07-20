import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { collectCoords, bboxOfPoints } from "../lib/geo";
import { addCadastralLayers, styleWithGlyphs } from "../lib/mapLayers";
import { MapLayersPanel } from "./MapLayersPanel";
import { api } from "../api/client";

const TEXAS_CENTER: [number, number] = [-97.5, 31.0];

/** One boundary segment of a tract, carrying its call for the hover readout. */
export interface TractSegment {
  tractId: string;
  seq: number;
  bearing: string | null;
  distance: string | null;
  from: [number, number];
  to: [number, number];
}

export interface TractMapFeature {
  id: string;
  name: string;
  geometry: GeoJSON.Feature | null; // anchored polygon (null until anchored)
  pob: { lon: number; lat: number } | null;
  segments: TractSegment[];
}

// Same layer set as the main map / DealMap so the experience is familiar,
// plus this deal's own abstract footprint as an optional overlay.
// Boundaries, numbers, survey names, wells, and wellbores all start ON — the
// most useful default view; every layer stays individually toggleable. POB is
// deliberately OFF by default (opt-in for presentations that need it).
const DEFAULT_LAYERS = { boundaries: true, numbers: true, surveys: true, wells: true, wellbores: true, dealAbstracts: false, pob: false };

/**
 * Deal-isolated tract map: the shared cadastral stack (lib/mapLayers) with this
 * deal's tract polygons highlighted on top — no other deals, no heat map.
 * Hovering a boundary segment shows its call (bearing + distance); "place POB"
 * mode turns the next map click into a new anchor for the active tract.
 * Rendered with preserveDrawingBuffer so exports can read the canvas.
 */
export function TractMap({ tracts, selectedId, abstractIds = [], placingPob, onPobPlaced, onSelect, onReady }: {
  tracts: TractMapFeature[];
  selectedId: string | null;
  /** The deal's linked abstracts — optional "Deal abstracts" context overlay. */
  abstractIds?: string[];
  placingPob: boolean;
  onPobPlaced: (lon: number, lat: number) => void;
  onSelect: (id: string) => void;
  onReady?: (map: maplibregl.Map) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const layersRef = useRef(layers); layersRef.current = layers;
  const placingRef = useRef(placingPob); placingRef.current = placingPob;
  const cbRef = useRef({ onPobPlaced, onSelect }); cbRef.current = { onPobPlaced, onSelect };
  const [hover, setHover] = useState<{ x: number; y: number; bearing: string | null; distance: string | null; seq: number } | null>(null);
  const fitted = useRef(false);

  const buildSources = () => {
    const polys: GeoJSON.Feature[] = tracts.filter((t) => t.geometry).map((t) => ({
      ...(t.geometry as GeoJSON.Feature),
      properties: { ...(t.geometry as GeoJSON.Feature).properties, tractId: t.id, name: t.name, selected: t.id === selectedId ? 1 : 0 },
    }));
    const pobs: GeoJSON.Feature[] = tracts.filter((t) => t.pob).map((t) => ({
      type: "Feature", properties: { tractId: t.id, name: t.name },
      geometry: { type: "Point", coordinates: [t.pob!.lon, t.pob!.lat] },
    }));
    const segs: GeoJSON.Feature[] = tracts.flatMap((t) => t.segments.map((s) => ({
      type: "Feature" as const,
      properties: { tractId: s.tractId, seq: s.seq, bearing: s.bearing, distance: s.distance },
      geometry: { type: "LineString" as const, coordinates: [s.from, s.to] },
    })));
    return {
      polys: { type: "FeatureCollection", features: polys } as GeoJSON.FeatureCollection,
      pobs: { type: "FeatureCollection", features: pobs } as GeoJSON.FeatureCollection,
      segs: { type: "FeatureCollection", features: segs } as GeoJSON.FeatureCollection,
    };
  };

  useEffect(() => {
    if (mapRef.current || !container.current) return;
    const map = new maplibregl.Map({
      container: container.current, style: styleWithGlyphs(),
      center: TEXAS_CENTER, zoom: 6,
      preserveDrawingBuffer: true, // required for PNG/PDF export capture
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "imperial" }), "bottom-left");
    mapRef.current = map;

    map.on("load", async () => {
      const countyLabels = await fetch(`/data/county-labels.geojson`).then((r) => r.json())
        .catch(() => ({ type: "FeatureCollection", features: [] }));
      addCadastralLayers(map, countyLabels as GeoJSON.FeatureCollection);

      // Deal-boundary context: the abstracts linked to this deal, amber like
      // DealMap, hidden until the "Deal abstracts" toggle is switched on.
      const dealFC = abstractIds.length
        ? await api.get<GeoJSON.FeatureCollection>(`/gis/features?ids=${encodeURIComponent(abstractIds.join(","))}`)
            .catch(() => ({ type: "FeatureCollection", features: [] } as GeoJSON.FeatureCollection))
        : ({ type: "FeatureCollection", features: [] } as GeoJSON.FeatureCollection);
      map.addSource("deal-abstracts", { type: "geojson", data: dealFC });
      map.addLayer({ id: "deal-abs-fill", type: "fill", source: "deal-abstracts", layout: { visibility: "none" }, paint: { "fill-color": "#f59e0b", "fill-opacity": 0.18 } });
      map.addLayer({ id: "deal-abs-line", type: "line", source: "deal-abstracts", layout: { visibility: "none" }, paint: { "line-color": "#b45309", "line-width": 1.5, "line-dasharray": [2, 1.5] } });

      const src = buildSources();
      map.addSource("tracts", { type: "geojson", data: src.polys });
      map.addSource("tract-segments", { type: "geojson", data: src.segs });
      map.addSource("tract-pobs", { type: "geojson", data: src.pobs });

      map.addLayer({ id: "tract-fill", type: "fill", source: "tracts", paint: {
        "fill-color": ["case", ["==", ["get", "selected"], 1], "#059669", "#10b981"],
        "fill-opacity": ["case", ["==", ["get", "selected"], 1], 0.4, 0.28] } });
      map.addLayer({ id: "tract-line", type: "line", source: "tracts", paint: {
        "line-color": ["case", ["==", ["get", "selected"], 1], "#065f46", "#047857"],
        "line-width": ["case", ["==", ["get", "selected"], 1], 3, 2] } });
      // Wide invisible hit area over each call segment + a hover highlight.
      map.addLayer({ id: "tract-seg-hit", type: "line", source: "tract-segments", paint: { "line-color": "#000", "line-opacity": 0, "line-width": 12 } });
      map.addLayer({ id: "tract-seg-hover", type: "line", source: "tract-segments", filter: ["==", ["get", "seq"], -1], paint: { "line-color": "#f59e0b", "line-width": 4 } });
      map.addLayer({ id: "tract-pob", type: "circle", source: "tract-pobs", paint: {
        "circle-radius": 6, "circle-color": "#dc2626", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
      map.addLayer({ id: "tract-pob-label", type: "symbol", source: "tract-pobs", layout: {
        "text-field": "POB", "text-font": ["Noto Sans Regular"], "text-size": 10, "text-offset": [0, 1.2] },
        paint: { "text-color": "#b91c1c", "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });

      ready.current = true;
      applyVis();
      fitToTracts(true);
      onReady?.(map);

      map.on("mousemove", "tract-seg-hit", (ev) => {
        const f = ev.features?.[0];
        if (!f) return;
        map.getCanvas().style.cursor = placingRef.current ? "crosshair" : "pointer";
        map.setFilter("tract-seg-hover", ["all", ["==", ["get", "seq"], f.properties.seq], ["==", ["get", "tractId"], f.properties.tractId]]);
        setHover({ x: ev.point.x, y: ev.point.y, bearing: (f.properties.bearing as string) || null, distance: (f.properties.distance as string) || null, seq: f.properties.seq as number });
      });
      map.on("mouseleave", "tract-seg-hit", () => {
        map.getCanvas().style.cursor = placingRef.current ? "crosshair" : "";
        map.setFilter("tract-seg-hover", ["==", ["get", "seq"], -1]);
        setHover(null);
      });
      map.on("click", (ev) => {
        if (placingRef.current) { cbRef.current.onPobPlaced(ev.lngLat.lng, ev.lngLat.lat); return; }
        const hits = map.queryRenderedFeatures(ev.point, { layers: ["tract-fill"] });
        if (hits.length) cbRef.current.onSelect(String(hits[0].properties.tractId));
      });
    });
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep sources in sync as tracts change (add/edit/anchor moves).
  useEffect(() => {
    const map = mapRef.current; if (!map || !ready.current) return;
    const src = buildSources();
    (map.getSource("tracts") as maplibregl.GeoJSONSource | undefined)?.setData(src.polys);
    (map.getSource("tract-segments") as maplibregl.GeoJSONSource | undefined)?.setData(src.segs);
    (map.getSource("tract-pobs") as maplibregl.GeoJSONSource | undefined)?.setData(src.pobs);
    fitToTracts(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracts, selectedId]);

  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    map.getCanvas().style.cursor = placingPob ? "crosshair" : "";
    if (!placingPob) return;
    // Place the POB from a plain DOM click + unproject rather than relying on
    // MapLibre's synthesized click: the gesture pipeline can miss clicks in
    // some browsers, and this interaction must never feel unresponsive.
    // (TractSection's placePob ignores a second call, so if MapLibre's own
    // click handler also fires it's harmless.)
    const canvas = map.getCanvas();
    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const ll = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
      cbRef.current.onPobPlaced(ll.lng, ll.lat);
    };
    canvas.addEventListener("click", onClick);
    return () => canvas.removeEventListener("click", onClick);
  }, [placingPob]);

  function fitToTracts(initial: boolean) {
    const map = mapRef.current; if (!map) return;
    const pts = tracts.flatMap((t) => (t.geometry ? collectCoords(t.geometry.geometry as { type: string; coordinates: unknown }) : []));
    for (const t of tracts) if (!t.geometry && t.pob) pts.push([t.pob.lon, t.pob.lat]);
    if (!pts.length) return;
    if (!initial && fitted.current) return; // don't fight user pan/zoom after first fit
    fitted.current = true;
    const [w, s, e, n] = bboxOfPoints(pts);
    map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 15, duration: 0 });
  }

  function applyVis() {
    const map = mapRef.current; if (!map || !ready.current) return;
    const L = layersRef.current;
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("abstracts-fill", L.boundaries); vis("abstracts-line", L.boundaries);
    vis("abstracts-num", L.numbers); vis("abstracts-survey", L.surveys);
    vis("wells", L.wells); vis("wellbores", L.wellbores); vis("wellbores-sel", L.wellbores);
    vis("deal-abs-fill", L.dealAbstracts); vis("deal-abs-line", L.dealAbstracts);
    vis("tract-pob", L.pob); vis("tract-pob-label", L.pob);
  }
  useEffect(applyVis, [layers]);

  const toggle = (k: keyof typeof layers) => setLayers((p) => ({ ...p, [k]: !p[k] }));

  const mapped = tracts.filter((t) => t.geometry).length;
  return (
    <div className="deal-map">
      <div className="dm-canvas">
        <div ref={container} style={{ position: "absolute", inset: 0 }} />
        {/* Same collapsible floating Layers control as the Marketplace map;
            the reset button sits beside it, exactly like the portal maps. */}
        <div className="portal-map-controls">
          {placingPob && <span className="muted" style={{ fontSize: 12, alignSelf: "center", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 8px" }}>Click the map to place the Point of Beginning</span>}
          <button className="small portal-map-reset" onClick={() => { fitted.current = false; fitToTracts(true); }} title="Zoom back to the full tract extent">⌂ Reset view</button>
          <MapLayersPanel
            variant="floating"
            collapsible
            storageKey="mh-tractmap-layers-open"
            defs={[
              { key: "boundaries", label: "Abstract boundaries" }, { key: "numbers", label: "Abstract numbers" },
              { key: "surveys", label: "Survey names" }, { key: "wells", label: "Wells" },
              { key: "wellbores", label: "Wellbores (laterals)" },
              { key: "pob", label: "Point of Beginning (POB)" },
              ...(abstractIds.length > 0 ? [{ key: "dealAbstracts", label: "Deal abstracts" }] : []),
            ]}
            layers={layers}
            onToggle={(k) => toggle(k as keyof typeof layers)}
          />
        </div>
        {hover && (
          <div className="dm-info" style={{ left: Math.min(hover.x + 12, 9999), top: hover.y + 12, right: "auto", position: "absolute", pointerEvents: "none" }}>
            <strong>Call {hover.seq}</strong>
            <div className="muted" style={{ fontSize: 12 }}>{[hover.bearing, hover.distance].filter(Boolean).join(" · ") || "unresolved call"}</div>
          </div>
        )}
        {/* Hidden while placing a POB: the overlay is opaque and sits over the
            canvas, which would both hide the map and swallow the placement
            click — the exact interaction the user was asked to perform. */}
        {mapped === 0 && !placingPob && (
          <div className="dm-empty">
            {tracts.length === 0
              ? "No tract descriptions yet. Add one below to see it mapped."
              : "No tract could be anchored to the map yet — set a Point of Beginning (Place POB) or check the parse warnings."}
          </div>
        )}
      </div>
    </div>
  );
}
