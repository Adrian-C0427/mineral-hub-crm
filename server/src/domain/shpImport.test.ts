import { describe, expect, it } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { parseShapefileUpload, MAX_UNZIPPED_BYTES, MAX_TRACT_VERTICES } from "./shpImport.js";

type Ring = [number, number][];
const SQUARE: Ring = [[-96, 31], [-96, 31.1], [-95.9, 31.1], [-95.9, 31], [-96, 31]];

/** Polygon .shp, one single-ring record per polygon (shapefile spec: mixed-endian). */
function polygonsShp(polys: Ring[]): Buffer {
  const box = polys.flat().reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const records = polys.map((pts, i) => {
    const content = Buffer.alloc(4 + 32 + 8 + 4 + pts.length * 16);
    let o = 0;
    content.writeInt32LE(5, o); o += 4;
    for (const v of box) { content.writeDoubleLE(v, o); o += 8; }
    content.writeInt32LE(1, o); o += 4;
    content.writeInt32LE(pts.length, o); o += 4;
    content.writeInt32LE(0, o); o += 4;
    for (const [x, y] of pts) { content.writeDoubleLE(x, o); content.writeDoubleLE(y, o + 8); o += 16; }
    const recHeader = Buffer.alloc(8);
    recHeader.writeInt32BE(i + 1, 0);
    recHeader.writeInt32BE(content.length / 2, 4);
    return Buffer.concat([recHeader, content]);
  });
  const body = Buffer.concat(records);
  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  header.writeInt32BE((100 + body.length) / 2, 24);
  header.writeInt32LE(1000, 28);
  header.writeInt32LE(5, 32);
  box.forEach((v, i) => header.writeDoubleLE(v, 36 + i * 8));
  return Buffer.concat([header, body]);
}
const squareShp = () => polygonsShp([SQUARE]);

/** Minimal deflate zip writer (local headers + central directory + EOCD). */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("parseShapefileUpload (zip)", () => {
  it("parses a zipped polygon shapefile", async () => {
    const buf = zip([{ name: "tracts.shp", data: squareShp() }, { name: "readme.txt", data: Buffer.from("ignored") }]);
    const r = await parseShapefileUpload([{ originalname: "tracts.zip", buffer: buf }], "tracts");
    expect(r.features).toHaveLength(1);
    expect(r.features[0].geometry.type).toBe("Polygon");
    expect(r.bbox).toEqual([-96, 31, -95.9, 31.1]);
  });

  it("rejects a zip bomb before it inflates past the budget", async () => {
    const bomb = zip([{ name: "bomb.shp", data: Buffer.alloc(MAX_UNZIPPED_BYTES + 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(parseShapefileUpload([{ originalname: "bomb.zip", buffer: bomb }], "bomb"))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/expands to more than/) });
  });

  it("rejects a zip with too many shapefile entries", async () => {
    const many = zip(Array.from({ length: 51 }, (_, i) => ({ name: `l${i}.prj`, data: Buffer.from("x") })));
    await expect(parseShapefileUpload([{ originalname: "many.zip", buffer: many }], "many"))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/more than 50 files/) });
  });
});

describe("parseShapefileUpload (validation, 2026-09-29 audit)", () => {
  const loose = (shp: Buffer) => parseShapefileUpload([{ originalname: "t.shp", buffer: shp }], "t");

  it("parses a loose .shp off the event loop and rounds coordinates to 1e-6", async () => {
    const r = await loose(polygonsShp([[[-96.123456789, 31], [-96, 31.1], [-95.9, 31.1], [-96.123456789, 31]]]));
    expect(r.features).toHaveLength(1);
    expect((r.features[0].geometry as GeoJSON.Polygon).coordinates[0][0]).toEqual([-96.123457, 31]);
  });

  it("rejects projected coordinates in ANY feature, not just the first", async () => {
    const projected: Ring = [[3_000_000, 10_000_000], [3_000_100, 10_000_000], [3_000_100, 10_000_100], [3_000_000, 10_000_000]];
    await expect(loose(polygonsShp([SQUARE, projected])))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not geographic/) });
  });

  it("rejects an upload over the vertex budget", async () => {
    const n = MAX_TRACT_VERTICES + 10;
    const ring: Ring = Array.from({ length: n }, (_, i) => [-96 + (i / n) * 0.1, 31 + ((i % 2) * 0.01)]);
    ring.push(ring[0]);
    await expect(loose(polygonsShp([ring])))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/boundary points/) });
  }, 60_000);

  it("turns a garbage .shp into a 400, not a crash", async () => {
    await expect(loose(Buffer.from("definitely not a shapefile")))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Could not read the shapefile/) });
  });

  it("does not echo parser internals back to the client", async () => {
    const err = await loose(Buffer.from("definitely not a shapefile")).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "Could not read the shapefile — check that it is a valid polygon shapefile (.shp with its .dbf and .prj)",
    );
  });
});
