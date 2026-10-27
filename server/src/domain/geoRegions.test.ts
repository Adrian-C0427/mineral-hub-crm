import fs from "node:fs";
import zlib from "node:zlib";
import { describe, it, expect } from "vitest";
import {
  composeGeoContext, formationFor, geoCatalog, parseFormations, parseGeoRegions, regionsGeoJSON, reservoirToken, suggestedTags,
  type FormationsDataset, type GeoRegionsDataset,
} from "./geoRegions.js";
import { regionDataPath } from "../services/gisRegions.js";
import { COUNTY_SHARES_SQL, buildRegionUpsert } from "../services/geoRegions.js";

// The boot loader writes into the production gis schema unattended and the
// forms auto-fill from these answers, so the rules are pinned here.

const square = (x: number, y: number, w = 1): number[][][][] => [[[[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]]];
const region = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  id, name: id.split(":")[1].replace(/-/g, " "), kind, parent: null, formation: null,
  sources: [{ id: "epa-aapg", code: "1", label: id }], geom: { type: "MultiPolygon", coordinates: square(0, 0) }, ...over,
});
const regionsJson = (over: Record<string, unknown> = {}) => JSON.stringify({
  key: "tx-geo-regions", builtAt: "2026-10-26", sources: [], uncovered: { basins: ["Dalhart Basin"], note: "" },
  regions: [
    region("basin:east-texas-basin", "basin", { name: "East Texas Basin" }),
    region("basin:gulf-coast-basin", "basin", { name: "Gulf Coast Basin" }),
    region("ref:tx-la-ms-salt", "reference", { name: "East Texas Basin" }),
    region("ref:western-gulf", "reference", { name: "Gulf Coast Basin" }),
    region("subbasin:delaware-basin", "subbasin", { name: "Delaware Basin", parent: "basin:gulf-coast-basin" }),
    region("play:eagle-ford", "play", { name: "Eagle Ford play", formation: "Eagle Ford", parent: "basin:gulf-coast-basin" }),
  ],
  countyRegions: [
    { fips: "48289", regionId: "basin:east-texas-basin", share: 0.999 },
    { fips: "48289", regionId: "play:eagle-ford", share: 0.82 },
    { fips: "48255", regionId: "basin:gulf-coast-basin", share: 1 },
    { fips: "48255", regionId: "play:eagle-ford", share: 1 },
    { fips: "48161", regionId: "basin:east-texas-basin", share: 0.6 },
    { fips: "48161", regionId: "basin:gulf-coast-basin", share: 0.4 },
  ],
  counties: [{ fips: "48289", name: "Leon" }, { fips: "48255", name: "Karnes" }, { fips: "48161", name: "Freestone" }],
  ...over,
});
const formationsJson = JSON.stringify({
  key: "tx-formations", builtAt: "2026-10-26", source: { name: "RRC", asOf: "2026-10" }, records: 3, withToken: 3, mapped: 3,
  tokens: { "COTTON VALLEY": "Cotton Valley", "WILCOX 9200": "Wilcox", WILCOX: "Wilcox", WOODBINE: "Woodbine", "EAGLE FORD": "Eagle Ford" },
  formations: [{ name: "Wilcox", records: 2177 }, { name: "Woodbine", records: 269 }, { name: "Dexter", records: 3 }],
  countyFormations: [{ fips: "289", formation: "Woodbine", fieldReservoirs: 22 }, { fips: "289", formation: "Cotton Valley", fieldReservoirs: 18 }, { fips: "255", formation: "Eagle Ford", fieldReservoirs: 9 }],
});
const regions = (): GeoRegionsDataset => parseGeoRegions(regionsJson());
const formations = (): FormationsDataset => parseFormations(formationsJson);
const base = { regions: regions(), formations: formations(), abstractIds: [] as string[], abstractShares: [], pendingAbstractIds: [], counties: [] as string[], wells: [] };

