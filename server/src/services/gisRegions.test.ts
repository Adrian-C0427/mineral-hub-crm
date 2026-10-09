import fs from "node:fs";
import zlib from "node:zlib";
import { describe, it, expect } from "vitest";
import {
  batches, buildParishUpsert, buildSectionUpsert, decideLoad, loadRegionDataset, normalizeSectionLabel,
  parseRegionDataset, regionDataPath, type GisDb, type GisDbRunner, type RegionDataset,
} from "./gisRegions.js";

// The Louisiana boot loader writes into the production gis schema unattended,
// so its pure parts are pinned here; the full SQL path was exercised against a
// PostGIS database (see the PR notes).

const square = (x: number, y: number) => ({ type: "Polygon", coordinates: [[[x, y], [x + 0.01, y], [x + 0.01, y + 0.01], [x, y + 0.01], [x, y]]] });
const dataset = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  source: "test",
  parishes: [{ fips: "22017", name: "Caddo", geom: { type: "MultiPolygon", coordinates: [square(-94, 32).coordinates] } }],
  sections: [
    { id: "LA-LA180230N0160W0SN320", countyFips: "017", county: "Caddo", abstract: "Sec 32", survey: "T23N R16W", area: 1484836, geom: square(-93.9, 32.5) },
    { id: "LA-LA180230N0160W0SN010", countyFips: "017", county: "Caddo", abstract: "Sec 01", survey: "T23N R16W", area: 1.5e6, geom: square(-93.8, 32.5) },
  ],
  ...overrides,
});

describe("regionDataPath", () => {
  it("resolves server/data/gis from both the tsx (src) and the built (dist) module", () => {
    expect(regionDataPath("file:///app/server/src/services/gisRegions.ts")).toBe("/app/server/data/gis/la-haynesville.json.gz");
    expect(regionDataPath("file:///app/server/dist/services/gisRegions.js")).toBe("/app/server/data/gis/la-haynesville.json.gz");
  });
  it("finds the bundled dataset, which parses to the 7 Haynesville parishes", () => {
    const file = regionDataPath(new URL("./gisRegions.ts", import.meta.url).href);
    expect(fs.existsSync(file)).toBe(true);
    const ds = parseRegionDataset(zlib.gunzipSync(fs.readFileSync(file)));
    expect(ds.parishes.map((p) => p.name).sort()).toEqual(["Bienville", "Bossier", "Caddo", "De Soto", "Natchitoches", "Red River", "Sabine"]);
    expect(ds.sections.length).toBe(6174);
    expect(ds.sections.every((s) => s.id.startsWith("LA-") && /^Sec \d+$/.test(s.abstract))).toBe(true);
  });
});

describe("parseRegionDataset", () => {
  it("normalizes section labels and versions by content", () => {
    const a = parseRegionDataset(dataset());
    expect(a.sections.map((s) => s.abstract)).toEqual(["Sec 32", "Sec 1"]);
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
    expect(parseRegionDataset(Buffer.from(dataset())).version).toBe(a.version);
    expect(parseRegionDataset(dataset({ source: "other" })).version).not.toBe(a.version);
  });
  it("refuses rows outside Louisiana / the LA- id namespace / the dataset's parishes", () => {
    expect(() => parseRegionDataset(dataset({ parishes: [{ fips: "48403", name: "Sabine", geom: square(0, 0) }] }))).toThrow(/non-Louisiana/);
    const bad = (s: Record<string, unknown>) => dataset({ sections: [{ id: "LA-X1", countyFips: "017", county: "Caddo", abstract: "Sec 1", survey: "T1N R1W", area: 1, geom: square(0, 0), ...s }] });
    expect(() => parseRegionDataset(bad({ id: "TX-289653" }))).toThrow(/LA- namespace/);
    expect(() => parseRegionDataset(bad({ countyFips: "403" }))).toThrow(/outside the dataset's parishes/);
    expect(() => parseRegionDataset(bad({ geom: { type: "Point", coordinates: [0, 0] } }))).toThrow(/polygon/);
    expect(() => parseRegionDataset(dataset({ sections: [] }))).toThrow(/no sections/);
  });
  it("rejects duplicate ids", () => {
    const one = JSON.parse(dataset()).sections[0];
    expect(() => parseRegionDataset(dataset({ sections: [one, one] }))).toThrow(/duplicate/);
  });
});

describe("normalizeSectionLabel", () => {
  it("drops zero padding only", () => {
    expect(normalizeSectionLabel("Sec 01")).toBe("Sec 1");
    expect(normalizeSectionLabel("Sec 00")).toBe("Sec 0");
    expect(normalizeSectionLabel("Sec 120")).toBe("Sec 120");
    expect(normalizeSectionLabel("Lot 7")).toBe("Lot 7");
  });
});

describe("decideLoad", () => {
  const exp = { parishes: 7, sections: 6174 };
  it("skips when the recorded version matches and every row is present", () => {
    expect(decideLoad({ version: "v1" }, "v1", exp, exp)).toEqual({ load: false, pruneStale: false });
  });
  it("loads (never prunes) on a first boot", () => {
    expect(decideLoad(null, "v1", { parishes: 0, sections: 0 }, exp)).toEqual({ load: true, pruneStale: false });
    // Rows someone else put there without a marker are left alone, not pruned.
    expect(decideLoad(null, "v1", exp, exp)).toEqual({ load: true, pruneStale: false });
  });
  it("reloads missing rows without pruning", () => {
    expect(decideLoad({ version: "v1" }, "v1", { parishes: 7, sections: 6173 }, exp)).toEqual({ load: true, pruneStale: false });
  });
  it("loads and prunes when a newer version replaces a loaded one", () => {
    expect(decideLoad({ version: "v1" }, "v2", exp, exp)).toEqual({ load: true, pruneStale: true });
  });
});

describe("upsert builders", () => {
  const ds = parseRegionDataset(dataset());
  it("batches", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 2)).toEqual([]);
  });
  it("writes parishes as Louisiana rows and only ever updates Louisiana rows", () => {
    const q = buildParishUpsert(ds.parishes);
    expect(q.sql).toContain("INSERT INTO gis.counties (fips, state, name, geom)");
    expect(q.sql).toContain("($1, 'LA', $2, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)))");
    expect(q.sql).toContain("WHERE gis.counties.state = 'LA'");
    expect(q.params).toEqual(["22017", "Caddo", JSON.stringify(ds.parishes[0].geom)]);
  });
  it("writes sections with 7 params per row and the same Louisiana guard", () => {
    const q = buildSectionUpsert(ds.sections);
    expect(q.params.length).toBe(14);
    expect(q.sql).toContain("($8, 'LA', $9, $10, $11, $12, $13::float8, ST_SetSRID(ST_GeomFromGeoJSON($14), 4326))");
    expect(q.sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(q.sql).toContain("WHERE gis.abstracts.state = 'LA'");
    expect(q.params.slice(0, 6)).toEqual(["LA-LA180230N0160W0SN320", "017", "Caddo", "Sec 32", "T23N R16W", 1484836]);
    // No value is ever spliced into the SQL text.
    expect(q.sql).not.toContain("Caddo");
  });
});

