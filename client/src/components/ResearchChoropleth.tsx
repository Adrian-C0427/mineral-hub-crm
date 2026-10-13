import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { formatAbstract } from "../lib/abstracts";
import { clientToView, fitView, panView, sameView, unitsPerPixel, zoomView, type ViewBox, type ViewLimits } from "../lib/svgView";

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
 *
 * Free pan / zoom (`zoomable`): drag to pan; Ctrl/⌘ + scroll or a trackpad /
 * touch pinch to zoom about the pointer; +/− / reset buttons; and, with the
 * map focused, arrow keys / + / − / 0. A plain scroll wheel or a one-finger
 * swipe keeps scrolling the PAGE (a hint says how to zoom) — the map never
 * traps page scrolling. The user's view survives filter, metric and period
 * changes; only a drill-down change (a different data extent) reframes it.
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
  /** County to outline as hovered (e.g. while its row in a side list is hovered). */
  highlightCounty?: string | null;
  /** Free pan / zoom with on-map controls (off on the public landing page). */
  zoomable?: boolean;
}

const W = 720, H = 680;
const ZOOM_MS = 650;
/** Button / keyboard steps: a quicker ease than the drill-down. */
const STEP_MS = 220;
const ZOOM_STEP = 1.6;
/** Pointer travel (px) before a press becomes a drag rather than a click. */
const DRAG_PX = 4;
/** Deep enough to read single abstracts inside a drilled county. */
const LIMITS: ViewLimits = { width: W, height: H, maxZoom: 128 };
const FULL_VIEW: ViewBox = [0, 0, W, H];
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent);
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Match research abstract ids ("455", "A-455", "0455") against GIS labels. */
function normAbstract(v: string | null | undefined): string {
  return String(v ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^A/, "").replace(/^0+/, "");
}

interface AbstractShape { abstract: string; survey: string | null; count: number; amount: number; d: string }
interface TipLine { text: string; color?: string; muted?: boolean }