describe("bundles", () => {
  it("ship with the server and parse", () => {
    const r = regionDataPath(new URL("./geoRegions.ts", import.meta.url).href, "tx-geo-regions.json.gz");
    const f = regionDataPath(new URL("./geoRegions.ts", import.meta.url).href, "tx-formations.json.gz");
    expect(fs.existsSync(r) && fs.existsSync(f)).toBe(true);
    const ds = parseGeoRegions(zlib.gunzipSync(fs.readFileSync(r)));
    expect(ds.regions.filter((x) => x.kind === "basin").map((x) => x.name).sort()).toEqual([
      "Anadarko Basin", "Ark-La-Tex", "Bend Arch", "East Texas Basin", "Fort Worth Basin", "Gulf Coast Basin", "Kerr Basin", "Llano Uplift",
      "North Texas (Muenster Arch)", "Orogrande Basin", "Ouachita Fold Belt", "Palo Duro Basin", "Permian Basin", "Strawn Basin",
    ]);
    expect(ds.regions.filter((x) => x.kind === "subbasin").map((x) => x.name).sort()).toEqual(["Central Basin Platform", "Delaware Basin", "Marfa Basin", "Midland Basin", "Ozona Arch", "Val Verde Basin"]);
    expect(ds.regions.filter((x) => x.kind === "play").map((x) => x.formation).sort()).toEqual(["Abo", "Austin Chalk", "Avalon", "Barnett", "Bend Shale", "Bone Spring", "Bossier", "Delaware", "Eagle Ford", "Haynesville", "Spraberry", "Tuscaloosa", "Wolfcamp", "Yeso"]);
    expect(ds.counties.length).toBe(254);
    // Every Texas county lies in at least one basin (the EPA layer tessellates the state).
    const withBasin = new Set(ds.countyRegions.filter((c) => c.regionId.startsWith("basin:")).map((c) => c.fips));
    expect(ds.counties.filter((c) => !withBasin.has(c.fips))).toEqual([]);
    const fds = parseFormations(zlib.gunzipSync(fs.readFileSync(f)));
    expect(fds.tokens["COTTON VALLEY"]).toBe("Cotton Valley");
    expect(fds.tokens["WILCOX 9200"]).toBe("Wilcox");
    expect(fds.formations[0].name).toBe("Frio");
    const leon = fds.countyFormations.filter((c) => c.fips === "289").sort((a, b) => b.fieldReservoirs - a.fieldReservoirs).map((c) => c.formation).slice(0, 4);
    expect(leon).toEqual(["Woodbine", "Cotton Valley", "Travis Peak", "Pettit"]);
  });
  it("refuse malformed files", () => {
    expect(() => parseGeoRegions(regionsJson({ key: "x" }))).toThrow(/unexpected key/);
    expect(() => parseGeoRegions(regionsJson({ regions: [region("play:x", "play")] }))).toThrow(/names no formation/);
    expect(() => parseGeoRegions(regionsJson({ regions: [region("basin:a", "basin", { parent: "basin:zzz" })] }))).toThrow(/unknown parent/);
    expect(() => parseGeoRegions(regionsJson({ countyRegions: [{ fips: "48289", regionId: "basin:nope", share: 0.5 }] }))).toThrow(/bad county share/);
    expect(() => parseFormations(formationsJson.replace('"tokens"', '"tokenz"'))).toThrow(/no dictionary/);
  });
});

describe("RRC field names", () => {
  it("take the last parenthetical, even when the 32-character name cut it off", () => {
    expect(reservoirToken("NORTH LEON (COTTON VALLEY)")).toBe("COTTON VALLEY");
    expect(reservoirToken("DEW (WOODBINE) (COTTON VALLEY")).toBe("COTTON VALLEY");
    expect(reservoirToken("SPRABERRY (TREND AREA)")).toBe("TREND AREA");
    expect(reservoirToken("NO PAREN")).toBeNull();
    expect(reservoirToken("")).toBeNull();
  });
  it("map through the dictionary, strip depth suffixes, and title-case the unknown", () => {
    const t = formations().tokens;
    expect(formationFor("WILCOX 9200", t)).toBe("Wilcox");
    expect(formationFor("WILCOX 7350", t)).toBe("Wilcox");
    expect(formationFor("wilcox", t)).toBe("Wilcox");
    expect(formationFor("SAN ANDRES", t)).toBe("San Andres");
    expect(formationFor("5500", t)).toBeNull();
    expect(formationFor(null, t)).toBeNull();
  });
});

