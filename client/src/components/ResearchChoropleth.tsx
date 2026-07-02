import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Lightweight SVG choropleth of Texas counties (no MapLibre — the boundaries
 * asset is ~100KB and a simple equirectangular projection is plenty at state
 * scale). Colors counties by activity volume or period-over-period change and
 * outlines detected hotspots. Nationwide-ready: swap/add per-state boundary
 * assets keyed by the same {fips,name} properties.
 */

interface GeoFeature {
  properties: { fips: string; name: string };
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };
}

export interface CountyStat {
  county: string; // display name, e.g. "Leon"
  total: number;
  pctChange: number | null;
  isHotspot: boolean;
}

interface Props {
  stats: CountyStat[];
  metric: "activity" | "change";
  selected: string[]; // selected county names
  onSelect: (county: string) => void;
}

const W = 720, H = 680;

export function ResearchChoropleth({ stats, metric, selected, onSelect }: Props) {
  const [features, setFeatures] = useState<GeoFeature[] | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; name: string; stat?: CountyStat } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/data/tx-counties.geojson")
      .then((r) => r.json())
      .then((g: { features: GeoFeature[] }) => setFeatures(g.features))
      .catch(() => setFeatures([]));
  }, []);

  // Project all rings once (TX bbox → viewport, aspect-preserving).
  const shapes = useMemo(() => {
    if (!features?.length) return [];
    let minX = 180, minY = -90, maxX = -180, maxY = 90; // note: y inverted later
    let w = 180, s = 90, e = -180, n = -90;
    const eachPoint = (f: GeoFeature, cb: (x: number, y: number) => void) => {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates as number[][][]] : (f.geometry.coordinates as number[][][][]);
      for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) cb(x, y);
    };
    for (const f of features) eachPoint(f, (x, y) => { if (x < w) w = x; if (y < s) s = y; if (x > e) e = x; if (y > n) n = y; });
    minX = w; maxX = e; minY = s; maxY = n;
    const pad = 8;
    const scale = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY));
    const px = (x: number) => pad + (x - minX) * scale;
    const py = (y: number) => H - pad - (y - minY) * scale;
    return features.map((f) => {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates as number[][][]] : (f.geometry.coordinates as number[][][][]);
      const d = polys
        .map((poly) => poly.map((ring) => "M" + ring.map(([x, y]) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`).join("L") + "Z").join(""))
        .join("");
      return { name: f.properties.name, d };
    });
  }, [features]);

  const statMap = useMemo(() => {
    const m = new Map<string, CountyStat>();
    for (const s of stats) m.set(s.county.toUpperCase(), s);
    return m;
  }, [stats]);

  const maxTotal = useMemo(() => Math.max(1, ...stats.map((s) => s.total)), [stats]);

  function fillFor(name: string): string {
    const s = statMap.get(name.toUpperCase());
    if (!s || s.total === 0) return "rgba(148,163,184,0.10)";
    if (metric === "activity") {
      const t = Math.log(s.total + 1) / Math.log(maxTotal + 1);
      return `rgba(59,130,246,${(0.15 + 0.8 * t).toFixed(2)})`;
    }
    // change: diverging green (up) / red (down); null pct (new activity) = strong green
    const p = s.pctChange;
    if (p == null) return "rgba(34,197,94,0.85)";
    const mag = Math.min(1, Math.abs(p) / 2); // saturates at ±200%
    return p >= 0 ? `rgba(34,197,94,${(0.15 + 0.75 * mag).toFixed(2)})` : `rgba(239,68,68,${(0.15 + 0.75 * mag).toFixed(2)})`;
  }

  if (!features) return <p className="muted">Loading map…</p>;
  if (!shapes.length) return <p className="muted">County boundaries unavailable.</p>;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {shapes.map((sh) => {
          const st = statMap.get(sh.name.toUpperCase());
          const isSel = selected.some((c) => c.toUpperCase() === sh.name.toUpperCase());
          return (
            <path
              key={sh.name}
              d={sh.d}
              fill={fillFor(sh.name)}
              stroke={isSel ? "var(--accent, #3b82f6)" : st?.isHotspot ? "#ef4444" : "rgba(148,163,184,0.35)"}
              strokeWidth={isSel ? 2 : st?.isHotspot ? 1.6 : 0.5}
              style={{ cursor: st ? "pointer" : "default" }}
              onClick={() => st && onSelect(sh.name)}
              onMouseMove={(e) => {
                const r = wrapRef.current?.getBoundingClientRect();
                if (r) setTip({ x: e.clientX - r.left + 12, y: e.clientY - r.top + 12, name: sh.name, stat: st });
              }}
              onMouseLeave={() => setTip(null)}
            />
          );
        })}
      </svg>
      {tip && (
        <div style={{
          position: "absolute", left: tip.x, top: tip.y, pointerEvents: "none", zIndex: 5,
          background: "var(--panel, #1f2937)", border: "1px solid var(--border, #374151)",
          borderRadius: 6, padding: "6px 9px", fontSize: 12, whiteSpace: "nowrap", boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        }}>
          <strong>{tip.name} County</strong>
          {tip.stat ? (
            <>
              <br />{tip.stat.total.toLocaleString()} records
              {tip.stat.pctChange != null && <> · {tip.stat.pctChange >= 0 ? "+" : ""}{Math.round(tip.stat.pctChange * 100)}% vs prior</>}
              {tip.stat.pctChange == null && tip.stat.total > 0 && <> · new activity</>}
              {tip.stat.isHotspot && <><br /><span style={{ color: "#ef4444" }}>⬤ Hotspot</span></>}
            </>
          ) : (
            <><br /><span className="muted">No data</span></>
          )}
        </div>
      )}
    </div>
  );
}