export function ResearchChoropleth({ stats, metric, selected, onSelect, qs = "", abstractStats = [], focusCounty = null, onFocusChange, onAbstractClick, highlightCounty = null, zoomable = false }: Props) {
  const [features, setFeatures] = useState<GeoFeature[] | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: TipLine[] } | null>(null);
  const [vb, setVb] = useState<ViewBox>(FULL_VIEW);
  const [abstractShapes, setAbstractShapes] = useState<AbstractShape[] | null>(null);
  const [abstractsVisible, setAbstractsVisible] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const animRef = useRef<number>(0);
  /** Where the running animation is headed (null when idle) — steps chain from it. */
  const animTarget = useRef<ViewBox | null>(null);
  const vbRef = useRef<ViewBox>(FULL_VIEW); vbRef.current = vb;
  // Gesture state (refs: they change every frame and never render on their own).
  const dragRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const pinchRef = useRef<{ d0: number; mid0: [number, number]; vb0: ViewBox } | null>(null);
  const touchingRef = useRef(false);
  const gestureRef = useRef<number | null>(null); // Safari trackpad pinch: last scale
  /** A drag / pinch just ended — swallow the click it would otherwise fire. */
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState<{ text: string; on: boolean }>({ text: "", on: false });
  const hintTimer = useRef<number>(0);
  const hintShown = useRef(""); // text on screen ("" = hidden) — avoids a re-render per wheel tick
  const helpId = useId();

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
          // 0.01 units: county lines stay true to the abstract mesh at deep zoom.
          return `${X.toFixed(2)},${Y.toFixed(2)}`;
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
  // Every view change goes through vbRef first so back-to-back events within
  // one frame build on each other rather than on a stale render.
  function showView(next: ViewBox) { vbRef.current = next; setVb(next); }
  function stopAnim() { cancelAnimationFrame(animRef.current); animTarget.current = null; }
  /** Direct manipulation (drag / pinch / wheel) — interrupts any animation. */
  function setView(next: ViewBox) { stopAnim(); showView(next); }
  function animateTo(target: ViewBox, ms = ZOOM_MS) {
    stopAnim();
    const from = vbRef.current;
    if (sameView(from, target)) { showView(target); return; }
    animTarget.current = target;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const k = easeInOutCubic(t);
      showView(from.map((v, i) => v + (target[i] - v) * k) as ViewBox);
      if (t < 1) animRef.current = requestAnimationFrame(step);
      else animTarget.current = null;
    };
    animRef.current = requestAnimationFrame(step);
  }
  useEffect(() => () => { cancelAnimationFrame(animRef.current); window.clearTimeout(hintTimer.current); }, []);

  const focusShape = focusCounty ? shapes.find((sh) => sh.name.toUpperCase() === focusCounty.toUpperCase()) : undefined;
  // "Home" for the reset control: the drilled county's framing (padded bbox,
  // viewport aspect) or the whole state.
  const homeView = (): ViewBox => (focusShape ? fitView(focusShape.bbox, 0.16, LIMITS) : FULL_VIEW);

  // Zoom in/out whenever the focused county changes — the one case where the
  // user's own pan/zoom is replaced, because the data extent itself changed.
  useEffect(() => {
    if (!shapes.length) return;
    animateTo(homeView());
    if (!focusShape) setAbstractsVisible(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCounty, shapes.length]);

  // ---- free pan / zoom -----------------------------------------------------
  function flashHint(text: string) {
    if (hintShown.current !== text) { hintShown.current = text; setHint({ text, on: true }); }
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => { hintShown.current = ""; setHint((h) => ({ ...h, on: false })); }, 1400);
  }
  /** Step zoom about the view center (buttons / keys); chains off a running step. */
  function stepZoom(factor: number) {
    const base = animTarget.current ?? vbRef.current;
    animateTo(zoomView(base, factor, [base[0] + base[2] / 2, base[1] + base[3] / 2], LIMITS), STEP_MS);
  }
  function stepPan(fx: number, fy: number) {
    const base = animTarget.current ?? vbRef.current;
    animateTo(panView(base, fx * base[2], fy * base[3], LIMITS), STEP_MS);
  }
  const resetView = () => animateTo(homeView(), STEP_MS);

  // Wheel, touch and Safari gesture listeners are native: React's are passive,
  // and zooming must preventDefault (page scroll / browser zoom) — but ONLY
  // for a deliberate zoom, so ordinary scrolling still moves the page.
  const hasShapes = shapes.length > 0;
  useEffect(() => {
    const svg = svgRef.current;
    if (!zoomable || !svg) return;
    const zoomAtClient = (factor: number, x: number, y: number) => {
      const cur = vbRef.current;
      setView(zoomView(cur, factor, clientToView(cur, svg.getBoundingClientRect(), x, y), LIMITS));
      setTip(null);
    };
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) { flashHint(`Hold ${MOD_KEY} and scroll to zoom the map`); return; }
      e.preventDefault();
      if (gestureRef.current != null) return; // Safari pinch is handled by its gesture events
      // Trackpad pinches arrive as small ctrl+wheel deltas, mouse notches as
      // ~100px; clamp so one notch is a comfortable step.
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      zoomAtClient(Math.exp(-Math.max(-50, Math.min(50, d)) * 0.01), e.clientX, e.clientY);
    };
    const pts = (t: TouchList): [[number, number], number] => {
      const a = t[0], b = t[1];
      return [[(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2], Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1];
    };
    // Two fingers pinch-zoom and pan; one finger scrolls the page as usual.
    let swipeFrom: [number, number] | null = null; // one-finger start (tap vs swipe)
    const onTouchStart = (e: TouchEvent) => {
      touchingRef.current = true;
      swipeFrom = e.touches.length === 1 ? [e.touches[0].clientX, e.touches[0].clientY] : null;
      if (e.touches.length === 2) {
        stopAnim(); setTip(null);
        const [mid0, d0] = pts(e.touches);
        pinchRef.current = { d0, mid0, vb0: vbRef.current };
      } else pinchRef.current = null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const p = pinchRef.current;
      if (p && e.touches.length === 2) {
        if (!e.cancelable) return; // the browser already owns this gesture (page scroll)
        e.preventDefault();
        suppressClick.current = true;
        const rect = svg.getBoundingClientRect();
        const [mid, d] = pts(e.touches);
        const zoomed = zoomView(p.vb0, d / p.d0, clientToView(p.vb0, rect, p.mid0[0], p.mid0[1]), LIMITS);
        const upp = unitsPerPixel(zoomed, rect);
        setView(panView(zoomed, (mid[0] - p.mid0[0]) * upp, (mid[1] - p.mid0[1]) * upp, LIMITS));
      } else if (!p && swipeFrom && e.touches.length === 1
        && Math.hypot(e.touches[0].clientX - swipeFrom[0], e.touches[0].clientY - swipeFrom[1]) > 10) {
        flashHint("Use two fingers to move the map"); // a swipe, not a tap
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current = null;
      if (e.touches.length === 0) touchingRef.current = false;
    };
    // Safari (macOS trackpad) reports pinches as proprietary gesture events,
    // not ctrl+wheel. iOS fires them too — there the touch handlers own it.
    type GestureLike = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => { e.preventDefault(); gestureRef.current = 1; };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureLike;
      if (!touchingRef.current && gestureRef.current != null) zoomAtClient(g.scale / gestureRef.current, g.clientX, g.clientY);
      gestureRef.current = g.scale;
    };
    const onGestureEnd = (e: Event) => { e.preventDefault(); gestureRef.current = null; };
    const active = { passive: false } as const;
    svg.addEventListener("wheel", onWheel, active);
    svg.addEventListener("touchstart", onTouchStart, active);
    svg.addEventListener("touchmove", onTouchMove, active);
    svg.addEventListener("touchend", onTouchEnd);
    svg.addEventListener("touchcancel", onTouchEnd);
    svg.addEventListener("gesturestart", onGestureStart, active);
    svg.addEventListener("gesturechange", onGestureChange, active);
    svg.addEventListener("gestureend", onGestureEnd, active);
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("touchstart", onTouchStart);
      svg.removeEventListener("touchmove", onTouchMove);
      svg.removeEventListener("touchend", onTouchEnd);
      svg.removeEventListener("touchcancel", onTouchEnd);
      svg.removeEventListener("gesturestart", onGestureStart);
      svg.removeEventListener("gesturechange", onGestureChange);
      svg.removeEventListener("gestureend", onGestureEnd);
    };
    // Handlers read live state through refs; re-bind only when the svg mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomable, hasShapes]);

  // Mouse / pen drag-to-pan. A press only becomes a drag past DRAG_PX, so a
  // plain click still selects a county; pointer capture starts with the drag
  // (capturing earlier would retarget that click to the <svg>).
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    suppressClick.current = false;
    if (e.pointerType === "touch" || e.button !== 0) return;
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    // Released outside the map before the drag began (no pointerup reached us).
    if ((e.buttons & 1) === 0) { dragRef.current = null; if (d.moved) setDragging(false); return; }
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true); setTip(null);
    }
    const cur = vbRef.current;
    const upp = unitsPerPixel(cur, e.currentTarget.getBoundingClientRect());
    setView(panView(cur, (e.clientX - d.x) * upp, (e.clientY - d.y) * upp, LIMITS));
    d.x = e.clientX; d.y = e.clientY;
  };
  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    if (d.moved) { suppressClick.current = true; setDragging(false); }
  };
  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const PAN = 0.15; // of the view per arrow press
    switch (e.key) {
      case "ArrowLeft": stepPan(PAN, 0); break;
      case "ArrowRight": stepPan(-PAN, 0); break;
      case "ArrowUp": stepPan(0, PAN); break;
      case "ArrowDown": stepPan(0, -PAN); break;
      case "+": case "=": stepZoom(ZOOM_STEP); break;
      case "-": case "_": stepZoom(1 / ZOOM_STEP); break;
      case "0": resetView(); break;
      default: return;
    }
    e.preventDefault();
  };

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
    if (!s || s.total === 0) return "var(--surface-2)";
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
  // Only abstracts with activity get a fill — the rest stay outline-only so
  // the shading reads as "where activity actually is", not a county wash.
  function abstractFill(a: AbstractStat | undefined, count = 0): string {
    const total = a?.total ?? count;
    if (total === 0) return "transparent";
    const t = Math.log(total + 1) / Math.log(maxAbstractTotal + 1);
    return `rgba(59,130,246,${(0.18 + 0.72 * t).toFixed(2)})`;
  }

  if (!features) return <p className="rs-map-status">Loading map…</p>;
  if (!shapes.length) return <p className="rs-map-status">County boundaries unavailable.</p>;

  // Stroke widths in viewBox units shrink as we zoom in — divide by the zoom
  // factor so lines keep a constant on-screen weight during the animation.
  const zoom = W / vb[2];
  const sw = (v: number) => v / zoom;
  const focused = !!focusCounty;

  const moveTip = (e: React.MouseEvent, title: string, lines: TipLine[]) => {
    if (dragRef.current?.moved || pinchRef.current) return; // no tooltips mid-gesture
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setTip({ x: e.clientX - r.left + 12, y: e.clientY - r.top + 12, title, lines });
  };

  return (
    <div ref={wrapRef} className={`rs-choro ${zoomable ? "zoomable" : ""} ${dragging ? "dragging" : ""}`}>
      {focused && (
        <button
          type="button"
          className="rs-choro-back"
          onClick={() => onFocusChange?.(null)}
        >
          ← All counties
        </button>
      )}
      <svg
        ref={svgRef}
        viewBox={vb.map((v) => v.toFixed(3)).join(" ")}
        className="rs-choro-svg"
        {...(zoomable ? {
          // Keyboard-operable map surface: arrows pan, + / − zoom, 0 resets.
          tabIndex: 0, role: "application", "aria-label": "Texas county activity map", "aria-describedby": helpId,
          onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onKeyDown,
          // A drag / pinch that ends over a county must not also select it.
          onClickCapture: (e: React.MouseEvent) => { if (suppressClick.current) { suppressClick.current = false; e.stopPropagation(); } },
        } : {})}
      >
        {shapes.map((sh) => {
          const st = statMap.get(sh.name.toUpperCase());
          const isSel = selected.some((c) => c.toUpperCase() === sh.name.toUpperCase());
          const isFocus = focused && sh.name.toUpperCase() === focusCounty!.toUpperCase();
          const isHover = !!highlightCounty && sh.name.toUpperCase() === highlightCounty.toUpperCase();
          return (
            <path
              key={sh.name}
              d={sh.d}
              // Outline colours live in CSS (tokens): the focused county keeps
              // its hotspot red outline through the drill-down; selection blue
              // applies only at the overview.
              className={`rs-cty ${isFocus ? "focus" : isSel ? "sel" : ""} ${st?.isHotspot ? "hot" : ""} ${isHover ? "hover" : ""}`}
              strokeWidth={isFocus ? sw(2.2) : isSel ? sw(2) : st?.isHotspot ? sw(1.6) : isHover ? sw(1.2) : sw(0.6)}
              // While drilled in, the abstract layer owns interaction inside the
              // county; other counties stay clickable to hop directly between them.
              style={{
                // Drilled in, the county's own choropleth wash disappears — the
                // abstract mesh alone shows where the activity is.
                fill: isFocus && abstractShapes?.length ? "var(--surface-1)" : fillFor(sh.name),
                cursor: st ? "pointer" : undefined, opacity: focused && !isFocus ? 0.45 : 1, transition: "opacity 300ms ease",
              }}
              pointerEvents={isFocus && abstractShapes?.length ? "none" : undefined}
              onClick={() => {
                if (!st) return;
                // Clicking a county both zooms in and applies it as the active
                // research filter (onSelect); backing out clears it upstream.
                if (onFocusChange) onFocusChange(sh.name);
                onSelect(sh.name);
              }}
              onMouseMove={(e) => moveTip(e, `${sh.name} County`, st ? [
                { text: `${st.total.toLocaleString()} records` },
                ...(st.pctChange != null ? [{ text: `${st.pctChange >= 0 ? "+" : ""}${Math.round(st.pctChange * 100)}% vs prior` }] : []),
                ...(st.pctChange == null && st.total > 0 ? [{ text: "new activity" }] : []),
                ...(st.isHotspot ? [{ text: "● Hotspot", color: "var(--danger-ink)" }] : []),
                ...(!focused ? [{ text: "Click to zoom in", muted: true }] : []),
              ] : [{ text: "No recorded activity", muted: true }])}
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
                  className={`rs-abs ${hot ? "hot" : ""}`}
                  strokeWidth={hot ? sw(1.4) : sw(0.35)}
                  style={{ fill: abstractFill(stat, ab.count), cursor: active && onAbstractClick ? "pointer" : undefined }}
                  onClick={() => active && onAbstractClick?.(stat?.abstractId ?? ab.abstract)}
                  onMouseMove={(e) => moveTip(e, formatAbstract({ abstract: ab.abstract, survey: ab.survey, county: focusCounty, state: "TX" }), [
                    { text: active ? `${(stat?.total ?? ab.count).toLocaleString()} records` : "No activity in period" },
                    ...(ab.amount > 0 ? [{ text: `$${Math.round(ab.amount).toLocaleString()} in transactions` }] : []),
                    ...(hot ? [{ text: "● Hotspot", color: "var(--danger-ink)" }] : []),
                    ...(active && onAbstractClick ? [{ text: "Click to view records", muted: true }] : []),
                  ])}
                  onMouseLeave={() => setTip(null)}
                />
              );
            })}
            {/* Re-draw the county boundary on top so the hotspot/selection ring
                stays crisp above the abstract mesh. */}
            {focusShape && (
              <path d={focusShape.d} fill="none"
                className={`rs-cty-ring ${statMap.get(focusShape.name.toUpperCase())?.isHotspot ? "hot" : ""}`}
                strokeWidth={sw(2.2)} pointerEvents="none" />
            )}
          </g>
        )}
      </svg>
      {focused && abstractShapes === null && (
        <div className="rs-map-note">Loading abstracts…</div>
      )}
      {focused && abstractShapes !== null && abstractShapes.length === 0 && (
        <div className="rs-map-note">Abstract boundaries aren't available for this county yet.</div>
      )}
      {zoomable && (
        <>
          <span id={helpId} className="rs-sr-only">
            Drag to pan. Hold {MOD_KEY} and scroll, or pinch, to zoom. With the map focused, arrow keys pan, plus and minus zoom, and 0 resets the view.
          </span>
          {/* Cooperative-gesture hint: shown when a plain scroll or one-finger
              swipe passes over the map (and keeps scrolling the page). */}
          <div className={`rs-choro-hint ${hint.on ? "show" : ""}`} aria-hidden="true"><span>{hint.text}</span></div>
          {/* Same control chrome as the main Map's zoom stack. */}
          <div className="mc-zoom rs-choro-zoom" role="group" aria-label="Map zoom">
            <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => stepZoom(ZOOM_STEP)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => stepZoom(1 / ZOOM_STEP)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
            </button>
            <button type="button" aria-label="Reset view" title={focused ? "Reset view (fit county)" : "Reset view (all of Texas)"} onClick={resetView}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
            </button>
          </div>
        </>
      )}
      {tip && (
        <div className="rs-map-tip" style={{ left: tip.x, top: tip.y }}>
          <strong>{tip.title}</strong>
          {tip.lines.map((l, i) => <div key={i} className={l.muted ? "muted" : undefined} style={l.color ? { color: l.color } : undefined}>{l.text}</div>)}
        </div>
      )}
    </div>
  );
}
