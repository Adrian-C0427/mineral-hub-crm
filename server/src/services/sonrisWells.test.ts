import fs from "node:fs";
import zlib from "node:zlib";
import { describe, it, expect } from "vitest";
import { regionDataPath, type GisDb, type GisDbRunner } from "./gisRegions.js";
import {
  buildBoreInsert, buildProductionInsert, buildWellInsert, LA_WELLS_DATASET_FILE, loadLaWellDataset,
  parseLaWellDataset, SONRIS_DDL, type LaWellDataset,
} from "./sonrisWells.js";

// The Louisiana well loader writes into the production database unattended at
// boot, so its validation, version decision and SQL shapes are pinned here;
// the full SQL path runs against PostGIS in the PR's PGlite verification.

const well = (o: Record<string, unknown> = {}) => ({
  serial: 253790, api: "17081217940000", name: "HA RA SUV;SUS FORESTS 4-9 HC", wellNo: "003-ALT",
  operator: "COMSTOCK OIL & GAS--LA, LLC", operatorId: "C332", field: "WOODARDVILLE", fieldId: "9803",
  statusCode: "10", status: "Active - Producing Gas", product: "20", classType: null,
  spud: "2023-01-25", permit: "2022-10-10", completion: "2023-08-12", statusDate: "2023-08-12",
  md: 22820, tvd: 12698, luw: "618433", section: 4, township: "T14N R9W", lon: -93.292593, lat: 32.235178,
  locationQuality: "ok", locationNote: null, ...o,
});
const bore = (o: Record<string, unknown> = {}) => ({ serial: 253790, seq: 2291219, md: 22820, tvd: 12698, path: [[-93.2926, 32.2352], [-93.2930, 32.2630]], ...o });
const prod = (o: Record<string, unknown> = {}) => ({
  luw: "618433", ym: 202305, line: "1", oil: 0, condensate: 0, gas: 290711, wells: 4, operatorId: "C332",
  operator: "COMSTOCK", fieldId: "9803", field: "WOODARDVILLE", luwName: "HA RA SU79;", luwType: "UNIT", stateFlag: null, ...o,
});
const file = (o: Record<string, unknown> = {}) => JSON.stringify({ key: "la-red-river-wells", source: {}, quality: {}, wells: [well()], bores: [bore()], production: [prod()], ...o });

describe("bundled file", () => {
  it("resolves from src and dist and parses cleanly", () => {
    expect(regionDataPath("file:///app/server/dist/services/sonrisWells.js", LA_WELLS_DATASET_FILE)).toBe("/app/server/data/gis/la-red-river-wells.json.gz");
    const path = regionDataPath(new URL("./sonrisWells.ts", import.meta.url).href, LA_WELLS_DATASET_FILE);
    expect(fs.existsSync(path)).toBe(true);
    const ds = parseLaWellDataset(zlib.gunzipSync(fs.readFileSync(path)));
    expect([ds.wells.length, ds.bores.length, ds.production.length]).toEqual([3931, 1352, 24759]);
    expect(ds.wells.filter((w) => w.locationQuality === "flag").length).toBe(53);
    // SONRIS' all-zero "API" means none — never stored as an identifier.
    expect(ds.wells.every((w) => w.api === null || /^17\d{12}$/.test(w.api))).toBe(true);
    expect(new Set(ds.wells.map((w) => w.fid)).size).toBe(3931);
  });
});

describe("parseLaWellDataset", () => {
  it("maps a well into the map vocabulary and its fid block, versioned by content", () => {
    const ds = parseLaWellDataset(file());
    expect(ds.wells[0]).toMatchObject({ fid: 2_000_253_790, status: "Producing", type: "Gas", symbol: "Gas", statusText: "Active - Producing Gas", section: 4, township: "T14N R9W" });
    expect(ds.bores[0]).toMatchObject({ fid: 2_002_291_219, surfaceFid: 2_000_253_790, boreType: "Horizontal" });
    expect(ds.version).toMatch(/^[0-9a-f]{16}$/);
    expect(parseLaWellDataset(Buffer.from(file())).version).toBe(ds.version);
    expect(parseLaWellDataset(file({ source: { x: 1 } })).version).not.toBe(ds.version);
  });
  it("treats an all-zero API as none and keeps a flagged location's note", () => {
    const ds = parseLaWellDataset(file({ wells: [well({ api: "00000000000000", locationQuality: "flag", locationNote: "more than 800 m from its recorded section" })] }));
    expect(ds.wells[0].api).toBeNull();
    expect(ds.wells[0].locationNote).toBe("more than 800 m from its recorded section");
  });
  it("refuses anything it can't vouch for", () => {
    const bad = (o: Record<string, unknown>, re: RegExp) => expect(() => parseLaWellDataset(file(o))).toThrow(re);
    bad({ key: "other" }, /file is dataset/);
    bad({ wells: [] }, /no wells/);
    bad({ wells: [well({ serial: 0 })] }, /fid block/);
    bad({ wells: [well({ serial: 100_000_000 })] }, /fid block/);
    bad({ wells: [well(), well()] }, /duplicated/);
    bad({ wells: [well({ api: "4228930123" })] }, /malformed API/);
    bad({ wells: [well({ api: "42289301230000" })] }, /non-Louisiana API/);
    bad({ wells: [well({ lon: -95.9, lat: 31.2 })] }, /not located in Louisiana/);
    bad({ wells: [well({ spud: "2023-02-30" })] }, /impossible date/);
    bad({ wells: [well({ statusCode: null })] }, /no status/);
    bad({ wells: [well({ township: "14N 9W" })] }, /township/);
    bad({ wells: [well({ luw: "61843" })] }, /LUW/);
    bad({ wells: [well({ locationQuality: "maybe" })] }, /location quality/);
    bad({ bores: [bore({ serial: 1 })] }, /not on a well/);
    bad({ bores: [bore({ path: [[-93.29, 32.23], [-93.29, 32.23]] })] }, /zero length/);
    bad({ bores: [bore({ path: [[-93.29, 32.23]] })] }, /no Louisiana line/);
    bad({ bores: [bore(), bore()] }, /duplicated/);
    bad({ production: [prod({ ym: 202313 })] }, /bad month/);
    bad({ production: [prod(), prod()] }, /duplicate production row/);
    bad({ production: [prod({ gas: "1" })] }, /not a number/);
  });
  it("keeps an operator change's same-line rows (they differ by operator)", () => {
    const ds = parseLaWellDataset(file({ production: [prod({ operatorId: "A1760", gas: 0 }), prod({ operatorId: "T4843", gas: 155 })] }));
    expect(ds.production.length).toBe(2);
  });
});

