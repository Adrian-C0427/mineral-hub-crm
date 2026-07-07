import { useMemo, useRef, useState } from "react";

/**
 * Dependency-free directed relationship graph.
 *
 * Nodes are laid out with a small deterministic force simulation (a few hundred
 * Fruchterman–Reingold iterations seeded from a hash of each key, so the layout
 * is stable across renders). Node size reflects activity, colour reflects the
 * entity classification, and directed edge thickness reflects transaction
 * volume. The user can zoom (wheel) and pan (drag the canvas); clicking a node
 * or edge calls back for drill-in.
 */

export interface GraphNode {
  norm: string; name: string; klass: string;
  activity: number; acquisitions: number; dispositions: number;
  buyerId?: string | null;
}
export interface GraphEdge { fromNorm: string; toNorm: string; count: number }

export const CLASS_COLORS: Record<string, string> = {
  TERMINAL_HOLD: "#22c55e",
  DISTRIBUTOR: "#3b82f6",
  AGGREGATOR: "#f59e0b",
  FEEDER: "#ec4899",
  PASS_THROUGH: "#8b5cf6",
  SELLER: "#94a3b8",
  ONE_TIME_BUYER: "#14b8a6",
  UNCLASSIFIED: "#64748b",
};

const CLASS_LABEL: Record<string, string> = {
  TERMINAL_HOLD: "Terminal Hold",
  DISTRIBUTOR: "Distributor",
  AGGREGATOR: "Aggregator",
  FEEDER: "Feeder",
  PASS_THROUGH: "Pass-Through",
  SELLER: "Seller",
  ONE_TIME_BUYER: "One-Time Buyer",
  UNCLASSIFIED: "Unclassified",
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295; // [0,1)
}

interface Pos { x: number; y: number }

/** Fixed-iteration force layout → positions in an arbitrary unit space. */
function layout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  const n = nodes.length;
  if (n === 0) return pos;
  const area = 1_000_000;
  const k = Math.sqrt(area / n);           // ideal edge length
  const R = Math.sqrt(area) / 2;
  nodes.forEach((nd, i) => {
    const a = hash(nd.norm) * Math.PI * 2;
    const r = R * (0.35 + 0.65 * hash(nd.norm + "r"));
    pos.set(nd.norm, { x: Math.cos(a) * r + (hash(nd.norm + "x") - 0.5) * 40 + i * 0.01, y: Math.sin(a) * r + (hash(nd.norm + "y") - 0.5) * 40 });
  });
  const adj = edges.filter((e) => pos.has(e.fromNorm) && pos.has(e.toNorm));
  let temp = R * 0.5;
  const iters = 220;
  for (let it = 0; it < iters; it++) {
    const disp = new Map<string, Pos>(nodes.map((nd) => [nd.norm, { x: 0, y: 0 }]));
    // Repulsion (all pairs).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(nodes[i].norm)!, b = pos.get(nodes[j].norm)!;
        let dx = a.x - b.x, dy = a.y - b.y;
        let d = Math.hypot(dx, dy) || 0.01;
        if (d > R * 2.5) continue;
        const f = (k * k) / d;
        dx /= d; dy /= d;
        const da = disp.get(nodes[i].norm)!, db = disp.get(nodes[j].norm)!;
        da.x += dx * f; da.y += dy * f; db.x -= dx * f; db.y -= dy * f;
      }
    }
    // Attraction (edges).
    for (const e of adj) {
      const a = pos.get(e.fromNorm)!, b = pos.get(e.toNorm)!;
      let dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / k;
      dx /= d; dy /= d;
      const da = disp.get(e.fromNorm)!, db = disp.get(e.toNorm)!;
      da.x -= dx * f; da.y -= dy * f; db.x += dx * f; db.y += dy * f;
    }
    // Apply with cooling.
    for (const nd of nodes) {
      const dp = disp.get(nd.norm)!, p = pos.get(nd.norm)!;
      const d = Math.hypot(dp.x, dp.y) || 0.01;
      p.x += (dp.x / d) * Math.min(d, temp);
      p.y += (dp.y / d) * Math.min(d, temp);
    }
    temp *= 0.96;
  }
  return pos;
}

