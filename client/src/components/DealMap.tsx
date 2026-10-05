import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { collectCoords, bboxOfPoints } from "../lib/geo";
import { num } from "../lib/format";
import { api } from "../api/client";
import { addCadastralLayers, addTractLayers, tractInfo, TRACT_SOURCE, type TractInfo, styleWithGlyphs, watchGisHealth } from "../lib/mapLayers";
import { formatAbstract } from "../lib/abstracts";
import { useAuth } from "../auth/AuthContext";
import { MapLayersPanel } from "./MapLayersPanel";
import { MapShpImport } from "./MapShpImport";

const LEON_CENTER: [number, number] = [-95.99, 31.29];

type FC = { type: "FeatureCollection"; features: { type: "Feature"; id?: string | number; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] };
type Sel =
  | { kind: "abstract"; abstract: string; survey: string; county: string }
  | { kind: "well"; api: string; wellNo: string; operator: string; leaseName: string; status: string; type: string }
  | ({ kind: "tract" } & TractInfo)
  | null;

// Same layer set the main map exposes (minus the always-on county boundaries /
// names); no filters, no heat map — just the layer toggles.
const DEFAULT_LAYERS = { boundaries: true, numbers: true, surveys: true, wells: true, wellbores: true, tracts: true };
const EMPTY: FC = { type: "FeatureCollection", features: [] };

/**
 * Compact per-deal map. Renders the identical cadastral stack as the main map
 * (lib/mapLayers) — county boundaries + names, abstracts, wells, laterals,
 * labels — with the deal's own abstracts highlighted on top. No filters/heat.
 * Shapefile tracts imported here are linked to the deal (`dealId`) and drawn
 * with the main map's exact tract styling; the main map shows them too.
 */
