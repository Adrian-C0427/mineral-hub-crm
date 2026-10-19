/**
 * NAD27 → NAD83 for RRC geometry that only ships in NAD27 (survey polygons,
 * lateral lines, out-of-file bottom holes).
 *
 * RRC publishes every well twice — LAT27/LONG27 and LAT83/LONG83 — and the
 * difference IS RRC's own datum conversion at that spot. Over a county the
 * shift is a smooth field (a few feet of variation across ~1,000 sq mi), so a
 * least-squares quadratic surface through thousands of wells reproduces it to
 * a fraction of a foot (measured: 0.04–0.14 ft median residual on Leon,
 * Freestone and Cherokee, 2026-10). Converting the survey polygons with the
 * SAME conversion RRC applied to the wells keeps every well on the side of a
 * survey line RRC's own maps put it — which a generic NAD27→WGS84 transform
 * does not (the previous OTLS-sourced abstracts sat ~35 ft off, 2026-10 audit).
 *
 * Wells whose two coordinate pairs disagree beyond the fitted shift (RRC
 * re-spotted one pair and not the other) are excluded from the fit and
 * reported by `coordinateMismatchFt` for the location-accuracy flag.
 */

export interface ControlPoint { lon27: number; lat27: number; lon83: number; lat83: number }

export interface DatumShift {
  /** NAD27 [lon, lat] → NAD83 [lon, lat]. */
  apply(lon: number, lat: number): [number, number];
  /** How far (ft) a well's published NAD83 point is from its NAD27 point converted by the fit. */
  mismatchFt(p: ControlPoint): number;
  inliers: number;
  total: number;
  /** Fit residual over inliers, ft (median, p90). */
  residualFt: { p50: number; p90: number };
}

const FT_PER_DEG_LAT = 364_000;
const terms = (x: number, y: number) => [1, x, y, x * x, x * y, y * y];

/** Solve the 6×6 normal equations (Gauss-Jordan with partial pivoting). */
function leastSquares(rows: number[][], b: number[]): number[] {
  const n = rows[0].length;
  const M = Array.from({ length: n }, (_, i) => {
    const r = new Array<number>(n + 1).fill(0);
    for (let k = 0; k < rows.length; k++) {
      for (let j = 0; j < n; j++) r[j] += rows[k][i] * rows[k][j];
      r[n] += rows[k][i] * b[k];
    }
    return r;
  });
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < n; r++) {
      if (r === i || M[i][i] === 0) continue;
      const f = M[r][i] / M[i][i];
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map((r, i) => (r[i] === 0 ? 0 : r[n] / r[i]));
}

const quantile = (sorted: readonly number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : 0);

/**
 * Fit the county's NAD27→NAD83 shift from its wells. Iteratively drops
 * points more than `rejectFt` off the surface (bad coordinate pairs).
 */
export function fitDatumShift(points: readonly ControlPoint[], rejectFt = 3): DatumShift {
  if (points.length < 12) throw new Error(`datum fit needs ≥12 control points (got ${points.length})`);
  const x0 = points.reduce((s, p) => s + p.lon27, 0) / points.length;
  const y0 = points.reduce((s, p) => s + p.lat27, 0) / points.length;
  const kx = Math.cos((y0 * Math.PI) / 180) * FT_PER_DEG_LAT;
  let keep = points.slice();
  let cx: number[] = [], cy: number[] = [];
  const errFt = (p: ControlPoint) => {
    const t = terms(p.lon27 - x0, p.lat27 - y0);
    const dx = t.reduce((s, v, i) => s + v * cx[i], 0) - (p.lon83 - p.lon27);
    const dy = t.reduce((s, v, i) => s + v * cy[i], 0) - (p.lat83 - p.lat27);
    return Math.hypot(dx * kx, dy * FT_PER_DEG_LAT);
  };
  for (let it = 0; it < 5; it++) {
    const rows = keep.map((p) => terms(p.lon27 - x0, p.lat27 - y0));
    cx = leastSquares(rows, keep.map((p) => p.lon83 - p.lon27));
    cy = leastSquares(rows, keep.map((p) => p.lat83 - p.lat27));
    const next = points.filter((p) => errFt(p) < rejectFt);
    if (next.length === keep.length) { keep = next; break; }
    keep = next;
    if (keep.length < 12) throw new Error("datum fit: too few consistent control points");
  }
  const res = keep.map(errFt).sort((a, b) => a - b);
  return {
    apply(lon, lat) {
      const t = terms(lon - x0, lat - y0);
      return [lon + t.reduce((s, v, i) => s + v * cx[i], 0), lat + t.reduce((s, v, i) => s + v * cy[i], 0)];
    },
    mismatchFt: errFt,
    inliers: keep.length,
    total: points.length,
    residualFt: { p50: quantile(res, 0.5), p90: quantile(res, 0.9) },
  };
}

/** Great-circle distance in feet between two [lon, lat] points. */
export function distanceFt(a: readonly [number, number], b: readonly [number, number]): number {
  const R = 20_902_231;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