describe("composeGeoContext", () => {
  it("abstract footprint wholly inside a basin that EIA agrees on → high; county-level stays medium", () => {
    const ctx = composeGeoContext({ ...base, abstractIds: ["TX-1"], abstractShares: [
      { abstractId: "TX-1", regionId: "basin:east-texas-basin", share: 1 }, { abstractId: "TX-1", regionId: "ref:tx-la-ms-salt", share: 1 },
    ] });
    expect(ctx.coverage).toMatchObject({ basis: "abstract", abstractsRequested: 1, abstractsResolved: 1, abstractsPending: 0 });
    expect(ctx.basins.map((b) => [b.name, b.confidence, b.edge])).toEqual([["East Texas Basin", "high", false]]);
    const county = composeGeoContext({ ...base, counties: ["Leon County"] });
    expect(county.coverage.basis).toBe("county");
    expect(county.basins.map((b) => [b.name, b.confidence, b.basis])).toEqual([["East Texas Basin", "medium", "county"]]);
    expect(county.plays.map((p) => [p.formation, p.confidence])).toEqual([["Eagle Ford", "low"]]);
  });
  it("a footprint on the drawn line is an edge; EIA disagreeing caps the basin at medium", () => {
    const edge = composeGeoContext({ ...base, abstractIds: ["TX-1"], abstractShares: [
      { abstractId: "TX-1", regionId: "basin:east-texas-basin", share: 0.7 }, { abstractId: "TX-1", regionId: "basin:gulf-coast-basin", share: 0.3 },
      { abstractId: "TX-1", regionId: "ref:tx-la-ms-salt", share: 0.9 },
    ] });
    expect(edge.basins.map((b) => [b.name, b.confidence, b.edge])).toEqual([["East Texas Basin", "medium", true], ["Gulf Coast Basin", "low", true]]);
    const disagree = composeGeoContext({ ...base, abstractIds: ["TX-1"], abstractShares: [
      { abstractId: "TX-1", regionId: "basin:east-texas-basin", share: 1 }, { abstractId: "TX-1", regionId: "ref:western-gulf", share: 1 },
    ] });
    expect(disagree.basins[0].confidence).toBe("medium");
    expect(disagree.basins[0].note).toMatch(/EIA's basin outline places this footprint in Gulf Coast Basin/);
  });
  it("averages shares over several abstracts and counts abstracts awaiting the index", () => {
    const ctx = composeGeoContext({ ...base, abstractIds: ["TX-1", "TX-2", "TX-3"], pendingAbstractIds: ["TX-3"], abstractShares: [
      { abstractId: "TX-1", regionId: "basin:east-texas-basin", share: 1 }, { abstractId: "TX-2", regionId: "basin:gulf-coast-basin", share: 1 },
    ] });
    expect(ctx.basins.map((b) => [b.name, b.share])).toEqual([["East Texas Basin", 0.5], ["Gulf Coast Basin", 0.5]]);
    expect(ctx.coverage.abstractsPending).toBe(1);
    expect(ctx.notes.some((n) => /not yet indexed/.test(n))).toBe(true);
  });
  it("formations: wells on the footprint beat plays, which beat the county field list", () => {
    const ctx = composeGeoContext({ ...base, abstractIds: ["TX-1"], counties: ["Leon"],
      abstractShares: [{ abstractId: "TX-1", regionId: "basin:east-texas-basin", share: 1 }, { abstractId: "TX-1", regionId: "play:eagle-ford", share: 0.8 }],
      wells: [
        { abstractId: "TX-1", fieldName: "NORTH LEON (COTTON VALLEY)", formations: null },
        { abstractId: "TX-1", fieldName: "DEW (WILCOX 9200)", formations: ["COTTON VALLEY"] },
      ] });
    expect(ctx.formations.map((f) => [f.name, f.basis, f.confidence, f.count])).toEqual([
      ["Cotton Valley", "wells", "high", 2], ["Wilcox", "wells", "high", 1],
      ["Eagle Ford", "play", "medium", 0],
      ["Woodbine", "fields", "low", 22],
    ]);
    expect(suggestedTags(ctx)).toEqual({ basins: ["East Texas Basin"], formations: ["Cotton Valley", "Wilcox"] });
  });
  it("suggests nothing it is not sure of: low-confidence basins and county field lists are menus, not facts", () => {
    const split = composeGeoContext({ ...base, counties: ["Freestone"] });
    expect(split.basins.map((b) => [b.name, b.confidence])).toEqual([["East Texas Basin", "low"], ["Gulf Coast Basin", "low"]]);
    expect(suggestedTags(split)).toEqual({ basins: [], formations: [] });
    const karnes = composeGeoContext({ ...base, counties: ["Karnes"] });
    expect(suggestedTags(karnes)).toEqual({ basins: ["Gulf Coast Basin"], formations: [] });
    const withPlay = composeGeoContext({ ...base, abstractIds: ["TX-9"], abstractShares: [
      { abstractId: "TX-9", regionId: "basin:gulf-coast-basin", share: 1 }, { abstractId: "TX-9", regionId: "ref:western-gulf", share: 1 },
      { abstractId: "TX-9", regionId: "subbasin:delaware-basin", share: 0.95 }, { abstractId: "TX-9", regionId: "play:eagle-ford", share: 0.9 },
    ] });
    expect(suggestedTags(withPlay)).toEqual({ basins: ["Gulf Coast Basin", "Delaware Basin"], formations: ["Eagle Ford"] });
  });
  it("reports unknown counties and an empty record honestly", () => {
    const ctx = composeGeoContext({ ...base, counties: ["Caddo Parish"] });
    expect(ctx.coverage.countiesUnknown).toEqual(["Caddo Parish"]);
    expect(ctx.basins).toEqual([]);
    expect(composeGeoContext(base).coverage.basis).toBe("none");
  });
});

describe("map + catalog", () => {
  it("serializes only the wanted kinds, never the reference layer", () => {
    const fc = regionsGeoJSON(regions(), ["basin", "subbasin"]);
    expect(fc.features.map((f) => f.properties!.kind)).toEqual(["basin", "basin", "subbasin"]);
    expect(fc.features[2].properties!.parentName).toBe("Gulf Coast Basin");
  });
  it("lists basins, plays and the formations with a real footprint", () => {
    const c = geoCatalog(regions(), formations());
    expect(c.basins.map((b) => b.name)).toEqual(["East Texas Basin", "Gulf Coast Basin"]);
    expect(c.plays[0]).toMatchObject({ formation: "Eagle Ford", basin: "Gulf Coast Basin" });
    expect(c.formations).toEqual(["Eagle Ford", "Wilcox", "Woodbine"]);
    expect(c.uncovered.basins).toEqual(["Dalhart Basin"]);
  });
});

describe("SQL builders", () => {
  it("upsert carries the version as the shared last parameter and converts geometry to MultiPolygon", () => {
    const q = buildRegionUpsert(regions().regions.slice(0, 2), "v1");
    expect(q.params.length).toBe(15);
    expect(q.params[14]).toBe("v1");
    expect(q.sql).toContain("$15, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($7), 4326)), 3))");
    expect(q.sql).toContain("$15, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($14), 4326)), 3))");
    expect(q.sql).toContain("ON CONFLICT (id) DO UPDATE");
  });
  it("county shares are scoped to one state + county and keep only ≥ 1 % overlaps of 2-D abstracts", () => {
    expect(COUNTY_SHARES_SQL).toContain("a.state = $1 AND a.county_fips = $2 AND ST_Dimension(a.geom) = 2");
    expect(COUNTY_SHARES_SQL).toContain(">= 0.01");
    expect(COUNTY_SHARES_SQL).toContain("LEAST(1.0,");
  });
});
