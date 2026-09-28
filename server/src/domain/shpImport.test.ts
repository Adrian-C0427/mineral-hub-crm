import { describe, expect, it } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { parseShapefileUpload, MAX_UNZIPPED_BYTES } from "./shpImport.js";

/** One-square-polygon .shp in lon/lat (shapefile spec: mixed-endian header). */
function squareShp(): Buffer {
  const pts: [number, number][] = [[-96, 31], [-96, 31.1], [-95.9, 31.1], [-95.9, 31], [-96, 31]];
  const content = Buffer.alloc(4 + 32 + 8 + 4 + pts.length * 16);
  let o = 0;
  content.writeInt32LE(5, o); o += 4;
  for (const v of [-96, 31, -95.9, 31.1]) { content.writeDoubleLE(v, o); o += 8; }
  content.writeInt32LE(1, o); o += 4;
  content.writeInt32LE(pts.length, o); o += 4;
  content.writeInt32LE(0, o); o += 4;
  for (const [x, y] of pts) { content.writeDoubleLE(x, o); content.writeDoubleLE(y, o + 8); o += 16; }

  const recHeader = Buffer.alloc(8);
  recHeader.writeInt32BE(1, 0);
  recHeader.writeInt32BE(content.length / 2, 4);

  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  header.writeInt32BE((100 + 8 + content.length) / 2, 24);
  header.writeInt32LE(1000, 28);
  header.writeInt32LE(5, 32);
  [-96, 31, -95.9, 31.1].forEach((v, i) => header.writeDoubleLE(v, 36 + i * 8));
  return Buffer.concat([header, recHeader, content]);
}

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
