import { inflateRawSync } from "node:zlib";
import { iter as iterZip } from "but-unzip";
import { HttpError } from "../middleware/errors.js";

/**
 * Shapefile → WGS84 GeoJSON polygon features, for the map's "Imported tracts"
 * overlay. Accepts either a zipped shapefile or the loose sidecar set
 * (.shp required; .dbf attributes and .prj projection used when present).
 * Reprojection to lon/lat is handled by shpjs from the .prj — without one the
 * coordinates must already be geographic, which is validated below so a State
 * Plane file missing its .prj fails loudly instead of plotting in the ocean.
 */

export interface UploadedFile { originalname: string; buffer: Buffer }

export interface ParsedTractFeature {
  name: string;
  properties: Record<string, unknown>;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

export interface ShpParseResult {
  features: ParsedTractFeature[];
  /** Features dropped because they weren't polygons (points/lines/null). */
  skipped: number;
  /** [minLon, minLat, maxLon, maxLat] over everything kept. */
  bbox: [number, number, number, number] | null;
}

/** Hard cap per upload — protects the row store and the client render. */
export const MAX_TRACT_FEATURES = 5000;

/** Decompressed-size budget for a zipped upload — a real tract shapefile is a
 *  few MB; this stops a zip bomb from inflating into GBs of heap. */
export const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 50;
const ZIP_SIDECAR = /\.(shp|dbf|prj|cpg)$/i;

/** DBF attribute keys commonly used as the feature's display name. */
const NAME_KEYS = ["name", "tract", "tract_name", "tractname", "label", "title", "lease", "unit", "owner", "id"];

type FC = GeoJSON.FeatureCollection;

async function loadShpjs() {
  // shpjs ships a browser-flavored bundle that dereferences `self` at module
  // load; give Node the alias before importing it.
  (globalThis as { self?: unknown }).self ??= globalThis;
  return import("shpjs");
}

const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function featureName(props: Record<string, unknown>, fallback: string): string {
  for (const want of NAME_KEYS) {
    for (const [k, v] of Object.entries(props)) {
      if (k.toLowerCase() !== want) continue;
      const s = String(v ?? "").trim();
      if (s) return s.slice(0, 200);
    }
  }
  return fallback;
}

function firstPosition(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number] | null {
  const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0]?.[0];
  const p = ring?.[0];
  return p ? [p[0], p[1]] : null;
}

