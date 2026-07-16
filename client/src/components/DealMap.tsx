import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { collectCoords, bboxOfPoints, convexHull } from "../lib/geo";
import { num } from "../lib/format";
import { api } from "../api/client";
import { addCadastralLayers, styleWithGlyphs, watchGisHealth } from "../lib/mapLayers";
import { MapLayersPanel } from "./MapLayersPanel";

const LEON_CENTER: [number, number] = [-95.99, 31.29];

type FC = { type: "FeatureCollection"; features: { type: "Feature"; id?: string | number; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] };
type Sel = { kind: "abstract"; abstract: string; survey: string; county: string } | { kind: "well"; api: string; wellNo: string; operator: string; leaseName: string; status: string; type: string } | null;

// Same layer set the main map exposes (minus the always-on county boundaries /
// names); no filters, no heat map — just the layer toggles.
const DEFAULT_LAYERS = { boundaries: true, numbers: true, surveys: true, wells: true, wellbores: true };

/**
 * Compact per-deal map. Renders the identical cadastral stack as the main map
 * (lib/mapLayers) — county boundaries + names, abstracts, wells, laterals,
 * labels — with the deal's own abstracts highlighted on top. No filters/heat.
 */
export function DealMap({ abstractIds }: { abstractIds: string[] }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const layersRef = useRef(layers); layersRef.current = layers;
  const [selected, setSelected] = useState<Sel>(null);
  const idSet = useMemo(() => new Set(abstractIds), [abstractIds]);
  // Latest ids for the async map-load handler (the map mounts once, but the
  // deal's abstracts can be edited while it lives).
  const idsRef = useRef(abstractIds); idsRef.current = abstractIds;
  // Ids currently carrying the "selected" feature-state, for cleanup on change.
  const prevIds = useRef<string[]>(abstractIds);

  useEffect(() => {
    if (mapRef.current || !container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: styleWithGlyphs(), center: LEON_CENTER, zoom: 9 });
    watchGisHealth(map);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;

    map.on("load", async () => {
      // County label points (shared layer stack) + this deal's own abstract
      // geometry (fill / hull / zoom-to-fit). Everything else streams as tiles.
      const ids = [...idsRef.current];
      const [countyLabels, dealFC] = await Promise.all([
        fetch(`/data/county-labels.geojson`).then((r) => r.json()).catch(() => ({ type: "FeatureCollection", features: [] })),
        ids.length
          ? api.get<FC>(`/gis/features?ids=${encodeURIComponent(ids.join(","))}`).catch(() => ({ type: "FeatureCollection", features: [] } as FC))
          : Promise.resolve({ type: "FeatureCollection", features: [] } as FC),
      ]);
      const dealFeats = dealFC.features;

      // Identical cadastral source + layers as the main map.
      addCadastralLayers(map, countyLabels as unknown as GeoJSON.FeatureCollection);

      // Highlight this deal's abstracts the same way the main map does: via
      // feature-state on the SHARED tile layers (abstractsPaint reacts to
      // "selected"), so each parcel is drawn once with the main map's exact
      // styling and layer order — no duplicate boundary stacked on top.
      for (const id of idsRef.current) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { selected: true });

      // The dashed convex hull marks the deal's overall extent (not a per-
      // parcel boundary), plus zoom-to-fit from the fetched geometry.
      const pts = dealFeats.flatMap((f) => collectCoords(f.geometry));
      const hull = convexHull(pts);
      map.addSource("deal-outline", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [hull] } } as unknown as GeoJSON.Feature });
      map.addLayer({ id: "deal-outline-line", type: "line", source: "deal-outline", paint: { "line-color": "#0f172a", "line-width": 2, "line-dasharray": [2, 1.5] } }, "wellbores");

      ready.current = true;
      applyVis();
      // Zoom-to-fit the whole deal, whatever its extent (crosses counties fine).
      if (pts.length) {
        const [w, s, e, n] = bboxOfPoints(pts);
        map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 14, duration: 0 });
      }

      map.on("click", (ev) => {
        if (layersRef.current.wells) {
          const wh = map.queryRenderedFeatures([[ev.point.x - 5, ev.point.y - 5], [ev.point.x + 5, ev.point.y + 5]], { layers: map.getLayer("wells") ? ["wells"] : [] });
          if (wh.length) { const p = wh[0].properties as Record<string, unknown>; setSelected({ kind: "well", api: String(p.api8 ?? p.api ?? ""), wellNo: String(p.wellNo ?? ""), operator: String(p.operator ?? ""), leaseName: String(p.leaseName ?? ""), status: String(p.status ?? ""), type: String(p.type ?? "") }); return; }
        }
        const ah = map.queryRenderedFeatures(ev.point, { layers: map.getLayer("abstracts-fill") ? ["abstracts-fill"] : [] });
        if (ah.length) { const p = ah[0].properties as Record<string, unknown>; setSelected({ kind: "abstract", abstract: String(p.abstract ?? ""), survey: String(p.survey ?? ""), county: String(p.county ?? "") }); }
        else setSelected(null);
      });
    });
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyVis() {
    const map = mapRef.current; if (!map || !ready.current) return;
    const L = layersRef.current;
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("abstracts-fill", L.boundaries); vis("abstracts-line", L.boundaries);
    vis("abstracts-num", L.numbers); vis("abstracts-survey", L.surveys);
    vis("wells", L.wells); vis("wellbores", L.wellbores); vis("wellbores-sel", L.wellbores);
  }
  useEffect(applyVis, [layers]);

  // Keep the highlighted deal geometry in sync when abstracts are edited on
  // the deal page — previously the map only ever showed the mount-time set.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    let cancelled = false;
    (async () => {
      const ids = [...idSet];
      const dealFC = ids.length
        ? await api.get<FC>(`/gis/features?ids=${encodeURIComponent(ids.join(","))}`).catch(() => ({ type: "FeatureCollection", features: [] } as FC))
        : ({ type: "FeatureCollection", features: [] } as FC);
      if (cancelled) return;
      const outline = map.getSource("deal-outline") as maplibregl.GeoJSONSource | undefined;
      if (!outline) return;
      // Re-point the highlight at the new abstract set (feature-state persists
      // on the source, so clear the old ids before marking the new ones).
      for (const id of prevIds.current) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { selected: false });
      for (const id of ids) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { selected: true });
      prevIds.current = ids;
      const pts = dealFC.features.flatMap((f) => collectCoords(f.geometry));
      const hull = convexHull(pts);
      outline.setData({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [hull] } } as unknown as GeoJSON.Feature);
      if (pts.length) {
        const [w, s, e, n] = bboxOfPoints(pts);
        map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 14 });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abstractIds.join("|")]);

  const toggle = (k: keyof typeof layers) => setLayers((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div className="deal-map">
      <MapLayersPanel
        variant="bar"
        defs={[
          { key: "boundaries", label: "Abstract boundaries" }, { key: "numbers", label: "Abstract numbers" },
          { key: "surveys", label: "Survey names" }, { key: "wells", label: "Wells" },
          { key: "wellbores", label: "Wellbores (laterals)" },
        ]}
        layers={layers}
        onToggle={(k) => toggle(k as keyof typeof layers)}
      />
      <div className="dm-canvas">
        <div ref={container} style={{ position: "absolute", inset: 0 }} />
        {selected && (
          <div className="dm-info">
            <button className="icon-btn" style={{ float: "right" }} onClick={() => setSelected(null)}>×</button>
            {selected.kind === "abstract" ? (
              <><strong>{selected.abstract}</strong><div className="muted" style={{ fontSize: 12 }}>{[selected.survey, selected.county ? `${selected.county} County` : ""].filter(Boolean).join(" · ")}</div></>
            ) : (
              <><strong>{selected.leaseName || "Well"} {selected.wellNo ? `#${selected.wellNo}` : ""}</strong>
                <div className="muted" style={{ fontSize: 12 }}>API {selected.api} · {selected.type} · {selected.status}</div>
                {selected.operator && <div className="muted" style={{ fontSize: 12 }}>{selected.operator}</div>}</>
            )}
          </div>
        )}
        {abstractIds.length === 0 && <div className="dm-empty">No abstracts linked to this deal yet. Add abstracts in Deal Characteristics to see it on the map.</div>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{num(abstractIds.length)} abstract(s) · zoomed to the full deal extent</div>
    </div>
  );
}
