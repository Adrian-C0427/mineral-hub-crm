// Lightweight geometry helpers (no dependency) for the embedded deal map.

type Pt = [number, number];

/** Collect all [lng,lat] vertices from a GeoJSON Polygon/MultiPolygon geometry. */
export function collectCoords(geom: { type: string; coordinates: unknown }, out: Pt[] = []): Pt[] {
  const walk = (x: unknown) => {
    if (Array.isArray(x) && typeof x[0] === "number") out.push([x[0] as number, x[1] as number]);
    else if (Array.isArray(x)) x.forEach(walk);
  };
  walk(geom.coordinates);
  return out;
}

/** Bounding box [w,s,e,n] of a set of points. */
export function bboxOfPoints(pts: Pt[]): [number, number, number, number] {
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of pts) { if (x < w) w = x; if (y < s) s = y; if (x > e) e = x; if (y > n) n = y; }
  return [w, s, e, n];
}

/** Convex hull (Andrew's monotone chain). Returns a closed ring of [lng,lat]. */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...new Set(points.map((p) => `${p[0]},${p[1]}`))].map((s) => s.split(",").map(Number) as Pt);
  if (pts.length < 3) return pts;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  hull.push(hull[0]); // close the ring
  return hull;
}