describe("SQL builders", () => {
  const ds = parseLaWellDataset(file());
  it("only touches the sonris schema", () => {
    for (const sql of SONRIS_DDL) {
      expect(sql).toMatch(/IF NOT EXISTS/);
      expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\b(rrc|gis)\./);
    }
    for (const q of [buildWellInsert(ds.wells, ds), buildBoreInsert(ds.bores, ds), buildProductionInsert(ds.production, ds)]) {
      expect(q.sql).toMatch(/^INSERT INTO sonris\./);
      expect(q.sql).not.toMatch(/\b(rrc|gis)\./);
      // No value is ever spliced into the SQL text.
      expect(q.sql).not.toContain("COMSTOCK");
    }
  });
  it("binds one parameter per column (+ lon/lat) and tags rows with the dataset", () => {
    const w = buildWellInsert(ds.wells, ds);
    expect(w.params.length).toBe(31);
    expect(w.params[2]).toBe("la-red-river-wells");
    expect(w.params.slice(-2)).toEqual([-93.292593, 32.235178]);
    expect(w.sql).toContain("ST_SetSRID(ST_MakePoint($30::float8, $31::float8), 4326)");
    const b = buildBoreInsert(ds.bores, ds);
    expect(b.params.length).toBe(8);
    expect(JSON.parse(b.params[7] as string)).toEqual({ type: "LineString", coordinates: ds.bores[0].path });
    expect(buildProductionInsert(ds.production, ds).sql).toContain("ON CONFLICT (luw, ym, line, operator_id)");
  });
});

/** A scripted fake of the SQL surface: records statements, answers the reads. */
function fakeDb(state: { gis: boolean; marker: string | null; present: [number, number, number] }) {
  const log: string[] = [];
  const db: GisDb = {
    async query<T>(sql: string): Promise<T[]> {
      log.push(sql.trim().split(/\s+/).slice(0, 4).join(" "));
      if (sql.includes("to_regclass")) return [{ ok: state.gis } as T];
      if (sql.includes("FROM gis.dataset_version")) return state.marker ? [{ version: state.marker } as T] : [];
      if (sql.includes("AS production")) return [{ wells: state.present[0], bores: state.present[1], production: state.present[2] } as T];
      if (sql.includes("DELETE FROM sonris")) return [{ n: 0 } as T];
      return [];
    },
    async execute(sql: string) { log.push(sql.trim().split(/\s+/).slice(0, 4).join(" ")); return 0; },
  };
  const runner: GisDbRunner = { ...db, transaction: async (fn) => { log.push("BEGIN"); const r = await fn(db); log.push("COMMIT"); return r; } };
  return { runner, log };
}

describe("loadLaWellDataset", () => {
  const ds: LaWellDataset = parseLaWellDataset(file());
  it("skips a database without the gis tables, creating nothing", async () => {
    const { runner, log } = fakeDb({ gis: false, marker: null, present: [0, 0, 0] });
    expect(await loadLaWellDataset(runner, ds)).toEqual({ status: "no-gis" });
    expect(log.some((l) => /CREATE|INSERT|DELETE/.test(l))).toBe(false);
  });
  it("is DDL + reads only when current", async () => {
    const { runner, log } = fakeDb({ gis: true, marker: ds.version, present: [1, 1, 1] });
    expect(await loadLaWellDataset(runner, ds)).toEqual({ status: "current", wells: 1, bores: 1, production: 1 });
    expect(log.some((l) => /INSERT|DELETE|BEGIN/.test(l))).toBe(false);
  });
  it("loads in one locked transaction (replace this dataset's rows, marker last)", async () => {
    const { runner, log } = fakeDb({ gis: true, marker: null, present: [0, 0, 0] });
    expect(await loadLaWellDataset(runner, ds)).toEqual({ status: "loaded", wells: 1, bores: 1, production: 1, pruned: 0 });
    const tx = log.slice(log.indexOf("BEGIN"));
    expect(tx[1]).toBe("SELECT pg_advisory_xact_lock(hashtext($1))");
    expect(tx.filter((l) => l.startsWith("WITH d AS (DELETE")).length).toBe(3);
    expect(tx.filter((l) => l.startsWith("INSERT INTO sonris.")).length).toBe(3);
    expect(tx.some((l) => /\b(rrc|gis\.(counties|abstracts))\b/.test(l))).toBe(false);
    expect(tx[tx.length - 2]).toBe("INSERT INTO gis.dataset_version (key,");
    expect(tx[tx.length - 1]).toBe("COMMIT");
  });
  it("reloads when rows went missing under a current marker", async () => {
    const { runner } = fakeDb({ gis: true, marker: ds.version, present: [1, 1, 0] });
    expect((await loadLaWellDataset(runner, ds)).status).toBe("loaded");
  });
});
