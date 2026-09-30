import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
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

/** Vertex budget per upload. Every vertex is stored and shipped to every map
 *  viewer in the org, so this bounds both the parse and GET /map/tracts. */
export const MAX_TRACT_VERTICES = 500_000;

/** Stored-geometry budget per org (bytes of GeoJSON text), checked on import. */
export const MAX_ORG_TRACT_BYTES = 60 * 1024 * 1024;

/** Parsing + reprojection run off the event loop, under these limits. */
const PARSE_TIMEOUT_MS = 60_000;
const PARSE_HEAP_MB = 1024;

/** DBF attribute rows are flat scalars; anything else is clamped to one. */
const MAX_PROP_KEYS = 50;
const MAX_PROP_KEY_LEN = 64;
const MAX_PROP_VALUE_LEN = 500;

/** DBF attribute keys commonly used as the feature's display name. */
const NAME_KEYS = ["name", "tract", "tract_name", "tractname", "label", "title", "lease", "unit", "owner", "id"];

type FC = GeoJSON.FeatureCollection;

/** One shapefile layer's sidecars, as handed to the parse worker. */
interface ShpLayer { shp: Uint8Array; dbf?: Uint8Array; prj?: string; cpg?: string }

/** Absolute URL of shpjs's ESM entry (its `exports` only maps "."). */
function shpjsUrl(): string {
  const cjsEntry = createRequire(import.meta.url).resolve("shpjs"); // …/shpjs/dist/shp.js
  return pathToFileURL(join(dirname(dirname(cjsEntry)), "lib", "index.js")).href;
}