/** A scripted fake of the SQL surface: records statements, answers the reads. */
function fakeDb(state: { gis: boolean; marker: string | null; parishes: number; sections: number }) {
  const log: string[] = [];
  const db: GisDb = {
    async query<T>(sql: string): Promise<T[]> {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("to_regclass")) return [{ ok: state.gis } as T];
      if (sql.includes("FROM gis.dataset_version")) return state.marker ? [{ version: state.marker } as T] : [];
      if (sql.includes("AS parishes")) return [{ parishes: state.parishes, sections: state.sections } as T];
      if (sql.includes("DELETE FROM gis.abstracts")) return [{ n: 0 } as T];
      return [];
    },
    async execute(sql: string) { log.push(sql.trim().split(/\s+/).slice(0, 3).join(" ")); return 0; },
  };
  const runner: GisDbRunner = { ...db, transaction: async (fn) => { log.push("BEGIN"); const r = await fn(db); log.push("COMMIT"); return r; } };
  return { runner, log };
}

describe("loadRegionDataset", () => {
  const ds: RegionDataset = parseRegionDataset(dataset());
  it("skips a database without the gis tables, writing nothing", async () => {
    const { runner, log } = fakeDb({ gis: false, marker: null, parishes: 0, sections: 0 });
    expect(await loadRegionDataset(runner, ds)).toEqual({ status: "no-gis" });
    expect(log.some((l) => /CREATE|INSERT|DELETE/.test(l))).toBe(false);
  });
  it("is a read-only no-op when already current", async () => {
    const { runner, log } = fakeDb({ gis: true, marker: ds.version, parishes: 1, sections: 2 });
    expect(await loadRegionDataset(runner, ds)).toEqual({ status: "current", parishes: 1, sections: 2 });
    expect(log.some((l) => /INSERT|DELETE|BEGIN/.test(l))).toBe(false);
  });
  it("loads inside one locked transaction, marker last, no prune on first load", async () => {
    const { runner, log } = fakeDb({ gis: true, marker: null, parishes: 0, sections: 0 });
    expect(await loadRegionDataset(runner, ds)).toEqual({ status: "loaded", parishes: 1, sections: 2, pruned: 0 });
    const tx = log.slice(log.indexOf("BEGIN"));
    expect(tx[1]).toBe("SELECT pg_advisory_xact_lock(hashtext($1))");
    expect(tx.filter((l) => l.startsWith("INSERT INTO gis.counties")).length).toBe(1);
    expect(tx.filter((l) => l.startsWith("INSERT INTO gis.abstracts")).length).toBe(1);
    expect(tx.some((l) => l.includes("DELETE"))).toBe(false);
    expect(tx[tx.length - 2]).toBe("INSERT INTO gis.dataset_version");
    expect(tx[tx.length - 1]).toBe("COMMIT");
  });
  it("prunes only when replacing a different recorded version", async () => {
    const { runner, log } = fakeDb({ gis: true, marker: "older", parishes: 1, sections: 2 });
    expect((await loadRegionDataset(runner, ds)).status).toBe("loaded");
    expect(log.some((l) => l.startsWith("WITH d AS"))).toBe(true);
  });
});
