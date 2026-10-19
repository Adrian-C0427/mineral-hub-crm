/**
 * Minimal ESRI shapefile readers for RRC's per-county GIS layers
 * (well{fips}.zip / surv{fips}.zip): dBASE III attribute tables (.dbf) and
 * point / polyline / polygon geometry (.shp). Only what those layers use —
 * no Z/M, no multipatch. Coordinates come back exactly as stored (RRC ships
 * NAD27 geographic degrees; datum.ts converts).
 */

export type DbfRecord = Record<string, string>;

/** Every record of a .dbf, field values trimmed (deleted records skipped). */
export function readDbf(buf: Buffer): DbfRecord[] {
  const nrec = buf.readUInt32LE(4);
  const hdrLen = buf.readUInt16LE(8);
  const recLen = buf.readUInt16LE(10);
  const fields: { name: string; len: number }[] = [];
  for (let off = 32; off + 32 <= hdrLen && buf[off] !== 0x0d; off += 32) {
    const raw = buf.subarray(off, off + 11);
    const end = raw.indexOf(0);
    fields.push({ name: raw.subarray(0, end < 0 ? 11 : end).toString("latin1"), len: buf[off + 16] });
  }
  const out: DbfRecord[] = [];
  for (let i = 0; i < nrec; i++) {
    const pos = hdrLen + i * recLen;
    if (pos + recLen > buf.length) break;
    if (buf[pos] === 0x2a) continue; // '*' = deleted
    const rec: DbfRecord = {};
    let o = pos + 1;
    for (const f of fields) {
      rec[f.name] = buf.subarray(o, o + f.len).toString("latin1").trim();
      o += f.len;
    }
    out.push(rec);
  }
  return out;
}

export type Pt = [number, number];
export type Shape =
  | { kind: "null" }
  | { kind: "point"; point: Pt }
  | { kind: "polyline"; parts: Pt[][] }
  | { kind: "polygon"; rings: Pt[][] };

/** Every record of a .shp in file order (index-aligned with the .dbf). */
export function readShp(buf: Buffer): Shape[] {
  const out: Shape[] = [];
  let pos = 100;
  while (pos + 8 <= buf.length) {
    const contentBytes = buf.readInt32BE(pos + 4) * 2;
    const body = pos + 8;
    pos = body + contentBytes;
    const type = buf.readInt32LE(body);
    if (type === 1) {
      out.push({ kind: "point", point: [buf.readDoubleLE(body + 4), buf.readDoubleLE(body + 12)] });
    } else if (type === 3 || type === 5) {
      const nParts = buf.readInt32LE(body + 36);
      const nPts = buf.readInt32LE(body + 40);
      const starts: number[] = [];
      for (let k = 0; k < nParts; k++) starts.push(buf.readInt32LE(body + 44 + 4 * k));
      starts.push(nPts);
      const ptsOff = body + 44 + 4 * nParts;
      const parts: Pt[][] = [];
      for (let k = 0; k < nParts; k++) {
        const ring: Pt[] = [];
        for (let j = starts[k]; j < starts[k + 1]; j++) ring.push([buf.readDoubleLE(ptsOff + 16 * j), buf.readDoubleLE(ptsOff + 16 * j + 8)]);
        parts.push(ring);
      }
      out.push(type === 3 ? { kind: "polyline", parts } : { kind: "polygon", rings: parts });
    } else {
      out.push({ kind: "null" });
    }
  }
  return out;
}

/** Shoelace sum — positive = counter-clockwise. ESRI outer rings are clockwise, holes counter-clockwise. */
export function signedArea(ring: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s / 2;
}

function pointInRing(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * ESRI polygon rings → GeoJSON MultiPolygon coordinates: each clockwise ring
 * starts a polygon; each counter-clockwise ring is a hole of the outer ring
 * that contains it (a hole no outer contains — malformed source — becomes a
 * polygon of its own rather than being dropped).
 */
export function ringsToMultiPolygon(rings: readonly Pt[][]): Pt[][][] {
  const outers: Pt[][][] = [];
  const holes: Pt[][] = [];
  for (const r of rings) {
    if (r.length < 4) continue;
    if (signedArea(r) <= 0) outers.push([r]);
    else holes.push(r);
  }
  for (const h of holes) {
    const host = outers.find((poly) => pointInRing(h[0], poly[0]));
    if (host) host.push(h);
    else outers.push([h]);
  }
  return outers;
}
