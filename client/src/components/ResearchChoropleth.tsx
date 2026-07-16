import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";

/**
 * Lightweight SVG choropleth of Texas counties (no MapLibre — the boundaries
 * asset is ~100KB and a simple equirectangular projection is plenty at state
 * scale). Colors counties by activity volume or period-over-period change and
 * outlines detected hotspots.
 *
 * Drill-down: clicking a county smoothly ZOOMS into it (animated viewBox — no
 * abrupt scene change; the surrounding counties stay visible for continuity)
 * and overlays the county's abstract outlines, colored by abstract-level
 * activity with hotspot abstracts outlined in red — the same hotspot visual
 * language as the county overview. "All counties" (or Esc) zooms back out.
 */

interface GeoFeature {
  properties: { fips: string; name: string };
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };
}

type AnyGeom = { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };

export interface CountyStat {
  county: string; // display name, e.g. "Leon"
  total: number;
  pctChange: number | null;
  isHotspot: boolean;
}

export interface AbstractStat {
  abstractId: string;
  total: number;
  isHotspot: boolean;
}

interface Props {
  stats: CountyStat[];
  metric: "activity" | "change";
  selected: string[]; // selected county names
  onSelect: (county: string) => void;
  /** Active research filter query string — the abstract layer respects it. */
  qs?: string;
  /** Abstract-level stats for the focused county (drives drill-down coloring). */
  abstractStats?: AbstractStat[];
  focusCounty?: string | null;
  onFocusChange?: (county: string | null) => void;
  /** Clicking an abstract in the drilled-in view (e.g. jump to its records). */
  onAbstractClick?: (abstractId: string) => void;
}

const W = 720, H = 680;
const ZOOM_MS = 650;

type ViewBox = [number, number, number, number];
const FULL_VIEW: ViewBox = [0, 0, W, H];

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Match research abstract ids ("455", "A-455", "0455") against GIS labels. */
function normAbstract(v: string | null | undefined): string {
  return String(v ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^A/, "").replace(/^0+/, "");
}

interface AbstractShape { abstract: string; survey: string | null; count: number; amount: number; d: string }

