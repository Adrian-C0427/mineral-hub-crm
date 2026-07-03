/**
 * Generate client/public/data/county-labels.geojson: one label point per
 * county (ST_PointOnSurface — always inside the polygon, even for concave
 * shapes) plus the county bbox, for the map's county-name layer and
 * search go-to-county framing. County POLYGONS render from vector tiles
 * (gis.counties, full-resolution TIGER); this file is just 254 points.
 *
 * Usage: npx tsx src/scripts/exportCountyLabels.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client/public/data/county-labels.geojson");

async function main() {
  const rows = await prisma.$queryRawUnsafe<{ fips: string; name: string; lon: number; lat: number; minx: number; miny: number; maxx: number; maxy: number }[]>(
    `SELECT fips, name,
            round(ST_X(ST_PointOnSurface(geom))::numeric, 5)::float AS lon,
            round(ST_Y(ST_PointOnSurface(geom))::numeric, 5)::float AS lat,
            round(ST_XMin(geom)::numeric, 4)::float AS minx, round(ST_YMin(geom)::numeric, 4)::float AS miny,
            round(ST_XMax(geom)::numeric, 4)::float AS maxx, round(ST_YMax(geom)::numeric, 4)::float AS maxy
       FROM gis.counties ORDER BY fips`);
  const fc = {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      properties: { fips: r.fips, name: r.name, bbox: [r.minx, r.miny, r.maxx, r.maxy] },
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
    })),
  };
  fs.writeFileSync(OUT, JSON.stringify(fc));
  console.log(`wrote ${rows.length} county label points -> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
