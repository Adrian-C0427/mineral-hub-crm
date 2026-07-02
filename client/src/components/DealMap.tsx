import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { collectCoords, bboxOfPoints, convexHull } from "../lib/geo";
import { num } from "../lib/format";

const ABSTRACTS_URL = "/data/leon-abstracts.geojson";
const WELLS_URL = "/data/leon-wells.geojson";
const WELLBORES_URL = "/data/leon-wellbores.geojson";
const LEON_CENTER: [number, number] = [-95.99, 31.29];

const STATUS_COLOR = [
  "match", ["get", "status"],
  "Producing", "#22c55e", "Shut-In", "#f59e0b", "Plugged", "#6b7280", "Permitted", "#3b82f6",
  "Dry Hole", "#78350f", "Active", "#7c3aed", "Canceled/Abandoned", "#9ca3af", "Surface location", "#0ea5e9",
  "#64748b",
] as unknown as maplibregl.ExpressionSpecification;

function style(): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: `${window.location.origin}/fonts/{fontstack}/{range}.pbf`,
    sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap" } },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  };
}

type FC = { type: "FeatureCollection"; features: { type: "Feature"; id?: string | number; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] };
type Sel = { kind: "abstract"; abstract: string; survey: string; county: string } | { kind: "well"; api: string; wellNo: string; operator: string; leaseName: string; status: string; type: string } | null;

const DEFAULT_LAYERS = { boundaries: true, numbers: true, surveys: true, wells: false, wellbores: false };

/** Compact, isolated map showing only the current deal's abstracts. */
export function DealMap({ abstractIds }: { abstractIds: string[] }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const wellsLoaded = useRef(false);
  const boresLoaded = useRef(false);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const layersRef = useRef(layers); layersRef.current = layers;
  const [selected, setSelected] = useState<Sel>(null);
  const idSet = useMemo(() => new Set(abstractIds), [abstractIds]);

  useEffect(() => {
    if (mapRef.current || !container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: style(), center: LEON_CENTER, zoom: 9 });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;

    map.on("load", async () => {
      const abs = (await fetch(ABSTRACTS_URL).then((r) => r.json())) as FC;
      const dealFeats = abs.features.filter((f) => idSet.has(f.properties.id as string));

      map.addSource("abstracts", { type: "geojson", data: abs as unknown as GeoJSON.FeatureCollection, promoteId: "id" });
      map.addSource("deal", { type: "geojson", data: { type: "FeatureCollection", features: dealFeats } as unknown as GeoJSON.FeatureCollection, promoteId: "id" });

      // Clean outer boundary = convex hull of all deal-abstract vertices.
      const pts = dealFeats.flatMap((f) => collectCoords(f.geometry));
      const hull = convexHull(pts);
      map.addSource("deal-outline", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [hull] } } as unknown as GeoJSON.Feature });

      // Reference abstract boundaries (toggleable).
      map.addLayer({ id: "abstracts-line", type: "line", source: "abstracts", paint: { "line-color": "#94a3b8", "line-width": 0.5 } });
      // The deal itself — highlighted fill + line (always shown).
      map.addLayer({ id: "deal-fill", type: "fill", source: "deal", paint: { "fill-color": "#f59e0b", "fill-opacity": 0.28 } });
      map.addLayer({ id: "deal-line", type: "line", source: "deal", paint: { "line-color": "#b45309", "line-width": 1.5 } });
      // Clean boundary around the whole deal.
      map.addLayer({ id: "deal-outline-line", type: "line", source: "deal-outline", paint: { "line-color": "#0f172a", "line-width": 2, "line-dasharray": [2, 1.5] } });
      // Labels (real glyphs; zoom-based, collision-free).
      map.addLayer({ id: "abstracts-num", type: "symbol", source: "abstracts", minzoom: 9, layout: {
        "symbol-sort-key": ["*", -1, ["get", "area"]], "text-field": ["get", "abstract"], "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13], "text-allow-overlap": false }, paint: { "text-color": "#0f172a", "text-halo-color": "#fff", "text-halo-width": 1.4 } });
      map.addLayer({ id: "abstracts-survey", type: "symbol", source: "abstracts", minzoom: 12.5, layout: {
        "symbol-sort-key": ["*", -1, ["get", "area"]], "text-field": ["get", "survey"], "text-font": ["Noto Sans Regular"],
        "text-size": 11, "text-offset": [0, 1.1], "text-allow-overlap": false }, paint: { "text-color": "#334155", "text-halo-color": "#fff", "text-halo-width": 1.3 } });

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
          if (wh.length) { const p = wh[0].properties as Record<string, unknown>; setSelected({ kind: "well", api: String(p.api ?? ""), wellNo: String(p.wellNo ?? ""), operator: String(p.operator ?? ""), leaseName: String(p.leaseName ?? ""), status: String(p.status ?? ""), type: String(p.type ?? "") }); return; }
        }
        const ah = map.queryRenderedFeatures(ev.point, { layers: ["deal-fill", "abstracts-line"] });
        if (ah.length) { const p = ah[0].properties as Record<string, unknown>; setSelected({ kind: "abstract", abstract: String(p.abstract ?? ""), survey: String(p.survey ?? ""), county: String(p.county ?? "") }); }
        else setSelected(null);
      });
    });
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy-load heavy layers only when first enabled (perf: no statewide load up front).
  async function ensureWells() {
    const map = mapRef.current!; if (wellsLoaded.current) return; wellsLoaded.current = true;
    const data = await fetch(WELLS_URL).then((r) => r.json());
    map.addSource("wells", { type: "geojson", data, promoteId: "fid" });
    map.addLayer({ id: "wells", type: "circle", source: "wells", paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2.3, 14, 5], "circle-color": STATUS_COLOR,
      "circle-stroke-width": 0.6, "circle-stroke-color": "#fff", "circle-opacity": 0.9 } });
  }
  async function ensureBores() {
    const map = mapRef.current!; if (boresLoaded.current) return; boresLoaded.current = true;
    const data = await fetch(WELLBORES_URL).then((r) => r.json());
    map.addSource("wellbores", { type: "geojson", data, promoteId: "fid" });
    map.addLayer({ id: "wellbores", type: "line", source: "wellbores", paint: {
      "line-color": ["match", ["get", "wellboreType"], "Directional", "#9333ea", "#0f766e"], "line-width": 1.5, "line-opacity": 0.8 } });
  }

  function applyVis() {
    const map = mapRef.current; if (!map || !ready.current) return;
    const L = layersRef.current;
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("abstracts-line", L.boundaries); vis("abstracts-num", L.numbers); vis("abstracts-survey", L.surveys);
    (async () => {
      if (L.wells) { await ensureWells(); vis("wells", true); } else vis("wells", false);
      if (L.wellbores) { await ensureBores(); vis("wellbores", true); } else vis("wellbores", false);
    })();
  }
  useEffect(applyVis, [layers]);

  const toggle = (k: keyof typeof layers) => setLayers((p) => ({ ...p, [k]: !p[k] }));
  const Chk = ({ k, label }: { k: keyof typeof layers; label: string }) => (
    <label className="dm-chk"><input type="checkbox" checked={layers[k]} onChange={() => toggle(k)} /> {label}</label>
  );

  return (
    <div className="deal-map">
      <div className="dm-toolbar">
        <Chk k="boundaries" label="Boundaries" /><Chk k="numbers" label="Abstract #" /><Chk k="surveys" label="Survey names" />
        <Chk k="wells" label="Wells" /><Chk k="wellbores" label="Wellbores" />
      </div>
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
