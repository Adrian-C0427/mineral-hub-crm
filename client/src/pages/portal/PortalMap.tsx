import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { addCadastralLayers, styleWithGlyphs } from "../../lib/mapLayers";
import { MapLayersPanel } from "../../components/MapLayersPanel";
import { collectCoords, bboxOfPoints } from "../../lib/geo";
import type { FC } from "./portalApi";

const TX_CENTER: [number, number] = [-98.5, 31.3];

const DEFAULT_LAYERS = { counties: true, boundaries: true, numbers: true, surveys: true, wells: true, wellbores: true };
type LayerState = typeof DEFAULT_LAYERS;

/**
 * Public offering map — the same cadastral engine as the CRM (vector tiles
 * from PostGIS), with the offering's abstracts highlighted, layer toggles,
 * zoom/pan/reset controls, and auto-fit to the property's extent.
 */
export function PortalMap({ features, height = 420, onSelect }: {
  features: FC;
  /** Pixel height, or any CSS length (e.g. "100%") to fill a flex container. */
  height?: number | string;
  /** Marketplace mode: called with the clicked feature's deal slug. */
  onSelect?: (slug: string, name: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const homeBounds = useRef<[[number, number], [number, number]] | null>(null);
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const layersRef = useRef(layers); layersRef.current = layers;
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  const [hovered, setHovered] = useState<string | null>(null);

  function applyVis(): void {
    const map = mapRef.current; if (!map || !ready.current) return;
    const L = layersRef.current;
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("county-bounds", L.counties); vis("county-names", L.counties);
    vis("abstracts-line", L.boundaries); vis("abstracts-fill", L.boundaries);
    vis("abstracts-num", L.numbers);
    vis("abstracts-survey", L.surveys);
    vis("wells", L.wells);
    vis("wellbores", L.wellbores);
  }

  useEffect(() => {
    if (mapRef.current || !container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: styleWithGlyphs(), center: TX_CENTER, zoom: 6 });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;
    map.on("load", async () => {
      const countyLabels = await fetch(`/data/county-labels.geojson`).then((r) => r.json()).catch(() => ({ type: "FeatureCollection", features: [] }));
      addCadastralLayers(map, countyLabels as unknown as GeoJSON.FeatureCollection);
      map.addSource("offering", { type: "geojson", data: features as unknown as GeoJSON.FeatureCollection, promoteId: "id" });
      map.addLayer({ id: "offering-fill", type: "fill", source: "offering", paint: { "fill-color": "#f59e0b", "fill-opacity": 0.3 } }, map.getLayer("wellbores") ? "wellbores" : undefined);
      map.addLayer({ id: "offering-line", type: "line", source: "offering", paint: { "line-color": "#b45309", "line-width": 2 } }, map.getLayer("wellbores") ? "wellbores" : undefined);

      const pts = features.features.flatMap((f) => collectCoords(f.geometry));
      if (pts.length) {
        const [w, s, e, n] = bboxOfPoints(pts);
        homeBounds.current = [[w, s], [e, n]];
        map.fitBounds(homeBounds.current, { padding: 50, maxZoom: 13, duration: 0 });
      }
      map.on("click", "offering-fill", (ev) => {
        const p = ev.features?.[0]?.properties as Record<string, unknown> | undefined;
        if (p?.slug && onSelectRef.current) onSelectRef.current(String(p.slug), String(p.name ?? ""));
      });
      map.on("mousemove", "offering-fill", (ev) => {
        map.getCanvas().style.cursor = onSelectRef.current ? "pointer" : "";
        const p = ev.features?.[0]?.properties as Record<string, unknown> | undefined;
        setHovered(p ? String(p.name ?? p.abstract ?? "") : null);
      });
      map.on("mouseleave", "offering-fill", () => { map.getCanvas().style.cursor = ""; setHovered(null); });
      ready.current = true;
      applyVis();
    });
    return () => { map.remove(); mapRef.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Marketplace data can arrive after mount — refresh the highlight source.
  useEffect(() => {
    const map = mapRef.current; if (!map || !ready.current) return;
    (map.getSource("offering") as maplibregl.GeoJSONSource | undefined)?.setData(features as unknown as GeoJSON.FeatureCollection);
    const pts = features.features.flatMap((f) => collectCoords(f.geometry));
    if (pts.length) {
      const [w, s, e, n] = bboxOfPoints(pts);
      homeBounds.current = [[w, s], [e, n]];
      map.fitBounds(homeBounds.current, { padding: 50, maxZoom: 13, duration: 400 });
    }
  }, [features]);

  // Keep the canvas sized to its container — the marketplace panel is resizable,
  // so the map's box changes without a window resize event.
  useEffect(() => {
    const el = container.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(applyVis, [layers]);

  const toggle = (k: keyof LayerState) => setLayers((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div className="portal-map" style={{ position: "relative", height, borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
      <div ref={container} style={{ position: "absolute", inset: 0 }} />
      <button
        className="small portal-map-reset"
        onClick={() => homeBounds.current && mapRef.current?.fitBounds(homeBounds.current, { padding: 50, maxZoom: 13, duration: 500 })}
        title="Reset view to the property"
      >⌂ Reset view</button>
      <MapLayersPanel
        variant="floating"
        collapsible
        defs={[
          { key: "counties", label: "Counties" }, { key: "boundaries", label: "Abstract boundaries" },
          { key: "numbers", label: "Abstract numbers" }, { key: "surveys", label: "Survey names" },
          { key: "wells", label: "Wells" }, { key: "wellbores", label: "Wellbores (laterals)" },
        ]}
        layers={layers}
        onToggle={(k) => toggle(k as keyof LayerState)}
      />
      {hovered && <div className="portal-map-hover">{hovered}</div>}
    </div>
  );
}