function extendBbox(bbox: [number, number, number, number] | null, g: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number, number, number] {
  let [minX, minY, maxX, maxY] = bbox ?? [Infinity, Infinity, -Infinity, -Infinity];
  const rings = g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Unzip only the shapefile sidecars, inflating under a shared output budget.
 * Entry sizes in the zip header are attacker-controlled, so the cap is enforced
 * on the actual inflate output (zlib maxOutputLength), not on declared sizes.
 */
async function unzipShapefiles(buffer: Buffer): Promise<Map<string, Buffer>> {
  let remaining = MAX_UNZIPPED_BYTES;
  const tooBig = () => new HttpError(400, `Shapefile zip expands to more than ${MAX_UNZIPPED_BYTES / 1024 / 1024} MB — split it into smaller files`);
  const inflate = (raw: Uint8Array): Uint8Array => {
    try {
      return inflateRawSync(raw, { maxOutputLength: Math.max(remaining, 1) });
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw tooBig();
      throw err;
    }
  };
  const out = new Map<string, Buffer>();
  let entries = 0;
  for (const entry of iterZip(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), inflate)) {
    if (entry.filename.includes("__MACOSX") || !ZIP_SIDECAR.test(entry.filename)) continue;
    if (++entries > MAX_ZIP_ENTRIES) throw new HttpError(400, `Shapefile zip has more than ${MAX_ZIP_ENTRIES} files — split it into smaller uploads`);
    const bytes = await entry.read();
    remaining -= bytes.byteLength;
    if (remaining < 0) throw tooBig();
    out.set(entry.filename, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
  return out;
}

/** Group unzipped sidecars into one FeatureCollection per .shp layer. */
function collectionsFromZip(shp: Awaited<ReturnType<typeof loadShpjs>>, entries: Map<string, Buffer>): FC[] {
  const layers = new Map<string, Partial<Record<"shp" | "dbf" | "prj" | "cpg", Buffer>>>();
  for (const [name, buf] of entries) {
    const dot = name.lastIndexOf(".");
    const base = name.slice(0, dot);
    const ext = name.slice(dot + 1).toLowerCase() as "shp" | "dbf" | "prj" | "cpg";
    layers.set(base, { ...layers.get(base), [ext]: buf });
  }
  const out: FC[] = [];
  for (const layer of layers.values()) {
    if (!layer.shp) continue;
    const geoms = shp.parseShp(toArrayBuffer(layer.shp), layer.prj?.toString("latin1"));
    const attrs = layer.dbf ? shp.parseDbf(toArrayBuffer(layer.dbf), layer.cpg?.toString("latin1")) : [];
    out.push(shp.combine([geoms, attrs]));
  }
  if (!out.length) throw new HttpError(400, "No .shp file found in the zip");
  return out;
}

/** Parse the upload (one .zip, or loose .shp/.dbf/.prj) into polygon features. */
export async function parseShapefileUpload(files: UploadedFile[], baseName: string): Promise<ShpParseResult> {
  if (!files.length) throw new HttpError(400, "No files uploaded");
  const shp = await loadShpjs();

  const byExt = (ext: string) => files.find((f) => f.originalname.toLowerCase().endsWith(ext));
  const zip = byExt(".zip");

  let collections: FC[];
  try {
    if (zip) {
      collections = collectionsFromZip(shp, await unzipShapefiles(zip.buffer));
    } else {
      const shpFile = byExt(".shp");
      if (!shpFile) throw new HttpError(400, "Upload a zipped shapefile, or the .shp file (with its .dbf and .prj alongside)");
      const prj = byExt(".prj");
      const dbf = byExt(".dbf");
      const geoms = shp.parseShp(toArrayBuffer(shpFile.buffer), prj ? prj.buffer.toString("latin1") : undefined);
      const attrs = dbf ? shp.parseDbf(toArrayBuffer(dbf.buffer)) : [];
      collections = [shp.combine([geoms, attrs])];
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `Could not read the shapefile: ${err instanceof Error ? err.message : "unrecognized format"}`);
  }

  const out: ParsedTractFeature[] = [];
  let skipped = 0;
  let bbox: [number, number, number, number] | null = null;

  for (const fc of collections) {
    for (const f of fc.features ?? []) {
      const g = f.geometry;
      if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) { skipped++; continue; }
      const geometry = g as GeoJSON.Polygon | GeoJSON.MultiPolygon;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      out.push({ name: featureName(props, `${baseName} ${out.length + 1}`), properties: props, geometry });
      bbox = extendBbox(bbox, geometry);
      if (out.length > MAX_TRACT_FEATURES) {
        throw new HttpError(400, `Shapefile has more than ${MAX_TRACT_FEATURES.toLocaleString()} polygons — split it into smaller files`);
      }
    }
  }

  if (!out.length) throw new HttpError(400, `No polygon boundaries found in the shapefile${skipped ? ` (${skipped} non-polygon feature${skipped === 1 ? "" : "s"} skipped)` : ""}`);

  // Geographic sanity: after any .prj reprojection the coordinates must be
  // lon/lat. Projected values (feet/meters) are orders of magnitude out of
  // range, so a missing/ignored .prj is caught here with an actionable error.
  const p = firstPosition(out[0].geometry);
  if (!p || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) {
    throw new HttpError(400, "The shapefile's coordinates are not geographic (lon/lat) — include its .prj projection file so they can be converted");
  }

  return { features: out, skipped, bbox };
}