export function ResearchChoropleth({ stats, metric, selected, onSelect, qs = "", abstractStats = [], focusCounty = null, onFocusChange, onAbstractClick }: Props) {
  const [features, setFeatures] = useState<GeoFeature[] | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: { text: string; color?: string }[] } | null>(null);
  const [vb, setVb] = useState<ViewBox>(FULL_VIEW);
  const [abstractShapes, setAbstractShapes] = useState<AbstractShape[] | null>(null);
  const [abstractsVisible, setAbstractsVisible] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const vbRef = useRef<ViewBox>(FULL_VIEW); vbRef.current = vb;

  useEffect(() => {
    fetch("/data/tx-counties.geojson")
      .then((r) => r.json())
      .then((g: { features: GeoFeature[] }) => setFeatures(g.features))
      .catch(() => setFeatures([]));
  }, []);

  // Project all rings once (TX bbox → viewport, aspect-preserving). The same
  // projection is reused for the drilled county's abstract shapes so the two
  // layers line up exactly and the zoom stays visually continuous.
  const { shapes, project } = useMemo(() => {
    if (!features?.length) return { shapes: [] as { name: string; d: string; bbox: ViewBox }[], project: null as null | ((x: number, y: number) => [number, number]) };
    let w = 180, s = 90, e = -180, n = -90;
    const eachPoint = (f: GeoFeature, cb: (x: number, y: number) => void) => {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates as number[][][]] : (f.geometry.coordinates as number[][][][]);
      for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) cb(x, y);
    };
    for (const f of features) eachPoint(f, (x, y) => { if (x < w) w = x; if (y < s) s = y; if (x > e) e = x; if (y > n) n = y; });
    const pad = 8;
    const scale = Math.min((W - pad * 2) / (e - w), (H - pad * 2) / (n - s));
    const px = (x: number) => pad + (x - w) * scale;
    const py = (y: number) => H - pad - (y - s) * scale;
    const shapes = features.map((f) => {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates as number[][][]] : (f.geometry.coordinates as number[][][][]);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const d = polys
        .map((poly) => poly.map((ring) => "M" + ring.map(([x, y]) => {
          const X = px(x), Y = py(y);
          if (X < minX) minX = X; if (X > maxX) maxX = X;
          if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
          return `${X.toFixed(1)},${Y.toFixed(1)}`;
        }).join("L") + "Z").join(""))
        .join("");
      return { name: f.properties.name, d, bbox: [minX, minY, maxX - minX, maxY - minY] as ViewBox };
    });
    return { shapes, project: (x: number, y: number) => [px(x), py(y)] as [number, number] };
  }, [features]);

  const statMap = useMemo(() => {
    const m = new Map<string, CountyStat>();
    for (const s of stats) m.set(s.county.toUpperCase(), s);
    return m;
  }, [stats]);
  const abstractStatMap = useMemo(() => {
    const m = new Map<string, AbstractStat>();
    for (const a of abstractStats) m.set(normAbstract(a.abstractId), a);
    return m;
  }, [abstractStats]);

  const maxTotal = useMemo(() => Math.max(1, ...stats.map((s) => s.total)), [stats]);
  const maxAbstractTotal = useMemo(() => Math.max(1, ...abstractStats.map((a) => a.total)), [abstractStats]);

  // ---- smooth viewBox animation ------------------------------------------
  function animateTo(target: ViewBox) {
    cancelAnimationFrame(animRef.current);
    const from = vbRef.current;
    if (from.every((v, i) => Math.abs(v - target[i]) < 0.5)) { setVb(target); return; }
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ZOOM_MS);
      const k = easeInOutCubic(t);
      setVb(from.map((v, i) => v + (target[i] - v) * k) as ViewBox);
      if (t < 1) animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  }
  useEffect(() => () => cancelAnimationFrame(animRef.current), []);

  const focusShape = focusCounty ? shapes.find((sh) => sh.name.toUpperCase() === focusCounty.toUpperCase()) : undefined;

  // Zoom in/out whenever the focused county changes.
  useEffect(() => {
    if (!shapes.length) return;
    if (focusShape) {
      const [x, y, w2, h2] = focusShape.bbox;
      // Pad the county bbox and preserve the viewport aspect so it fills nicely.
      const padF = 0.16;
      let bw = w2 * (1 + padF * 2), bh = h2 * (1 + padF * 2);
      const cx = x + w2 / 2, cy = y + h2 / 2;
      if (bw / bh > W / H) bh = bw * (H / W); else bw = bh * (W / H);
      animateTo([cx - bw / 2, cy - bh / 2, bw, bh]);
    } else {
      animateTo(FULL_VIEW);
      setAbstractsVisible(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCounty, shapes.length]);

  // Load + project the focused county's abstract outlines (geometry + per-
  // abstract record count and summed transaction amount, filter-aware), fading
  // them in once ready — no abrupt layer pop.
  useEffect(() => {
    setAbstractShapes(null);
    if (!focusCounty || !project) return;
    let cancelled = false;
    api.get<{ features: { properties: { abstract: string; survey: string | null; count: number; amount: number }; geometry: AnyGeom }[] }>(
      `/research/abstract-map?mapCounty=${encodeURIComponent(focusCounty)}${qs ? `&${qs}` : ""}`,
    )
      .then((fc) => {
        if (cancelled) return;
        const toPath = (geom: AnyGeom): string => {
          const polys = geom.type === "Polygon" ? [geom.coordinates as number[][][]] : (geom.coordinates as number[][][][]);
          return polys.map((poly) => poly.map((ring) => "M" + ring.map(([x, y]) => {
            const [X, Y] = project(x, y);
            return `${X.toFixed(2)},${Y.toFixed(2)}`;
          }).join("L") + "Z").join("")).join("");
        };
        setAbstractShapes(fc.features.map((f) => ({ ...f.properties, d: toPath(f.geometry) })));
        window.setTimeout(() => { if (!cancelled) setAbstractsVisible(true); }, 120);
      })
      .catch(() => { if (!cancelled) setAbstractShapes([]); });
    return () => { cancelled = true; };
  }, [focusCounty, project, qs]);

  // Esc backs out of the drill-down.
  useEffect(() => {
    if (!focusCounty || !onFocusChange) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onFocusChange(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusCounty, onFocusChange]);

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

  // Prefer the hotspot-aware geography stats; fall back to the geometry
  // payload's own record count so activity still shades if the join misses.
  function abstractFill(a: AbstractStat | undefined, count = 0): string {
    const total = a?.total ?? count;
    if (total === 0) return "rgba(148,163,184,0.06)";
    const t = Math.log(total + 1) / Math.log(maxAbstractTotal + 1);
    return `rgba(59,130,246,${(0.18 + 0.72 * t).toFixed(2)})`;
  }

  if (!features) return <p className="muted">Loading map…</p>;
  if (!shapes.length) return <p className="muted">County boundaries unavailable.</p>;

  // Stroke widths in viewBox units shrink as we zoom in — divide by the zoom
  // factor so lines keep a constant on-screen weight during the animation.
  const zoom = W / vb[2];
  const sw = (v: number) => v / zoom;
  const focused = !!focusCounty;

  const moveTip = (e: React.MouseEvent, title: string, lines: { text: string; color?: string }[]) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setTip({ x: e.clientX - r.left + 12, y: e.clientY - r.top + 12, title, lines });
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      {focused && (
        <button
          className="small"
          style={{ position: "absolute", top: 6, left: 6, zIndex: 6 }}
          onClick={() => onFocusChange?.(null)}
        >
          ← All counties
        </button>
      )}
      <svg viewBox={vb.map((v) => v.toFixed(2)).join(" ")} style={{ width: "100%", height: "auto", display: "block" }}>
        {shapes.map((sh) => {
          const st = statMap.get(sh.name.toUpperCase());
          const isSel = selected.some((c) => c.toUpperCase() === sh.name.toUpperCase());
          const isFocus = focused && sh.name.toUpperCase() === focusCounty!.toUpperCase();
          return (
            <path
              key={sh.name}
              d={sh.d}
              fill={fillFor(sh.name)}
              // The focused county keeps its hotspot red outline through the
              // drill-down; selection blue applies only at the overview.
              stroke={isFocus
                ? (st?.isHotspot ? "#ef4444" : "var(--accent, #3b82f6)")
                : isSel ? "var(--accent, #3b82f6)" : st?.isHotspot ? "#ef4444" : "rgba(148,163,184,0.35)"}
              strokeWidth={isFocus ? sw(2.2) : isSel ? sw(2) : st?.isHotspot ? sw(1.6) : sw(0.5)}
              // While drilled in, the abstract layer owns interaction inside the
              // county; other counties stay clickable to hop directly between them.
              style={{ cursor: st ? "pointer" : "default", opacity: focused && !isFocus ? 0.45 : 1, transition: "opacity 300ms ease" }}
              pointerEvents={isFocus && abstractShapes?.length ? "none" : undefined}
              onClick={() => {
                if (!st) return;
                if (onFocusChange) {
                  onFocusChange(sh.name);
                  if (!selected.some((c) => c.toUpperCase() === sh.name.toUpperCase())) onSelect(sh.name);
                } else onSelect(sh.name);
              }}
              onMouseMove={(e) => moveTip(e, `${sh.name} County`, st ? [
                { text: `${st.total.toLocaleString()} records` },
                ...(st.pctChange != null ? [{ text: `${st.pctChange >= 0 ? "+" : ""}${Math.round(st.pctChange * 100)}% vs prior` }] : []),
                ...(st.pctChange == null && st.total > 0 ? [{ text: "new activity" }] : []),
                ...(st.isHotspot ? [{ text: "● Hotspot", color: "#ef4444" }] : []),
                ...(!focused ? [{ text: "Click to zoom in" }] : []),
              ] : [{ text: "No data" }])}
              onMouseLeave={() => setTip(null)}
            />
          );
        })}

        {/* Drilled-in abstract layer: activity fill + red hotspot outlines. */}
        {focused && abstractShapes && (
          <g style={{ opacity: abstractsVisible ? 1 : 0, transition: "opacity 350ms ease" }}>
            {abstractShapes.map((ab) => {
              const stat = abstractStatMap.get(normAbstract(ab.abstract));
              const hot = stat?.isHotspot ?? false;
              const active = ab.count > 0 || !!stat;
              return (
                <path
                  key={ab.abstract}
                  d={ab.d}
                  fill={abstractFill(stat, ab.count)}
                  stroke={hot ? "#ef4444" : "rgba(148,163,184,0.4)"}
                  strokeWidth={hot ? sw(1.4) : sw(0.35)}
                  style={{ cursor: active && onAbstractClick ? "pointer" : "default" }}
                  onClick={() => active && onAbstractClick?.(stat?.abstractId ?? ab.abstract)}
                  onMouseMove={(e) => moveTip(e, `Abstract ${ab.abstract || "?"}`, [
                    ...(ab.survey ? [{ text: ab.survey }] : []),
                    { text: active ? `${(stat?.total ?? ab.count).toLocaleString()} records` : "No activity in period" },
                    ...(ab.amount > 0 ? [{ text: `$${Math.round(ab.amount).toLocaleString()} in transactions` }] : []),
                    ...(hot ? [{ text: "● Hotspot", color: "#ef4444" }] : []),
                    ...(active && onAbstractClick ? [{ text: "Click to view records" }] : []),
                  ])}
                  onMouseLeave={() => setTip(null)}
                />
              );
            })}
            {/* Re-draw the county boundary on top so the hotspot/selection ring
                stays crisp above the abstract mesh. */}
            {focusShape && (
              <path d={focusShape.d} fill="none"
                stroke={statMap.get(focusShape.name.toUpperCase())?.isHotspot ? "#ef4444" : "var(--accent, #3b82f6)"}
                strokeWidth={sw(2.2)} pointerEvents="none" />
            )}
          </g>
        )}
      </svg>
      {focused && abstractShapes === null && (
        <div className="muted" style={{ position: "absolute", bottom: 8, left: 8, fontSize: 12 }}>Loading abstracts…</div>
      )}
      {focused && abstractShapes !== null && abstractShapes.length === 0 && (
        <div className="muted" style={{ position: "absolute", bottom: 8, left: 8, fontSize: 12 }}>Abstract boundaries aren't available for this county yet.</div>
      )}
      {tip && (
        <div style={{
          position: "absolute", left: tip.x, top: tip.y, pointerEvents: "none", zIndex: 5,
          background: "var(--panel, #1f2937)", border: "1px solid var(--border, #374151)",
          borderRadius: 6, padding: "6px 9px", fontSize: 12, whiteSpace: "nowrap", boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        }}>
          <strong>{tip.title}</strong>
          {tip.lines.map((l, i) => <div key={i} style={l.color ? { color: l.color } : undefined}>{l.text}</div>)}
        </div>
      )}
    </div>
  );
}