export function DealMap({ abstractIds, dealId, noun = "deal", abstractsWhere = "Deal Characteristics" }: {
  abstractIds: string[]; dealId?: string;
  /** What the record is called in the empty-map hint ("deal", "asset"). */
  noun?: string;
  /** Where the page edits its abstracts (named in the empty-map hint). */
  abstractsWhere?: string;
}) {
  const { can } = useAuth();
  const [tractCount, setTractCount] = useState(0);
  // This deal's imported tracts, fetched on mount (independent of the map
  // finishing its style load) and handed to the map source once it exists.
  const tractsRef = useRef<Promise<FC> | null>(null);
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
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
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

      // Identical cadastral source + layers as the main map, plus the same
      // imported-tract overlay (scoped to this deal's imports).
      addCadastralLayers(map, countyLabels as unknown as GeoJSON.FeatureCollection);
      addTractLayers(map, "wells");
      const tracts = await (tractsRef.current ?? loadTracts());
      (map.getSource(TRACT_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(tracts as unknown as GeoJSON.FeatureCollection);
      map.on("mouseenter", "tracts-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "tracts-fill", () => (map.getCanvas().style.cursor = ""));

      // Highlight this deal's abstracts the same way the main map does: via
      // feature-state on the SHARED tile layers (abstractsPaint reacts to
      // "selected"), so each parcel is drawn once with the main map's exact
      // styling and layer order — no duplicate boundary stacked on top.
      for (const id of idsRef.current) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { selected: true });

      // No extra outline layer on top: the feature-state highlight above is the
      // whole treatment, exactly like the main Map page. (The old dashed convex
      // hull doubled the abstract boundary whenever a deal had one parcel.)
      // Frame the deal's abstracts and its imported tracts together.
      const pts = [...dealFeats, ...tracts.features].flatMap((f) => collectCoords(f.geometry));

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
        if (layersRef.current.tracts && map.getLayer("tracts-fill")) {
          const tf = map.queryRenderedFeatures(ev.point, { layers: ["tracts-fill"] });
          if (tf.length) { setSelected({ kind: "tract", ...tractInfo(tf[0].properties as Record<string, unknown>) }); return; }
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
    vis("tracts-fill", L.tracts); vis("tracts-line", L.tracts); vis("tracts-label", L.tracts);
  }

  // This deal's imported tracts (none without a dealId): refetched after every
  // import/removal, pushed into the map source when it's ready. Returns the
  // data so the load handler can frame it.
  function loadTracts(): Promise<FC> {
    const p = (dealId
      ? api.get<FC>(`/map/tracts?dealId=${encodeURIComponent(dealId)}`).catch(() => EMPTY)
      : Promise.resolve(EMPTY)
    ).then((fc) => {
      (mapRef.current?.getSource(TRACT_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(fc as unknown as GeoJSON.FeatureCollection);
      setTractCount(fc.features.length);
      return fc;
    });
    tractsRef.current = p;
    return p;
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadTracts(); }, [dealId]);
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
      // Re-point the highlight at the new abstract set (feature-state persists
      // on the source, so clear the old ids before marking the new ones).
      for (const id of prevIds.current) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { selected: false });
      for (const id of ids) map.setFeatureState({ source: "abstracts", sourceLayer: "abstracts", id }, { selected: true });
      prevIds.current = ids;
      const pts = dealFC.features.flatMap((f) => collectCoords(f.geometry));
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
      <div className="dm-canvas">
        <div ref={container} style={{ position: "absolute", inset: 0 }} />
        {/* Same Layers popover + Import SHP as the main map, top-left. */}
        <div className="portal-map-controls dm-controls">
          <MapLayersPanel
            variant="floating"
            collapsible
            storageKey="mh-dealmap-layers-open"
            defs={[
              { key: "boundaries", label: "Abstract boundaries" }, { key: "numbers", label: "Abstract numbers" },
              { key: "surveys", label: "Survey names" }, { key: "wells", label: "Wells" },
              { key: "wellbores", label: "Wellbores (laterals)" },
              ...(dealId ? [{ key: "tracts", label: "Imported tracts" }] : []),
            ]}
            layers={layers}
            onToggle={(k) => toggle(k as keyof typeof layers)}
          />
          {dealId && can("manageMapData") && (
            <MapShpImport
              dealId={dealId}
              compact
              onChanged={(bbox) => {
                void loadTracts();
                setLayers((p) => ({ ...p, tracts: true }));
                if (bbox) mapRef.current?.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 800, maxZoom: 14 });
              }}
              onShow={(importId) => {
                // Frame one upload's boundaries from the tracts already loaded.
                setLayers((p) => ({ ...p, tracts: true }));
                void (tractsRef.current ?? loadTracts()).then((fc) => {
                  const pts = fc.features.filter((f) => f.properties.__importId === importId).flatMap((f) => collectCoords(f.geometry));
                  if (!pts.length) return;
                  const [w, s, e, n] = bboxOfPoints(pts);
                  mapRef.current?.fitBounds([[w, s], [e, n]], { padding: 40, duration: 800, maxZoom: 14 });
                });
              }}
            />
          )}
        </div>
        {selected && (
          <div className="dm-info">
            <button className="icon-btn dm-info-x" aria-label="Close" onClick={() => setSelected(null)}>×</button>
            {selected.kind === "abstract" ? (
              <><strong>{formatAbstract({ abstract: selected.abstract, survey: selected.survey, county: selected.county, state: "TX" })}</strong></>
            ) : selected.kind === "tract" ? (
              <><strong>{selected.name}</strong>
                <div className="muted" style={{ fontSize: 12 }}>Imported tract · {selected.sourceFile}</div>
                {selected.attrs.slice(0, 6).map(([k, v]) => <div key={k} style={{ fontSize: 12 }}><span className="muted">{k}:</span> {v}</div>)}</>
            ) : (
              <><strong>{selected.leaseName || "Well"} {selected.wellNo ? `#${selected.wellNo}` : ""}</strong>
                <div className="muted" style={{ fontSize: 12 }}>API {selected.api} · {selected.type} · {selected.status}</div>
                {selected.operator && <div className="muted" style={{ fontSize: 12 }}>{selected.operator}</div>}</>
            )}
          </div>
        )}
        {abstractIds.length === 0 && tractCount === 0 && (
          <div className="dm-empty">No abstracts or imported tracts on this {noun} yet. Add abstracts in {abstractsWhere}{dealId && can("manageMapData") ? ", or import a shapefile," : ""} to see it on the map.</div>
        )}
      </div>
      <div className="dm-foot">
        {num(abstractIds.length)} abstract(s){dealId ? ` · ${num(tractCount)} imported tract(s)` : ""} · zoomed to the full deal extent
      </div>
    </div>
  );
}
