import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { addCadastralLayers, styleWithGlyphs } from "../lib/mapLayers";

/**
 * Landing tract demo — the REAL platform map. Renders the parsed
 * metes-and-bounds polygon on the same cadastral stack the app uses
 * (abstract boundaries, survey labels, wells), anchored in Leon County the
 * way an anchored tract looks on a deal page.
 */

// Anchor the demo tract among real Leon County abstracts.
const ANCHOR: [number, number] = [-95.94, 31.33];
const FT_PER_DEG_LAT = 364_567;

/** Feet-offset ring → lon/lat ring centered on the anchor. */
function toLonLat(ring: [number, number][]): [number, number][] {
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const ftPerDegLon = FT_PER_DEG_LAT * Math.cos((ANCHOR[1] * Math.PI) / 180);
  return ring.map(([x, y]) => [ANCHOR[0] + (x - cx) / ftPerDegLon, ANCHOR[1] + (y - cy) / FT_PER_DEG_LAT]);
}

export default function TractMapDemo({ ring }: { ring: [number, number][] }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loaded = useRef(false);

  // Mount the map once.
  useEffect(() => {
    if (mapRef.current || !container.current) return;
    const map = new maplibregl.Map({
      container: container.current, style: styleWithGlyphs(), center: ANCHOR, zoom: 13,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    map.on("load", async () => {
      const countyLabels = await fetch(`/data/county-labels.geojson`).then((r) => r.json())
        .catch(() => ({ type: "FeatureCollection", features: [] }));
      addCadastralLayers(map, countyLabels as GeoJSON.FeatureCollection);
      map.addSource("demo-tract", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "demo-tract-fill", type: "fill", source: "demo-tract", paint: { "fill-color": "#f59e0b", "fill-opacity": 0.3 } });
      map.addLayer({ id: "demo-tract-line", type: "line", source: "demo-tract", paint: { "line-color": "#b45309", "line-width": 2.5 } });
      loaded.current = true;
      draw(map, ring);
    });
    return () => { map.remove(); mapRef.current = null; loaded.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw whenever the parsed ring changes.
  useEffect(() => {
    const map = mapRef.current;
    if (map && loaded.current) draw(map, ring);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(ring)]);

  return <div ref={container} style={{ position: "absolute", inset: 0 }} />;
}

function draw(map: maplibregl.Map, ring: [number, number][]): void {
  if (ring.length < 3) return;
  const ll = toLonLat(ring);
  const closed = [...ll, ll[0]];
  const src = map.getSource("demo-tract") as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  src.setData({
    type: "Feature", properties: {},
    geometry: { type: "Polygon", coordinates: [closed] },
  } as GeoJSON.Feature);
  const lons = ll.map((p) => p[0]), lats = ll.map((p) => p[1]);
  map.fitBounds(
    [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: 70, maxZoom: 15.5, duration: 600 },
  );
}