export function NetworkGraph({
  nodes: rawNodes, edges: rawEdges, height = 460, maxNodes = 40, focusNorm,
  onNodeClick, onEdgeClick, emptyLabel = "No relationships to graph.",
}: {
  nodes: GraphNode[]; edges: GraphEdge[]; height?: number; maxNodes?: number; focusNorm?: string;
  onNodeClick?: (n: GraphNode) => void;
  onEdgeClick?: (e: GraphEdge, from: GraphNode, to: GraphNode) => void;
  emptyLabel?: string;
}) {
  // Cap to the most active nodes for legibility; keep edges between survivors.
  const { nodes, edges } = useMemo(() => {
    const kept = [...rawNodes].sort((a, b) => b.activity - a.activity).slice(0, maxNodes);
    const keep = new Set(kept.map((k) => k.norm));
    if (focusNorm && !keep.has(focusNorm)) {
      const f = rawNodes.find((k) => k.norm === focusNorm);
      if (f) { kept.push(f); keep.add(f.norm); }
    }
    return { nodes: kept, edges: rawEdges.filter((e) => keep.has(e.fromNorm) && keep.has(e.toNorm)) };
  }, [rawNodes, rawEdges, maxNodes, focusNorm]);

  const pos = useMemo(() => layout(nodes, edges), [nodes, edges]);
  const nodeByNorm = useMemo(() => new Map(nodes.map((n) => [n.norm, n])), [nodes]);

  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const bounds = useMemo(() => {
    if (nodes.length === 0) return { minX: -500, minY: -500, w: 1000, h: 1000 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { const p = pos.get(n.norm)!; minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const pad = 120;
    return { minX: minX - pad, minY: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
  }, [nodes, pos]);

  if (nodes.length === 0) return <p className="muted" style={{ margin: 0 }}>{emptyLabel}</p>;

  const maxCount = Math.max(1, ...edges.map((e) => e.count));
  const maxAct = Math.max(1, ...nodes.map((n) => n.activity));
  const radius = (n: GraphNode) => 8 + 18 * Math.sqrt(n.activity / maxAct);

  const usedClasses = [...new Set(nodes.map((n) => n.klass))];

  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <div className="chip-row" style={{ gap: 10, flexWrap: "wrap" }}>
          {usedClasses.map((c) => (
            <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: CLASS_COLORS[c] ?? "#64748b", display: "inline-block" }} />
              {CLASS_LABEL[c] ?? c}
            </span>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>Scroll to zoom · drag to pan</span>
        <button className="small" onClick={() => setView({ scale: 1, tx: 0, ty: 0 })}>Reset view</button>
      </div>
      <svg
        width="100%" height={height} style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel-2)", cursor: drag.current ? "grabbing" : "grab", touchAction: "none" }}
        viewBox={`${bounds.minX} ${bounds.minY} ${bounds.w} ${bounds.h}`}
        onWheel={(e) => {
          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          setView((v) => ({ ...v, scale: Math.min(6, Math.max(0.3, v.scale * factor)) }));
        }}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }; (e.target as Element).setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = (e.clientX - drag.current.x) * (bounds.w / 600);
          const dy = (e.clientY - drag.current.y) * (bounds.h / height);
          setView((v) => ({ ...v, tx: drag.current!.tx + dx / v.scale, ty: drag.current!.ty + dy / v.scale }));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerLeave={() => { drag.current = null; }}
      >
        <defs>
          <marker id="ng-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--text-dim)" />
          </marker>
        </defs>
        <g transform={`translate(${(bounds.minX + bounds.w / 2)} ${(bounds.minY + bounds.h / 2)}) scale(${view.scale}) translate(${-(bounds.minX + bounds.w / 2) + view.tx} ${-(bounds.minY + bounds.h / 2) + view.ty})`}>
          {/* Edges */}
          {edges.map((e, i) => {
            const a = pos.get(e.fromNorm), b = pos.get(e.toNorm);
            const from = nodeByNorm.get(e.fromNorm), to = nodeByNorm.get(e.toNorm);
            if (!a || !b || !from || !to) return null;
            // Trim endpoints to node borders so the arrowhead sits at the edge.
            const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
            const ux = dx / d, uy = dy / d;
            const x1 = a.x + ux * radius(from), y1 = a.y + uy * radius(from);
            const x2 = b.x - ux * (radius(to) + 6), y2 = b.y - uy * (radius(to) + 6);
            const active = hover === e.fromNorm || hover === e.toNorm;
            return (
              <line
                key={i} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={active ? "var(--accent)" : "var(--text-dim)"}
                strokeOpacity={active ? 0.9 : 0.4}
                strokeWidth={1 + 5 * (e.count / maxCount)}
                markerEnd="url(#ng-arrow)"
                style={{ cursor: onEdgeClick ? "pointer" : "default" }}
                onClick={() => onEdgeClick?.(e, from, to)}
              >
                <title>{from.name} → {to.name}: {e.count} transaction{e.count === 1 ? "" : "s"}</title>
              </line>
            );
          })}
          {/* Nodes */}
          {nodes.map((n) => {
            const p = pos.get(n.norm)!;
            const r = radius(n);
            const isFocus = n.norm === focusNorm;
            return (
              <g key={n.norm} transform={`translate(${p.x} ${p.y})`}
                style={{ cursor: onNodeClick ? "pointer" : "default" }}
                onMouseEnter={() => setHover(n.norm)} onMouseLeave={() => setHover(null)}
                onClick={() => onNodeClick?.(n)}>
                <circle r={r} fill={CLASS_COLORS[n.klass] ?? "#64748b"} fillOpacity={0.85}
                  stroke={isFocus ? "var(--accent)" : "var(--panel)"} strokeWidth={isFocus ? 3 : 1.5} />
                <text textAnchor="middle" y={r + 13} fontSize={12} fill="var(--text)" style={{ pointerEvents: "none" }}>
                  {n.name.length > 22 ? n.name.slice(0, 21) + "…" : n.name}
                </text>
                <title>{n.name} — {CLASS_LABEL[n.klass] ?? n.klass}\nAcquired: {n.acquisitions} · Sold: {n.dispositions}</title>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
