/**
 * CLI: load East Texas Basin salt dome outlines into gis.salt_domes.
 *
 * Source: BEG Report of Investigations No. 140 — Jackson & Seni (1984),
 * "Atlas of Salt Domes in the East Texas Basin" (public; store.beg.utexas.edu
 * BEG-RI0140D.pdf). For each of the basin's 15 shallow (<4,000 ft) piercement
 * domes the atlas publishes the dome center (lat/long DMS), the salt stock's
 * maximum lateral major/minor axes at a reference depth, and the major-axis
 * azimuth. The outlines below are ellipses built from exactly those published
 * numbers — an APPROXIMATE plan-view extent of the salt stock, not a digitized
 * structure contour — and the layer is labeled accordingly in the app.
 *
 * OCR notes: Bethel's longitude prints as 96°54'54"W in the scanned atlas
 * text layer — a 5→6 misread; 95°54'54"W is used (NW Anderson Co., matching
 * the atlas county and every other Bethel reference). Butler's seconds print
 * as "OT" → 07. Mount Sylvan's and Butler's azimuths did not OCR; their
 * ellipses are near-circular so orientation matters little (0° used).
 *
 * The atlas names three deeper diapirs it does not map (crests below 4,000 ft):
 * La Rue, Concord (Leon Co.), and Girlie Caldwell. No published coordinates in
 * the atlas text — deliberately omitted here rather than guessed.
 *
 * Idempotent: full replace on re-run (15 rows).
 * Usage: npx tsx src/scripts/importSaltDomes.ts
 */
import { prisma } from "../db.js";

interface Dome {
  name: string; county: string; lat: number; lon: number;
  majorMi: number; minorMi: number; azimuthDeg: number;
  crestFt: number; // depth to salt stock, ft below surface
}

const dms = (d: number, m: number, s: number) => d + m / 60 + s / 3600;

const DOMES: Dome[] = [
  { name: "Bethel", county: "Anderson", lat: dms(31, 53, 23), lon: -dms(95, 54, 54), majorMi: 2.3, minorMi: 1.9, azimuthDeg: 15, crestFt: 1600 },
  { name: "Boggy Creek", county: "Anderson/Cherokee", lat: dms(31, 58, 7), lon: -dms(95, 26, 26), majorMi: 9.0, minorMi: 2.5, azimuthDeg: 35, crestFt: 330 },
  { name: "Brooks", county: "Smith", lat: dms(32, 9, 42), lon: -dms(95, 26, 38), majorMi: 3.5, minorMi: 3.3, azimuthDeg: 42, crestFt: 1140 },
  { name: "Brushy Creek", county: "Anderson", lat: dms(31, 55, 27), lon: -dms(95, 35, 50), majorMi: 1.56, minorMi: 1.56, azimuthDeg: 0, crestFt: 2800 },
  { name: "Bullard", county: "Smith", lat: dms(32, 9, 20), lon: -dms(95, 17, 38), majorMi: 1.0, minorMi: 0.5, azimuthDeg: 95, crestFt: 3060 },
  { name: "Butler", county: "Freestone", lat: dms(31, 40, 7), lon: -dms(95, 51, 52), majorMi: 2.5, minorMi: 2.2, azimuthDeg: 0, crestFt: 460 },
  { name: "East Tyler", county: "Smith", lat: dms(32, 22, 30), lon: -dms(95, 15, 45), majorMi: 3.3, minorMi: 2.9, azimuthDeg: 80, crestFt: 1130 },
  { name: "Grand Saline", county: "Van Zandt", lat: dms(32, 39, 58), lon: -dms(95, 42, 34), majorMi: 1.6, minorMi: 1.5, azimuthDeg: 50, crestFt: 215 },
  { name: "Hainesville", county: "Wood", lat: dms(32, 41, 40), lon: -dms(95, 22, 20), majorMi: 4.3, minorMi: 3.2, azimuthDeg: 40, crestFt: 1080 },
  { name: "Keechi", county: "Anderson", lat: dms(31, 50, 19), lon: -dms(95, 42, 20), majorMi: 4.6, minorMi: 1.7, azimuthDeg: 15, crestFt: 400 },
  { name: "Mount Sylvan", county: "Smith", lat: dms(32, 23, 9), lon: -dms(95, 26, 55), majorMi: 2.3, minorMi: 1.5, azimuthDeg: 0, crestFt: 1440 },
  { name: "Oakwood", county: "Freestone/Leon", lat: dms(31, 32, 10), lon: -dms(95, 58, 13), majorMi: 2.5, minorMi: 2.0, azimuthDeg: 120, crestFt: 160 },
  { name: "Palestine", county: "Anderson", lat: dms(31, 44, 13), lon: -dms(95, 43, 41), majorMi: 3.4, minorMi: 2.7, azimuthDeg: 170, crestFt: 150 },
  { name: "Steen", county: "Smith", lat: dms(32, 31, 0), lon: -dms(95, 19, 30), majorMi: 2.2, minorMi: 2.1, azimuthDeg: 45, crestFt: 1200 },
  { name: "Whitehouse", county: "Smith", lat: dms(32, 13, 27), lon: -dms(95, 17, 3), majorMi: 2.6, minorMi: 1.3, azimuthDeg: 15, crestFt: 1520 },
];

const MI_M = 1609.344;

/** WKT ellipse polygon: published axes (semi = length/2), azimuth clockwise from north. */
function ellipseWkt(d: Dome, points = 48): string {
  const a = (d.majorMi * MI_M) / 2, b = (d.minorMi * MI_M) / 2;
  const az = (d.azimuthDeg * Math.PI) / 180;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((d.lat * Math.PI) / 180);
  const coords: string[] = [];
  for (let i = 0; i <= points; i++) {
    const t = (i / points) * 2 * Math.PI;
    // Ellipse local coords: x east, y north; major axis along azimuth.
    const px = a * Math.cos(t), py = b * Math.sin(t);
    const east = px * Math.sin(az) + py * Math.cos(az);
    const north = px * Math.cos(az) - py * Math.sin(az);
    coords.push(`${(d.lon + east / mPerDegLon).toFixed(6)} ${(d.lat + north / mPerDegLat).toFixed(6)}`);
  }
  return `POLYGON((${coords.join(",")}))`;
}

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS gis.salt_domes (
      id          serial PRIMARY KEY,
      name        text NOT NULL UNIQUE,
      county      text NOT NULL,
      major_mi    numeric(4,2) NOT NULL,
      minor_mi    numeric(4,2) NOT NULL,
      azimuth_deg integer NOT NULL,
      crest_ft    integer NOT NULL,
      source      text NOT NULL,
      geom        geometry(Polygon, 4326) NOT NULL
    )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS salt_domes_geom_idx ON gis.salt_domes USING GIST (geom)`);
  await prisma.$executeRawUnsafe(`TRUNCATE gis.salt_domes RESTART IDENTITY`);
  for (const d of DOMES) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO gis.salt_domes (name, county, major_mi, minor_mi, azimuth_deg, crest_ft, source, geom)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ST_GeomFromText($8, 4326))`,
      d.name, d.county, d.majorMi, d.minorMi, d.azimuthDeg, d.crestFt,
      "BEG RI-140 (Jackson & Seni 1984) — approximate extent from published axes",
      ellipseWkt(d),
    );
  }
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) n FROM gis.salt_domes`);
  console.log(`gis.salt_domes loaded: ${n} domes`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
