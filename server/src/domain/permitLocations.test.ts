import { describe, it, expect } from "vitest";
import { frameExtent, permitApi8, resolvePermitLocations, type WellLocation } from "./permitLocations.js";

describe("permitApi8", () => {
  it("reduces every API spelling to the 8-digit county + unique number", () => {
    expect(permitApi8("42-289-31234")).toBe("28931234");
    expect(permitApi8("4228931234")).toBe("28931234");
    expect(permitApi8("42289312340000")).toBe("28931234");
    expect(permitApi8("28931234")).toBe("28931234");
  });
  it("keeps a bare api8 whose county code starts with 42 (Smith = 423)", () => {
    expect(permitApi8("42312345")).toBe("42312345");
    expect(permitApi8("42-423-12345")).toBe("42312345");
  });
  it("returns null for missing or short numbers", () => {
    expect(permitApi8(null)).toBeNull();
    expect(permitApi8("")).toBeNull();
    expect(permitApi8("12345")).toBeNull();
  });
});

describe("frameExtent", () => {
  it("pads a single point to a sensible span centred on it", () => {
    const [w, s, e, n] = frameExtent([-96, 31.3, -96, 31.3], 0.05);
    expect(e - w).toBeCloseTo(0.05);
    expect(n - s).toBeCloseTo(0.05);
    expect((w + e) / 2).toBeCloseTo(-96);
    expect((s + n) / 2).toBeCloseTo(31.3);
  });
  it("leaves an already-large extent unchanged", () => {
    expect(frameExtent([-97, 31, -95, 32])).toEqual([-97, 31, -95, 32]);
  });
  it("pads only the collapsed axis", () => {
    const b = frameExtent([-97, 31.3, -95, 31.3], 0.05);
    expect([b[0], b[2]]).toEqual([-97, -95]);
    expect(b[3] - b[1]).toBeCloseTo(0.05);
  });
});

describe("resolvePermitLocations", () => {
  const wells: WellLocation[] = [
    { fid: 1, api8: "28931234", lon: -96.0, lat: 31.3 },
    { fid: 2, api8: "16100001", lon: -96.2, lat: 31.6 },
    { fid: 3, api8: "16100001", lon: -96.2001, lat: 31.6001 }, // same API, re-plotted
  ];

  it("counts every permit and locates by API first, then coordinates", () => {
    const r = resolvePermitLocations([
      { api8: "28931234" },
      { api8: "16100001" },
      { api8: null, lat: 31.5, lon: -95.9 },   // org import with coordinates only
      { api8: "99999999" },                    // no well, no coordinates
      { api8: null, lat: 0, lon: 0 },          // null-island = missing
    ], wells);
    expect(r.total).toBe(5);
    expect(r.located).toBe(3);
    expect(r.unlocated).toBe(2);
    // fid 1 + both surface records of 16100001 + the coordinate point
    expect(r.points.map((p) => p.fid).sort()).toEqual([1, 2, 3, null].sort());
    expect(r.wells).toBe(4);
  });

  it("collapses several permits on one well into one point", () => {
    const r = resolvePermitLocations([{ api8: "28931234" }, { api8: "28931234" }], wells);
    expect(r.total).toBe(2);
    expect(r.located).toBe(2);
    expect(r.points).toEqual([{ fid: 1, lon: -96.0, lat: 31.3, permits: 2 }]);
  });

  it("frames all located points, padding a single well", () => {
    const one = resolvePermitLocations([{ api8: "28931234" }], wells);
    expect(one.bbox).toEqual(frameExtent([-96.0, 31.3, -96.0, 31.3]));
    const many = resolvePermitLocations([{ api8: "28931234" }, { api8: "16100001" }], wells);
    expect(many.bbox).toEqual([-96.2001, 31.3, -96.0, 31.6001]);
  });

  it("returns no bbox when nothing is located", () => {
    const r = resolvePermitLocations([{ api8: "00000000" }], wells);
    expect(r).toMatchObject({ total: 1, located: 0, unlocated: 1, wells: 0, bbox: null, points: [] });
  });

  it("caps the points payload but frames everything", () => {
    const many: WellLocation[] = Array.from({ length: 10 }, (_, i) => ({ fid: i + 10, api8: String(10000000 + i), lon: -96 - i, lat: 31 }));
    const r = resolvePermitLocations(many.map((w) => ({ api8: w.api8 })), many, 4);
    expect(r.points).toHaveLength(4);
    expect(r.truncated).toBe(true);
    expect(r.wells).toBe(10);
    expect(r.bbox?.[0]).toBe(-105);
  });

  it("ignores wells with unusable coordinates", () => {
    const r = resolvePermitLocations([{ api8: "28931234" }], [{ fid: 1, api8: "28931234", lon: NaN, lat: 31 }]);
    expect(r.located).toBe(0);
  });
});
