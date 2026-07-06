import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { addCadastralLayers, styleWithGlyphs } from "../lib/mapLayers";

const LEON: [number, number] = [-95.99, 31.29];

/**
 * Live GIS demo on the public landing page. This is the REAL platform map —
 * the cadastral tile endpoint serves public-record survey geometry without
 * auth, so visitors interact with the same abstracts/wells/wellbores stack
 * customers use, not a video or screenshot.
 */
export default function LandingMap() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const [layers, setLayers] = useState({ boundaries: true, numbers: true, surveys: false, wells: true, wellbores: true });
  const layersRef = useRef(layers); layersRef.current = layers;
  const [picked, setPicked] = useState<{ title: string; sub: string } | null>(null);

  useEffect(() => {
    if (mapRef.current || !container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: styleWithGlyphs(), center: LEON, zoom: 9.6, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    map.on("load", async () => {
      const countyLabels = await fetch(`/data/county-labels.geojson`).then((r) => r.json())
        .catch(() => ({ type: "FeatureCollection", features: [] }));
      addCadastralLayers(map, countyLabels as GeoJSON.FeatureCollection);
      ready.current = true;
      applyVis();
      map.on("click", (ev) => {
        const wells = map.queryRenderedFeatures([[ev.point.x - 5, ev.point.y - 5], [ev.point.x + 5, ev.point.y + 5]], { layers: map.getLayer("wells") ? ["wells"] : [] });
        if (wells.length) {
          const p = wells[0].properties as Record<string, unknown>;
          setPicked({ title: `${p.leaseName ?? "Well"} ${p.wellNo ? `#${p.wellNo}` : ""}`, sub: [p.operator, p.status, p.type].filter(Boolean).join(" · ") });
          return;
        }
        const abs = map.queryRenderedFeatures(ev.point, { layers: map.getLayer("abstracts-fill") ? ["abstracts-fill"] : [] });
        if (abs.length) {
          const p = abs[0].properties as Record<string, unknown>;
          setPicked({ title: String(p.abstract ?? "Abstract"), sub: [p.survey, p.county ? `${p.county} County` : ""].filter(Boolean).join(" · ") });
        } else setPicked(null);
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
  const Chk = ({ k, label }: { k: keyof typeof layers; label: string }) => (
    <label className="lm-chk"><input type="checkbox" checked={layers[k]} onChange={() => setLayers((p) => ({ ...p, [k]: !p[k] }))} /> {label}</label>
  );

  return (
    <div className="lm-wrap">
      <div className="lm-toolbar" role="group" aria-label="Map layers">
        <span className="lm-live"><span className="lm-dot" aria-hidden />Live demo — real public cadastral data</span>
        <Chk k="boundaries" label="Abstracts" /><Chk k="numbers" label="Numbers" /><Chk k="surveys" label="Survey names" />
        <Chk k="wells" label="Wells" /><Chk k="wellbores" label="Wellbores" />
      </div>
      <div className="lm-canvas">
        <div ref={container} style={{ position: "absolute", inset: 0 }} />
        {picked && (
          <div className="lm-info">
            <button className="lm-info-x" onClick={() => setPicked(null)} aria-label="Close">×</button>
            <strong>{picked.title}</strong>
            {picked.sub && <div>{picked.sub}</div>}
          </div>
        )}
      </div>
      <p className="lm-hint">Zoom into Leon County, Texas — click any abstract or well. This is the same layer stack your team gets on day one.</p>
    </div>
  );
}