// Inline (eval) worker so it resolves identically under tsx, vitest and the
// compiled dist build. shpjs ships a browser-flavored bundle that dereferences
// `self` at module load, so alias it first.
const PARSE_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
globalThis.self ??= globalThis;
(async () => {
  const shp = await import(workerData.shpjsUrl);
  const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const out = [];
  for (const l of workerData.layers) {
    const geoms = shp.parseShp(ab(l.shp), l.prj);
    const attrs = l.dbf ? shp.parseDbf(ab(l.dbf), l.cpg) : [];
    out.push(shp.combine([geoms, attrs]));
  }
  parentPort.postMessage({ ok: true, collections: out });
})().catch((e) => parentPort.postMessage({ ok: false, message: String((e && e.message) || "unrecognized format") }));
`;

/**
 * Parse + reproject in a worker thread: a hostile or just huge .shp can't block
 * the API's event loop, and runaway memory/time kills the worker, not the API.
 */
function parseLayersInWorker(layers: ShpLayer[]): Promise<FC[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PARSE_WORKER, {
      eval: true,
      workerData: { shpjsUrl: shpjsUrl(), layers },
      resourceLimits: { maxOldGenerationSizeMb: PARSE_HEAP_MB },
    });
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); fn(); };
    const timer = setTimeout(() => done(() => reject(new HttpError(400, "Shapefile took too long to read — split it into smaller files"))), PARSE_TIMEOUT_MS);
    worker.once("message", (m: { ok: true; collections: FC[] } | { ok: false; message: string }) =>
      done(() => (m.ok ? resolve(m.collections) : reject(new Error(m.message)))));
    worker.once("error", (err: Error & { code?: string }) => done(() => reject(
      err.code === "ERR_WORKER_OUT_OF_MEMORY" ? new HttpError(400, "Shapefile is too large to read — split it into smaller files") : err)));
    worker.once("exit", (code) => done(() => reject(new Error(`parser exited (${code})`))));
  });
}

/** DBF rows are flat scalars; clamp anything else so stored JSON stays bounded. */
function sanitizeProps(props: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(props).slice(0, MAX_PROP_KEYS)) {
    const key = k.slice(0, MAX_PROP_KEY_LEN);
    if (v == null || typeof v === "boolean") out[key] = v ?? null;
    else if (typeof v === "number") out[key] = Number.isFinite(v) ? v : null;
    else out[key] = (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : JSON.stringify(v) ?? "").slice(0, MAX_PROP_VALUE_LEN);
  }
  return out;
}

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

/** 1e-6° ≈ 11 cm — far below survey precision; roughly halves stored JSON. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Validate every position (not just the first) and round it in place. Returns
 * the vertex count. Projected values (feet/meters) are orders of magnitude out
 * of lon/lat range, so a missing/ignored .prj fails with an actionable error.
 */
function checkAndRoundCoords(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): number {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  if (!Array.isArray(polys)) throw new HttpError(400, "Shapefile contains a malformed polygon");
  let n = 0;
  for (const poly of polys) {
    if (!Array.isArray(poly)) throw new HttpError(400, "Shapefile contains a malformed polygon");
    for (const ring of poly) {
      if (!Array.isArray(ring)) throw new HttpError(400, "Shapefile contains a malformed polygon");
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const x = Array.isArray(p) ? p[0] : NaN, y = Array.isArray(p) ? p[1] : NaN;
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new HttpError(400, "Shapefile contains invalid (non-numeric) coordinates");
        }
        if (Math.abs(x) > 180 || Math.abs(y) > 90) {
          throw new HttpError(400, "The shapefile's coordinates are not geographic (lon/lat) — include its .prj projection file so they can be converted");
        }
        ring[i] = [round6(x), round6(y)];
      }
      n += ring.length;
    }
  }
  return n;
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

/** Group unzipped sidecars into one layer per .shp. */
function layersFromZip(entries: Map<string, Buffer>): ShpLayer[] {
  const byBase = new Map<string, Partial<Record<"shp" | "dbf" | "prj" | "cpg", Buffer>>>();
  for (const [name, buf] of entries) {
    const dot = name.lastIndexOf(".");
    const base = name.slice(0, dot);
    const ext = name.slice(dot + 1).toLowerCase() as "shp" | "dbf" | "prj" | "cpg";
    byBase.set(base, { ...byBase.get(base), [ext]: buf });
  }
  const out: ShpLayer[] = [];
  for (const l of byBase.values()) {
    if (!l.shp) continue;
    out.push({ shp: l.shp, dbf: l.dbf, prj: l.prj?.toString("latin1"), cpg: l.cpg?.toString("latin1") });
  }
  if (!out.length) throw new HttpError(400, "No .shp file found in the zip");
  return out;
}

/** Parse the upload (one .zip, or loose .shp/.dbf/.prj) into polygon features. */
export async function parseShapefileUpload(files: UploadedFile[], baseName: string): Promise<ShpParseResult> {
  if (!files.length) throw new HttpError(400, "No files uploaded");

  const byExt = (ext: string) => files.find((f) => f.originalname.toLowerCase().endsWith(ext));
  const zip = byExt(".zip");

  let collections: FC[];
  try {
    if (zip) {
      collections = await parseLayersInWorker(layersFromZip(await unzipShapefiles(zip.buffer)));
    } else {
      const shpFile = byExt(".shp");
      if (!shpFile) throw new HttpError(400, "Upload a zipped shapefile, or the .shp file (with its .dbf and .prj alongside)");
      const prj = byExt(".prj");
      const cpg = byExt(".cpg");
      collections = await parseLayersInWorker([{
        shp: shpFile.buffer, dbf: byExt(".dbf")?.buffer,
        prj: prj?.buffer.toString("latin1"), cpg: cpg?.buffer.toString("latin1"),
      }]);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Parser internals (shpjs/proj4 messages, stack-ish text) stay in the
    // server log; the client gets a stable, generic reason.
    console.warn("[shpImport] parse failed:", err instanceof Error ? err.message : err);
    throw new HttpError(400, "Could not read the shapefile — check that it is a valid polygon shapefile (.shp with its .dbf and .prj)");
  }

  const out: ParsedTractFeature[] = [];
  let skipped = 0;
  let bbox: [number, number, number, number] | null = null;
  let vertices = 0;

  for (const fc of collections) {
    for (const f of fc.features ?? []) {
      const g = f.geometry;
      if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) { skipped++; continue; }
      const geometry = g as GeoJSON.Polygon | GeoJSON.MultiPolygon;
      vertices += checkAndRoundCoords(geometry);
      if (vertices > MAX_TRACT_VERTICES) {
        throw new HttpError(400, `Shapefile has more than ${MAX_TRACT_VERTICES.toLocaleString()} boundary points — simplify it or split it into smaller files`);
      }
      const props = sanitizeProps((f.properties ?? {}) as Record<string, unknown>);
      out.push({ name: featureName(props, `${baseName} ${out.length + 1}`), properties: props, geometry });
      bbox = extendBbox(bbox, geometry);
      if (out.length > MAX_TRACT_FEATURES) {
        throw new HttpError(400, `Shapefile has more than ${MAX_TRACT_FEATURES.toLocaleString()} polygons — split it into smaller files`);
      }
    }
  }

  if (!out.length) throw new HttpError(400, `No polygon boundaries found in the shapefile${skipped ? ` (${skipped} non-polygon feature${skipped === 1 ? "" : "s"} skipped)` : ""}`);

  return { features: out, skipped, bbox };
}
